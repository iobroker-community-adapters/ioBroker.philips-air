'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { CloudAccount } = require('../lib/cloudAccount');

const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id', expiresAt: 4000000 };
const tokenReply = { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id', expires_in: 3600 };
const routing = { api: 'prod.eu-da.iot.versuni.com', iot: 'ats.prod.eu-da.iot.versuni.com' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(replies = []) {
    const calls = [];
    const saved = [];
    const account = new CloudAccount({ tokens: { ...tokens }, now: () => 1000, countryCode: 'DE',
        saveTokens: async data => { saved.push(data); },
        fetch: async (url, init) => { calls.push({ url, init }); return response(replies.shift()); } });
    return { account, calls, saved };
}
function otpFetch(calls, token = tokenReply) {
    return async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('sendCode')) return response({ errorCode: 0, vToken: 'synthetic-vtoken' });
        if (url.endsWith('email.login')) return response({ errorCode: 0, sessionInfo: { cookieValue: 'synthetic-session' } });
        if (url.includes('/authorize?')) return new Response(null, { status: 302,
            headers: { location: 'https://www.accounts.home.id/authui/client/proxy?context=synthetic-context' } });
        if (url.endsWith('socialize.getIDs')) return response({ errorCode: 0, gmidTicket: 'synthetic-ticket' });
        if (url.includes('/authorize/continue?')) return new Response(null, { status: 302,
            headers: { location: 'com.philips.air://loginredirect?code=synthetic%2Bcode' } });
        return response(token);
    };
}
async function login(account) {
    await account.requestOtp('synthetic@example.test', 'admin.0');
    return account.completeOtp('123456', 'admin.0');
}

describe('cloud account OAuth and REST', () => {
    it('persists the verified login email with its tokens without overwriting it on refresh', async () => {
        const { account } = fixture();
        const emails = [];
        account.fetch = otpFetch([]);
        account.saveTokens = async (_tokens, email) => { emails.push(email); };
        await login(account);
        await account.ensureAccessToken(true);
        assert.deepEqual(emails, ['synthetic@example.test', undefined]);
    });
    it('requires an explicit country before login or regional discovery', async () => {
        let requests = 0;
        const account = new CloudAccount({ saveTokens: async () => {},
            fetch: async () => { requests++; return response(routing); } });
        await assert.rejects(account.requestOtp('synthetic@example.test', 'admin.0'), /country_required/);
        await assert.rejects(account.discover(), /country_required/);
        assert.equal(requests, 0);
        account.destroy();
    });

    it('does not let an old refresh overwrite a newly completed account login', async () => {
        const { account, saved } = fixture();
        let finishRefresh = (_reply) => {};
        const oauth = otpFetch([] , { ...tokenReply, access_token: 'new-account' });
        account.fetch = async (_url, init) => {
            const form = new URLSearchParams(String(init?.body));
            if (form.get('grant_type') === 'refresh_token') {
                return new Promise(resolve => { finishRefresh = resolve; });
            }
            return oauth(_url, init);
        };
        const refresh = account.ensureAccessToken(true).catch(error => error.message);
        await login(account);
        finishRefresh(response({ ...tokenReply, access_token: 'old-account' }));
        assert.match(await refresh, /login_superseded/);
        assert.deepEqual(saved.map(value => value.accessToken), ['new-account']);
        assert.equal(account.tokens?.accessToken, 'new-account');
    });

    it('serializes an already started native write before a new login saves', async () => {
        const { account, saved } = fixture([tokenReply, { ...tokenReply, access_token: 'new-account' }]);
        let finishSave = () => {};
        let saving = () => {};
        const enteredSave = new Promise(resolve => { saving = () => resolve(undefined); });
        account.saveTokens = async value => {
            if (!saved.length) {
                saved.push(value);
                saving();
                await new Promise(resolve => { finishSave = () => resolve(undefined); });
            } else {
                saved.push(value);
            }
        };
        const refresh = account.ensureAccessToken(true).catch(error => error.message);
        await enteredSave;
        account.fetch = otpFetch([], { ...tokenReply, access_token: 'new-account' });
        await account.requestOtp('synthetic@example.test', 'admin.0');
        const signingIn = account.completeOtp('123456', 'admin.0');
        await assert.rejects(account.ensureAccessToken(), /login_in_progress/);
        finishSave();
        assert.match(await refresh, /login_superseded/);
        await signingIn;
        assert.equal(saved.at(-1).accessToken, 'new-account');
        assert.equal(account.tokens?.accessToken, 'new-account');
    });
    it('can retry discovery after a transient failure without sending credentials to discovery', async () => {
        const { account, calls } = fixture();
        let count = 0;
        account.fetch = async (url, init) => {
            calls.push({ url, init });
            if (++count === 1) throw new Error('synthetic network failure');
            return response(routing);
        };
        await assert.rejects(account.discover(), /request_failed/);
        await account.discover();
        assert.equal(count, 2);
        assert.ok(calls.every(call => !call.init.headers.Authorization));
    });
    it('sends OTP and completes passive S256 PKCE without following redirects or retaining credentials', async () => {
        const { account, calls, saved } = fixture();
        account.fetch = otpFetch(calls);
        await account.requestOtp('synthetic@example.test', 'admin.0');
        assert.ok(account.login);
        const verifier = account.login.verifier;
        await account.completeOtp('123456', 'admin.0');
        const authorization = new URL(calls.find(call => call.url.includes('/authorize?')).url);
        assert.equal(authorization.searchParams.get('prompt'), 'none');
        assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorization.searchParams.get('redirect_uri'), 'com.philips.air://loginredirect');
        const form = new URLSearchParams(calls.at(-1).init.body);
        assert.equal(form.get('code'), 'synthetic+code');
        assert.equal(form.get('code_verifier'), verifier);
        assert.ok(calls.at(-1).url.endsWith('/token'));
        assert.equal(saved[0].accessToken, 'new-access');
        assert.equal(account.login, undefined);
        assert.ok(calls.every(call => call.init.redirect === (call.url.includes('/authorize') ? 'manual' : 'error')));
        await assert.rejects(account.completeOtp('123456', 'admin.0'), /invalid_state/);
    });

    it('rejects invalid inputs, wrong owners and expired sessions before verification', async () => {
        const { account, calls } = fixture();
        account.fetch = otpFetch(calls);
        await assert.rejects(account.requestOtp('bad', 'admin.0'), /invalid_email/);
        await assert.rejects(account.requestOtp('synthetic@example.test', ''), /invalid_owner/);
        await account.requestOtp('synthetic@example.test', 'admin.0');
        await assert.rejects(account.completeOtp('123456', 'another'), /invalid_state/);
        await assert.rejects(account.completeOtp('12345', 'admin.0'), /otp_invalid/);
        account.now = () => 700000;
        await assert.rejects(account.completeOtp('123456', 'admin.0'), /invalid_state/);
        assert.equal(calls.length, 1);
    });

    it('allows correcting a rejected OTP but blocks parallel completion and consumes verified sessions', async () => {
        const { account } = fixture();
        account.fetch = otpFetch([]);
        await account.requestOtp('synthetic@example.test', 'admin.0');
        const oauth = account.fetch;
        let finish = (_response) => {};
        account.fetch = async () => new Promise(resolve => { finish = resolve; });
        const first = account.completeOtp('123456', 'admin.0');
        await assert.rejects(account.completeOtp('123456', 'admin.0'), /login_in_progress/);
        finish(response({ errorCode: 403000, errorMessage: 'private-data' }));
        await assert.rejects(first, /otp_invalid/);
        assert.ok(account.login);
        account.fetch = oauth;
        await account.completeOtp('654321', 'admin.0');
        await assert.rejects(account.completeOtp('654321', 'admin.0'), /invalid_state/);
    });

    it('discards superseded OTP requests and verification results', async () => {
        const { account, saved } = fixture();
        let finish = (_response) => {};
        account.fetch = async () => new Promise(resolve => { finish = resolve; });
        const old = account.requestOtp('old@example.test', 'admin.0');
        account.fetch = otpFetch([]);
        await account.requestOtp('new@example.test', 'admin.0');
        finish(response({ errorCode: 0, vToken: 'old-token' }));
        await assert.rejects(old, /login_superseded/);
        assert.equal(account.login?.email, 'new@example.test');
        account.fetch = async () => new Promise(resolve => { finish = resolve; });
        const verifying = account.completeOtp('123456', 'admin.0');
        account.fetch = otpFetch([]);
        await account.requestOtp('newest@example.test', 'admin.0');
        finish(response({ errorCode: 0, sessionInfo: { cookieValue: 'old-session' } }));
        await assert.rejects(verifying, /login_superseded/);
        assert.equal(saved.length, 0);
    });

    it('rejects changed callback destinations, duplicate codes and wrong states without token exchange', async () => {
        for (const callback of ['https://attacker.test/?code=secret',
            'com.philips.air://loginredirect.attacker?code=secret',
            'com.philips.air://loginredirect?code=one&code=two',
            'com.philips.air://loginredirect?code=one&state=wrong']) {
            const { account, calls, saved } = fixture();
            const oauth = otpFetch(calls);
            account.fetch = async (url, init) => String(url).includes('/authorize/continue?')
                ? new Response(null, { status: 302, headers: { location: callback } }) : oauth(url, init);
            await assert.rejects(login(account), /invalid_redirect|authorization_failed|invalid_state/);
            assert.equal(saved.length, 0);
            assert.equal(account.tokens?.accessToken, tokens.accessToken);
            assert.ok(!calls.some(call => call.url.endsWith('/token')));
        }
    });

    it('rejects untrusted context redirects without following them or requesting a ticket', async () => {
        const { account, calls, saved } = fixture();
        const oauth = otpFetch(calls);
        account.fetch = async (url, init) => String(url).includes('/authorize?')
            ? new Response(null, { status: 302, headers: { location: 'https://attacker.test/?context=secret' } }) : oauth(url, init);
        await assert.rejects(login(account), /invalid_redirect/);
        assert.equal(saved.length, 0);
        assert.ok(!calls.some(call => call.url.endsWith('socialize.getIDs')));
    });

    it('releases OAuth response bodies on both valid and rejected redirects', async () => {
        for (const status of [302, 200]) {
            const { account } = fixture();
            let canceled = false;
            account.fetch = async () => new Response(new ReadableStream({
                cancel() { canceled = true; },
            }), { status, headers: { location: 'https://www.accounts.home.id/authui/client/proxy?context=synthetic' } });
            if (status === 302) {
                assert.match(await account.redirect('https://cdc.accounts.home.id/synthetic'), /context=synthetic/);
            } else {
                await assert.rejects(account.redirect('https://cdc.accounts.home.id/synthetic'), /authorization_failed/);
            }
            assert.equal(canceled, true);
        }
    });

    it('requires app registration when Gigya accepts a pending account and sanitizes provider errors', async () => {
        const { account } = fixture();
        const oauth = otpFetch([]);
        account.fetch = async (url, init) => String(url).endsWith('email.login')
            ? response({ errorCode: 206001, errorMessage: 'private-account-data' }) : oauth(url, init);
        await assert.rejects(login(account), /account_pending_registration/);
        assert.equal(account.login, undefined);
        assert.equal(account.tokens?.accessToken, tokens.accessToken);
    });

    it('rejects verification after its session expires or the adapter unloads', async () => {
        for (const stop of [false, true]) {
            const { account, saved } = fixture();
            account.fetch = otpFetch([]);
            await account.requestOtp('synthetic@example.test', 'admin.0');
            let finish = (_response) => {};
            account.fetch = async () => new Promise(resolve => { finish = resolve; });
            const verification = account.completeOtp('123456', 'admin.0');
            if (stop) account.destroy();
            else account.now = () => 700000;
            finish(response({ errorCode: 0, sessionInfo: { cookieValue: 'late-private-session' } }));
            await assert.rejects(verification, stop ? /stopped/ : /invalid_state/);
            assert.equal(saved.length, 0);
        }
    });

    it('coalesces concurrent refreshes and includes both existing tokens in the refresh form', async () => {
        const { account, calls, saved } = fixture([tokenReply]);
        assert.deepEqual(await Promise.all([account.ensureAccessToken(true), account.ensureAccessToken(true)]), ['new-access', 'new-access']);
        assert.equal(calls.length, 1);
        assert.equal(saved.length, 1);
        const body = new URLSearchParams(String(calls[0].init.body));
        assert.equal(body.get('access_token'), tokens.accessToken);
        assert.equal(body.get('refresh_token'), tokens.refreshToken);
    });

    it('does not use unpersisted rotated tokens and permits a new login after storage failure', async () => {
        const { account, saved } = fixture([tokenReply, tokenReply]);
        account.saveTokens = async () => { throw new Error('private token storage data'); };
        await assert.rejects(account.ensureAccessToken(true), /token_storage_failed/);
        assert.equal(account.tokens?.accessToken, tokens.accessToken);
        account.fetch = otpFetch([]);
        account.saveTokens = async data => { saved.push(data); };
        await login(account);
        assert.equal(saved.length, 1);
    });

    it('strips private device fields while preserving independent REST and MQTT identities', async () => {
        const { account, calls } = fixture([routing, [{ id: 'rest-id', thingName: 'thing-id', ctn: 'AC0651/10',
            friendlyName: 'Synthetic purifier', localCredentials: 'must-not-return' }], { id: 'user-id' }, { signature: 'signature' }]);
        assert.deepEqual(await account.listDevices(), [{ id: 'rest-id', thingName: 'thing-id', ctn: 'AC0651/10', friendlyName: 'Synthetic purifier' }]);
        const info = await account.getConnectionInfo();
        assert.equal(info.signature, 'signature');
        assert.equal(info.accessToken, tokens.accessToken);
        assert.equal(info.brokerUrl, 'wss://ats.prod.eu-da.iot.versuni.com:443/mqtt');
        assert.equal(calls[0].init.headers.Authorization, undefined);
        assert.equal(calls[1].init.headers.Authorization, `Bearer ${tokens.accessToken}`);
    });

    it('rejects discovery destinations outside Versuni IoT before sending credentials', async () => {
        const { account, calls } = fixture([{ api: 'iot.versuni.com.attacker.test', iot: routing.iot }]);
        await assert.rejects(account.listDevices(), /invalid_cloud_configuration/);
        assert.equal(calls.length, 1);
    });

    it('retries a rejected bearer once with a persisted refresh and matching signature', async () => {
        const { account, calls } = fixture();
        const replies = [response(routing), response({ id: 'user' }), response({}, 401), response(tokenReply), response({ signature: 'new-signature' })];
        account.fetch = async (url, init) => { calls.push({ url, init }); const reply = replies.shift(); assert.ok(reply); return reply; };
        const info = await account.getConnectionInfo();
        assert.equal(info.accessToken, 'new-access');
        assert.equal(info.signature, 'new-signature');
        assert.equal(calls.length, 5);
    });

    it('sanitizes remote and network failures', async () => {
        const { account } = fixture();
        account.fetch = async () => { throw new Error('private-url-and-token'); };
        await assert.rejects(account.ensureAccessToken(true), error => error instanceof Error && error.message === 'Philips cloud: request_failed' && !error.cause);
        account.fetch = async () => response({ error: 'private-token' }, 403);
        await assert.rejects(account.ensureAccessToken(true), /http_403/);
    });

    it('requires login after invalid_grant without exposing the OAuth description', async () => {
        const { account } = fixture();
        account.fetch = async () => response({ error: 'invalid_grant', error_description: 'private-data' }, 400);
        await assert.rejects(account.ensureAccessToken(true), { message: 'Philips cloud: login_required. Sign in again in the instance settings.' });
        assert.equal(account.tokens, undefined);
    });

    it('rejects malformed tokens and device responses', async () => {
        const { account, saved } = fixture([null]);
        await assert.rejects(account.ensureAccessToken(true), /invalid_token_response/);
        assert.equal(saved.length, 0);
        const malformed = fixture([routing, [{ id: 'rest-id', ctn: 'AC0651' }]]);
        await assert.rejects(malformed.account.listDevices(), /invalid_devices/);
    });

    it('does not persist a token response completed after destroy', async () => {
        const { account, saved } = fixture();
        let finish = (_response) => {};
        account.fetch = async () => new Promise(resolve => { finish = resolve; });
        const refreshing = account.ensureAccessToken(true);
        account.destroy();
        finish(response(tokenReply));
        await assert.rejects(refreshing, /stopped/);
        assert.equal(saved.length, 0);
        assert.equal(account.abort.signal.aborted, true);
    });
});
