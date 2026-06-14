// Shared attribute mapping and helpers used by both the CoAP and HTTP protocol implementations.
// Keeping this in one place avoids the two protocol files drifting apart.

const NAME_MAPPING = {
    rhset: { name: 'targetHumidity', control: true },
    func: { name: 'function', options: { P: 'purification', PH: 'humidification' }, control: true },
    pwr: { name: 'power', options: { 1: true, 0: false }, control: true },
    om: { name: 'fanSpeed', options: { s: 'silent', t: 'turbo', a: 'auto', 1: '1', 2: '2', 3: '3' }, control: true },
    aqil: { name: 'lightBrightness', control: true },
    aqit: { name: 'airQualityNotificationThreshold', control: true },
    uil: { name: 'buttonLight', options: { 1: true, 0: false }, control: true },
    rh: { name: 'humidity' },
    iaql: { name: 'allergenIndex' },
    temp: { name: 'temperature' },
    wl: { name: 'waterLevel' },
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
    Runtime: { name: 'uptime', device: true },
    pm25: { name: 'pm25' },
    tvoc: { name: 'totalVolatileOrganicCompounds' },
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
    dt: { name: 'timerHours', control: true },
    dtrs: { name: 'timerMinutes' },
    fltt1: { name: 'hepaFilterType', options: { A3: 'NanoProtect Filter Series 3 (FY2422)' }, filter: true },
    fltt2: { name: 'activeCarbonFilterType', options: { C7: 'NanoProtect Filter AC (FY2420)' }, filter: true },
    fltsts0: { name: 'preFilterCleanInHours', filter: true },
    fltsts1: { name: 'hepaFilterReplaceInHours', filter: true },
    fltsts2: { name: 'activeCarbonFilterReplaceInHours', filter: true },
    wicksts: { name: 'wickFilterReplaceInHours', filter: true },
    err: {
        name: 'error',
        options: {
            0: 'none',
            // 193 (0xC1) is reported by the AC2889 for this condition (confirmed against the Philips app)
            193: 'pre-filter must be cleaned',
            0x8000: 'water tank open',
            0xc003: 'pre-filter must be cleaned',
            0xc100: 'no water',
        },
        device: true,
    },
};

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

module.exports = { NAME_MAPPING, renameReported, buildControlPayload };
