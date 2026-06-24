// Shared attribute mapping and helpers used by both the CoAP and HTTP protocol implementations.
// Keeping this in one place avoids the two protocol files drifting apart.

const NAME_MAPPING = {
    rhset: { name: 'targetHumidity', control: true, role: 'level.humidity', unit: '%' },
    func: { name: 'function', options: { P: 'purification', PH: 'humidification' }, control: true },
    pwr: { name: 'power', options: { 1: true, 0: false }, control: true },
    om: {
        name: 'fanSpeed',
        options: { s: 'silent', t: 'turbo', a: 'auto', 1: '1', 2: '2', 3: '3' },
        control: true,
        role: 'level.speed',
    },
    aqil: { name: 'lightBrightness', control: true, role: 'level.brightness', unit: '%' },
    aqit: { name: 'airQualityNotificationThreshold', control: true },
    uil: { name: 'buttonLight', options: { 1: true, 0: false }, control: true },
    rh: { name: 'humidity', role: 'value.humidity', unit: '%' },
    iaql: { name: 'allergenIndex', role: 'value' },
    temp: { name: 'temperature', role: 'value.temperature', unit: '°C' },
    wl: { name: 'waterLevel', role: 'value.fill', unit: '%' },
    cl: { name: 'childLock', options: { 1: true, 0: false }, control: true },
    swversion: { name: 'softwareVersion', device: true },
    name: { name: 'name', device: true },
    type: { name: 'type', device: true },
    modelid: { name: 'modelId', device: true },
    WifiVersion: { name: 'wifiVersion', device: true },
    ProductId: { name: 'productId', device: true },
    DeviceId: { name: 'deviceId', device: true },
    StatusType: { name: 'statusType', device: true },
    ConnectType: { name: 'connectType', device: true },
    ota: { name: 'overTheAirUpdates', device: true },
    Runtime: { name: 'uptime', device: true, type: 'number', role: 'value.interval', unit: 'ms' },
    pm25: { name: 'pm25', role: 'value' },
    tvoc: { name: 'totalVolatileOrganicCompounds', role: 'value' },
    mode: {
        name: 'mode',
        options: {
            P: 'auto',
            A: 'allergen',
            S: 'sleep',
            M: 'manual',
            B: 'bacteria',
            N: 'night',
            T: 'turbo',
            AG: 'automode',
            GT: 'gentle',
        },
        control: true,
    },
    ddp: { name: 'usedIndex', options: { 3: 'humidity', 1: 'pm2.5', 0: 'iai' }, control: true },
    rddp: { name: 'rddp' },
    dt: { name: 'timerHours', control: true, role: 'level.timer', unit: 'hours' },
    dtrs: { name: 'timerMinutes', unit: 'min' },
    fltt1: { name: 'hepaFilterType', options: { A3: 'NanoProtect Filter Series 3 (FY2422)' }, filter: true },
    fltt2: { name: 'activeCarbonFilterType', options: { C7: 'NanoProtect Filter AC (FY2420)' }, filter: true },
    fltsts0: { name: 'preFilterCleanInHours', filter: true, unit: 'hours' },
    fltsts1: { name: 'hepaFilterReplaceInHours', filter: true, unit: 'hours' },
    fltsts2: { name: 'activeCarbonFilterReplaceInHours', filter: true, unit: 'hours' },
    wicksts: { name: 'wickFilterReplaceInHours', filter: true, unit: 'hours' },
    err: {
        name: 'error',
        options: {
            0: 'none',
            // 193 (0xC1) is reported by the AC2889 for this condition. Confirmed live: on a pre-filter
            // reset err goes 193 -> 0, so the error code (not the filter hours) drives this message.
            193: 'pre-filter must be cleaned',
            0x8000: 'water tank open',
            0xc003: 'pre-filter must be cleaned',
            0xc100: 'no water',
        },
        device: true,
    },
};

/**
 * The object-tree channel a mapped state belongs to.
 *
 * @param item a mapping entry
 * @returns one of 'control' | 'filter' | 'device' | 'status'
 */
function channelOf(item) {
    if (item.control) {
        return 'control';
    }
    if (item.filter) {
        return 'filter';
    }
    if (item.device) {
        return 'device';
    }
    return 'status';
}

/**
 * Infer the ioBroker state type for a mapping entry when it is not given explicitly.
 *
 * @param item a mapping entry
 * @returns 'boolean' | 'string' | 'number'
 */
function inferType(item) {
    if (item.type) {
        return item.type;
    }
    if (item.options) {
        return Object.values(item.options).every(v => typeof v === 'boolean') ? 'boolean' : 'string';
    }
    // device info is textual (ids, names, versions); everything else (sensors, filters, numeric
    // controls) is numeric. Numeric exceptions like uptime carry an explicit type.
    return item.device ? 'string' : 'number';
}

/**
 * Build the ioBroker object `common` block for a mapped device state. This makes the mapping the
 * single source of truth, so device states can be created dynamically instead of being duplicated in
 * io-package.json (which only holds the adapter's own infrastructure states).
 *
 * @param item a mapping entry
 * @returns an ioBroker state `common` object
 */
function stateCommon(item) {
    const type = inferType(item);
    const common = {
        name: item.name,
        type,
        role:
            item.role ||
            (type === 'boolean' ? (item.control ? 'switch' : 'indicator') : type === 'string' ? 'text' : 'value'),
        read: true,
        write: !!item.control,
    };
    if (item.unit) {
        common.unit = item.unit;
    }
    // Offer a dropdown for option-based controls (the renamed friendly value is both key and label).
    if (item.options) {
        const values = Object.values(item.options);
        if (!values.every(v => typeof v === 'boolean')) {
            common.states = {};
            values.forEach(v => (common.states[v] = String(v)));
        }
    }
    return common;
}

/**
 * Rename the raw device attributes of a flat reported object to the friendly state names, mapping
 * option values and keeping native numbers/booleans. Operates in place.
 *
 * @param reported a flat object of raw device attributes (the "reported" status)
 */
function renameReported(reported) {
    if (!reported) {
        return;
    }
    Object.keys(reported).forEach(attr => {
        const map = NAME_MAPPING[attr];
        if (!map) {
            return;
        }
        const val = reported[attr];
        delete reported[attr];
        if (map.options && Object.prototype.hasOwnProperty.call(map.options, val)) {
            reported[map.name] = map.options[val];
        } else {
            // Keep native numbers/booleans so typed states are not rejected; coerce only the rest.
            reported[map.name] = typeof val === 'number' || typeof val === 'boolean' ? val : (val ?? '').toString();
        }
    });
}

/**
 * Build the raw control payload (device attribute -> raw value) from friendly state settings.
 *
 * @param settings mapping of friendly state names to desired values
 * @returns the raw payload keyed by device attribute
 */
function buildControlPayload(settings) {
    const payload = {};
    Object.keys(NAME_MAPPING)
        .filter(attr => NAME_MAPPING[attr].control)
        .forEach(attr => {
            const map = NAME_MAPPING[attr];
            if (!Object.prototype.hasOwnProperty.call(settings, map.name)) {
                return;
            }
            if (map.options) {
                const key = Object.keys(map.options).find(k => map.options[k] == settings[map.name]);
                if (key === undefined) {
                    throw new Error(
                        `Invalid option for ${map.name}: ${settings[map.name]}. Supported only: ${JSON.stringify(map.options)}`,
                    );
                }
                payload[attr] = key;
            } else {
                payload[attr] = settings[map.name];
            }
        });
    return payload;
}

module.exports = { NAME_MAPPING, channelOf, stateCommon, renameReported, buildControlPayload };
