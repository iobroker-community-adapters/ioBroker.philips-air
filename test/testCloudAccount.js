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
    const account = new CloudAccount({ tokens: { ...tokens }, now: () => 1000,
        saveTokens: async data => { saved.push(data); },
        fetch: async (url, init) => { calls.push({ url, init }); return response(replies.shift()); } });
    return { account, calls, saved };
}
function callback(account) {
    const url = new URL(account.startLogin('admin.0').url);
    return `com.philips.air://loginredirect?code=synthetic%2Bcode&state=${url.searchParams.get('state')}`;
}

describe('cloud account OAuth and REST', () => {
    it('does not let an old refresh overwrite a newly completed account login', async () => {
        const { account, saved } = fixture();
        let finishRefresh = (_reply) => {};
        account.fetch = async (_url, init) => {
            const form = new URLSearchParams(String(init?.body));
            if (form.get('grant_type') === 'refresh_token') {
                return new Promise(resolve => { finishRefresh = resolve; });
            }
            return response({ ...tokenReply, access_token: 'new-account' });
        };
        const refresh = account.ensureAccessToken(true).catch(error => error.message);
        await account.completeLogin(callback(account), 'admin.0');
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
        const login = account.completeLogin(callback(account), 'admin.0');
        await assert.rejects(account.ensureAccessToken(), /login_in_progress/);
        finishSave();
        assert.match(await refresh, /login_superseded/);
        await login;
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
    it('uses S256 and an encoded form, saves tokens before exposing them, and consumes callbacks once', async () => {
        const { account, calls, saved } = fixture([tokenReply]);
        const redirect = callback(account);
        assert.ok(account.login);
        const verifier = account.login.verifier;
        assert.equal(verifier.length, 86);
        const other = new URL(account.startLogin('other').url);
        assert.ok(account.login);
        assert.equal(other.searchParams.get('code_challenge'), createHash('sha256').update(account.login.verifier).digest('base64url'));
        assert.equal(other.searchParams.get('code_challenge_method'), 'S256');
        await assert.rejects(account.completeLogin(redirect, 'admin.0'), /invalid_state/);
        const current = callback(account);
        await account.completeLogin(current, 'admin.0');
        const form = new URLSearchParams(String(calls[0].init.body));
        assert.equal(form.get('code'), 'synthetic+code');
        assert.equal(form.get('redirect_uri'), 'com.philips.air://loginredirect');
        assert.equal(saved[0].accessToken, 'new-access');
        await assert.rejects(account.completeLogin(current, 'admin.0'), /invalid_state/);
    });

    it('rejects wrong owners, expired states, duplicate parameters and altered callback hosts', async () => {
        const { account, calls } = fixture();
        const redirect = callback(account);
        await assert.rejects(account.completeLogin(redirect, 'another'), /invalid_state/);
        await assert.rejects(account.completeLogin(redirect.replace('loginredirect', 'loginredirect.attacker'), 'admin.0'), /invalid_redirect/);
        await assert.rejects(account.completeLogin(`${redirect}&state=duplicate`, 'admin.0'), /invalid_state/);
        account.now = () => 700000;
        await assert.rejects(account.completeLogin(redirect, 'admin.0'), /invalid_state/);
        assert.equal(calls.length, 0);
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
        await assert.rejects(account.ensureAccessToken(), /login_required/);
        account.saveTokens = async data => { saved.push(data); };
        await account.completeLogin(callback(account), 'admin.0');
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
