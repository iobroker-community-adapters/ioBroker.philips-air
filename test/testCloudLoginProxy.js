'use strict';

const assert = require('node:assert/strict');
const https = require('node:https');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const CloudLoginProxy = require('../lib/cloudLoginProxy');
const { CloudAccount } = require('../lib/cloudAccount');

const certificates = {
    key: readFileSync(join(__dirname, 'fixtures/cloud-login-key.pem')),
    cert: readFileSync(join(__dirname, 'fixtures/cloud-login-cert.pem')),
};

/**
 * @param {string} url Local HTTPS request.
 * @param {import('node:https').RequestOptions} [options] Request headers/method.
 * @param {string} [body] Synthetic request body.
 * @returns {Promise<{status: number | undefined, headers: import('node:http').IncomingHttpHeaders, body: string}>} Reply.
 */
function request(url, options = {}, body = '') {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { rejectUnauthorized: false, ...options }, res => {
            const parts = [];
            res.on('data', part => parts.push(part));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** @returns {{proxy: CloudLoginProxy, account: CloudAccount, saved: unknown[]}} Isolated login. */
function fixture() {
    const saved = [];
    const account = new CloudAccount({
        saveTokens: async tokens => { saved.push(tokens); },
        fetch: async () => new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
            id_token: 'synthetic-id', expires_in: 3600 })),
    });
    const proxy = new CloudLoginProxy({ account, owner: 'admin.0', hostname: '127.0.0.1',
        returnUrl: 'https://127.0.0.1:8081/#tab=instances', certificates });
    return { proxy, account, saved };
}

/** @param {CloudLoginProxy} proxy Login bridge. @returns {Promise<string>} Browser cookie. */
async function bootstrap(proxy) {
    const { url } = await proxy.start();
    const reply = await request(url);
    assert.equal(reply.status, 302);
    assert.ok(reply.headers['set-cookie']);
    assert.match(reply.headers['set-cookie'][0], /; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
    return reply.headers['set-cookie'][0].split(';')[0];
}

describe('Home.ID HTTPS login proxy', () => {
    /** @type {CloudLoginProxy[]} */
    let proxies;
    const originalFetch = global.fetch;
    beforeEach(() => { proxies = []; });
    afterEach(() => { proxies.forEach(proxy => proxy.destroy()); global.fetch = originalFetch; });

    it('requires a one-use nonce, the cookie, the exact Host and same-origin POST', async () => {
        const { proxy } = fixture(); proxies.push(proxy);
        const { url } = await proxy.start();
        assert.equal((await request(`${proxy.origin}/private`)).status, 403);
        assert.equal((await request(url, { headers: { Host: 'attacker.invalid' } })).status, 403);
        assert.equal((await request(`${proxy.origin}/_start?nonce=wrong`)).status, 403);
        const reply = await request(url);
        assert.ok(reply.headers['set-cookie']);
        const cookie = reply.headers['set-cookie'][0].split(';')[0];
        assert.equal((await request(url)).status, 403);
        assert.equal((await request(`${proxy.origin}/anything`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } })).status, 403);
        assert.equal((await request(`${proxy.origin}/_upstream/attacker.invalid/path`, { headers: { Cookie: cookie } })).status, 403);
        assert.equal(reply.headers['cache-control'], 'no-store');
        assert.equal(reply.headers['referrer-policy'], 'same-origin');
    });

    it('uses separate capability cookies for parallel instances on the same hostname', async () => {
        const first = fixture().proxy;
        const second = fixture().proxy;
        proxies.push(first, second);
        const firstCookie = await bootstrap(first);
        const secondCookie = await bootstrap(second);
        assert.notEqual(firstCookie.split('=')[0], secondCookie.split('=')[0]);
        const headers = { Cookie: `${firstCookie}; ${secondCookie}` };
        global.fetch = async () => new Response('ok');
        assert.equal((await request(`${first.origin}/login`, { headers })).status, 200);
        assert.equal((await request(`${second.origin}/login`, { headers })).status, 200);
    });

    it('isolates provider cookies between parallel logins sharing a hostname', async () => {
        const first = fixture().proxy;
        const second = fixture().proxy;
        proxies.push(first, second);
        const firstCookie = await bootstrap(first);
        const secondCookie = await bootstrap(second);
        global.fetch = async () => new Response('<head></head>', {
            headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'glt_key=provider; Path=/; Secure' },
        });
        const a = await request(`${first.origin}/login`, { headers: { Cookie: firstCookie } });
        const b = await request(`${second.origin}/login`, { headers: { Cookie: secondCookie } });
        assert.ok(a.body.includes(`const cookiePrefix = '${first.cookiePrefix}'`));
        assert.ok(b.body.includes(`const cookiePrefix = '${second.cookiePrefix}'`));
        assert.ok(a.headers['set-cookie']);
        assert.ok(b.headers['set-cookie']);
        const aProvider = a.headers['set-cookie'][0].split(';')[0];
        const bProvider = b.headers['set-cookie'][0].split(';')[0];
        assert.notEqual(aProvider, bProvider);
        const calls = [];
        global.fetch = async (_input, options) => { calls.push(options.headers.cookie); return new Response('ok'); };
        const browser = `${firstCookie}; ${secondCookie}; ${first.cookiePrefix}gmid=first; ${second.cookiePrefix}gmid=second; gmid=unscoped`;
        await request(`${first.origin}/login`, { headers: { Cookie: browser } });
        await request(`${second.origin}/login`, { headers: { Cookie: browser } });
        assert.equal(calls[0], 'glt_key=provider; gmid=first');
        assert.equal(calls[1], 'glt_key=provider; gmid=second');
    });

    it('keeps upstream cookies domain/path scoped and never forwards the login capability', async () => {
        const { proxy } = fixture(); proxies.push(proxy);
        const cookie = await bootstrap(proxy);
        const calls = [];
        global.fetch = async (input, options) => {
            calls.push({ url: String(input), headers: options.headers });
            return new Response('ok', { headers: { 'Set-Cookie': 'upstream=synthetic; Path=/only; Secure; HttpOnly' } });
        };
        const headers = { Cookie: `${cookie}; unrelated=private` };
        await request(`${proxy.origin}/_upstream/cdc.accounts.home.id/only/start`, { headers });
        await request(`${proxy.origin}/_upstream/cdc.accounts.home.id/only/next`, { headers });
        await request(`${proxy.origin}/_upstream/cdc.accounts.home.id/other`, { headers });
        await request(`${proxy.origin}/_upstream/accounts.eu1.gigya.com/only/next`, { headers });
        assert.equal(calls[0].headers.cookie, '');
        assert.equal(calls[1].headers.cookie, 'upstream=synthetic');
        assert.equal(calls[2].headers.cookie, '');
        assert.equal(calls[3].headers.cookie, '');
        assert.ok(calls.every(call => !JSON.stringify(call).includes(cookie)));
    });

    it('rewrites the SDK identity and callback without replacing canonical URL guards', async () => {
        const { proxy } = fixture(); proxies.push(proxy);
        const cookie = await bootstrap(proxy);
        global.fetch = async () => new Response('<html><head></head><body><script>e&&t&&t!==i?"".concat(e,".").concat(t):h();x.location().href=callback;guard(location.href)</script></body></html>', { headers: { 'Content-Type': 'text/html' } });
        const reply = await request(`${proxy.origin}/login`, { headers: { Cookie: cookie } });
        assert.equal(reply.status, 200);
        assert.ok(reply.body.includes('e&&t&&t!==i?"cdc.accounts.home.id":h()'));
        assert.ok(reply.body.includes('x.location().href=window.__philipsCloudUrl(callback)'));
        assert.ok(reply.body.includes('guard(location.href)'));
        assert.ok(reply.body.includes('const originalFetch'));
        assert.equal(proxy.rewrite('https://cdc.accounts.home.id.evil/path'), 'https://cdc.accounts.home.id.evil/path');
        assert.equal(proxy.rewrite('https:\\/\\/cdc.accounts.home.id\\/path'), `${proxy.origin}/_upstream/cdc.accounts.home.id/path`.replaceAll('/', '\\/'));
    });

    it('invalidates only its pending exchange on destroy without stopping the shared account', async () => {
        const { proxy, account, saved } = fixture(); proxies.push(proxy);
        const cookie = await bootstrap(proxy);
        assert.ok(account.login);
        const state = account.login.state;
        let entered = () => {};
        let release = () => {};
        const waiting = new Promise(resolve => { entered = () => resolve(undefined); });
        account.fetch = async () => {
            entered();
            await new Promise(resolve => { release = () => resolve(undefined); });
            return new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late', id_token: 'late', expires_in: 3600 }));
        };
        const reply = request(`${proxy.origin}/_complete?code=synthetic&state=${state}`, { headers: { Cookie: cookie } }).catch(() => undefined);
        await waiting;
        proxy.destroy();
        release();
        await reply;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(saved.length, 0);
        assert.equal(account.authorizing, false);
        assert.equal(account.destroyed, false);
        assert.equal(proxy.completed, false);
    });

    it('rejects external redirects, bounds payloads and concurrent requests', async () => {
        const { proxy } = fixture(); proxies.push(proxy);
        const cookie = await bootstrap(proxy);
        global.fetch = async () => new Response('', { status: 302, headers: { Location: 'https://attacker.invalid/' } });
        const headers = { Cookie: cookie };
        assert.equal((await request(`${proxy.origin}/login`, { headers })).status, 502);
        proxy.active = 12;
        assert.equal((await request(`${proxy.origin}/login`, { headers })).status, 429);
        await assert.rejects(proxy.read(Readable.from([Buffer.alloc(101)]), 100), /payload_too_large/);
    });

    it('automatically consumes the callback, persists before success and flushes the success page', async () => {
        const { proxy, account, saved } = fixture(); proxies.push(proxy);
        const cookie = await bootstrap(proxy);
        assert.ok(account.login);
        const state = account.login.state;
        global.fetch = async () => new Response('', { status: 302,
            headers: { Location: `com.philips.air://loginredirect?code=synthetic&state=${state}` } });
        const redirect = await request(`${proxy.origin}/authorize`, { headers: { Cookie: cookie } });
        assert.equal(redirect.headers.location, `${proxy.origin}/_complete?code=synthetic&state=${state}`);
        const reply = await request(redirect.headers.location, { headers: { Cookie: cookie } });
        assert.equal(reply.status, 200);
        assert.ok(reply.body.endsWith('</body></html>'));
        assert.equal(saved.length, 1);
        assert.equal(proxy.completed, true);
        assert.equal(proxy.destroyed, true);
        assert.equal(account.destroyed, false);
    });

    it('expires at ten minutes and preserves a newer pending login during idempotent cleanup', async () => {
        const { proxy, account } = fixture(); proxies.push(proxy);
        let expire = () => {};
        let delay = 0;
        let clears = 0;
        proxy.options.setTimeout = (callback, timeout) => { expire = callback; delay = timeout; return setTimeout(() => {}, 600000); };
        proxy.options.clearTimeout = timer => { clears++; clearTimeout(timer); };
        await proxy.start();
        account.startLogin('another-owner');
        const pending = account.login;
        expire(); proxy.destroy();
        assert.equal(delay, 600000);
        assert.equal(clears, 1);
        assert.equal(account.login, pending);
        assert.equal(account.destroyed, false);
        assert.equal(proxy.abort.signal.aborted, true);
        assert.equal(proxy.server?.listening, false);
    });
});
