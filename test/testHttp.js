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
