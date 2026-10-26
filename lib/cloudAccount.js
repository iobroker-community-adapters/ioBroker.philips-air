'use strict';

const { randomBytes, createHash } = require('node:crypto');

const OIDC = 'https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA';
const CLIENT_ID = '-XsK7O6iEkLml77yDGDUi0ku';
const REDIRECT = 'com.philips.air://loginredirect';
const SCOPES =
    'openid email profile address offline_access DI.Account.read DI.Account.write DI.AccountProfile.read DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read DI.AccountSubscription.write';

/** A deliberately content-free error safe for adapter/admin logs. */
class CloudError extends Error {
    /** @param {string} code Stable local failure code. */
    constructor(code) {
        const action = {
            login_required: 'Sign in again in the instance settings.',
            unauthorized: 'Check the account and sign in again in the instance settings.',
            token_storage_failed: 'Token storage failed; sign in again after checking the controller.',
            admin_user_context_required: 'Use an Admin/controller version that forwards the authenticated user.',
            administrator_required: 'Sign in to ioBroker Admin as the built-in admin user.',
            invalid_admin_origin: 'Open the adapter settings through a valid HTTP or HTTPS Admin address.',
            login_proxy_multihost_unsupported: 'Use Admin on the same ioBroker host as this adapter.',
            login_proxy_unavailable:
                'Configure a valid public/private certificate pair in Admin and start a new login.',
            login_proxy_start_failed: 'Check the Admin certificate and available network ports, then try again.',
        }[code];
        super(`Philips cloud: ${code}${action ? `. ${action}` : ''}`);
        this.code = code;
    }
}

/** @typedef {{accessToken: string, refreshToken: string, idToken: string, expiresAt: number}} Tokens */

/** Account OAuth and the read-only DA account endpoints. */
class CloudAccount {
    /**
     * @param {object} options Account storage and HTTP dependencies.
     * @param {Tokens} [options.tokens] Previously decrypted native fields.
     * @param {(tokens: Tokens) => Promise<void>} options.saveTokens Persist through the controller before use.
     * @param {typeof fetch} [options.fetch] HTTP implementation.
     * @param {() => number} [options.now] Clock in milliseconds.
     * @param {string} [options.countryCode] Two-letter account country.
     */
    constructor(options) {
        this.tokens = options.tokens;
        this.saveTokens = options.saveTokens;
        this.fetch = options.fetch || fetch;
        this.now = options.now || Date.now;
        this.countryCode = /^[a-z]{2}$/i.test(options.countryCode || '')
            ? (options.countryCode || '').toUpperCase()
            : 'GB';
        this.abort = new AbortController();
        this.destroyed = false;
        this.generation = 0;
        this.authorizing = false;
        this.persisting = Promise.resolve();
        /** @type {{owner: string, verifier: string, state: string, expires: number} | undefined} */
        this.login = undefined;
        /** @type {Promise<string> | undefined} */
        this.refreshing = undefined;
        /** @type {Promise<void> | undefined} */
        this.discovery = undefined;
        this.api = 'https://prod.eu-da.iot.versuni.com/api/da';
        this.brokerUrl = 'wss://ats.prod.eu-da.iot.versuni.com:443/mqtt';
    }

    /** @returns {void} Reject late HTTP completions after unload. */
    assertActive() {
        if (this.destroyed) {
            throw new CloudError('stopped');
        }
    }

    /**
     * @param {string} owner Trusted admin session owner.
     * @returns {{url: string}} Browser authorization link; never log it.
     */
    startLogin(owner) {
        this.assertActive();
        if (typeof owner !== 'string' || !owner) {
            throw new CloudError('invalid_owner');
        }
        const verifier = randomBytes(64).toString('base64url');
        this.generation++;
        this.authorizing = false;
        this.refreshing = undefined;
        const state = randomBytes(32).toString('base64url');
        this.login = { owner, verifier, state, expires: this.now() + 600000 };
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT,
            response_type: 'code',
            code_challenge_method: 'S256',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            state,
            scope: SCOPES,
            ui_locales: `en-${this.countryCode}`,
        });
        return { url: `${OIDC}/authorize?${params}` };
    }

    /**
     * @param {string} redirectUrl Full custom-scheme callback captured during browser authorization.
     * @param {string} owner Trusted admin session owner.
     * @returns {Promise<void>} Resolves after tokens are persisted.
     */
    async completeLogin(redirectUrl, owner) {
        this.assertActive();
        const pending = this.login;
        let callback;
        try {
            callback = new URL(redirectUrl);
        } catch {
            throw new CloudError('invalid_redirect');
        }
        if (
            `${callback.protocol}//${callback.host}${callback.pathname}` !== REDIRECT ||
            callback.hash ||
            callback.username ||
            callback.password
        ) {
            throw new CloudError('invalid_redirect');
        }
        if (
            !pending ||
            pending.owner !== owner ||
            pending.expires <= this.now() ||
            callback.searchParams.getAll('state').length !== 1 ||
            callback.searchParams.get('state') !== pending.state
        ) {
            throw new CloudError('invalid_state');
        }
        this.login = undefined;
        if (
            callback.searchParams.has('error') ||
            callback.searchParams.has('reason') ||
            callback.searchParams.getAll('code').length !== 1 ||
            !callback.searchParams.get('code')
        ) {
            throw new CloudError('authorization_failed');
        }
        const generation = ++this.generation;
        this.refreshing = undefined;
        this.authorizing = true;
        try {
            await this.exchange({
                grant_type: 'authorization_code',
                code: callback.searchParams.get('code') || '',
                redirect_uri: REDIRECT,
                code_verifier: pending.verifier,
            });
        } finally {
            if (this.generation === generation) {
                this.authorizing = false;
            }
        }
    }

    /**
     * @param {Record<string, string>} fields OAuth form fields.
     * @returns {Promise<void>} Saves a validated token rotation before publishing it.
     */
    async exchange(fields) {
        const generation = this.generation;
        const data = await this.request(`${OIDC}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }).toString(),
        });
        const previous = fields.grant_type === 'refresh_token' ? this.tokens : undefined;
        const tokens = {
            accessToken: data?.access_token,
            refreshToken: data?.refresh_token || previous?.refreshToken,
            idToken: data?.id_token || previous?.idToken,
            expiresAt: this.now() + data?.expires_in * 1000,
        };
        if (
            ![tokens.accessToken, tokens.refreshToken, tokens.idToken].every(
                value => typeof value === 'string' && value.length > 0,
            ) ||
            typeof data?.expires_in !== 'number' ||
            !Number.isFinite(tokens.expiresAt) ||
            data.expires_in <= 0
        ) {
            throw new CloudError('invalid_token_response');
        }
        const current = () => {
            this.assertActive();
            if (this.generation !== generation) {
                throw new CloudError('login_superseded');
            }
        };
        // Serialize native writes so an older in-flight save cannot overwrite a newer login.
        const save = this.persisting
            .catch(() => {})
            .then(async () => {
                current();
                try {
                    await this.saveTokens(tokens);
                } catch {
                    if (this.generation === generation) {
                        this.tokens = undefined;
                    }
                    throw new CloudError('token_storage_failed');
                }
                current();
                this.tokens = tokens;
            });
        this.persisting = save;
        await save;
    }

    /**
     * @param {boolean} [force] Refresh after a rejected access token.
     * @returns {Promise<string>} Current persisted bearer token.
     */
    async ensureAccessToken(force = false) {
        this.assertActive();
        if (this.authorizing) {
            throw new CloudError('login_in_progress');
        }
        if (this.refreshing) {
            return this.refreshing;
        }
        if (!this.tokens?.refreshToken) {
            throw new CloudError('login_required');
        }
        if (!force && this.tokens.accessToken && this.tokens.expiresAt > this.now() + 60000) {
            return this.tokens.accessToken;
        }
        const previous = this.tokens;
        const generation = this.generation;
        const refreshing = (async () => {
            await this.exchange({
                grant_type: 'refresh_token',
                refresh_token: previous.refreshToken,
                access_token: previous.accessToken,
            });
            if (!this.tokens) {
                throw new CloudError('login_required');
            }
            return this.tokens.accessToken;
        })();
        this.refreshing = refreshing;
        try {
            return await refreshing;
        } catch (error) {
            if (
                this.generation === generation &&
                error instanceof CloudError &&
                ['login_required', 'unauthorized'].includes(error.code)
            ) {
                this.tokens = undefined;
            }
            throw error;
        } finally {
            if (this.refreshing === refreshing) {
                this.refreshing = undefined;
            }
        }
    }

    /**
     * @param {string} url Fixed or validated endpoint.
     * @param {RequestInit} [options] HTTP parameters.
     * @returns {Promise<any>} Parsed, untrusted JSON.
     */
    async request(url, options = {}) {
        this.assertActive();
        try {
            const response = await this.fetch(url, {
                ...options,
                redirect: 'error',
                signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]),
                headers: { Accept: 'application/json', ...options.headers },
            });
            this.assertActive();
            if (!response.ok) {
                if (url === `${OIDC}/oauth/token` && response.status === 400) {
                    const failure = /** @type {{error?: string} | null} */ (await response.json().catch(() => null));
                    if (failure?.error === 'invalid_grant') {
                        throw new CloudError('login_required');
                    }
                }
                throw new CloudError(response.status === 401 ? 'unauthorized' : `http_${response.status}`);
            }
            const data = await response.json();
            this.assertActive();
            return data;
        } catch (error) {
            if (error instanceof CloudError) {
                throw error;
            }
            throw new CloudError(this.destroyed ? 'stopped' : 'request_failed');
        }
    }

    /** @returns {Promise<void>} Resolve account routing without ever sending credentials to discovery. */
    async discover() {
        if (!this.discovery) {
            this.discovery = (async () => {
                const data = await this.request(
                    `https://prod.global-da.iot.versuni.com/configuration?countryCode=${this.countryCode}`,
                );
                const host = value => typeof value === 'string' && /^(?:[a-z0-9-]+\.)+iot\.versuni\.com$/i.test(value);
                if (!host(data?.api) || !host(data?.iot)) {
                    throw new CloudError('invalid_cloud_configuration');
                }
                this.api = `https://${data.api}/api/da`;
                this.brokerUrl = `wss://${data.iot}:443/mqtt`;
            })().catch(error => {
                this.discovery = undefined;
                throw error;
            });
        }
        return this.discovery;
    }

    /**
     * @param {string} path Account read endpoint.
     * @returns {Promise<{data: any, accessToken: string}>} Response paired with its bearer token.
     */
    async authorized(path) {
        await this.discover();
        let accessToken = await this.ensureAccessToken();
        try {
            return {
                data: await this.request(`${this.api}/${path}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }),
                accessToken,
            };
        } catch (error) {
            if (!(error instanceof CloudError) || error.code !== 'unauthorized') {
                throw error;
            }
            accessToken = await this.ensureAccessToken(accessToken === this.tokens?.accessToken);
            return {
                data: await this.request(`${this.api}/${path}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }),
                accessToken,
            };
        }
    }

    /** @returns {Promise<Array<{id: string, thingName: string, ctn: string, friendlyName: string}>>} Safe device selection fields. */
    async listDevices() {
        const { data } = await this.authorized('user/self/device');
        if (
            !Array.isArray(data) ||
            data.some(
                item =>
                    !item ||
                    !['id', 'thingName', 'ctn'].every(key => typeof item[key] === 'string' && item[key].length > 0),
            )
        ) {
            throw new CloudError('invalid_devices');
        }
        return data.map(({ id, thingName, ctn, friendlyName }) => ({
            id,
            thingName,
            ctn,
            friendlyName: typeof friendlyName === 'string' ? friendlyName : ctn,
        }));
    }

    /** @returns {Promise<{accessToken: string, signature: string, userId: string, brokerUrl: string, tenant: string}>} Private MQTT connection material. */
    async getConnectionInfo() {
        const user = await this.authorized('user/self');
        const signature = await this.authorized('user/self/signature');
        if (
            typeof user.data?.id !== 'string' ||
            !user.data.id ||
            typeof signature.data?.signature !== 'string' ||
            !signature.data.signature
        ) {
            throw new CloudError('invalid_connection_info');
        }
        return {
            userId: user.data.id,
            accessToken: signature.accessToken,
            signature: signature.data.signature,
            brokerUrl: this.brokerUrl,
            tenant: 'da',
        };
    }

    /** @returns {void} Stop pending HTTP and invalidate unfinished logins. */
    destroy() {
        this.destroyed = true;
        this.login = undefined;
        this.abort.abort();
    }
}

module.exports = { CloudAccount, CloudError };
