const { expect } = require('chai');
const EventEmitter = require('node:events');
const path = require('node:path');

// main.js is loaded with a fake adapter-core and a fake CoAP transport, so stateChange() and the
// 'status' event can be driven directly and the confirmation timer can be fired by hand.
let lastPurifier;
class FakePurifier extends EventEmitter {
    constructor() {
        super();
        lastPurifier = this;
        this.controlResult = () => Promise.resolve({ status: 'success' });
    }
    control(settings) {
        this.lastSettings = settings;
        return this.controlResult(settings);
    }
    destroy() {}
}

let adapterOptions;
function createFakeAdapter() {
    const adapter = {
        namespace: 'philips-air.0',
        config: { host: '127.0.0.1', model: 'AC2889', protocol: 'coap' },
        warnings: [],
        timers: new Map(),
        nextTimer: 1,
        log: {
            debug: () => {},
            info: () => {},
            error: () => {},
            warn: msg => adapter.warnings.push(msg),
        },
        setTimeout: (fn, ms) => {
            const handle = adapter.nextTimer++;
            adapter.timers.set(handle, { fn, ms });
            return handle;
        },
        clearTimeout: handle => adapter.timers.delete(handle),
        setState: () => Promise.resolve(),
        setStateAsync: () => Promise.resolve(),
        setObjectNotExistsAsync: () => Promise.resolve(),
        subscribeStates: () => {},
    };
    return adapter;
}

function stub(modulePath, exports) {
    const resolved = require.resolve(modulePath);
    const previous = require.cache[resolved];
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return () => {
        if (previous) {
            require.cache[resolved] = previous;
        } else {
            delete require.cache[resolved];
        }
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('control confirmation (GitHub #414)', () => {
    let restore;
    let startAdapter;
    let adapter;

    before(() => {
        const restoreCore = stub('@iobroker/adapter-core', {
            Adapter: options => {
                adapterOptions = options;
                return Object.assign(createFakeAdapter(), options);
            },
        });
        const restoreCoap = stub(path.join(__dirname, '../lib/coap.js'), FakePurifier);
        const mainPath = require.resolve('../main.js');
        delete require.cache[mainPath];
        startAdapter = require('../main.js');
        restore = () => {
            delete require.cache[mainPath];
            restoreCoap();
            restoreCore();
        };
    });

    after(() => restore());

    beforeEach(async () => {
        adapter = startAdapter();
        await adapterOptions.ready();
    });

    afterEach(done => {
        adapterOptions.unload(() => done());
    });

    function write(name, val) {
        adapterOptions.stateChange(`philips-air.0.control.${name}`, { val, ack: false });
    }

    function report(status) {
        lastPurifier.emit('status', status, new Set(Object.keys(status)));
        return flush();
    }

    function fireTimers() {
        const timers = [...adapter.timers.values()];
        adapter.timers.clear();
        timers.forEach(timer => timer.fn());
    }

    it('cancels the timer without a warning when the frame matches', async () => {
        write('childLock', true);
        await flush();
        expect(adapter.timers.size).to.equal(1);
        expect([...adapter.timers.values()][0].ms).to.equal(10000);
        await report({ childLock: true });
        expect(adapter.timers.size).to.equal(0);
        fireTimers();
        expect(adapter.warnings).to.deep.equal([]);
    });

    it('confirms control.function from the reported text', async () => {
        write('function', true);
        await flush();
        expect(lastPurifier.lastSettings).to.deep.equal({ function: 'humidification' });
        await report({ function: 'humidification' });
        expect(adapter.timers.size).to.equal(0);
        expect(adapter.warnings).to.deep.equal([]);
    });

    it('does not warn on a mismatch followed by a match', async () => {
        write('childLock', true);
        await flush();
        await report({ childLock: false });
        expect(adapter.timers.size).to.equal(1);
        await report({ childLock: true });
        expect(adapter.timers.size).to.equal(0);
        expect(adapter.warnings).to.deep.equal([]);
    });

    it('warns with the reported value when the value still differs at the timeout', async () => {
        write('childLock', true);
        await flush();
        await report({ childLock: false });
        fireTimers();
        expect(adapter.warnings).to.deep.equal([
            'Device accepted childLock=true but did not apply it (reports false)',
        ]);
    });

    it('warns when no status frame arrives at all', async () => {
        write('childLock', true);
        await flush();
        fireTimers();
        expect(adapter.warnings).to.deep.equal([
            'No status update from the device within 10s after writing childLock; the command may have been ignored',
        ]);
    });

    it('replaces the pending entry on a new write to the same state', async () => {
        write('childLock', true);
        await flush();
        write('childLock', false);
        await flush();
        expect(adapter.timers.size).to.equal(1);
        await report({ childLock: false });
        expect(adapter.timers.size).to.equal(0);
        expect(adapter.warnings).to.deep.equal([]);
    });

    it('does not wait for a confirmation when the command fails', async () => {
        lastPurifier.controlResult = () => Promise.resolve({ status: 'failed' });
        write('childLock', true);
        await flush();
        expect(adapter.timers.size).to.equal(0);
        expect(adapter.warnings).to.have.length(1);
        expect(adapter.warnings[0]).to.match(/^Could not control childLock/);
    });

    it('clears pending timers on unload', async () => {
        write('childLock', true);
        await flush();
        await new Promise(resolve => adapterOptions.unload(resolve));
        expect(adapter.timers.size).to.equal(0);
    });
});
