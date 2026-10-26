const { expect } = require('chai');
const EventEmitter = require('node:events');
const Cloud = require('../lib/cloud');

const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(ctn = 'AC0651/10', observedPower = true) {
    const timers = new Map();
    const clients = [];
    const account = {
        calls: 0,
        listDevices: async () => { throw new Error('Transport must reuse discovered device'); },
        async getConnectionInfo() {
            this.calls++;
            return { accessToken: 'synthetic-token', signature: `signature-${this.calls}`, userId: 'user',
                brokerUrl: 'wss://example.invalid/mqtt', tenant: 'da' };
        },
    };
    const options = { cloudAccount: account, cloudDevice: { id: 'device-id', thingName: 'real-thing', ctn }, mqttConnect: (_url, opts) => {
        const client = new EventEmitter();
        Object.assign(client, {
            opts, topics: [], sent: /** @type {any[]} */ ([]), ended: false,
            subscribe(topics, _options, done) { this.topics = topics; done(null, topics.map(topic => ({ topic, qos: 0 }))); },
            publish(topic, body, options, done) { this.sent.push({ topic, payload: JSON.parse(body), options }); done(); },
            end(force) { this.ended = force; },
        });
        clients.push(client);
        return client;
    } };
    const adapter = {
        setTimeout(callback, delay) { const id = /** @type {any} */ ({}); timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
    const cloud = new Cloud('', options, adapter);
    const errors = [];
    const statuses = [];
    cloud.on('error', error => errors.push(error));
    cloud.on('status', status => statuses.push(status));
    await flush();
    const client = /** @type {any} */ (clients[0]);
    client.emit('connect');
    await flush();
    function answer(request, properties = {}, status = 0) {
        client.emit('message', cloud.inbound, Buffer.from(JSON.stringify({ cid: request.payload.cid.toUpperCase(),
            type: 'response', cn: request.payload.cn, status,
            data: { portName: request.payload.data.portName, properties } })));
    }
    for (const request of client.sent.filter(item => item.payload.cn === 'getPort')) {
        answer(request, request.payload.data.portName === 'Status' ? { D0310C: 0 } : {});
    }
    await flush();
    client.sent.length = 0;
    if (observedPower) {
        client.emit('message', `${cloud.shadow}/get/accepted`, Buffer.from('{"state":{"reported":{"powerOn":false}}}'));
        statuses.length = 0;
    }
    return { cloud, client, clients, account, timers, errors, statuses, answer };
}

describe('Cloud DA IoT transport (synthetic)', () => {
    it('enables the shared standby control only for a valid reported flag', async () => {
        const f = await fixture('OTHER/10');
        expect(await f.cloud.control({ standbyMonitor: true }).catch(error => error.message)).to.include('observed Status');
        f.cloud.port({ portName: 'Status', properties: { D03134: 2 } });
        expect(f.cloud.ports.Status).not.to.have.property('D03134');
        f.cloud.port({ portName: 'Status', properties: { D03134: 0 } });
        expect(f.statuses.at(-1)).to.deep.equal({ standbyMonitor: false });
        const control = f.cloud.control({ standbyMonitor: true });
        await flush();
        expect(f.client.sent[0].payload.data.properties).to.deep.equal({ D03134: 1 });
        f.answer(f.client.sent[0]);
        await flush();
        f.answer(f.client.sent[1], { D03134: 1 });
        await control;
        f.cloud.destroy();
    });
    it('allows shared cloud controls only after observed capabilities', async () => {
        const f = await fixture('OTHER/10', false);
        expect(f.cloud.connected).to.equal(true);
        const unsupported = await f.cloud.control({ power: true }).catch(error => error.message);
        expect(unsupported).to.include('observed reported powerOn');
        f.client.emit('message', `${f.cloud.shadow}/get/accepted`, Buffer.from('{"state":{"reported":{"powerOn":false}}}'));
        expect(f.statuses.at(-1)).to.deep.equal({ power: false });
        await f.cloud.control({ power: true });
        expect(f.client.sent[0].payload).to.deep.equal({ state: { desired: { powerOn: true } } });
        f.client.sent.length = 0;
        f.cloud.ports.Status = {};
        const unsupportedMode = await f.cloud.control({ mode: 'auto' }).catch(error => error.message);
        expect(unsupportedMode).to.include('observed Status');
        f.cloud.port({ portName: 'Status', properties: { D0310C: 0 } });
        const mode = f.cloud.control({ mode: 'sleep' });
        await flush();
        expect(f.client.sent[0].payload.data.properties).to.deep.equal({ D0310C: 17 });
        f.answer(f.client.sent[0]);
        await flush();
        f.answer(f.client.sent[1], { D0310C: 17 });
        await mode;
        f.cloud.disconnect('synthetic disconnect');
        expect(f.cloud.powerSupported).to.equal(false);
        f.cloud.destroy();
    });

    it('uses selected thing identity, fresh signed headers and all five subscriptions', async () => {
        const f = await fixture();
        expect(f.client.opts.wsOptions.headers['x-amz-customauthorizer-signature']).to.equal('signature-1');
        expect(f.client.opts.reconnectPeriod).to.equal(0);
        expect(f.client.topics).to.have.length(5);
        expect(f.cloud.outbound).to.equal('da_ctrl/real-thing/to_ncp');
        expect(f.cloud.connected).to.equal(true);
        f.cloud.destroy();
        expect(f.client.ended).to.equal(true);
        expect(f.timers.size).to.equal(0);
    });

    it('keeps desired power separate from observed shadow power', async () => {
        const f = await fixture();
        await f.cloud.control({ power: true });
        expect(f.client.sent[0].payload).to.deep.equal({ state: { desired: { powerOn: true } } });
        expect(f.statuses.flatMap(Object.keys)).not.to.include('power');
        f.client.emit('message', `${f.cloud.shadow}/update/accepted`, Buffer.from('{"state":{"desired":{"powerOn":true}}}'));
        expect(f.statuses.flatMap(Object.keys)).not.to.include('power');
        f.client.emit('message', `${f.cloud.shadow}/get/accepted`, Buffer.from('{"state":{"reported":{"powerOn":false}}}'));
        expect(f.statuses.at(-1)).to.deep.equal({ power: false });
        f.cloud.destroy();
    });

    it('ignores shadow reports older than the latest accepted version', async () => {
        const f = await fixture();
        for (const [operation, version, powerOn] of [['update', 11, true], ['get', 10, false], ['get', 12, false]]) {
            f.client.emit('message', `${f.cloud.shadow}/${operation}/accepted`,
                Buffer.from(JSON.stringify({ version, state: { reported: { powerOn } } })));
        }
        expect(f.statuses).to.deep.equal([{ power: true }, { power: false }]);
        f.cloud.destroy();
    });

    it('correlates NCP writes and reads back without optimistic status updates', async () => {
        const f = await fixture();
        const command = f.cloud.control({ mode: 'sleep' });
        await flush();
        const request = f.client.sent[0];
        expect(request.payload.data).to.deep.equal({ portName: 'Control', properties: { D0310C: 17 } });
        expect(request.payload.time).to.match(/^\d{4}-.*:\d{2}Z$/);
        expect(request.options).to.deep.equal({ qos: 1, retain: false });
        f.answer(request);
        await flush();
        expect(f.client.sent[1].payload.data.portName).to.equal('Status');
        f.answer(f.client.sent[1], { D0310C: 17 });
        await command;
        expect(f.statuses.at(-1).mode).to.equal('sleep');
        f.cloud.destroy();
    });

    it('merges partial filter reports and resets only from freshly read totals', async () => {
        const f = await fixture();
        f.cloud.port({ portName: 'filtRd', properties: { D05207: 400, D0520D: 100 } });
        f.cloud.port({ portName: 'filtRd', properties: { D0520D: 80 } });
        expect(f.statuses.at(-1).preFilterPercent).to.equal(20);
        const reset = f.cloud.control({ resetPreFilter: true });
        await flush();
        f.answer(f.client.sent[0], { D05207: 600, D0520D: 80 });
        await flush();
        expect(f.client.sent[1].payload.data).to.deep.equal({ portName: 'filtWr', properties: { D0520D: 600 } });
        f.answer(f.client.sent[1]);
        await flush();
        f.answer(f.client.sent[2], { D0520D: 600 });
        await reset;
        expect(f.statuses.at(-1).preFilterPercent).to.equal(100);
        f.cloud.destroy();
    });

    it('announces reset buttons only for observed valid filter pairs and clears them on disconnect', async () => {
        const f = await fixture('OTHER/10');
        const capabilities = [];
        f.cloud.on('capabilities', names => capabilities.push(names));
        f.cloud.port({ portName: 'filtRd', properties: { D05207: 400 } });
        expect(capabilities.at(-1)).to.deep.equal([]);
        f.cloud.port({ portName: 'filtRd', properties: { D0520D: 100 } });
        expect(capabilities.at(-1)).to.deep.equal(['resetPreFilter']);
        f.cloud.port({ portName: 'filtRd', properties: { D05408: 800, D0540E: 600 } });
        expect(capabilities.at(-1)).to.deep.equal(['resetPreFilter', 'resetHepaFilter']);
        f.cloud.disconnect('synthetic disconnect');
        expect(capabilities.at(-1)).to.deep.equal([]);
        f.cloud.destroy();
    });

    it('rejects filter reset when the fresh read has no valid total', async () => {
        const f = await fixture();
        f.cloud.port({ portName: 'filtRd', properties: { D05207: 400 } });
        const result = f.cloud.control({ resetPreFilter: true }).then(() => 'ok', error => error.message);
        await flush();
        f.answer(f.client.sent[0], { D0520D: 1 });
        expect(await result).to.include('valid observed total');
        expect(f.client.sent).to.have.length(1);
        f.cloud.destroy();
    });

    it('rejects busy and timed out commands without replaying writes', async () => {
        const f = await fixture();
        const busy = f.cloud.command('setPort', 'Control', { D0310C: 0 }).catch(error => error.message);
        f.answer(f.client.sent[0], {}, 1);
        expect(await busy).to.include('busy');
        const timeout = f.cloud.command('setPort', 'Control', { D0310C: 17 }).catch(error => error.message);
        const timer = [...f.timers.values()].find(value => value.delay === 30000);
        timer.callback();
        expect(await timeout).to.include('outcome unknown');
        expect(f.client.sent).to.have.length(2);
        f.cloud.destroy();
    });

    it('rejects malformed reports and preserves unknown scalar diagnostics', async () => {
        const f = await fixture();
        f.cloud.port({ portName: 'Status', properties: { D03221: 'bad', D0312C: 4, evil: { token: 'secret' } } });
        expect(f.statuses.at(-1)).to.deep.equal({ D0312C: 4 });
        f.cloud.message(f.cloud.inbound, Buffer.from('{malformed'));
        expect(f.errors).to.include('Malformed cloud MQTT JSON');
        f.cloud.destroy();
    });

    it('ignores late connect callbacks after unload', async () => {
        const f = await fixture();
        f.cloud.destroy();
        let subscriptions = 0;
        f.client.subscribe = () => subscriptions++;
        f.client.emit('connect');
        expect(subscriptions).to.equal(0);
        expect(f.cloud.connected).to.equal(false);
    });

    it('forwards only D-code properties from their owning ports, keeping secrets private', async () => {
        const f = await fixture();
        f.cloud.port({ portName: 'Config', properties: {
            accessToken: 'secret', localCredentials: 'secret', powerOn: true,
            D0310C: 17, D05207: 400, D01S03: 'Air purifier',
        } });
        expect(f.statuses.at(-1)).to.deep.equal({ D01S03: 'Air purifier' });
        f.cloud.port({ portName: 'Status', properties: { powerOn: true, resetPreFilter: true,
            D05207: 300, D01S03: 'injected', D0310C: 17 } });
        expect(f.statuses.at(-1)).to.deep.equal({ mode: 'sleep' });
        f.cloud.port({ portName: 'filtRd', properties: { D0310C: 18, D05207: 100, D0520D: 101 } });
        expect(f.statuses.at(-1)).to.deep.equal({ preFilterTotal: 100, preFilterRemaining: 101 });
        expect(f.cloud.ports.filtRd.D0310C).to.equal(undefined);
        f.cloud.destroy();
    });

    it('times out a stalled broker publish and stops its owned timers on unload', async () => {
        const f = await fixture();
        f.client.publish = () => {};
        const result = f.cloud.control({ power: true }).catch(error => error.message);
        const timer = [...f.timers.values()].find(value => value.delay === 10000);
        timer.callback();
        expect(await result).to.include('outcome unknown');
        f.cloud.destroy();
    });

    it('does not accept unrelated or malformed NCP responses as a successful read', async () => {
        const f = await fixture();
        const result = f.cloud.command('getPort', 'Status').catch(error => error.message);
        const request = f.client.sent[0];
        f.client.emit('message', f.cloud.inbound, Buffer.from(JSON.stringify({
            cid: request.payload.cid, type: 'response', cn: 'getPort', status: 0,
        })));
        expect(await result).to.include('rejected');
        expect(f.statuses.flatMap(Object.keys)).not.to.include('mode');
        f.cloud.destroy();
    });

    it('cleans pending commands and refreshes credentials before reconnect', async () => {
        const f = await fixture();
        const result = f.cloud.command('setPort', 'Control', { D0310C: 0 }).catch(error => error.message);
        f.client.emit('close');
        expect(await result).to.include('outcome unknown');
        expect(f.client.ended).to.equal(true);
        const timer = [...f.timers.values()].find(value => value.delay === 1500);
        timer.callback();
        await flush();
        expect(f.account.calls).to.equal(2);
        expect(/** @type {any} */ (f.clients[1]).opts.wsOptions.headers['x-amz-customauthorizer-signature']).to.equal('signature-2');
        expect(f.cloud.pending.size).to.equal(0);
        f.cloud.destroy();
    });
});
