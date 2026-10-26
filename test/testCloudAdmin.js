'use strict';

const assert = require('node:assert/strict');
const proxyPath = require('node:path').join(__dirname, '../lib/cloudLoginProxy.js');
const originalProxyModule = require.cache[proxyPath];
const proxies = [];
class FakeProxy {
    constructor(options) { this.options = options; this.destroyed = false; this.completed = false; proxies.push(this); }
    async start() { return { url: 'https://admin.example:12345/login' }; }
    destroy() { this.destroyed = true; }
}
require.cache[proxyPath] = Object.assign(new (require('node:module').Module)(proxyPath), {
    filename: proxyPath, loaded: true, exports: FakeProxy,
});
delete require.cache[require.resolve('../lib/cloudAdmin')];
const CloudAdmin = require('../lib/cloudAdmin');
if (originalProxyModule) require.cache[proxyPath] = originalProxyModule;
else delete require.cache[proxyPath];
delete require.cache[require.resolve('../lib/cloudAdmin')];
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
    return { admin, adapter, replies, updates };
}

function message(command, payload = {}) {
    return { from: 'system.adapter.admin.0', user: 'system.user.admin', command, message: payload, callback: { id: 123 } };
}

describe('cloud Admin account boundary', () => {
    it('requires the trusted built-in administrator, independently of payload claims', async () => {
        const { admin, replies } = fixture();
        admin.account.startLogin = () => { throw new Error('must not start'); };
        await admin.onMessage({ ...message('cloudLogin', { user: 'system.user.admin' }), user: 'system.user.guest' });
        await admin.onMessage({ ...message('cloudLogin'), user: undefined });
        assert.deepEqual(replies.map(reply => reply.result.error), [
            new CloudError('administrator_required').message, new CloudError('admin_user_context_required').message,
        ]);
    });
    it('ignores non-Admin senders, missing callbacks and unknown commands', async () => {
        const { admin, replies } = fixture();
        admin.account.startLogin = () => { throw new Error('must not start'); };
        for (const from of ['admin.0', 'system.adapter.javascript.0', 'system.adapter.admin.0.evil', 'system.adapter.admin.-1']) {
            await admin.onMessage({ ...message('cloudLogin'), from });
        }
        await admin.onMessage({ ...message('cloudLogin'), callback: undefined });
        await admin.onMessage(message('unknown'));
        await admin.onMessage(message('cloudDevices'));
        await admin.onMessage(null);
        assert.equal(replies.length, 0);
    });

    it('opens the HTTPS proxy with same-host Admin certificates and trusted owner', async () => {
        const { admin, adapter, replies } = fixture();
        const names = [];
        adapter.getForeignObjectAsync = async id => {
            names.push(id);
            return { common: { host: adapter.host }, native: { certPublic: 'public', certPrivate: 'private' } };
        };
        adapter.getCertificatesAsync = async (...args) => { names.push(args); return [{ key: 'key', cert: 'cert' }]; };
        const request = message('cloudLogin', { origin: 'https://admin.example:8081/admin/' });
        await admin.onMessage(request);
        const proxy = proxies.at(-1);
        assert.deepEqual(names, [request.from, ['public', 'private']]);
        assert.equal(proxy.options.owner, `${request.from}:${request.user}`);
        assert.equal(proxy.options.hostname, 'admin.example');
        assert.equal(proxy.options.returnUrl, request.message.origin);
        assert.deepEqual(proxy.options.certificates, { key: 'key', cert: 'cert' });
        assert.deepEqual(replies[0].result, { openUrl: 'https://admin.example:12345/login', window: '_blank' });
        admin.destroy();
        assert.equal(proxy.destroyed, true);
    });

    it('rejects invalid origins and unsupported multihost before starting a proxy', async () => {
        const { admin, adapter, replies } = fixture();
        const before = proxies.length;
        for (const origin of [undefined, 42, 'not a URL', 'ftp://admin.example', 'https://user:pass@admin.example', 'x'.repeat(2049)]) {
            await admin.onMessage(message('cloudLogin', { origin }));
        }
        assert.ok(replies.every(reply => reply.result.error === new CloudError('invalid_admin_origin').message));
        adapter.getForeignObjectAsync = async () => ({ common: { host: 'other-host' }, native: {} });
        await admin.onMessage(message('cloudLogin', { origin: 'http://admin.example/' }));
        assert.equal(replies.at(-1).result.error, new CloudError('login_proxy_multihost_unsupported').message);
        assert.equal(proxies.length, before);
    });

    it('returns safe login status and ignores the removed manual callback command', async () => {
        const { admin, replies } = fixture();
        await admin.onMessage(message('cloudCompleteLogin', { redirect: 'synthetic-private-callback' }));
        assert.equal(replies.length, 0);
        await admin.onMessage(message('cloudLoginStatus'));
        assert.deepEqual(replies.at(-1).result, { signedIn: true, reloadBrowser: true });
        admin.account.tokens = undefined;
        await admin.onMessage(message('cloudLoginStatus'));
        assert.deepEqual(replies.at(-1).result, { signedIn: false, reloadBrowser: false });
    });

    it('requires the new login to complete even when previous tokens exist', async () => {
        const { admin, adapter, replies } = fixture();
        let finish = (_result) => {};
        adapter.getForeignObjectAsync = () => new Promise(resolve => { finish = resolve; });
        const pending = admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        await admin.onMessage(message('cloudLoginStatus'));
        assert.deepEqual(replies.at(-1).result, { signedIn: false, reloadBrowser: false });
        finish({ common: { host: adapter.host }, native: {} });
        await pending;
        await admin.onMessage(message('cloudLoginStatus'));
        assert.deepEqual(replies.at(-1).result, { signedIn: false, reloadBrowser: false });
        proxies.at(-1).completed = true;
        await admin.onMessage(message('cloudLoginStatus'));
        assert.deepEqual(replies.at(-1).result, { signedIn: true, reloadBrowser: true });
        admin.destroy();
    });

    it('discards superseded starts and late certificate completions after shutdown', async () => {
        const { admin, adapter, replies } = fixture();
        let finishFirst = (_result) => {};
        adapter.getForeignObjectAsync = () => new Promise(resolve => { finishFirst = resolve; });
        const first = admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        adapter.getForeignObjectAsync = async () => ({ common: { host: adapter.host }, native: {} });
        await admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        const active = proxies.at(-1);
        finishFirst({ common: { host: adapter.host }, native: {} });
        await first;
        assert.equal(replies.length, 1);
        let finishCertificates = (_result) => {};
        adapter.getCertificatesAsync = () => new Promise(resolve => { finishCertificates = resolve; });
        const pending = admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        await Promise.resolve();
        assert.equal(active.destroyed, true);
        admin.destroy();
        finishCertificates([{ key: 'key', cert: 'cert' }]);
        await pending;
        assert.equal(replies.length, 1);
    });

    it('destroys failed and superseded proxies without publishing late links', async () => {
        const { admin, replies } = fixture();
        const originalStart = FakeProxy.prototype.start;
        let finish = (_result) => {};
        try {
            FakeProxy.prototype.start = () => new Promise(resolve => { finish = resolve; });
            const pending = admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
            await Promise.resolve();
            await Promise.resolve();
            const previous = proxies.at(-1);
            FakeProxy.prototype.start = originalStart;
            await admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
            finish({ url: 'https://superseded.example/' });
            await pending;
            assert.equal(previous.destroyed, true);
            assert.equal(replies.length, 1);
            FakeProxy.prototype.start = async () => { throw new Error('synthetic-secret'); };
            await admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
            assert.equal(proxies.at(-1).destroyed, true);
            assert.deepEqual(replies.at(-1).result, { error: 'Philips cloud: request_failed' });
        } finally {
            FakeProxy.prototype.start = originalStart;
            admin.destroy();
        }
    });

    it('sanitizes unexpected failures and preserves stable CloudError messages', async () => {
        const { admin, adapter, replies } = fixture();
        adapter.getForeignObjectAsync = async () => { throw new Error('synthetic-secret-from-provider'); };
        await admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        adapter.getForeignObjectAsync = async () => { throw new CloudError('login_required'); };
        await admin.onMessage(message('cloudLogin', { origin: 'https://admin.example/' }));
        assert.deepEqual(replies.map(reply => reply.result), [
            { error: 'Philips cloud: request_failed' }, { error: 'Philips cloud: login_required. Sign in again in the instance settings.' },
        ]);
    });

    it('discards late replies and invalidates account work on destroy', async () => {
        const { admin, replies, updates } = fixture();
        admin.destroy();
        await admin.onMessage(message('cloudLogin'));
        assert.equal(replies.length, 0);
        assert.equal(admin.account.destroyed, true);
        await assert.rejects(admin.account.saveTokens({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 999 }), /stopped/);
        assert.equal(updates.length, 0);
    });

    it('uses controller updateConfig with flat metadata-protected secret fields', async () => {
        const { admin, updates } = fixture();
        const tokens = { accessToken: 'new-synthetic-access', refreshToken: 'new-synthetic-refresh',
            idToken: 'new-synthetic-id', expiresAt: 999999 };
        await admin.account.saveTokens(tokens);
        assert.deepEqual(updates, [{ cloudAccessToken: tokens.accessToken, cloudRefreshToken: tokens.refreshToken,
            cloudIdToken: tokens.idToken, cloudExpiresAt: tokens.expiresAt }]);
        for (const field of ['cloudAccessToken', 'cloudRefreshToken', 'cloudIdToken']) {
            assert.ok(metadata.encryptedNative.includes(field), `${field} must be encrypted`);
            assert.ok(metadata.protectedNative.includes(field), `${field} must be protected`);
            assert.ok(Object.hasOwn(metadata.native, field), `${field} must be a flat native field`);
        }
        assert.ok(admin.account.tokens);
        assert.equal(admin.account.tokens.accessToken, 'synthetic-access');
    });
});
