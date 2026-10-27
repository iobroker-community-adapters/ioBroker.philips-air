'use strict';

const { randomBytes, createHash } = require('node:crypto');

const OIDC = 'https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA';
const GIGYA = 'https://cdc.accounts.home.id';
const API_KEY = '4_JGZWlP8eQHpEqkvQElolbA';
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
            country_required: 'Select the account country and save the settings first.',
            otp_invalid: 'Check the email verification code and try again.',
            account_pending_registration: 'Complete account registration in the Philips app first.',
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
     * @param {(tokens: Tokens, email?: string) => Promise<void>} options.saveTokens Persist through the controller before use.
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
            : '';
        this.abort = new AbortController();
        this.destroyed = false;
        this.generation = 0;
        this.authorizing = false;
        this.persisting = Promise.resolve();
        /** @type {{owner: string, email: string, vToken: string, verifier: string, state: string, expires: number, busy: boolean} | undefined} */
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
     * @param {string} email Email used only for the transient verification session.
     * @param {string} owner Controller-authenticated Admin owner.
     * @returns {Promise<void>} Sends an email code without persisting the email.
     */
    async requestOtp(email, owner) {
        this.assertActive();
        if (!this.countryCode) {
            throw new CloudError('country_required');
        }
        if (typeof owner !== 'string' || !owner) {
            throw new CloudError('invalid_owner');
        }
        if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new CloudError('invalid_email');
        }
        const generation = ++this.generation;
        this.login = undefined;
        this.authorizing = false;
        this.refreshing = undefined;
        const data = await this.gigya('accounts.auth.otp.email.sendCode', { email });
        this.assertActive();
        if (generation !== this.generation) {
            throw new CloudError('login_superseded');
        }
        if (data?.errorCode !== 0 || typeof data.vToken !== 'string' || !data.vToken) {
            throw new CloudError('otp_request_failed');
        }
        this.login = {
            owner,
            email,
            vToken: data.vToken,
            verifier: randomBytes(64).toString('base64url'),
            state: randomBytes(32).toString('base64url'),
            expires: this.now() + 600000,
            busy: false,
        };
    }

    /**
     * @param {string} code Six digit email verification code.
     * @param {string} owner Controller-authenticated Admin owner.
     * @returns {Promise<void>} Completes passive PKCE and persists the resulting tokens.
     */
    async completeOtp(code, owner) {
        this.assertActive();
        const pending = this.login;
        if (!pending || pending.owner !== owner || pending.expires <= this.now()) {
            if (pending && pending.expires <= this.now()) {
                this.login = undefined;
            }
            throw new CloudError('invalid_state');
        }
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
            throw new CloudError('otp_invalid');
        }
        if (pending.busy) {
            throw new CloudError('login_in_progress');
        }
        pending.busy = true;
        const generation = ++this.generation;
        this.refreshing = undefined;
        this.authorizing = true;
        const current = () => {
            this.assertActive();
            if (this.generation !== generation) {
                throw new CloudError('login_superseded');
            }
            if (pending.expires <= this.now()) {
                throw new CloudError('invalid_state');
            }
        };
        try {
            const verified = await this.gigya('accounts.auth.otp.email.login', {
                email: pending.email,
                code,
                vToken: pending.vToken,
            });
            current();
            if (verified?.errorCode === 206001) {
                this.login = undefined;
                throw new CloudError('account_pending_registration');
            }
            // Keep the verification session for a corrected code until its original expiry.
            if (verified?.errorCode !== 0) {
                throw new CloudError('otp_invalid');
            }
            this.login = undefined;
            const session = verified?.sessionInfo?.cookieValue;
            if (typeof session !== 'string' || !session) {
                throw new CloudError('invalid_session');
            }
            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT,
                response_type: 'code',
                prompt: 'none',
                code_challenge_method: 'S256',
                code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
                state: pending.state,
                scope: SCOPES,
            });
            const location = await this.redirect(`${OIDC}/authorize?${params}`);
            current();
            let context;
            try {
                const target = new URL(location);
                if (
                    target.origin !== 'https://www.accounts.home.id' ||
                    target.pathname !== '/authui/client/proxy' ||
                    target.username ||
                    target.password ||
                    target.hash
                ) {
                    throw new Error();
                }
                if (target.searchParams.getAll('context').length !== 1) {
                    throw new Error();
                }
                context = target.searchParams.get('context');
            } catch {
                throw new CloudError('invalid_redirect');
            }
            if (!context) {
                throw new CloudError('invalid_redirect');
            }
            const ids = await this.gigya('socialize.getIDs', { includeTicket: 'true' });
            current();
            if (ids?.errorCode !== 0 || typeof ids.gmidTicket !== 'string' || !ids.gmidTicket) {
                throw new CloudError('invalid_session');
            }
            const continuation = new URLSearchParams({
                context,
                login_token: session,
                gmidTicket: ids.gmidTicket,
                client_id: CLIENT_ID,
            });
            const callbackLocation = await this.redirect(`${OIDC}/authorize/continue?${continuation}`);
            current();
            let callback;
            try {
                callback = new URL(callbackLocation);
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
            // Gigya may omit state on its passive continuation; validate it whenever supplied.
            if (
                callback.searchParams.has('state') &&
                (callback.searchParams.getAll('state').length !== 1 ||
                    callback.searchParams.get('state') !== pending.state)
            ) {
                throw new CloudError('invalid_state');
            }
            if (
                ['error', 'errorMessage', 'reason'].some(key => callback.searchParams.has(key)) ||
                callback.searchParams.getAll('code').length !== 1 ||
                !callback.searchParams.get('code')
            ) {
                throw new CloudError('authorization_failed');
            }
            await this.exchange(
                {
                    grant_type: 'authorization_code',
                    code: callback.searchParams.get('code') || '',
                    redirect_uri: REDIRECT,
                    code_verifier: pending.verifier,
                },
                pending.email,
            );
        } finally {
            pending.busy = false;
            if (this.generation === generation) {
                this.authorizing = false;
            }
        }
    }

    /**
     * @param {string} method Fixed Gigya API method.
     * @param {Record<string, string>} fields Form fields.
     * @returns {ReturnType<CloudAccount['request']>} Untrusted Gigya JSON.
     */
    gigya(method, fields) {
        return this.request(`${GIGYA}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                [method === 'socialize.getIDs' ? 'APIKey' : 'apiKey']: API_KEY,
                format: 'json',
                ...fields,
            }).toString(),
        });
    }

    /**
     * @param {string} url Fixed OAuth endpoint; redirect destinations are never requested.
     * @returns {Promise<string>} Untrusted Location for validation by the caller.
     */
    async redirect(url) {
        this.assertActive();
        try {
            const response = await this.fetch(url, {
                redirect: 'manual',
                signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)]),
            });
            try {
                this.assertActive();
                if (![301, 302, 303, 307, 308].includes(response.status)) {
                    throw new CloudError('authorization_failed');
                }
                const location = response.headers.get('location');
                if (!location || location.length > 32768) {
                    throw new CloudError('invalid_redirect');
                }
                return location;
            } finally {
                await response.body?.cancel();
            }
        } catch (error) {
            if (error instanceof CloudError) {
                throw error;
            }
            throw new CloudError(this.destroyed ? 'stopped' : 'request_failed');
        }
    }

    /**
     * @param {Record<string, string>} fields OAuth form fields.
     * @param {string} [email] Verified login email to save with this token set; absent during refresh.
     * @returns {Promise<void>} Saves a validated token rotation before publishing it.
     */
    async exchange(fields, email) {
        const generation = this.generation;
        const data = await this.request(`${OIDC}/token`, {
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
                    await this.saveTokens(tokens, email);
                } catch {
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
                if (url === `${OIDC}/token` && response.status === 400) {
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
        if (!this.countryCode) {
            throw new CloudError('country_required');
        }
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
     * @returns {Promise<{data: any, accessToken: string, expiresAt: number|undefined}>} Response paired with its bearer token.
     */
    async authorized(path) {
        await this.discover();
        let accessToken = await this.ensureAccessToken();
        let expiresAt = this.tokens?.expiresAt;
        try {
            return {
                data: await this.request(`${this.api}/${path}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }),
                accessToken,
                expiresAt,
            };
        } catch (error) {
            if (!(error instanceof CloudError) || error.code !== 'unauthorized') {
                throw error;
            }
            accessToken = await this.ensureAccessToken(accessToken === this.tokens?.accessToken);
            expiresAt = this.tokens?.expiresAt;
            return {
                data: await this.request(`${this.api}/${path}`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }),
                accessToken,
                expiresAt,
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

    /** @returns {Promise<{accessToken: string, expiresAt: number|undefined, signature: string, userId: string, brokerUrl: string, tenant: string}>} Private MQTT connection material. */
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
            expiresAt: signature.expiresAt,
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
