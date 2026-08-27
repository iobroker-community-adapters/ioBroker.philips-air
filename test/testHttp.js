const { expect } = require('chai');
const AirPurifier = require('../lib/http');

// Build an instance without running the constructor (which would read states and start networking).
function makeInstance(client) {
    const inst = Object.create(AirPurifier.prototype);
    const emitted = [];
    inst.deviceIp = '127.0.0.1';
    inst.clientKey = '';
    inst.connected = false;
    inst.aliveTimeout = 30000;
    inst.reconnectInterval = 30000;
    inst.client = client;
    inst.emit = (event, payload) => emitted.push([event, payload]);
    inst.buildControlPayload = settings => settings;
    inst.adapter = {
        setTimeout: () => 'ping-timer',
        clearTimeout: () => {},
        setStateAsync: async () => {},
    };
    return { inst, emitted };
}

describe('http - control', () => {
    it('accepts an empty device answer without logging a parse error', async () => {
        // Regression: setValues() returned nothing, so control() ran JSON.parse(undefined) and logged
        // "Cannot parse: undefined" on every single command sent to an HTTP device.
        const { inst, emitted } = makeInstance({
            key: Buffer.alloc(16, 1),
            setValues: async () => '',
        });

        const result = await inst.control({ pwr: '1' });

        expect(result).to.equal('');
        expect(emitted.filter(([event]) => event === 'error')).to.deep.equal([]);
    });

    it('returns the parsed device answer of a control command', async () => {
        const { inst, emitted } = makeInstance({
            key: Buffer.alloc(16, 1),
            setValues: async () => JSON.stringify({ om: 't', pwr: '1' }),
        });

        const result = await inst.control({ om: 't' });

        expect(result).to.deep.equal({ om: 't', pwr: '1' });
        expect(emitted.filter(([event]) => event === 'error')).to.deep.equal([]);
    });

    it('reports a non-empty answer that is not valid JSON', async () => {
        const { inst, emitted } = makeInstance({
            key: Buffer.alloc(16, 1),
            setValues: async () => 'not-json',
        });

        await inst.control({ om: 't' });

        expect(emitted.filter(([event]) => event === 'error')).to.deep.equal([['error', 'Cannot parse: not-json']]);
    });

    it('rejects a control command while the client is not built yet', async () => {
        const { inst } = makeInstance(null);

        let message = '';
        await inst.control({ pwr: '1' }).catch(err => (message = err.message));

        expect(message).to.contain('not connected yet');
    });
});

describe('http - shutdown', () => {
    it('a control answer arriving after destroy does not re-arm the poll timer', async () => {
        const { inst } = makeInstance({
            setValues: async () => JSON.stringify({ pwr: '1' }),
            key: null,
        });
        inst.destroyed = true;
        inst.adapter.setTimeout = () => {
            throw new Error('must not arm a poll timer after destroy');
        };

        const answer = await inst.control({ pwr: '1' });

        expect(answer).to.deep.equal({ pwr: '1' });
        expect(inst.pingTimeout).to.equal(undefined);
    });
});

describe('http - protocol hint', () => {
    // Build a client whose four sync calls succeed while `answers` has entries left and fail with
    // `code` afterwards. sync() asks for status, firmware, filters and wifi in that order.
    function makeSyncClient(answers, code) {
        const reply = async () => {
            if (answers.length) {
                return answers.shift();
            }
            const error = new Error(`socket hang up`);
            // @ts-expect-error - node attaches the system code to the error object
            error.code = code;
            throw error;
        };
        return {
            key: Buffer.alloc(16, 1),
            getStatus: reply,
            getFirmware: reply,
            getFilters: reply,
            getWifi: reply,
        };
    }

    function hints(emitted) {
        return emitted.filter(([event, text]) => event === 'info' && String(text).includes('switching'));
    }

    it('advises CoAP when the very first HTTP connection is reset', async () => {
        const { inst, emitted } = makeInstance(makeSyncClient([], 'ECONNRESET'));
        inst.renameReported = () => {};
        inst.httpProven = false;
        inst._hintShown = false;

        await inst.sync();

        expect(hints(emitted)).to.have.lengthOf(1);
        expect(hints(emitted)[0][1]).to.contain('ECONNRESET');
    });

    it('stays silent about CoAP once the device has answered over HTTP', async () => {
        // Regression for issue #383 (AC3829/10): the device works over HTTP and only drops the
        // socket now and then. Telling that user to switch the protocol sends them down a dead end.
        const { inst, emitted } = makeInstance(makeSyncClient([{ pwr: '1' }, {}, {}, {}], 'ECONNRESET'));
        inst.renameReported = () => {};
        inst.httpProven = false;
        inst._hintShown = false;

        await inst.sync();
        expect(inst.httpProven).to.equal(true);

        await inst.sync();

        expect(hints(emitted)).to.deep.equal([]);
        // The failure itself is still reported - only the misleading advice is gone.
        expect(emitted.filter(([event]) => event === 'error')).to.have.lengthOf(1);
    });

    it('emits the hint only once while the device never answers', async () => {
        const { inst, emitted } = makeInstance(makeSyncClient([], 'ECONNREFUSED'));
        inst.renameReported = () => {};
        inst.httpProven = false;
        inst._hintShown = false;

        await inst.sync();
        await inst.sync();

        expect(hints(emitted)).to.have.lengthOf(1);
    });
});
