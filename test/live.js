'use strict';

// Standalone live test against a real Philips device - it does NOT touch any ioBroker installation.
// Usage:
//   node test/live.js <device-ip> [coap|http]
// Example:
//   node test/live.js 192.168.1.50 coap
//
// It wires the real adapter protocol class (lib/coap.js or lib/http.js) to a tiny in-memory mock
// adapter and prints every connection/status/error event. Stop with Ctrl+C.

const ip = process.argv[2];
const protocol = (process.argv[3] || 'coap').toLowerCase();

if (!ip || !['coap', 'http'].includes(protocol)) {
    console.error('Usage: node test/live.js <device-ip> [coap|http]');
    process.exit(1);
}

// In-memory replacement for the persisted `info.key` state used by the HTTP protocol.
const states = {};

const config = { host: ip, protocol, aliveTimeout: 30000, reconnectInterval: 30000 };

const mockAdapter = {
    namespace: 'philips-air.0',
    config,
    log: {
        debug: msg => console.log('  [debug]', msg),
        info: msg => console.log('  [info ]', msg),
        warn: msg => console.log('  [warn ]', msg),
        error: msg => console.log('  [error]', msg),
    },
    getState: (id, cb) => cb(null, Object.prototype.hasOwnProperty.call(states, id) ? { val: states[id] } : null),
    setStateAsync: async (id, val) => {
        states[id] = val;
    },
};

const Purifier = protocol === 'http' ? require('../lib/http') : require('../lib/coap');

console.log(`Connecting to ${ip} via ${protocol.toUpperCase()} ... (Ctrl+C to stop)\n`);

const device = new Purifier(ip, config, mockAdapter);

device.on('connected', connected => console.log(connected ? '\n✅ CONNECTED\n' : '\n❌ DISCONNECTED\n'));
device.on('status', status => console.log('📊 STATUS:', JSON.stringify(status)));
device.on('info', msg => console.log('ℹ️ ', msg));
device.on('debug', msg => console.log('  [debug]', msg));
device.on('error', err => console.log('🛑 ERROR:', err && err.message ? err.message : err));

process.on('SIGINT', () => {
    console.log('\nStopping ...');
    try {
        device.destroy && device.destroy();
    } catch {
        // ignore
    }
    process.exit(0);
});
