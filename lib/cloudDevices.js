'use strict';

const { createHash } = require('node:crypto');
const CloudTransport = require('./cloud');
const { createCloudMapping, channelOf, stateCommon } = require('./mapping');

/**
 * Keep arbitrary cloud identifiers out of ioBroker paths; reserve the hash prefix.
 *
 * @param value cloud identifier
 */
function objectKey(value) {
    return /^[A-Za-z0-9_-]{1,80}$/.test(value) && !value.startsWith('_hash_')
        ? value
        : `_hash_${createHash('sha256').update(value, 'utf16le').digest('hex')}`;
}

/** Own all account device sessions, their objects, and command routing. */
class CloudDevices {
    /**
     * @param adapter ioBroker adapter
     * @param account authenticated account shared with Admin
     */
    constructor(adapter, account) {
        this.adapter = adapter;
        this.account = account;
        this.devices = new Map();
        this.stopped = false;
        this.jobs = new Set();
    }

    /**
     * Track asynchronous events so shutdown can drain writes already in progress.
     *
     * @param job pending write
     */
    track(job) {
        this.jobs.add(job);
        job.catch(() => {
            if (!this.stopped) {
                this.adapter.log.warn('Could not update cloud device states');
            }
        }).finally(() => this.jobs.delete(job));
    }

    /** Discover once per startup; each transport owns its independent bounded reconnects. */
    start() {
        this.startup = this.discover();
        return this.startup;
    }

    /** Discover account devices while checking shutdown after each asynchronous step. */
    async discover() {
        if (!this.account.tokens?.refreshToken) {
            this.adapter.log.info('Philips cloud: sign in in the instance settings');
            return;
        }
        try {
            const devices = await this.account.listDevices();
            if (this.stopped) {
                return;
            }
            await this.adapter.setObjectNotExistsAsync('devices', {
                type: 'channel',
                common: { name: 'Cloud devices' },
                native: {},
            });
            this.adapter.subscribeStates('devices.*.control.*');
            for (const device of devices) {
                if (this.stopped) {
                    return;
                }
                const root = `devices.${objectKey(device.id)}`;
                if (this.devices.has(root)) {
                    continue;
                }
                const context = {
                    root,
                    mapping: createCloudMapping(device.ctn).mapping,
                    objects: new Set(),
                    unknown: new Set(),
                    capabilities: new Set(),
                    connected: false,
                    updates: Promise.resolve(),
                    transport: /** @type {CloudTransport|null} */ (null),
                };
                this.devices.set(root, context);
                await this.adapter.setObjectNotExistsAsync(root, {
                    type: 'device',
                    common: { name: device.friendlyName || device.ctn },
                    native: {},
                });
                for (const channel of ['control', 'status', 'device', 'filter', 'unknownStates', 'info']) {
                    if (this.stopped) {
                        return;
                    }
                    await this.adapter.setObjectNotExistsAsync(`${root}.${channel}`, {
                        type: 'channel',
                        common: { name: channel },
                        native: {},
                    });
                }
                await this.connection(context, false);
                if (this.stopped) {
                    return;
                }
                const transport = new CloudTransport(
                    undefined,
                    { cloudAccount: this.account, cloudDevice: device },
                    this.adapter,
                );
                context.transport = transport;
                transport.on('mapping', mapping =>
                    this.enqueue(context, async () => {
                        context.mapping = mapping;
                        context.objects.clear();
                    }),
                );
                transport.on('connected', connected => {
                    context.connected = connected;
                    this.enqueue(context, () => this.connection(context, connected));
                });
                transport.on('capabilities', names => {
                    context.capabilities = new Set(names);
                    this.enqueue(context, () => this.capabilities(context, names));
                });
                transport.on('status', (status, names) =>
                    this.enqueue(context, () => this.status(context, status, names)),
                );
                transport.on('error', () => {
                    if (!this.stopped) {
                        this.adapter.log.warn('Philips cloud device connection/read failed; check account and network');
                    }
                });
            }
        } catch {
            if (!this.stopped) {
                this.adapter.log.warn('Philips cloud device discovery failed; check sign-in and network, then restart');
            }
        }
    }

    /**
     * Serialize device observations so slow object writes cannot restore stale values.
     *
     * @param context device context
     * @param operation next observation
     */
    enqueue(context, operation) {
        const job = context.updates.then(() => {
            if (!this.stopped) {
                return operation();
            }
        });
        context.updates = job.catch(() => {});
        this.track(job);
    }

    /**
     * @param context device context
     * @param connected subscription connectivity
     */
    async connection(context, connected) {
        if (this.stopped) {
            return;
        }
        await this.write(
            context,
            'info.connection',
            {
                name: 'Connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
            },
            connected,
        );
        if (!this.stopped) {
            await this.adapter.setStateAsync(
                'info.connection',
                [...this.devices.values()].some(item => item.connected),
                true,
            );
        }
    }

    /**
     * @param context device context
     * @param id relative state ID
     * @param common state metadata
     */
    async object(context, id, common) {
        if (this.stopped || context.objects.has(id)) {
            return;
        }
        const fullId = `${context.root}.${id}`;
        const old = await this.adapter.getObjectAsync(fullId);
        if (this.stopped) {
            return;
        }
        await this.adapter.extendObjectAsync(fullId, {
            type: 'state',
            common: { ...common, name: old?.common?.name ?? common.name },
            native: {},
        });
        context.objects.add(id);
    }

    /**
     * @param context device context
     * @param id relative state ID
     * @param common metadata
     * @param value observed value
     */
    async write(context, id, common, value) {
        await this.object(context, id, common);
        if (!this.stopped) {
            await this.adapter.setStateAsync(`${context.root}.${id}`, value, true);
        }
    }

    /**
     * @param context device context
     * @param names observed button capabilities
     */
    async capabilities(context, names) {
        for (const name of names) {
            const item = context.mapping[name];
            if (item?.role === 'button') {
                await this.object(context, `control.${name}`, stateCommon(item));
            }
        }
    }

    /**
     * @param context device context
     * @param status reported properties
     * @param names actually renamed properties
     */
    async status(context, status, names) {
        if (this.stopped) {
            return;
        }
        const mapped = names instanceof Set ? names : new Set();
        const written = new Set();
        for (const item of Object.values(context.mapping)) {
            if (!mapped.has(item.name) || !Object.hasOwn(status, item.name) || written.has(item.name)) {
                continue;
            }
            written.add(item.name);
            const common = stateCommon(item);
            let value = status[item.name];
            if (common.type === 'string' && value != null) {
                value = String(value);
            }
            await this.write(context, `${channelOf(item)}.${item.name}`, common, value);
        }
        for (const [key, raw] of Object.entries(status)) {
            if (mapped.has(key) || key === 'key') {
                continue;
            }
            const type = typeof raw === 'number' || typeof raw === 'boolean' ? typeof raw : 'string';
            const value =
                type === 'string'
                    ? raw !== null && typeof raw === 'object'
                        ? JSON.stringify(raw)
                        : String(raw ?? '')
                    : raw;
            await this.write(
                context,
                `unknownStates.${objectKey(key)}`,
                {
                    name: key,
                    type,
                    role: type === 'number' ? 'value' : type === 'boolean' ? 'indicator' : 'text',
                    read: true,
                    write: false,
                },
                value,
            );
            if (!context.unknown.has(key)) {
                context.unknown.add(key);
                this.adapter.log.debug('Unknown cloud device attribute exposed read-only under unknownStates');
            }
        }
    }

    /**
     * @param id full state ID
     * @param state desired state or deletion
     */
    stateChange(id, state) {
        if (this.stopped || !state || state.ack || !id.startsWith(`${this.adapter.namespace}.`)) {
            return;
        }
        const relative = id.slice(this.adapter.namespace.length + 1);
        const match = /^(devices\.[^.]+)\.control\.([^.]+)$/.exec(relative);
        const context = match && this.devices.get(match[1]);
        if (!context || !context.transport || !context.objects.has(`control.${match[2]}`)) {
            return;
        }
        const name = match[2];
        const button = context.mapping[name]?.role === 'button';
        if (button && (state.val !== true || !context.capabilities.has(name))) {
            return;
        }
        this.track(
            Promise.resolve().then(() => {
                if (!this.stopped) {
                    return context.transport.control({ [name]: state.val }).then(() => {
                        if (button && !this.stopped) {
                            return this.adapter.setStateAsync(relative, true, true);
                        }
                    });
                }
            }),
        );
    }

    /**
     * Stop every session and suppress late events.
     *
     * @returns pending state writes
     */
    async destroy() {
        this.stopped = true;
        for (const context of this.devices.values()) {
            context.transport?.destroy();
        }
        await this.startup;
        await Promise.allSettled([...this.jobs]);
        await Promise.allSettled(
            [...this.devices.values()]
                .filter(context => context.objects.has('info.connection'))
                .map(context => this.adapter.setStateAsync(`${context.root}.info.connection`, false, true)),
        );
    }
}

module.exports = CloudDevices;
