'use strict';

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils           = require('@iobroker/adapter-core');
const adapterName     = require('./package.json').name.split('.').pop();
const AirPurifier     = require('./lib/coap');
const AirHttpPurifier = require('./lib/http');

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;
let airPurifier;

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.Adapter(Object.assign({}, options, {
        name: adapterName,

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: main, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: (callback) => {
            try {
                adapter.setState('info.connection', false, true);
                airPurifier && airPurifier.destroy();
                airPurifier = null;
                callback();
            } catch (e) {
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
                const name = id.substring((`${adapter.namespace}.control.`).length);
                if (name === 'function') {
                    airPurifier && airPurifier.control({function: state.val ? 'humidification' : 'purification'});
                } else {
                    try {
                        airPurifier && airPurifier.control({[name]: state.val});
                    } catch (err) {
                        adapter.log.warn(`Could not control ${name}: ${err.message}`);
                    }
                }
            }
        }
    }));
}

async function updateStatus(status) {
    const MAPPING = adapter.config.protocol === 'http' ? AirHttpPurifier.getMapping() : AirPurifier.getMapping();
    const keys = Object.keys(MAPPING);
    for (let i = 0; i < keys.length; i++) {
        const item = MAPPING[keys[i]];
        if (Object.prototype.hasOwnProperty.call(status, item.name)) {
            if (item.name === 'error') {
                status[item.name] = typeof status[item.name] === 'number' ? status[item.name].toString() : (status[item.name] || '').toString();
            }
            if (item.control) {
                if (item.name === 'function') {
                    await adapter.setStateAsync('control.function', status[item.name] === 'humidification', true);
                } else {
                    await adapter.setStateAsync(`control.${item.name}`, status[item.name], true);
                }
            } else if (item.filter) {
                await adapter.setStateAsync(`filter.${item.name}`, status[item.name], true);
            } else if (item.device) {
                if (item.name === 'function') {
                    await adapter.setStateAsync('device.function', status[item.name] === 'humidification', true);
                } else if (item.name === 'uptime') {
                    await adapter.setStateAsync('device.uptime', status[item.name], true);
                    const date = new Date();
                    date.setMilliseconds(date.getMilliseconds() - status[item.name]);
                    await adapter.setStateAsync('device.started', date.toISOString(), true);
                } else {
                    if (item.name === 'error') {
                        await adapter.setStateAsync(`device.error`, status.error.toString(), true);
                        await adapter.setStateAsync('device.maintenance', status[item.name] !== 'none', true);
                    } else {
                        await adapter.setStateAsync(`device.${item.name}`, status[item.name], true);
                    }
                }
            } else {
                await adapter.setStateAsync(`status.${item.name}`, status[item.name], true);
            }
        }
    }
}

async function main() {
    // Reset the connection indicator during startup
    await adapter.setStateAsync('info.connection', false, true);

    // fix type of overTheAirUpdates
    const overTheAirUpdates = await adapter.getObjectAsync('device.overTheAirUpdates');
    if (overTheAirUpdates.common.type !== 'string') {
        overTheAirUpdates.common.type = 'string';
        await adapter.setObjectAsync('device.overTheAirUpdates', overTheAirUpdates);
    }

    if (!adapter.config.host) {
        return adapter.log.warn('No IP defined');
    }

    // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
    adapter.subscribeStates('control.*');
    adapter.log.debug(`start with ${adapter.config.host} ${JSON.stringify(adapter.config)}`);
    airPurifier = new (adapter.config.protocol === 'http' ? AirHttpPurifier : AirPurifier)(adapter.config.host, adapter.config, adapter);
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

    airPurifier.on('error', async status => {
        adapter.log.error(status);
    });
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}
