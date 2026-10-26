'use strict';

const { createHash } = require('node:crypto');

/** Encrypted runtime credentials, bound to the saved native login. */
class CloudTokenStore {
    /** @param {object} adapter Adapter object, state and encryption APIs. */
    constructor(adapter) {
        this.adapter = adapter;
    }

    /** Create objects before values; token ACLs are separate from UI read/write flags. */
    async init() {
        const acl = { owner: 'system.user.admin', ownerGroup: 'system.group.administrator', object: 0x600 };
        await this.adapter.setObjectNotExistsAsync('auth', {
            type: 'channel',
            common: { name: 'Cloud authentication' },
            native: {},
            acl,
        });
        await this.adapter.setObjectNotExistsAsync('auth.tokens', {
            type: 'state',
            common: {
                name: 'Encrypted cloud tokens',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                expert: true,
            },
            native: {},
            acl: { ...acl, state: 0x600 },
        });
        await this.adapter.setObjectNotExistsAsync('info.cloudTokenExpiresAt', {
            type: 'state',
            common: {
                name: 'Cloud access token expires at',
                type: 'number',
                role: 'value.time',
                unit: 'ms',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    /** @returns {Promise<import('./cloudAccount').Tokens | undefined>} Persisted rotation for this login. */
    async load() {
        const state = await this.adapter.getStateAsync('auth.tokens');
        if (state?.val == null || state.val === '') {
            return undefined;
        }
        if (typeof state.val !== 'string') {
            throw new Error('Invalid saved cloud tokens');
        }
        const saved = JSON.parse(state.val);
        if (
            !saved ||
            typeof saved.source !== 'string' ||
            !/^[a-f0-9]{64}$/.test(saved.source) ||
            typeof saved.encrypted !== 'string' ||
            !saved.encrypted
        ) {
            throw new Error('Invalid saved cloud tokens');
        }
        const source = createHash('sha256')
            .update(this.adapter.config.cloudRefreshToken || '')
            .digest('hex');
        if (saved.source !== source) {
            return undefined;
        }
        const tokens = JSON.parse(this.adapter.decrypt(saved.encrypted));
        if (
            ![tokens?.accessToken, tokens?.refreshToken, tokens?.idToken].every(
                value => typeof value === 'string' && value.length > 0,
            ) ||
            typeof tokens.expiresAt !== 'number' ||
            !Number.isFinite(tokens.expiresAt) ||
            tokens.expiresAt < 0
        ) {
            throw new Error('Invalid saved cloud tokens');
        }
        return tokens;
    }

    /**
     * @param {import('./cloudAccount').Tokens} tokens Validated rotated tokens.
     * @param {string} [sourceRefreshToken] Native login identity; changes only after explicit login.
     */
    async save(tokens, sourceRefreshToken = this.adapter.config.cloudRefreshToken || '') {
        await this.adapter.setStateAsync('auth.tokens', {
            val: JSON.stringify({
                source: createHash('sha256').update(sourceRefreshToken).digest('hex'),
                encrypted: this.adapter.encrypt(JSON.stringify(tokens)),
            }),
            ack: true,
        });
        await this.updateExpiry(tokens.expiresAt);
    }

    /** @param {number} expiresAt Access-token expiry as Unix milliseconds; zero means no saved token. */
    async updateExpiry(expiresAt) {
        try {
            await this.adapter.setStateAsync('info.cloudTokenExpiresAt', { val: expiresAt, ack: true });
        } catch {
            // The rotated refresh token is already saved; a diagnostic write must not invalidate it.
            this.adapter.log.warn('Philips cloud: could not update the token expiry state');
        }
    }
}

module.exports = CloudTokenStore;
