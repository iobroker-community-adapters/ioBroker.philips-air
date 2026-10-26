'use strict';

const { CloudAccount, CloudError } = require('./cloudAccount');

/** Own the account independently of whether a cloud device has been selected yet. */
class CloudAdmin {
    /**
     * @param {object} adapter Adapter instance.
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.stopped = false;
        this.loginGeneration = 0;
        this.account = new CloudAccount({
            tokens: {
                accessToken: adapter.config.cloudAccessToken || '',
                refreshToken: adapter.config.cloudRefreshToken || '',
                idToken: adapter.config.cloudIdToken || '',
                expiresAt: adapter.config.cloudExpiresAt || 0,
            },
            countryCode: adapter.config.cloudCountry,
            saveTokens: async (tokens, email) => {
                if (this.stopped) {
                    throw new CloudError('stopped');
                }
                // updateConfig merges and encrypts encryptedNative fields on controller >=6.0.11.
                await adapter.updateConfig({
                    cloudAccessToken: tokens.accessToken,
                    cloudRefreshToken: tokens.refreshToken,
                    cloudIdToken: tokens.idToken,
                    cloudExpiresAt: tokens.expiresAt,
                    ...(email ? { cloudEmail: email } : {}),
                });
            },
        });
    }

    /**
     * @param {object} message Controller message; only Admin may manage account credentials.
     * @returns {Promise<void>} Completes the caller's callback without exposing secrets.
     */
    async onMessage(message) {
        if (!message?.callback || !/^system\.adapter\.admin\.\d+$/.test(message.from || '')) {
            return;
        }
        let result;
        let requestGeneration;
        try {
            if (this.stopped) {
                throw new CloudError('stopped');
            }
            // Only the controller-propagated socket user is trusted, never a payload field.
            if (message.user !== 'system.user.admin') {
                throw new CloudError(message.user ? 'administrator_required' : 'admin_user_context_required');
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
    }
}

module.exports = CloudAdmin;
