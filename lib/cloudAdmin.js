'use strict';

const { CloudAccount, CloudError } = require('./cloudAccount');
const CloudTokenStore = require('./cloudTokenStore');

/** Own the account independently of whether a cloud device has been selected yet. */
class CloudAdmin {
    /**
     * @param {object} adapter Adapter instance.
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.stopped = false;
        this.loginGeneration = 0;
        this.restoring = Promise.resolve();
        this.tokenStore = /** @type {CloudTokenStore | undefined} */ (undefined);
        this.account = new CloudAccount({
            tokens: {
                accessToken: adapter.config.cloudAccessToken || '',
                refreshToken: adapter.config.cloudRefreshToken || '',
                idToken: adapter.config.cloudIdToken || '',
                expiresAt: adapter.config.cloudExpiresAt || 0,
            },
            countryCode: adapter.config.cloudCountry,
            saveTokens: async (tokens, email) => {
                await this.restoring;
                if (this.stopped) {
                    throw new CloudError('stopped');
                }
                if (!email) {
                    if (!this.tokenStore) {
                        throw new CloudError('token_storage_failed');
                    }
                    await this.tokenStore.save(tokens);
                    return;
                }
                // Only an explicit login changes native configuration and restarts the instance.
                await adapter.updateConfig({
                    cloudAccessToken: tokens.accessToken,
                    cloudRefreshToken: tokens.refreshToken,
                    cloudIdToken: tokens.idToken,
                    cloudExpiresAt: tokens.expiresAt,
                    ...(email ? { cloudEmail: email } : {}),
                });
                // Unload drains this save if the native write has already initiated a restart.
                if (this.tokenStore) {
                    await this.tokenStore.save(tokens, tokens.refreshToken);
                }
            },
        });
    }

    /** Restore encrypted runtime tokens before account device discovery. */
    restoreTokens() {
        this.tokenStore = new CloudTokenStore(this.adapter);
        const store = this.tokenStore;
        this.restoring = (async () => {
            try {
                await store.init();
                if (this.stopped) {
                    return;
                }
                const tokens = await store.load();
                if (this.stopped) {
                    return;
                }
                if (tokens) {
                    this.account.tokens = tokens;
                }
            } catch {
                this.account.tokens = undefined;
                if (!this.stopped) {
                    this.adapter.log.warn(
                        'Philips cloud: could not load saved tokens; sign in again in the instance settings',
                    );
                }
            }
            if (!this.stopped) {
                await store.updateExpiry(this.account.tokens?.refreshToken ? this.account.tokens.expiresAt : 0);
            }
        })();
        return this.restoring;
    }

    /**
     * Check only the Cloud login path, using the Admin instance that sent the request.
     *
     * @param from trusted Admin sender ID
     * @returns diagnostic, or an empty string for supported versions
     */
    async runtimeRequirement(from) {
        const [host, admin] = await Promise.all([
            this.adapter.getForeignObjectAsync(`system.host.${this.adapter.host}`),
            this.adapter.getForeignObjectAsync(from),
        ]);
        const controllerVersion = host?.common?.installedVersion;
        const adminVersion = admin?.common?.version;
        const supported = (version, minimum) => {
            if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
                return false;
            }
            const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
            for (let i = 0; i < 3; i++) {
                if (parts[i] !== minimum[i]) {
                    return parts[i] > minimum[i];
                }
            }
            return !version.includes('-');
        };
        if (supported(controllerVersion, [7, 2, 5]) && supported(adminVersion, [8, 1, 0])) {
            return '';
        }
        return (
            `Cloud login requires js-controller >= 7.2.5 and Admin >= 8.1.0; ` +
            `this system runs ${controllerVersion || 'unknown'} / ${adminVersion || 'unknown'} (${from}).`
        );
    }

    /**
     * @param {object} message Controller message; only Admin may manage account credentials.
     * @returns {Promise<void>} Completes the caller's callback without exposing secrets.
     */
    async onMessage(message) {
        if (!message?.callback || !/^system\.adapter\.admin\.\d+$/.test(message.from || '')) {
            return;
        }
        if (!['cloudRequestCode', 'cloudConfirmCode', 'cloudLoginStatus'].includes(message.command)) {
            return;
        }
        let result;
        let requestGeneration;
        try {
            if (this.stopped) {
                throw new CloudError('stopped');
            }
            const requirement = await this.runtimeRequirement(message.from);
            if (this.stopped) {
                return;
            }
            if (requirement) {
                result = message.command === 'cloudLoginStatus' ? { text: requirement } : { error: requirement };
                this.adapter.sendTo(message.from, message.command, result, message.callback);
                return;
            }
            // Only the controller-propagated socket user is trusted, never a payload field.
            if (typeof message.user !== 'string' || !message.user) {
                throw new CloudError('admin_user_context_required');
            }
            if (message.user !== 'system.user.admin') {
                const group = await this.adapter.getForeignObjectAsync('system.group.administrator');
                if (!Array.isArray(group?.common?.members) || !group.common.members.includes(message.user)) {
                    throw new CloudError('administrator_required');
                }
                if (this.stopped) {
                    throw new CloudError('stopped');
                }
            }
            const owner = `${message.from}:${message.user}`;
            switch (message.command) {
                case 'cloudRequestCode': {
                    const generation = ++this.loginGeneration;
                    requestGeneration = generation;
                    await this.account.requestOtp(message.message?.email, owner);
                    if (generation !== this.loginGeneration) {
                        return;
                    }
                    result = { result: 'Verification code sent. Check your email.' };
                    break;
                }
                case 'cloudConfirmCode': {
                    requestGeneration = this.loginGeneration;
                    await this.account.completeOtp(message.message?.code, owner);
                    if (requestGeneration !== this.loginGeneration) {
                        return;
                    }
                    result = { result: 'Signed in successfully.', reloadBrowser: true };
                    break;
                }
                case 'cloudLoginStatus': {
                    const requested = message.message?.language;
                    const language = ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'].includes(
                        requested,
                    )
                        ? requested
                        : 'en';
                    const translations = require(`../admin/i18n/${language}.json`);
                    const tokens = this.account.tokens;
                    let text = translations['Not signed in'];
                    if (tokens?.refreshToken) {
                        text = translations['Sign-in saved'];
                        if (
                            tokens.accessToken &&
                            tokens.expiresAt > this.account.now() &&
                            Number.isFinite(new Date(tokens.expiresAt).getTime())
                        ) {
                            text = translations['Signed in. Token valid until %s. Renewed automatically.'].replace(
                                '%s',
                                new Intl.DateTimeFormat(language, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                }).format(tokens.expiresAt),
                            );
                        }
                    }
                    result = {
                        text,
                        style: { fontSize: '1.1rem', fontWeight: 600, lineHeight: 1.5, margin: '12px 0' },
                    };
                    break;
                }
                default:
                    return;
            }
        } catch (error) {
            if (requestGeneration !== undefined && requestGeneration !== this.loginGeneration) {
                return;
            }
            result = { error: error instanceof CloudError ? error.message : 'Philips cloud: request_failed' };
        }
        if (!this.stopped) {
            this.adapter.sendTo(message.from, message.command, result, message.callback);
        }
    }

    /** Stop requests and discard any pending authorization attempt. */
    destroy() {
        this.stopped = true;
        this.loginGeneration++;
        this.account.destroy();
        return Promise.all([this.account.persisting, this.restoring].map(job => job.catch(() => {})));
    }
}

module.exports = CloudAdmin;
