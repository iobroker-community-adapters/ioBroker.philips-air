const EventEmitter = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { createCloudMapping } = require('./mapping');
const { CloudError } = require('./cloudAccount');

/** DA IoT MQTT transport for already paired devices. */
class CloudTransport extends EventEmitter {
    /**
     * @param _host unused by cloud
     * @param options transport options, injected account and optional MQTT factory
     * @param adapter adapter timers
     */
    constructor(_host, options, adapter) {
        super();
        this.adapter = adapter;
        this.options = options;
        this.account = options.cloudAccount;
        this.powerSupported = false;
        this.shadowVersion = -1;
        this.mapping = createCloudMapping('');
        this.connected = false;
        this.destroyed = false;
        this.attempts = 0;
        /** @type {import('mqtt').MqttClient|null} */
        this.client = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.retryTimer = null;
        /** @type {ReturnType<typeof setTimeout>|null} */
        this.connectTimer = null;
        /** @type {Map<string, {resolve: (value: object) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>, cn: string, port: string}>} */
        this.pending = new Map();
        /** @type {Map<ReturnType<typeof setTimeout>, (error: Error) => void>} */
        this.publishing = new Map();
        this.ports = {};
        this.shadow = '';
        this.inbound = '';
        this.outbound = '';
        // Allow lifecycle/error listeners to be attached before the first asynchronous failure.
        Promise.resolve().then(() => this.connect());
    }

    /** Open a new session with a newly acquired token/signature pair. */
    async connect() {
        if (this.destroyed) {
            return;
        }
        try {
            if (this.destroyed) {
                return;
            }
            const device = this.options.cloudDevice;
            if (!device) {
                throw new Error('Discovered cloud device is missing');
            }
            this.mapping = createCloudMapping(device.ctn);
            this.emit('mapping', this.mapping.mapping);
            if (typeof device.thingName !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(device.thingName)) {
                throw new Error('Cloud device has an invalid MQTT thing name');
            }
            const info = await this.account.getConnectionInfo();
            if (this.destroyed) {
                return;
            }
            this.shadow = `$aws/things/${device.thingName}/shadow`;
            this.inbound = `${info.tenant}_ctrl/${device.thingName}/from_ncp`;
            this.outbound = `${info.tenant}_ctrl/${device.thingName}/to_ncp`;
            const factory = this.options.mqttConnect || require('mqtt').connect;
            const client = factory(info.brokerUrl, {
                clientId: `${info.userId}_${randomUUID()}`,
                clean: true,
                reconnectPeriod: 0,
                queueQoSZero: false,
                connectTimeout: 10000,
                keepalive: 30,
                wsOptions: {
                    headers: {
                        'x-amz-customauthorizer-name': 'CustomAuthorizer',
                        'x-amz-customauthorizer-signature': info.signature,
                        'token-header': `Bearer ${info.accessToken}`,
                        tenant: info.tenant,
                        'content-type': 'application/json',
                    },
                },
            });
            this.client = client;
            const current = () => !this.destroyed && this.client === client;
            this.connectTimer = this.adapter.setTimeout(() => {
                if (current()) {
                    this.disconnect('Cloud MQTT connection/subscription timed out');
                }
            }, 15000);
            client.on('error', () => current() && this.disconnect('Cloud MQTT connection failed'));
            client.on('close', () => current() && this.disconnect('Cloud MQTT disconnected'));
            client.on('message', (topic, body) => current() && this.message(topic, body));
            client.on('connect', () => {
                if (!current()) {
                    return;
                }
                const topics = [
                    this.inbound,
                    ...['get', 'update'].flatMap(operation =>
                        ['accepted', 'rejected'].map(result => `${this.shadow}/${operation}/${result}`),
                    ),
                ];
                client.subscribe(topics, { qos: 0 }, (error, grants) => {
                    if (!current()) {
                        return;
                    }
                    if (error || !grants || grants.length !== topics.length || grants.some(item => item.qos > 2)) {
                        this.disconnect('Cloud MQTT subscription rejected');
                        return;
                    }
                    this.adapter.clearTimeout(this.connectTimer);
                    this.connectTimer = null;
                    this.connected = true;
                    this.attempts = 0;
                    this.emit('connected', true);
                    this.refresh();
                });
            });
        } catch (error) {
            if (!this.destroyed) {
                this.disconnect(
                    error instanceof CloudError
                        ? error.message
                        : 'Cloud account/device connection failed; check authentication and discovered devices',
                );
            }
        }
    }

    /** Read reported state after connecting; desired state is never reported as observed. */
    refresh() {
        this.publish(`${this.shadow}/get`, {}).catch(() => {
            if (!this.destroyed) {
                this.emit('error', 'Cloud shadow read failed');
            }
        });
        for (const port of ['Config', 'Status', 'devRd', 'filtRd']) {
            this.command('getPort', port).catch(() => {
                if (!this.destroyed) {
                    this.emit('error', `Cloud ${port} read failed`);
                }
            });
        }
    }

    /**
     * @param topic MQTT topic
     * @param body UTF-8 payload
     */
    message(topic, body) {
        let payload;
        try {
            if (body.length > 262144) {
                return;
            }
            payload = JSON.parse(body.toString('utf8'));
        } catch {
            this.emit('error', 'Malformed cloud MQTT JSON');
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return;
        }
        if (topic === this.inbound) {
            const key = typeof payload.cid === 'string' ? payload.cid.toLowerCase() : '';
            const pending = this.pending.get(key);
            if (pending && ['response', 'error'].includes(payload.type)) {
                if (payload.cn !== pending.cn || (payload.data?.portName && payload.data.portName !== pending.port)) {
                    return;
                }
                this.pending.delete(key);
                this.adapter.clearTimeout(pending.timer);
                if (
                    payload.type === 'response' &&
                    payload.status === 0 &&
                    (pending.cn !== 'getPort' ||
                        (payload.data?.portName === pending.port &&
                            payload.data?.properties &&
                            typeof payload.data.properties === 'object' &&
                            !Array.isArray(payload.data.properties)))
                ) {
                    if (pending.cn === 'getPort') {
                        this.port(payload.data);
                    }
                    pending.resolve(payload);
                } else {
                    pending.reject(new Error(payload.status === 1 ? 'Cloud device busy' : 'Cloud command rejected'));
                }
            } else if (payload.type === 'event' && payload.cn === 'updatePort') {
                this.port(payload.data);
            }
        } else if ([`${this.shadow}/get/accepted`, `${this.shadow}/update/accepted`].includes(topic)) {
            if (Number.isSafeInteger(payload.version) && payload.version >= 0) {
                if (payload.version < this.shadowVersion) {
                    return;
                }
                this.shadowVersion = payload.version;
            }
            if (typeof payload.state?.reported?.powerOn === 'boolean') {
                this.powerSupported = true;
                this.report({ powerOn: payload.state.reported.powerOn });
            }
        } else if (topic.endsWith('/rejected')) {
            this.emit('error', 'Cloud shadow request rejected');
        }
    }

    /**
     * Merge independently observed ports; accept only scalar properties.
     *
     * @param data port envelope
     */
    port(data) {
        if (
            !data ||
            !['Config', 'Status', 'devRd', 'filtRd'].includes(data.portName) ||
            !data.properties ||
            typeof data.properties !== 'object' ||
            Array.isArray(data.properties)
        ) {
            return;
        }
        const properties = {};
        for (const [key, value] of Object.entries(data.properties)) {
            const numeric = /^D[0-9A-F]{5}$/.test(key);
            const text = /^D[0-9A-F]{2}S[0-9A-F]{2}$/.test(key);
            if (
                (!numeric && !text) ||
                (numeric && (typeof value !== 'number' || !Number.isInteger(value))) ||
                (text && typeof value !== 'string')
            ) {
                continue;
            }
            // Known register families belong to distinct ports; never merge an injected cross-port value.
            const family = key.slice(1, 3);
            if (
                (family === '01' && !['Config', 'devRd'].includes(data.portName)) ||
                (family === '03' && data.portName !== 'Status') ||
                (family === '05' && data.portName !== 'filtRd')
            ) {
                continue;
            }
            const options = this.mapping.mapping[key]?.options;
            if (
                options &&
                Object.values(options).every(option => typeof option === 'boolean') &&
                !Object.hasOwn(options, value)
            ) {
                continue;
            }
            properties[key] = value;
        }
        this.ports[data.portName] = { ...this.ports[data.portName], ...properties };
        if (data.portName === 'filtRd') {
            for (const [name, totalKey, remainingKey] of [
                ['preFilterPercent', 'D05207', 'D0520D'],
                ['hepaFilterPercent', 'D05408', 'D0540E'],
            ]) {
                const total = this.ports.filtRd[totalKey];
                const remaining = this.ports.filtRd[remainingKey];
                if (
                    Number.isInteger(total) &&
                    total > 0 &&
                    total !== 65535 &&
                    Number.isInteger(remaining) &&
                    remaining >= 0 &&
                    remaining <= total &&
                    remaining !== 65535
                ) {
                    properties[name] = Math.ceil((100 * remaining) / total);
                }
            }
        }
        if (data.portName === 'filtRd') {
            const filters = this.ports.filtRd;
            const resets = [
                ['resetPreFilter', 'D05207', 'D0520D'],
                ['resetHepaFilter', 'D05408', 'D0540E'],
            ].filter(
                ([, totalKey, remainingKey]) =>
                    Number.isInteger(filters[totalKey]) &&
                    filters[totalKey] > 0 &&
                    filters[totalKey] < 65535 &&
                    Number.isInteger(filters[remainingKey]) &&
                    filters[remainingKey] >= 0 &&
                    filters[remainingKey] <= filters[totalKey],
            );
            this.emit(
                'capabilities',
                resets.map(([name]) => name),
            );
        }
        this.report(properties);
    }

    /**
     * @param properties observed raw properties
     */
    report(properties) {
        const renamed = this.mapping.renameReported(properties);
        this.emit('status', properties, renamed);
    }

    /**
     * @param topic target topic
     * @param payload JSON object
     * @returns publish acknowledgement, without claiming a physical effect
     */
    publish(topic, payload) {
        return new Promise((resolve, reject) => {
            if (!this.connected || !this.client || this.destroyed) {
                reject(new Error('Cloud is not connected'));
                return;
            }
            const timer = this.adapter.setTimeout(() => {
                this.publishing.delete(timer);
                reject(new Error('Cloud publish timed out; command outcome unknown'));
            }, 10000);
            this.publishing.set(timer, reject);
            const done = error => {
                if (!this.publishing.delete(timer)) {
                    return;
                }
                this.adapter.clearTimeout(timer);
                error ? reject(new Error('Cloud publish failed')) : resolve(undefined);
            };
            try {
                this.client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, done);
            } catch {
                done(new Error('Cloud publish failed'));
            }
        });
    }

    /**
     * @param cn NCP command name
     * @param port port name
     * @param {object} [properties] optional command properties
     * @returns correlated NCP response; timed-out writes are never replayed
     */
    command(cn, port, properties = undefined) {
        if (!this.connected || this.destroyed) {
            return Promise.reject(new Error('Cloud is not connected'));
        }
        let cid;
        do {
            cid = randomBytes(4).readUInt32LE().toString(16);
        } while (this.pending.has(cid));
        return new Promise((resolve, reject) => {
            const timer = this.adapter.setTimeout(() => {
                this.pending.delete(cid);
                reject(new Error('Cloud response timed out; command outcome unknown'));
            }, 30000);
            this.pending.set(cid, { resolve, reject, timer, cn, port });
            this.publish(this.outbound, {
                cid,
                time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                type: 'command',
                cn,
                ct: 'mobile',
                data: properties === undefined ? { portName: port } : { portName: port, properties },
            }).catch(() => {
                const pending = this.pending.get(cid);
                if (pending) {
                    this.pending.delete(cid);
                    this.adapter.clearTimeout(timer);
                    reject(new Error('Cloud publish failed; command outcome unknown'));
                }
            });
        });
    }

    /**
     * @param settings friendly control values
     */
    async control(settings) {
        const keys = Object.keys(settings);
        if (keys.length !== 1) {
            throw new Error('Cloud commands require exactly one setting');
        }
        const name = keys[0];
        if (name === 'power') {
            if (!this.powerSupported) {
                throw new Error('Cloud power needs an observed reported powerOn boolean');
            }
            if (typeof settings.power !== 'boolean') {
                throw new Error('Power requires a boolean');
            }
            await this.publish(`${this.shadow}/update`, { state: { desired: { powerOn: settings.power } } });
            await this.publish(`${this.shadow}/get`, {});
            return;
        }
        if (['resetPreFilter', 'resetHepaFilter'].includes(name)) {
            if (settings[name] !== true) {
                throw new Error('Filter reset requires true');
            }
            // Obtain a fresh device total for each reset rather than relying on a default or old session.
            delete this.ports.filtRd;
            await this.command('getPort', 'filtRd');
            const cleaning = name === 'resetPreFilter';
            const total = this.ports.filtRd?.[cleaning ? 'D05207' : 'D05408'];
            const remaining = this.ports.filtRd?.[cleaning ? 'D0520D' : 'D0540E'];
            if (
                !Number.isInteger(total) ||
                total <= 0 ||
                total >= 65535 ||
                !Number.isInteger(remaining) ||
                remaining < 0 ||
                remaining > total
            ) {
                throw new Error('Filter reset needs a valid observed total');
            }
            await this.command('setPort', 'filtWr', { [cleaning ? 'D0520D' : 'D0540E']: total });
            await this.command('getPort', 'filtRd');
            return;
        }
        const properties = this.mapping.buildControlPayload(settings);
        const rawKeys = Object.keys(properties);
        if (!rawKeys.length || rawKeys.some(key => !Object.hasOwn(this.ports.Status || {}, key))) {
            throw new Error('Cloud control needs a supported observed Status property');
        }
        await this.command('setPort', 'Control', properties);
        await this.command('getPort', 'Status');
    }

    /**
     * End the old session before bounded retries; never retain queued commands.
     *
     * @param reason sanitized diagnostic
     */
    disconnect(reason) {
        const client = this.client;
        this.client = null;
        client?.end(true);
        this.adapter.clearTimeout(this.connectTimer);
        this.connectTimer = null;
        if (this.connected) {
            this.connected = false;
            this.emit('connected', false);
        }
        this.ports = {};
        this.powerSupported = false;
        this.shadowVersion = -1;
        this.emit('capabilities', []);
        for (const [timer, reject] of this.publishing) {
            this.adapter.clearTimeout(timer);
            reject(new Error('Cloud disconnected; command outcome unknown'));
        }
        this.publishing.clear();
        for (const pending of this.pending.values()) {
            this.adapter.clearTimeout(pending.timer);
            pending.reject(new Error('Cloud disconnected; command outcome unknown'));
        }
        this.pending.clear();
        if (this.destroyed || this.retryTimer) {
            return;
        }
        this.emit('error', reason);
        if (this.attempts >= 5) {
            this.emit('error', 'Cloud reconnect attempts exhausted; restart after checking account/network');
            return;
        }
        this.retryTimer = this.adapter.setTimeout(
            () => {
                this.retryTimer = null;
                this.connect();
            },
            Math.trunc(1000 * 1.5 ** ++this.attempts),
        );
    }

    /** @returns current MQTT subscription connectivity */
    getConnected() {
        return this.connected;
    }

    /** Stop sessions, command promises and reconnect timers. Account lifetime belongs to the adapter. */
    destroy() {
        this.destroyed = true;
        this.adapter.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.disconnect('Cloud stopped');
    }
}

module.exports = CloudTransport;
