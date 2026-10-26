const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const EventEmitter = require('node:events');
const path = require('node:path');

function harness(config) {
    let callbacks = { ready: async () => {}, stateChange: (_id, _state) => {}, unload: callback => callback() };
    let transport;
    const transports = [];
    const objects = new Map();
    for (const object of require('../io-package.json').instanceObjects) {
        objects.set(object._id, object);
    }
    const writes = [];
    const controls = [];
    const adapter = {
        config, namespace: 'philips-air.0',
        log: { info() {}, debug() {}, warn() {}, error() {} },
        subscribeStates() {},
        async setStateAsync(id, val, ack) {
            if (id !== 'info.connection') assert.ok(objects.has(id), `object missing: ${id}`);
            writes.push({ id, val, ack });
        },
        setState() { return Promise.resolve(); },
        async setObjectNotExistsAsync(id, object) { objects.set(id, object); },
        async getObjectAsync(id) { return objects.get(id); },
        async extendObjectAsync(id, object) {
            const old = objects.get(id);
            objects.set(id, { ...old, ...object,
                common: { ...old?.common, ...object.common,
                    ...(object.common.states ? { states: { ...old?.common?.states, ...object.common.states } } : {}),
                },
                native: { ...old?.native, ...object.native },
            });
        },
    };
    class Transport extends EventEmitter {
        constructor(_host, options) { super(); transport = this; this.device = options.cloudDevice; transports.push(this); }
        async control(settings) { controls.push({ device: this.device?.id, settings }); }
        destroy() { this.stopped = true; }
    }
    class Admin {
        constructor() { this.account = { tokens: config.cloudRefreshToken ? { refreshToken: config.cloudRefreshToken } : undefined, listDevices: async () => config.devices || [{ id: 'synthetic-device', ctn: 'AC0651' }] }; }
        async restoreTokens() {}
        destroy() { return config.accountStopped; }
    }
    const entry = { exports: (_options) => {} };
    const customRequire = name => {
        if (name === '@iobroker/adapter-core') return { Adapter(options) { callbacks = options; return adapter; } };
        if (name === './lib/cloudAdmin') return Admin;
        if (name === './lib/cloudDevices') {
            const helper = { exports: {} };
            vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/cloudDevices.js'), 'utf8'), {
                require: dependency => dependency === './cloud' ? Transport : dependency === './mapping' ? require('../lib/mapping') : require(dependency),
                module: helper, Set, Map, Promise, Object, Buffer,
            });
            return helper.exports;
        }
        if (['./lib/http', './lib/coap', './lib/cloud'].includes(name)) return Transport;
        return require(path.resolve(__dirname, '..', name));
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), {
        require: customRequire, module: entry, Set, Map, Promise, Object, Date, Buffer,
    });
    entry.exports({});
    return { adapter, callbacks, objects, writes, controls, transports, transport: () => transport };
}

describe('main - cloud integration preserves local contracts', () => {
    it('does not finish unload before account persistence completes', async () => {
        let finish = () => {};
        const accountStopped = new Promise(resolve => { finish = () => resolve(undefined); });
        const h = harness({ protocol: 'cloud', accountStopped });
        await h.callbacks.ready();
        let stopped = false;
        h.callbacks.unload(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        finish();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, true);
    });
    it('creates only shared infrastructure and device-scoped objects in cloud mode', async () => {
        for (const cloudRefreshToken of ['', 'synthetic-refresh']) {
            const h = harness({ protocol: 'cloud', cloudRefreshToken });
            await h.callbacks.ready();
            for (const id of ['control', 'filter', 'status', 'device', 'unknownStates', 'info.key']) {
                assert.equal(h.objects.has(id), false, `${id} is local-only`);
            }
            assert.ok(h.objects.has('info.connection'));
        }
    });
    it('extends cloud profile metadata while preserving user settings and existing ACLs', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        h.objects.set('devices.synthetic-device.control.mode', { type: 'state', common: {
            name: 'My mode', custom: { history: { enabled: true } },
        }, native: { retained: true }, acl: { owner: 'system.user.admin' } });
        await h.callbacks.ready();
        h.transport().emit('mapping', require('../lib/mapping').createCloudMapping('AC1715/11').mapping);
        h.transport().emit('status', { mode: 'speed2' }, new Set(['mode']));
        await new Promise(resolve => setImmediate(resolve));
        const object = h.objects.get('devices.synthetic-device.control.mode');
        assert.equal(object.common.name, 'My mode');
        assert.ok(object.common.custom.history.enabled);
        assert.ok(object.native.retained);
        assert.equal(object.acl.owner, 'system.user.admin');
        assert.deepEqual(Object.keys(object.common.states).sort(), ['auto', 'sleep', 'speed1', 'speed2', 'turbo']);
        assert.ok(h.writes.some(w => w.id === 'devices.synthetic-device.control.mode' && w.val === 'speed2'));
    });
    it('does not require a cloud host and writes observed states after their objects', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh', model: 'Generic' });
        await h.callbacks.ready();
        h.transport().emit('mapping', require('../lib/mapping').createCloudMapping('AC0651').mapping);
        h.transport().emit('capabilities', ['resetPreFilter']);
        h.transport().emit('status', { power: false, pm25: 0 }, new Set(['power', 'pm25']));
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(h.writes.some(w => w.id === 'devices.synthetic-device.control.power' && w.val === false && w.ack === true));
        assert.ok(h.writes.some(w => w.id === 'devices.synthetic-device.status.pm25' && w.val === 0 && w.ack === true));
        assert.equal(h.objects.get('devices.synthetic-device.control.resetPreFilter').common.read, false);
    });

    it('only explicit unacknowledged TRUE reset events reach the transport', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        await h.callbacks.ready();
        h.transport().emit('mapping', require('../lib/mapping').createCloudMapping('AC0651').mapping);
        h.transport().emit('capabilities', ['resetPreFilter']);
        await new Promise(resolve => setImmediate(resolve));
        for (const state of [{ val: false, ack: false }, { val: true, ack: true }, { val: 'true', ack: false }]) {
            h.callbacks.stateChange('philips-air.0.devices.synthetic-device.control.resetPreFilter', state);
        }
        assert.equal(h.controls.length, 0);
        h.callbacks.stateChange('philips-air.0.devices.synthetic-device.control.resetPreFilter', { val: true, ack: false });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.controls.length, 1);
        assert.ok(h.writes.some(w => w.id.endsWith('resetPreFilter') && w.ack === true));
    });

    it('acknowledges reset only after successful transport completion', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        await h.callbacks.ready();
        h.transport().emit('capabilities', ['resetPreFilter']);
        await new Promise(resolve => setImmediate(resolve));
        h.transport().control = async () => { throw new Error('synthetic failure'); };
        h.callbacks.stateChange('philips-air.0.devices.synthetic-device.control.resetPreFilter', { val: true, ack: false });
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(!h.writes.some(w => w.id.endsWith('resetPreFilter')));
    });

    it('isolates two profiles, observations, controls and connection indicators', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh', devices: [
            { id: 'first', ctn: 'AC0651' }, { id: 'second', ctn: 'AC1715/11' },
        ] });
        await h.callbacks.ready();
        assert.equal(h.transports.length, 2);
        const [first, second] = h.transports;
        first.emit('status', { mode: 'gentle', pm25: 2 }, new Set(['mode', 'pm25']));
        second.emit('status', { mode: 'speed2', pm25: 30 }, new Set(['mode', 'pm25']));
        first.emit('connected', true);
        second.emit('connected', true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.objects.get('devices.first').type, 'device');
        assert.ok(h.objects.get('devices.first.control.mode').common.states.gentle);
        assert.ok(h.objects.get('devices.second.control.mode').common.states.speed2);
        h.callbacks.stateChange('philips-air.0.devices.second.control.mode', { val: 'sleep', ack: false });
        h.callbacks.stateChange('philips-air.0.devices.missing.control.mode', { val: 'sleep', ack: false });
        h.callbacks.stateChange('philips-air.0.control.mode', { val: 'sleep', ack: false });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(JSON.parse(JSON.stringify(h.controls)), [{ device: 'second', settings: { mode: 'sleep' } }]);
        assert.ok(h.writes.some(w => w.id === 'devices.first.status.pm25' && w.val === 2));
        assert.ok(h.writes.some(w => w.id === 'devices.second.status.pm25' && w.val === 30));
        first.emit('connected', false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.writes.filter(w => w.id === 'info.connection').at(-1).val, true);
        assert.equal(h.writes.filter(w => w.id === 'devices.first.info.connection').at(-1).val, false);
        await new Promise(resolve => h.callbacks.unload(resolve));
        assert.ok(h.transports.every(transport => transport.stopped));
        assert.equal(h.writes.filter(w => w.id === 'devices.second.info.connection').at(-1).val, false);
    });

    it('serializes delayed connection updates so disconnect remains the final state', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        await h.callbacks.ready();
        const original = h.adapter.getObjectAsync;
        let release = () => {};
        const wait = new Promise(resolve => release = () => resolve(undefined));
        h.adapter.getObjectAsync = async id => {
            if (id === 'devices.synthetic-device.info.connection') await wait;
            return original(id);
        };
        h.transport().emit('mapping', require('../lib/mapping').createCloudMapping('AC0651').mapping);
        h.transport().emit('connected', true);
        await new Promise(resolve => setImmediate(resolve));
        h.transport().emit('connected', false);
        release();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.writes.filter(w => w.id === 'devices.synthetic-device.info.connection').at(-1).val, false);
        assert.equal(h.writes.filter(w => w.id === 'info.connection').at(-1).val, false);
    });

    it('does not initialize cloud after unload during the first startup write', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        const initialObjects = h.objects.size;
        const write = h.adapter.setStateAsync;
        let release = () => {};
        const wait = new Promise(resolve => release = () => resolve(undefined));
        h.adapter.setStateAsync = async (id, value, ack) => {
            await wait;
            return write(id, value, ack);
        };
        const started = h.callbacks.ready();
        await new Promise(resolve => h.callbacks.unload(resolve));
        release();
        await started;
        assert.equal(h.transports.length, 0);
        assert.equal(h.objects.size, initialObjects);
    });

    it('drains startup object creation before unload and avoids missing connection writes', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        const create = h.adapter.setObjectNotExistsAsync;
        let release = () => {};
        const wait = new Promise(resolve => release = () => resolve(undefined));
        h.adapter.setObjectNotExistsAsync = async (id, object) => {
            if (id === 'devices.synthetic-device') await wait;
            return create(id, object);
        };
        const started = h.callbacks.ready();
        await new Promise(resolve => setImmediate(resolve));
        let stopped = false;
        const unloaded = new Promise(resolve => h.callbacks.unload(() => { stopped = true; resolve(undefined); }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        release();
        await Promise.all([started, unloaded]);
        assert.equal(h.transports.length, 0);
        assert.ok(!h.writes.some(w => w.id === 'devices.synthetic-device.info.connection'));
    });

    it('encodes arbitrary IDs without path injection or collisions with safe IDs', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh', devices: [
            { id: 'a.b', ctn: 'OTHER' }, { id: 'a_b', ctn: 'OTHER' },
            { id: '_hash_reserved', ctn: 'OTHER' }, { id: 'a.b', ctn: 'OTHER' },
        ] });
        await h.callbacks.ready();
        const roots = [...h.objects].filter(([, object]) => object.type === 'device').map(([id]) => id);
        assert.equal(roots.length, 3);
        assert.ok(roots.every(id => /^devices\.[A-Za-z0-9_-]+$/.test(id)));
        assert.ok(roots.includes('devices.a_b'));
        assert.equal(h.transports.length, 3);
    });

    it('waits for login without discovery or reconnect loops', async () => {
        const h = harness({ protocol: 'cloud' });
        await h.callbacks.ready();
        assert.equal(h.transports.length, 0);
    });

    for (const protocol of ['http', 'coap']) {
        it(`${protocol} still requires a host and retains the selected model`, async () => {
            const missing = harness({ protocol, model: 'CX3550' });
            await missing.callbacks.ready();
            assert.equal(missing.transport(), undefined);
            const h = harness({ protocol, host: 'synthetic.invalid', model: 'CX3550' });
            await h.callbacks.ready();
            for (const id of ['control', 'filter', 'status', 'device', 'unknownStates', 'info.key']) {
                assert.ok(h.objects.has(id), `${protocol} needs ${id}`);
            }
            h.callbacks.stateChange('philips-air.0.control.oscillation', { val: true, ack: false });
            assert.equal(h.controls.length, 1);
            h.transport().emit('status', { oscillation: true }, new Set(['oscillation']));
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(h.writes.some(w => w.id === 'control.oscillation' && w.ack === true));
        });
    }

    it('does not write late observations after unload', async () => {
        const h = harness({ protocol: 'cloud', cloudRefreshToken: 'synthetic-refresh' });
        await h.callbacks.ready();
        const transport = h.transport();
        await new Promise(resolve => h.callbacks.unload(resolve));
        const count = h.writes.length;
        transport.emit('status', { pm25: 10 }, new Set(['pm25']));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.writes.length, count);
    });
});
