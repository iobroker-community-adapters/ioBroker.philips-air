const path = require('path');
const { tests } = require('@iobroker/testing');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite, it }) {
        suite('Cloud configuration without account/device traffic', getHarness => {
            it('starts without a host and preserves encrypted native fields after shutdown', async () => {
                const harness = getHarness();
                await harness.changeAdapterConfig('philips-air', {
                    common: { loglevel: 'debug' },
                    native: {
                        protocol: 'cloud', host: '',
                        cloudAccessToken: '', cloudRefreshToken: '', cloudIdToken: '', cloudExpiresAt: 0,
                    },
                });
                assert.equal((await harness.getAdapterConfig())?.native.protocol, 'cloud');
                await harness.startAdapterAndWait();
                // alive is set before ready finishes creating and restoring the authentication states.
                let expiry;
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    expiry = await harness.states.getStateAsync('philips-air.0.info.cloudTokenExpiresAt');
                    if (expiry) {
                        break;
                    }
                    await delay(50);
                }
                assert.ok(expiry, 'Cloud authentication states were not initialized');
                assert.equal((await harness.states.getStateAsync('philips-air.0.info.connection')).val, false);
                const tokenObject = await harness.objects.getObjectAsync('philips-air.0.auth.tokens');
                assert.equal(tokenObject.common.type, 'string');
                assert.equal(tokenObject.common.role, 'json');
                assert.equal(tokenObject.common.write, false);
                assert.equal(tokenObject.acl.owner, 'system.user.admin');
                assert.equal(tokenObject.acl.object, 0x600);
                assert.equal(tokenObject.acl.state, 0x600);
                assert.equal(expiry.val, 0);
                assert.equal(expiry.ack, true);
                await harness.stopAdapter();
                // Store synthetic credentials only after stop, so this isolated test never calls the provider.
                await harness.changeAdapterConfig('philips-air', {
                    native: {
                        cloudAccessToken: 'synthetic-access', cloudRefreshToken: 'synthetic-refresh',
                        cloudIdToken: 'synthetic-id', cloudExpiresAt: 1,
                    },
                });
                const raw = await harness.objects.getObjectAsync('system.adapter.philips-air.0');
                for (const [key, value] of Object.entries({ cloudAccessToken: 'synthetic-access',
                    cloudRefreshToken: 'synthetic-refresh', cloudIdToken: 'synthetic-id' })) {
                    assert.notEqual(raw.native[key], value, `${key} is stored as plaintext`);
                    assert.ok(raw.native[key], `${key} was not saved`);
                }
                const config = await harness.getAdapterConfig();
                assert.equal(config?.native.cloudRefreshToken, 'synthetic-refresh');
                assert.equal(config?.native.protocol, 'cloud');
                assert.equal(config?.native.host, '');
                for (const secret of ['synthetic-access', 'synthetic-refresh', 'synthetic-id']) {
                    assert.equal(harness.hasLog(secret), false, 'native credential leaked to a log');
                }
            }).timeout(60000);
        });
    },
});
