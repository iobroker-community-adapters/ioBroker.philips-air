'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { createMapping, channelOf, stateCommon } = require('./lib/mapping');
const adapterName = require('./package.json').name.split('.').pop();

/**
 * The adapter instance
 *
 */
let adapter;
let airPurifier;
// The selected purifier class (CoAP or HTTP) is loaded lazily in main() depending on the
// configured protocol, so a missing optional `philips-air` dependency cannot crash CoAP users.
let PurifierClass;
// The active (STANDARD + model) mapping, built once in main() from adapter.config.model. Set before
// any 'status' event can fire, so updateStatus() always sees a valid mapping.
let activeMapping;
// All friendly state names the active mapping can produce, built alongside activeMapping. Used by
// updateStatus() to tell genuinely unknown raw device attributes (-> unknownStates.*) apart from
// attributes renameReported() already renamed to a friendly name (-> known, handled above).
let knownNames;
// Raw attribute keys we already logged once as "unknown" this adapter run, so a device that keeps
// reporting the same unmapped D-code does not spam the log on every status frame.
const loggedUnknownKeys = new Set();

/**
 * Starts the adapter instance
 *
 * @param [options] adapter options passed through to the ioBroker adapter
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return (adapter = utils.Adapter(
        Object.assign({}, options, {
            name: adapterName,

            // The ready callback is called when databases are connected and adapter received configuration.
            // start here!
            ready: main, // Main method defined below for readability

            // is called when adapter shuts down - callback has to be called under any circumstances!
            unload: callback => {
                try {
                    adapter.setState('info.connection', false, true);
                    airPurifier && airPurifier.destroy();
                    airPurifier = null;
                    callback();
                } catch {
                    callback();
                }
            },

            // If you need to react to object changes, uncomment the following method.
            // You also need to subscribe to the objects with `adapter.subscribeObjects`, similar to `adapter.subscribeStates`.
            // objectChange: (id, obj) => {
            //     if (obj) {
            //         // The object was changed
            //         adapter.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
            //     } else {
            //         // The object was deleted
            //         adapter.log.info(`object ${id} deleted`);
            //     }
            // },

            // is called if a subscribed state changes
            stateChange: (id, state) => {
                adapter.log.debug(`State change: ${JSON.stringify(state)}`);
                if (state && !state.ack && id.startsWith(`${adapter.namespace}.control.`)) {
                    const name = id.substring(`${adapter.namespace}.control.`.length);
                    const settings =
                        name === 'function'
                            ? { function: state.val ? 'humidification' : 'purification' }
                            : { [name]: state.val };
                    try {
                        const result = airPurifier && airPurifier.control(settings);
                        // control() returns a promise - catch async failures too, otherwise a failed
                        // command produces an unhandled rejection that crashes the adapter.
                        if (result && typeof result.catch === 'function') {
                            result.catch(err =>
                                adapter.log.warn(
                                    `Could not control ${name}: ${err && err.message ? err.message : err}`,
                                ),
                            );
                        }
                    } catch (err) {
                        adapter.log.warn(`Could not control ${name}: ${err.message}`);
                    }
                }
            },
        }),
    ));
}

// Device states are created on demand from the mapping (io-package.json only defines the adapter's
// own infrastructure). Ids already ensured this run are cached so we touch the object DB only once.
const ensuredObjects = new Set();

/**
 * Create the state object once (from a mapping-derived common block) if it does not exist yet, then
 * write the value.
 *
 * @param id the state id (e.g. "status.pm25")
 * @param common the ioBroker object `common` block
 * @param value the value to write (always acknowledged)
 */
async function setDeviceState(id, common, value) {
    if (!ensuredObjects.has(id)) {
        await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        ensuredObjects.add(id);
    }
    await adapter.setStateAsync(id, value, true);
}

/**
 * Coerce a value to the state's declared type so js-controller never rejects a typed state when a
 * device reports a value outside our known option set (e.g. an unmapped numeric fan/purifier mode
 * for a string-typed control). Only string and boolean are forced; numbers pass through unchanged.
 *
 * @param value the value about to be written
 * @param type the ioBroker `common.type` of the target state
 * @returns the value coerced to match `type`
 */
function coerceToType(value, type) {
    if (value === null || value === undefined) {
        return value;
    }
    if (type === 'string' && typeof value !== 'string') {
        return String(value);
    }
    if (type === 'boolean' && typeof value !== 'boolean') {
        return Boolean(value);
    }
    return value;
}

async function updateStatus(status) {
    for (const attr of Object.keys(activeMapping)) {
        const item = activeMapping[attr];
        if (!Object.prototype.hasOwnProperty.call(status, item.name)) {
            continue;
        }
        const channel = channelOf(item);

        // The 'function' state is presented as a humidification on/off switch, not the raw text.
        if (item.name === 'function') {
            await setDeviceState(
                'control.function',
                { name: 'function', type: 'boolean', role: 'switch', read: true, write: true },
                status.function === 'humidification',
            );
            continue;
        }

        // Uptime additionally drives a derived "started" timestamp.
        if (item.name === 'uptime') {
            await setDeviceState('device.uptime', stateCommon(item), status.uptime);
            const date = new Date();
            date.setMilliseconds(date.getMilliseconds() - status.uptime);
            await setDeviceState(
                'device.started',
                { name: 'started', type: 'string', role: 'value.time', read: true, write: false },
                date.toISOString(),
            );
            continue;
        }

        // The error code drives a derived maintenance indicator. Known codes are mapped to a text by
        // renameAttributes; unknown codes stay numeric. Only a known, non-'none' error means real
        // maintenance is required - some models (e.g. AC2889) constantly report an undocumented code
        // (193) while perfectly healthy, which must not raise a false maintenance flag.
        if (item.name === 'error') {
            const isKnownError = typeof status.error === 'string';
            await setDeviceState(
                'device.error',
                stateCommon(item),
                isKnownError ? status.error : `unknown (${status.error})`,
            );
            await setDeviceState(
                'device.maintenance',
                { name: 'maintenance', type: 'boolean', role: 'indicator.maintenance', read: true, write: false },
                isKnownError && status.error !== 'none',
            );
            continue;
        }

        const common = stateCommon(item);
        await setDeviceState(`${channel}.${item.name}`, common, coerceToType(status[item.name], common.type));
    }

    await updateUnknownStates(status);
}

/**
 * Infer an ioBroker state type from a raw JS value for a genuinely unmapped device attribute.
 *
 * @param value the raw value reported by the device
 * @returns `{ type, value }` - the inferred type and the value coerced to match it
 */
function inferUnknownType(value) {
    if (typeof value === 'number') {
        return { type: 'number', value };
    }
    if (typeof value === 'boolean') {
        return { type: 'boolean', value };
    }
    if (value !== null && typeof value === 'object') {
        // Arrays/objects have no native ioBroker state type - stringify so the value is not lost.
        return { type: 'string', value: JSON.stringify(value) };
    }
    return { type: 'string', value: value === null || value === undefined ? '' : String(value) };
}

/**
 * Catch raw device attributes that renameReported() left untouched because no mapping entry claims
 * them (renameReported only renames/deletes keys it recognizes, so unmapped raw keys survive into
 * updateStatus unchanged). These are genuinely unknown attributes - write them read-only under
 * `unknownStates.<rawKey>` and log each new raw key once so a user can report it for onboarding.
 *
 * @param status the (partially renamed) status object as received by updateStatus
 */
async function updateUnknownStates(status) {
    for (const rawKey of Object.keys(status)) {
        // 'key' is a potential HTTP client secret, never renamed on purpose - never surface it either.
        if (rawKey === 'key' || knownNames.has(rawKey)) {
            continue;
        }
        if (!loggedUnknownKeys.has(rawKey)) {
            loggedUnknownKeys.add(rawKey);
            adapter.log.info(
                `Unknown raw device attribute "${rawKey}" (value: ${JSON.stringify(status[rawKey])}) - ` +
                    `exposed read-only as unknownStates.${rawKey}. Please report this to the adapter developer.`,
            );
        }
        const { type, value } = inferUnknownType(status[rawKey]);
        await setDeviceState(
            `unknownStates.${rawKey}`,
            {
                name: rawKey,
                type,
                role: type === 'boolean' ? 'indicator' : type === 'number' ? 'value' : 'text',
                read: true,
                write: false,
            },
            value,
        );
    }
}

async function main() {
    // Reset the connection indicator during startup
    await adapter.setStateAsync('info.connection', false, true);

    if (!adapter.config.host) {
        return adapter.log.warn('No IP defined');
    }

    // Build the active (STANDARD + model) mapping before anything can trigger a 'status' event.
    activeMapping = createMapping(adapter.config.model).mapping;
    knownNames = new Set(Object.values(activeMapping).map(item => item.name));

    // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
    adapter.subscribeStates('control.*');
    adapter.log.debug(`start with ${adapter.config.host} ${JSON.stringify(adapter.config)}`);

    // Load only the protocol implementation that is actually used.
    try {
        PurifierClass = adapter.config.protocol === 'http' ? require('./lib/http') : require('./lib/coap');
    } catch (err) {
        return adapter.log.error(`Cannot load protocol "${adapter.config.protocol}": ${err.message}`);
    }

    adapter.log.info(
        `Connecting to ${adapter.config.host} using ${adapter.config.protocol === 'http' ? 'HTTP' : 'CoAP'} protocol`,
    );
    airPurifier = new PurifierClass(adapter.config.host, adapter.config, adapter);
    adapter.log.debug('started');

    airPurifier.on('connected', connected => {
        adapter.log.debug(connected ? 'connected' : 'disconnected');
        adapter.setState('info.connection', connected, true);
    });

    airPurifier.on('status', async status => {
        adapter.log.debug(`STATUS: ${JSON.stringify(status)}`);
        await updateStatus(status);
    });

    airPurifier.on('info', async status => {
        adapter.log.info(status);
    });

    airPurifier.on('debug', async status => {
        adapter.log.debug(status);
    });

    airPurifier.on('warn', async status => {
        adapter.log.warn(status);
    });

    airPurifier.on('error', async status => {
        adapter.log.error(status);
    });
}

if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}
