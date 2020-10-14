'use strict';

/*
 * Created with @iobroker/create-adapter v1.26.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils       = require('@iobroker/adapter-core');
const adapterName = require('./package.json').name.split('.').pop();
const AirPurifier = require('./lib/coap');

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
    return adapter = utils.adapter(Object.assign({}, options, {
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
            if (state && !state.ack && id.startsWith(adapter.namespace + '.control.')) {
                const name = id.substring((adapter.namespace + '.control.').length);
                if (name === 'function') {
                    airPurifier && airPurifier.control({function: state.val ? 'humidification' : 'purification'});
                } else {
                    airPurifier && airPurifier.control({[name]: state.val});
                }
            }
        }
    }));
}

async function updateStatus(status) {
    const MAPPING = AirPurifier.getMapping();
    const keys = Object.keys(MAPPING);
    for (let i = 0; i < keys.length; i++) {
        const item = MAPPING[keys[i]];
        if (status.hasOwnProperty(item.name)) {
            if (item.control) {
                await adapter.setStateAsync('control.' + item.name, status[item.name], true);
            } else if (item.filter) {
                await adapter.setStateAsync('filter.' + item.name, status[item.name], true);
            } else if (item.device) {
                if (item.name === 'function') {
                    await adapter.setStateAsync('device.function', status[item.name] === 'humidification', true);
                } else if (item.name === 'uptime') {
                    await adapter.setStateAsync('device.uptime', status[item.name], true);
                    const date = new Date();
                    date.setMilliseconds(date.getMilliseconds() - status[item.name]);
                    await adapter.setStateAsync('device.started', date.toISOString(), true);
                } else {
                    await adapter.setStateAsync('device.' + item.name, status[item.name], true);
                    if (item.name === 'error') {
                        await adapter.setStateAsync('device.maintenance', status[item.name] !== 'none', true);
                    }
                }
            } else {
                await adapter.setStateAsync('status.' + item.name, status[item.name], true);
            }
        }
    }
}

async function main() {
    // Reset the connection indicator during startup
    await adapter.setStateAsync('info.connection', false, true);

    if (!adapter.config.host) {
        return adapter.log.warn('No IP defined');
    }

    // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
    adapter.subscribeStates('control.*');
    airPurifier = new AirPurifier(adapter.config.host, adapter.config);
    airPurifier.on('connected', connected => {
        adapter.log.debug(connected ? 'connected' : 'disconnected');
        adapter.setState('info.connection', connected, true);
    });
    airPurifier.on('status', async status => {
        adapter.log.debug('STATUS: ' + JSON.stringify(status));
        await updateStatus(status);
    })
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}