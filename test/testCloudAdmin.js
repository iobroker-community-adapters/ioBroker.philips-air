'use strict';

const assert = require('node:assert/strict');
const CloudAdmin = require('../lib/cloudAdmin');
const CloudTokenStore = require('../lib/cloudTokenStore');
const { CloudError } = require('../lib/cloudAccount');
const metadata = require('../io-package.json');

function fixture() {
    const replies = [];
    const updates = [];
    const adapter = {
        host: 'synthetic-host',
        setTimeout, clearTimeout,
        getForeignObjectAsync: async () => ({ common: { host: 'synthetic-host' }, native: {} }),
        getCertificatesAsync: async () => [{ key: 'synthetic-key', cert: 'synthetic-cert' }],
        config: { cloudCountry: 'DE', cloudAccessToken: 'synthetic-access', cloudRefreshToken: 'synthetic-refresh',
            cloudIdToken: 'synthetic-id', cloudExpiresAt: 12345 },
        updateConfig: async patch => { updates.push(patch); },
        sendTo: (from, command, result, callback) => replies.push({ from, command, result, callback }),
    };
    const admin = new CloudAdmin(adapter);
    const rotations = [];
    admin.tokenStore = new CloudTokenStore(adapter);
    admin.tokenStore.save = async tokens => { rotations.push(tokens); };
    adapter.log = { warn() {} };
    return { admin, adapter, replies, updates, rotations };
}

function message(command, payload = {}) {
    return { from: 'system.adapter.admin.0', user: 'system.user.admin', command, message: payload, callback: { id: 123 } };
}

describe('cloud Admin account boundary', () => {
    it('requires the trusted built-in administrator, independently of payload claims', async () => {
        const { admin, replies } = fixture();
        admin.account.requestOtp = async () => { throw new Error('must not start'); };
        await admin.onMessage({ ...message('cloudRequestCode', { user: 'system.user.admin' }), user: 'system.user.guest' });
        await admin.onMessage({ ...message('cloudRequestCode'), user: undefined });
        assert.deepEqual(replies.map(reply => reply.result.error), [
            new CloudError('administrator_required').message, new CloudError('admin_user_context_required').message,
        ]);
    });
    it('ignores non-Admin senders, missing callbacks and unknown commands', async () => {
        const { admin, replies } = fixture();
        admin.account.requestOtp = async () => { throw new Error('must not start'); };
        for (const from of ['admin.0', 'system.adapter.javascript.0', 'system.adapter.admin.0.evil', 'system.adapter.admin.-1']) {
            await admin.onMessage({ ...message('cloudRequestCode'), from });
        }
        await admin.onMessage({ ...message('cloudRequestCode'), callback: undefined });
        await admin.onMessage(message('unknown'));
        await admin.onMessage(message('cloudDevices'));
        await admin.onMessage(null);
        assert.equal(replies.length, 0);
    });

    it('passes only email/code and trusted owner, with completion reload after token persistence', async () => {
        const { admin, replies } = fixture();
        const calls = [];
        admin.account.requestOtp = async (...args) => { calls.push(args); };
        admin.account.completeOtp = async (...args) => { calls.push(args); };
        await admin.onMessage(message('cloudRequestCode', { email: 'synthetic@example.test', owner: 'forged' }));
        await admin.onMessage(message('cloudConfirmCode', { code: '123456' }));
        assert.deepEqual(calls, [['synthetic@example.test', 'system.adapter.admin.0:system.user.admin'],
            ['123456', 'system.adapter.admin.0:system.user.admin']]);
        assert.equal(replies.at(-1).result.reloadBrowser, true);
    });

    it('ignores removed browser commands', async () => {
        const { admin, replies } = fixture();
        await admin.onMessage(message('cloudLogin'));
        await admin.onMessage(message('cloudCompleteLogin'));
        assert.equal(replies.length, 0);
    });

    it('shows saved login and expiry without exposing tokens or claiming refresh lifetime', async () => {
        const { admin, replies } = fixture();
        admin.account.now = () => 1000;
        await admin.onMessage(message('cloudLoginStatus', { language: 'de' }));
        assert.match(replies.at(-1).result.text, /^Angemeldet\. Token gültig bis /);
        assert.ok(replies.at(-1).result.text.endsWith('. Wird automatisch erneuert.'));
        assert.equal(replies.at(-1).result.style.fontSize, '1.1rem');
        assert.ok(admin.account.tokens);
        admin.account.tokens.expiresAt = 1;
        await admin.onMessage(message('cloudLoginStatus'));
        assert.equal(replies.at(-1).result.text, 'Sign-in saved');
        admin.account.tokens = undefined;
        await admin.onMessage(message('cloudLoginStatus', { language: 'de' }));
        assert.equal(replies.at(-1).result.text, 'Nicht angemeldet');
        assert.ok(replies.every(reply => Object.keys(reply.result).sort().join() === 'style,text'));
        assert.ok(replies.every(reply => !JSON.stringify(reply.result).includes('synthetic-')));
    });

    it('discards superseded starts and late confirmations', async () => {
        const { admin, replies } = fixture();
        let finish = () => {};
        admin.account.requestOtp = async () => new Promise(resolve => { finish = () => resolve(undefined); });
        const first = admin.onMessage(message('cloudRequestCode', { email: 'old@example.test' }));
        admin.account.requestOtp = async () => {};
        await admin.onMessage(message('cloudRequestCode', { email: 'new@example.test' }));
        finish();
        await first;
        assert.equal(replies.length, 1);
        admin.account.completeOtp = async () => new Promise(resolve => { finish = () => resolve(undefined); });
        const confirmation = admin.onMessage(message('cloudConfirmCode', { code: '123456' }));
        await admin.onMessage(message('cloudRequestCode', { email: 'newest@example.test' }));
        finish();
        await confirmation;
        assert.equal(replies.length, 2);
        assert.ok(replies.every(reply => !reply.result.reloadBrowser));
    });

    it('sanitizes unexpected failures and preserves stable CloudError messages', async () => {
        const { admin, replies } = fixture();
        admin.account.requestOtp = async () => { throw new Error('synthetic-private-data'); };
        await admin.onMessage(message('cloudRequestCode', { email: 'synthetic@example.test' }));
        admin.account.requestOtp = async () => { throw new CloudError('otp_invalid'); };
        await admin.onMessage(message('cloudRequestCode', { email: 'synthetic@example.test' }));
        assert.deepEqual(replies.map(reply => reply.result), [
            { error: 'Philips cloud: request_failed' }, { error: new CloudError('otp_invalid').message },
        ]);
    });

    it('discards late replies and invalidates account work on destroy', async () => {
        const { admin, replies, updates } = fixture();
        admin.destroy();
        await admin.onMessage(message('cloudRequestCode'));
        assert.equal(replies.length, 0);
        assert.equal(admin.account.destroyed, true);
        await assert.rejects(admin.account.saveTokens({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 999 }), /stopped/);
        assert.equal(updates.length, 0);
    });

    it('waits for an in-flight rotation to reach storage during unload', async () => {
        const { admin } = fixture();
        let finishSave = () => {};
        let enteredSave = () => {};
        const entered = new Promise(resolve => { enteredSave = () => resolve(undefined); });
        assert.ok(admin.tokenStore);
        admin.tokenStore.save = async () => {
            enteredSave();
            await new Promise(resolve => { finishSave = () => resolve(undefined); });
        };
        admin.account.fetch = async () => new Response(JSON.stringify({
            access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600,
        }));
        const refresh = admin.account.ensureAccessToken(true).catch(error => error);
        await entered;
        let stopped = false;
        const stopping = admin.destroy().then(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        finishSave();
        await stopping;
        assert.equal(stopped, true);
        assert.match((await refresh).message, /stopped/);
    });

    it('persists refreshes without native writes and keeps explicit login encrypted in native', async () => {
        const { admin, updates, rotations } = fixture();
        const tokens = { accessToken: 'new-synthetic-access', refreshToken: 'new-synthetic-refresh',
            idToken: 'new-synthetic-id', expiresAt: 999999 };
        await admin.account.saveTokens(tokens);
        assert.equal(updates.length, 0);
        assert.deepEqual(rotations, [tokens]);
        for (const field of ['cloudAccessToken', 'cloudRefreshToken', 'cloudIdToken']) {
            assert.ok(metadata.encryptedNative.includes(field), `${field} must be encrypted`);
            assert.ok(metadata.protectedNative.includes(field), `${field} must be protected`);
            assert.ok(Object.hasOwn(metadata.native, field), `${field} must be a flat native field`);
        }
        assert.ok(admin.account.tokens);
        assert.equal(admin.account.tokens.accessToken, 'synthetic-access');
        await admin.account.saveTokens(tokens, 'synthetic@example.test');
        assert.equal(updates.at(-1)?.cloudEmail, 'synthetic@example.test');
    });
});
