const { expect } = require('chai');
const coap = require('coap');
const AirPurifier = require('../lib/coap');
const { createMapping } = require('../lib/mapping');

// Build an instance without running the constructor (which would start networking).
function makeInstance(clientKey = 'AABBCCDD') {
    const inst = Object.create(AirPurifier.prototype);
    inst.clientKey = clientKey;
    inst.deviceIp = '127.0.0.1';
    inst.emit = () => {};
    // The constructor normally builds these from createMapping(this.adapter.config.model); tests that
    // bypass the constructor need them set explicitly (default to the classic AC2889 mapping).
    const m = createMapping('AC2889');
    inst.renameReported = m.renameReported;
    inst.buildControlPayload = m.buildControlPayload;
    return inst;
}

describe('coap - encryption', () => {
    it('encryptPayload output can be decrypted back to the original payload', async () => {
        const inst = makeInstance();
        const payload = { state: { desired: { om: '1', pwr: '1', CommandType: 'app' } } };

        const encrypted = await inst.encryptPayload(payload);
        expect(encrypted).to.be.a('string');

        const decrypted = await inst.decryptPayload(Buffer.from(encrypted));
        expect(JSON.parse(decrypted)).to.deep.equal(payload);
    });

    it('decryptPayload rejects a tampered (corrupted) message', async () => {
        const inst = makeInstance();
        const encrypted = await inst.encryptPayload({ a: 1 });
        // flip a character in the encrypted body to break the digest
        const tampered = `${encrypted.slice(0, 12)}${encrypted[12] === '0' ? '1' : '0'}${encrypted.slice(13)}`;
        expect(() => inst.decryptPayload(Buffer.from(tampered))).to.throw(/corrupted/i);
    });

    it('decryptPayload ignores trailing null bytes from CoAP payload buffers', async () => {
        const inst = makeInstance();
        const encrypted = await inst.encryptPayload({ a: 1 });

        const decrypted = await inst.decryptPayload(Buffer.from(`${encrypted}\0\0`, 'utf8'));
        expect(JSON.parse(decrypted)).to.deep.equal({ a: 1 });
    });

    it('decryptPayload rejects a non-hex / too-short payload with a clear error', () => {
        const inst = makeInstance();
        // Garbage that is not hex, and a hex string shorter than counter+body+digest (72 chars): both
        // must be rejected up front with a clear error instead of being fed into the cipher.
        expect(() => inst.decryptPayload(Buffer.from('not-hex-garbage'))).to.throw(/Unexpected encrypted payload/i);
        expect(() => inst.decryptPayload(Buffer.from('AABB'))).to.throw(/Unexpected encrypted payload/i);
    });

    it('updateClientKey increments the key as an 8-char uppercase hex counter', () => {
        const inst = makeInstance('0000000F');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('00000010');
    });

    it('updateClientKey handles keys with the high bit set (unsigned 32-bit)', () => {
        const inst = makeInstance('AABBCCDD');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('AABBCCDE');
    });

    it('updateClientKey wraps around at 0xFFFFFFFF', () => {
        const inst = makeInstance('FFFFFFFF');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('00000000');
    });
});

describe('coap - connection handling', () => {
    it('markConnected marks the session usable and arms the watchdog', () => {
        const inst = makeInstance();
        const cleared = [];
        const emitted = [];
        let watchdogCallback;
        inst.connected = false;
        inst._failedAttempts = 2;
        inst.staleTimeout = 120000;
        inst.reconnectTimeout = 'reconnect-timer';
        inst.pingTimeout = 'ping-timer';
        inst.adapter = {
            clearTimeout: timer => cleared.push(timer),
            setTimeout: callback => {
                watchdogCallback = callback;
                return 'watchdog-timer';
            },
        };
        inst.emit = (event, payload) => emitted.push([event, payload]);

        inst._markConnected('Connected');

        expect(inst.connected).to.equal(true);
        expect(inst._failedAttempts).to.equal(0);
        expect(inst.pingTimeout).to.equal('watchdog-timer');
        expect(watchdogCallback).to.be.a('function');
        expect(cleared).to.deep.equal(['reconnect-timer', 'ping-timer']);
        expect(emitted).to.deep.equal([
            ['connected', true],
            ['info', 'Connected'],
        ]);
    });

    it('markConnected stays silent and arms no timer once the instance was destroyed', () => {
        const inst = makeInstance();
        const emitted = [];
        inst.connected = false;
        inst.destroyed = true;
        inst.staleTimeout = 120000;
        inst.pingTimeout = null;
        inst.adapter = {
            clearTimeout: () => {},
            setTimeout: () => {
                throw new Error('must not arm a watchdog timer after destroy');
            },
        };
        inst.emit = (event, payload) => emitted.push([event, payload]);

        inst._markConnected('Connected');

        expect(inst.connected).to.equal(false);
        expect(inst.pingTimeout).to.equal(null);
        expect(emitted).to.deep.equal([]);
    });

    it('keeps a quiet observe subscription open instead of rejecting on subscribe timeout', async () => {
        const inst = makeInstance();
        const originalRequest = coap.request;
        const cleared = [];
        const emitted = [];
        let subscribeTimerCallback;
        let requestEnded = false;
        const fakeRequest = {
            on() {
                return this;
            },
            end() {
                requestEnded = true;
            },
        };
        inst.connected = false;
        inst.subscribeTimeout = 30000;
        inst.staleTimeout = 120000;
        inst.adapter = {
            clearTimeout: timer => cleared.push(timer),
            setTimeout: callback => {
                if (!subscribeTimerCallback) {
                    subscribeTimerCallback = callback;
                    return 'subscribe-timer';
                }
                return 'watchdog-timer';
            },
        };
        inst.emit = (event, payload) => emitted.push([event, payload]);
        // The stub only implements what _subscribeOnStatus() uses, not the full coap OutgoingMessage.
        coap.request = /** @type {any} */ (() => fakeRequest);

        try {
            const subscribe = inst._subscribeOnStatus();
            expect(requestEnded).to.equal(true);
            /** @type {any} */ (subscribeTimerCallback)();
            await subscribe;
        } finally {
            coap.request = originalRequest;
        }

        expect(inst.connected).to.equal(true);
        expect(inst._statusRequest).to.equal(fakeRequest);
        expect(cleared).to.include('subscribe-timer');
        expect(emitted).to.deep.include(['connected', true]);
    });
});

describe('coap - quiet observe stream (#377)', () => {
    // A CX7550/01 sent a single status frame in 4.6 hours while answering every /sys/dev/sync probe:
    // silence alone must not tear the session down.
    function makeWatchdogInstance() {
        const inst = makeInstance();
        inst.connected = true;
        inst.staleTimeout = 600000;
        inst.pingTimeout = 'old-ping-timer';
        inst.reconnectTimeout = null;
        inst.emitted = [];
        inst.emit = (event, payload) => inst.emitted.push([event, payload]);
        inst.adapter = {
            clearTimeout: () => {},
            setTimeout: () => 'watchdog-timer',
        };
        inst._reconnect = () => {
            inst.reconnected = true;
        };
        inst.subscribes = 0;
        inst._subscribeOnStatus = async () => {
            inst.subscribes++;
        };
        return inst;
    }

    it('keeps the session and renews the subscription when the device answers the probe', async () => {
        const inst = makeWatchdogInstance();
        let probes = 0;
        inst.sync = async () => {
            probes++;
        };

        await inst._checkAlive();

        expect(probes).to.equal(1);
        expect(inst.reconnected).to.equal(undefined);
        expect(inst.connected).to.equal(true);
        expect(inst.pingTimeout).to.equal('watchdog-timer');
        // The observe registration must be renewed - a silently expired one would otherwise never
        // deliver data again, which a full reconnect used to fix as a side effect.
        expect(inst.subscribes).to.equal(1);
        // A quiet but healthy device must not produce a single info line.
        expect(inst.emitted.filter(([event]) => event !== 'debug')).to.deep.equal([]);
    });

    it('reconnects when the subscription cannot be renewed', async () => {
        const inst = makeWatchdogInstance();
        inst.sync = async () => {};
        inst._subscribeOnStatus = async () => {
            throw new Error('no response');
        };

        await inst._checkAlive();

        expect(inst.reconnected).to.equal(true);
    });

    it('reconnects when the device does not answer the probe', async () => {
        const inst = makeWatchdogInstance();
        inst.sync = async () => {
            throw new Error('timeout');
        };

        await inst._checkAlive();

        expect(inst.reconnected).to.equal(true);
    });

    it('does not probe or reconnect after destroy', async () => {
        const inst = makeWatchdogInstance();
        inst.destroyed = true;
        let probes = 0;
        inst.sync = async () => {
            probes++;
        };

        await inst._checkAlive();

        expect(probes).to.equal(0);
        expect(inst.reconnected).to.equal(undefined);
    });
});

describe('coap - reconnect backoff (#377)', () => {
    // A switched-off device used to log one error line per reconnectInterval, forever.
    async function failingReconnects(attempts) {
        const inst = makeInstance();
        const delays = [];
        const emitted = [];
        inst.connected = false;
        inst.reconnectInterval = 30000;
        inst.aliveTimeout = 30000;
        inst.emit = (event, payload) => emitted.push([event, payload]);
        inst.adapter = {
            clearTimeout: () => {},
            setTimeout: (callback, delay) => {
                delays.push(delay);
                return 'retry-timer';
            },
        };
        inst.sync = async () => {
            throw new Error('EHOSTUNREACH');
        };
        for (let i = 0; i < attempts; i++) {
            await inst._reconnect();
        }
        // Every attempt schedules twice: the fixed pre-attempt timer and the backed-off retry.
        return { retries: delays.filter((_, i) => i % 2 === 1), emitted };
    }

    it('doubles the retry delay per failed attempt and caps it', async () => {
        const { retries } = await failingReconnects(6);

        expect(retries).to.deep.equal([30000, 60000, 120000, 120000, 120000, 120000]);
    });

    it('reports the first attempts as errors and keeps the endless repetitions in debug', async () => {
        const { emitted } = await failingReconnects(6);
        const levels = emitted.filter(([, text]) => /failed \(attempt/.test(text)).map(([event]) => event);

        expect(levels).to.deep.equal(['error', 'error', 'error', 'debug', 'debug', 'debug']);
    });
});

describe('coap - renameAttributes', () => {
    function rename(reported) {
        const inst = makeInstance();
        const status = { state: { reported } };
        inst.renameAttributes(status);
        return status.state.reported;
    }

    it('keeps numeric and boolean values native instead of stringifying them', () => {
        const r = rename({ pm25: 7, aqil: 50, Runtime: 123456, fltsts1: 1804 });
        expect(r.pm25).to.equal(7);
        expect(r.lightBrightness).to.equal(50);
        expect(r.uptime).to.equal(123456);
        expect(r.hepaFilterReplaceInHours).to.equal(1804);
    });

    it('maps option values (power, childLock, mode, fanSpeed)', () => {
        const r = rename({ pwr: '1', cl: 0, mode: 'M', om: 'a' });
        expect(r.power).to.equal(true);
        expect(r.childLock).to.equal(false);
        expect(r.mode).to.equal('manual');
        expect(r.fanSpeed).to.equal('auto');
    });

    it('maps known error codes and keeps unknown ones numeric', () => {
        expect(rename({ err: 0 }).error).to.equal('none');
        expect(rename({ err: 193 }).error).to.equal('pre-filter must be cleaned');
        expect(rename({ err: 0x8000 }).error).to.equal('water tank open');
        expect(rename({ err: 12345 }).error).to.equal(12345);
    });
});
