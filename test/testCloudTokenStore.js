'use strict';

const assert = require('node:assert/strict');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const CloudTokenStore = require('../lib/cloudTokenStore');
const CloudAdmin = require('../lib/cloudAdmin');

describe('encrypted cloud token state persistence', () => {
    let adapter;
    let objects;
    let states;
    let warnings;
    let admins;
    const tokens = {
        accessToken: 'synthetic-access', refreshToken: 'synthetic-rotated-refresh',
        idToken: 'synthetic-id', expiresAt: 123456,
    };

    beforeEach(() => {
        objects = new Map();
        states = new Map();
        warnings = [];
        admins = [];
        const key = randomBytes(24);
        adapter = {
            config: { cloudRefreshToken: 'synthetic-login-refresh' },
            log: { warn(message) { warnings.push(message); } },
            async setObjectNotExistsAsync(id, object) {
                if (!objects.has(id)) {
                    objects.set(id, structuredClone(object));
                }
            },
            async extendObjectAsync(id, object) {
                objects.set(id, { ...objects.get(id), ...structuredClone(object) });
            },
            async getStateAsync(id) { return states.get(id) ?? null; },
            async setStateAsync(id, state) {
                assert.ok(objects.has(id), `Missing object before state write: ${id}`);
                states.set(id, structuredClone(state));
            },
            encrypt(value) {
                const iv = randomBytes(16);
                const cipher = createCipheriv('aes-192-cbc', key, iv);
                return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
            },
            decrypt(value) {
                const bytes = Buffer.from(value, 'base64');
                const decipher = createDecipheriv('aes-192-cbc', key, bytes.subarray(0, 16));
                return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
            },
            updateConfig() { throw new Error('A refresh must not restart the adapter'); },
        };
    });
    afterEach(async () => {
        await Promise.all(admins.map(admin => admin.destroy()));
    });

    async function restore() {
        const admin = new CloudAdmin(adapter);
        admins.push(admin);
        await admin.restoreTokens();
        return admin;
    }

    async function store() {
        const result = new CloudTokenStore(adapter);
        await result.init();
        return result;
    }

    it('creates private token objects and a public expiry timestamp with accurate metadata', async () => {
        await store();
        const acl = {
            owner: 'system.user.admin', ownerGroup: 'system.group.administrator', object: 0x600,
        };
        assert.equal(objects.get('auth').type, 'channel');
        assert.deepEqual(objects.get('auth').acl, acl);
        const saved = objects.get('auth.tokens');
        assert.equal(saved.type, 'state');
        assert.deepEqual(saved.acl, { ...acl, state: 0x600 });
        assert.equal(saved.common.type, 'string');
        assert.equal(saved.common.role, 'json');
        assert.equal(saved.common.expert, true);
        assert.equal(saved.common.read, true);
        assert.equal(saved.common.write, false);
        const expiry = objects.get('info.cloudTokenExpiresAt');
        assert.equal(expiry.type, 'state');
        assert.equal(expiry.common.type, 'number');
        assert.equal(expiry.common.role, 'value.time');
        assert.equal(expiry.common.unit, 'ms');
        assert.equal(expiry.common.read, true);
        assert.equal(expiry.common.write, false);
    });

    it('restores native credentials initially and reports zero expiry when no credentials exist', async () => {
        Object.assign(adapter.config, {
            cloudAccessToken: tokens.accessToken, cloudIdToken: tokens.idToken, cloudExpiresAt: tokens.expiresAt,
        });
        assert.equal(await (await store()).load(), undefined);
        const admin = await restore();
        assert.ok(admin.account.tokens);
        assert.equal(admin.account.tokens.refreshToken, adapter.config.cloudRefreshToken);
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: tokens.expiresAt, ack: true });
        adapter.config = {};
        await restore();
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: 0, ack: true });
    });

    it('retains encrypted rotations across account recreation without native configuration writes', async () => {
        const native = structuredClone(adapter.config);
        const first = await restore();
        await first.account.saveTokens(tokens);
        await first.destroy();
        const next = await restore();
        assert.deepEqual(next.account.tokens, tokens);
        assert.deepEqual(adapter.config, native);
        const saved = states.get('auth.tokens');
        assert.equal(saved.ack, true);
        assert.equal(typeof saved.val, 'string');
        const contents = JSON.stringify([...states]);
        for (const value of [tokens.accessToken, tokens.refreshToken, tokens.idToken, native.cloudRefreshToken]) {
            assert.ok(!contents.includes(value));
        }
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: tokens.expiresAt, ack: true });
    });

    it('ignores saved rotations belonging to a previous native login', async () => {
        const saved = await store();
        await saved.save(tokens);
        adapter.config.cloudRefreshToken = 'another-login';
        assert.equal(await saved.load(), undefined);
        const admin = await restore();
        assert.ok(admin.account.tokens);
        assert.equal(admin.account.tokens.refreshToken, 'another-login');
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: 0, ack: true });
    });

    it('treats an empty token state as absent', async () => {
        const saved = await store();
        states.set('auth.tokens', { val: '', ack: true });
        assert.equal(await saved.load(), undefined);
    });

    it('fails closed on malformed envelopes, ciphertext and tokens without exposing their contents', async () => {
        const saved = await store();
        await saved.save(tokens);
        const envelope = JSON.parse(states.get('auth.tokens').val);
        for (const value of [
            'synthetic-corrupt-secret',
            JSON.stringify({ ...envelope, source: 'invalid' }),
            JSON.stringify({ ...envelope, encrypted: 'synthetic-corrupt-secret' }),
            JSON.stringify({ ...envelope, encrypted: adapter.encrypt(JSON.stringify({ ...tokens, refreshToken: '' })) }),
            JSON.stringify({ ...envelope, encrypted: adapter.encrypt(JSON.stringify({ ...tokens, expiresAt: '123' })) }),
        ]) {
            states.set('auth.tokens', { val: value, ack: true });
            await assert.rejects(saved.load());
            const admin = await restore();
            assert.equal(admin.account.tokens, undefined);
            assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: 0, ack: true });
        }
        assert.ok(warnings.length > 0);
        assert.ok(!warnings.join(' ').includes('synthetic-corrupt-secret'));
        assert.ok(!warnings.join(' ').includes(tokens.accessToken));
    });

    it('preserves the previous rotation and expiry when encryption or the token-state write fails', async () => {
        const saved = await store();
        await saved.save(tokens);
        const previous = structuredClone([...states]);
        const encrypt = adapter.encrypt;
        adapter.encrypt = () => { throw new Error('synthetic encryption failure'); };
        await assert.rejects(saved.save({ ...tokens, accessToken: 'unsaved', expiresAt: 999999 }));
        assert.deepEqual([...states], previous);
        adapter.encrypt = encrypt;
        const setState = adapter.setStateAsync;
        adapter.setStateAsync = async (id, state) => {
            if (id === 'auth.tokens') {
                throw new Error('synthetic token-state failure');
            }
            await setState(id, state);
        };
        await assert.rejects(saved.save({ ...tokens, accessToken: 'unsaved', expiresAt: 999999 }));
        assert.deepEqual([...states], previous);
        assert.deepEqual(await saved.load(), tokens);
    });

    it('keeps a successfully saved rotation when the derived expiry state cannot be written', async () => {
        const saved = await store();
        await saved.save(tokens);
        const setState = adapter.setStateAsync;
        adapter.setStateAsync = async (id, state) => {
            if (id === 'info.cloudTokenExpiresAt') {
                throw new Error(`synthetic private failure ${tokens.accessToken}`);
            }
            await setState(id, state);
        };
        const rotated = { ...tokens, accessToken: 'next-access', expiresAt: 999999 };
        await saved.save(rotated);
        assert.deepEqual(await saved.load(), rotated);
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: tokens.expiresAt, ack: true });
        assert.ok(warnings.length > 0);
        assert.ok(!warnings.join(' ').includes(tokens.accessToken));
    });

    it('preserves the previous rotation when explicit login cannot update native configuration', async () => {
        const admin = await restore();
        await admin.account.saveTokens(tokens);
        const previous = structuredClone([...states]);
        await assert.rejects(admin.account.saveTokens({ ...tokens, refreshToken: 'new-login' }, 'new@example.test'));
        assert.deepEqual([...states], previous);
        const next = await restore();
        assert.deepEqual(next.account.tokens, tokens);
    });

    it('waits for initialization on unload without reading credentials or writing expiry afterward', async () => {
        const { promise: blocked, resolve: release } = Promise.withResolvers();
        const { promise: started, resolve: entered } = Promise.withResolvers();
        const createObject = adapter.setObjectNotExistsAsync;
        adapter.setObjectNotExistsAsync = async (id, object) => {
            if (id === 'auth') {
                entered(undefined);
                await blocked;
            }
            await createObject(id, object);
        };
        let reads = 0;
        adapter.getStateAsync = async () => { reads++; return null; };
        const admin = new CloudAdmin(adapter);
        admins.push(admin);
        const restoring = admin.restoreTokens();
        await started;
        let drained = false;
        const unloading = admin.destroy().then(() => { drained = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false);
        release(undefined);
        await Promise.all([restoring, unloading]);
        assert.equal(drained, true);
        assert.equal(states.size, 0);
        assert.equal(reads, 0);
        assert.deepEqual(warnings, []);
    });

    it('allows explicit login to replace corrupt state and binds it to the new native login', async () => {
        states.set('auth.tokens', { val: 'broken', ack: true });
        const admin = await restore();
        adapter.updateConfig = async patch => { Object.assign(adapter.config, patch); };
        const fresh = { ...tokens, refreshToken: 'new-login', expiresAt: 999999 };
        await admin.account.saveTokens(fresh, 'new@example.test');
        const next = await restore();
        assert.deepEqual(next.account.tokens, fresh);
        assert.equal(adapter.config.cloudEmail, 'new@example.test');
        assert.deepEqual(states.get('info.cloudTokenExpiresAt'), { val: fresh.expiresAt, ack: true });
    });
});
