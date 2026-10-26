'use strict';

const { CloudAccount, CloudError } = require('./cloudAccount');
const CloudLoginProxy = require('./cloudLoginProxy');

/** Own the account independently of whether a cloud device has been selected yet. */
class CloudAdmin {
    /**
     * @param {object} adapter Adapter instance.
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.stopped = false;
        this.loginGeneration = 0;
        /** @type {InstanceType<typeof CloudLoginProxy> | undefined} */
        this.loginProxy = undefined;
        this.account = new CloudAccount({
            tokens: {
                accessToken: adapter.config.cloudAccessToken || '',
                refreshToken: adapter.config.cloudRefreshToken || '',
                idToken: adapter.config.cloudIdToken || '',
                expiresAt: adapter.config.cloudExpiresAt || 0,
            },
            countryCode: adapter.config.cloudCountry,
            saveTokens: async tokens => {
                if (this.stopped) {
                    throw new CloudError('stopped');
                }
                // updateConfig merges and encrypts encryptedNative fields on controller >=6.0.11.
                await adapter.updateConfig({
                    cloudAccessToken: tokens.accessToken,
                    cloudRefreshToken: tokens.refreshToken,
                    cloudIdToken: tokens.idToken,
                    cloudExpiresAt: tokens.expiresAt,
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
                case 'cloudLogin': {
                    const origin = message.message?.origin;
                    if (typeof origin !== 'string' || origin.length > 2048) {
                        throw new CloudError('invalid_admin_origin');
                    }
                    let returnUrl;
                    try {
                        returnUrl = new URL(origin);
                    } catch {
                        throw new CloudError('invalid_admin_origin');
                    }
                    if (!['http:', 'https:'].includes(returnUrl.protocol) || returnUrl.username || returnUrl.password) {
                        throw new CloudError('invalid_admin_origin');
                    }
                    const generation = ++this.loginGeneration;
                    requestGeneration = generation;
                    this.loginProxy?.destroy();
                    this.loginProxy = undefined;
                    const admin = await this.adapter.getForeignObjectAsync(message.from);
                    if (this.stopped || generation !== this.loginGeneration) {
                        return;
                    }
                    if (!admin?.common?.host || admin.common.host !== this.adapter.host) {
                        throw new CloudError('login_proxy_multihost_unsupported');
                    }
                    const [certificates] = await this.adapter.getCertificatesAsync(
                        admin.native?.certPublic || 'defaultPublic',
                        admin.native?.certPrivate || 'defaultPrivate',
                    );
                    if (this.stopped || generation !== this.loginGeneration) {
                        return;
                    }
                    const proxy = new CloudLoginProxy({
                        account: this.account,
                        owner,
                        hostname: returnUrl.hostname,
                        returnUrl: returnUrl.href,
                        certificates,
                        setTimeout: this.adapter.setTimeout.bind(this.adapter),
                        clearTimeout: this.adapter.clearTimeout.bind(this.adapter),
                    });
                    this.loginProxy = proxy;
                    let url;
                    try {
                        ({ url } = await proxy.start());
                    } catch (error) {
                        proxy.destroy();
                        throw error;
                    }
                    if (this.stopped || generation !== this.loginGeneration) {
                        proxy.destroy();
                        return;
                    }
                    result = { openUrl: url, window: '_blank' };
                    break;
                }
                case 'cloudLoginStatus': {
                    const signedIn = this.loginGeneration
                        ? !!this.loginProxy?.completed
                        : !!this.account.tokens?.refreshToken;
                    // Reload stored configuration instead of saving stale form tokens over the rotation.
                    result = { signedIn, reloadBrowser: signedIn };
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
        this.loginProxy?.destroy();
        this.loginProxy = undefined;
        this.account.destroy();
    }
}

module.exports = CloudAdmin;
