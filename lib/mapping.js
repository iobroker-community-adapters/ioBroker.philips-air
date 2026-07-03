// Shared attribute mapping and helpers used by both the CoAP and HTTP protocol implementations.
// Keeping this in one place avoids the two protocol files drifting apart.
//
// The mapping is layered by model because a handful of raw D-code attributes (notably D03102 /
// D0310C / D03130) are reused by different device families with completely different semantics
// (e.g. AC3221 air purifier vs. CX3550 fan). D-codes alone cannot disambiguate the device class, so
// the adapter config picks the model and only ONE control table is active at a time:
//
//   STANDARD_MAPPING          - read-only across all models (sensors, filters, device-info, error, ...)
//   MODEL_MAPPING[model]      - ONLY the read/write controls that differ per model
//   createMapping(model)      - activeMapping = { ...STANDARD_MAPPING, ...MODEL_MAPPING[model] }

/**
 * Read-only entries shared by all models: sensors, filters, device-info and error.
 */
const STANDARD_MAPPING = {
    rh: { name: 'humidity', role: 'value.humidity', unit: '%' },
    iaql: { name: 'allergenIndex', role: 'value' },
    temp: { name: 'temperature', role: 'value.temperature', unit: '°C' },
    wl: { name: 'waterLevel', role: 'value.fill', unit: '%' },
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
    rddp: { name: 'rddp' },
    dtrs: { name: 'timerMinutes', unit: 'min' },
    fltt1: { name: 'hepaFilterType', options: { A3: 'NanoProtect Filter Series 3 (FY2422)' }, filter: true },
    fltt2: { name: 'activeCarbonFilterType', options: { C7: 'NanoProtect Filter AC (FY2420)' }, filter: true },
    fltsts0: { name: 'preFilterCleanInHours', filter: true, unit: 'hours' },
    fltsts1: { name: 'hepaFilterReplaceInHours', filter: true, unit: 'hours' },
    fltsts2: { name: 'activeCarbonFilterReplaceInHours', filter: true, unit: 'hours' },
    wicksts: { name: 'wickFilterReplaceInHours', filter: true, unit: 'hours' },

    // Philips/Versuni CX3550/01 fan and AC3221 new-gen purifier, local CoAP / HomeID generation.
    // Device-info D01S* keys use the same schema on both new-gen device families.
    D01S03: { name: 'name', device: true },
    D01S04: { name: 'platform', device: true },
    D01S05: { name: 'modelId', device: true },
    D01S0D: { name: 'serialNumber', device: true },
    D01S12: { name: 'softwareVersion', device: true },

    // Read-only housekeeping/telemetry sent by new-gen CoAP devices (confirmed present in
    // state.reported on AC3221, .claude/philips-2026.07.02.log). Legitimate diagnostics, so they get
    // a device.* state instead of falling through to unknownStates.
    rssi: { name: 'rssi', device: true, type: 'number', role: 'value', unit: 'dBm' },
    free_memory: { name: 'freeMemory', device: true, type: 'number', role: 'value' },
    // Observed only as false/-1 in the log (no string "log" content seen). otacheck/wifilog are typed
    // boolean (coerceToType safely forces any value to boolean). blelog is kept string on purpose: its
    // "log" name suggests it may carry text on other firmware, and coerceToType cannot coerce TO number
    // - a number type would risk a rejected-state crash if a string ever arrives, so string is safe.
    otacheck: { name: 'otaCheck', device: true, type: 'boolean' },
    wifilog: { name: 'wifiLog', device: true, type: 'boolean' },
    blelog: { name: 'bleLog', device: true, type: 'string', role: 'text' },

    // Lowercase device-info aliases the new-gen CoAP frames send (classic HTTP-gen devices send the
    // capitalized spellings above: Runtime/ProductId/DeviceId/WifiVersion/StatusType/ConnectType).
    // Mapped to the SAME friendly names so real device info lands in device.* regardless of
    // generation. `uptime` must keep this exact friendly name - it re-triggers the uptime -> started
    // special case in main.js. `key` is intentionally NOT mapped here (potentially sensitive).
    uptime: { name: 'uptime', device: true, type: 'number', role: 'value.interval', unit: 'ms' },
    productId: { name: 'productId', device: true },
    deviceId: { name: 'deviceId', device: true },
    wifiVersion: { name: 'wifiVersion', device: true },
    statusType: { name: 'statusType', device: true },
    connectType: { name: 'connectType', device: true },

    // Read-only, shared across new-gen models (no per-model semantic difference).
    // CX3550 fan reports 0-3; AC3221 additionally reports 4 (speed4) and 18 (the shared max level,
    // reported for both speed5 and turbo). Cover the union so no reported speed shows as a raw number.
    D0310D: {
        name: 'fanSpeedReported',
        options: { 0: 'off', 1: 'speed1', 2: 'speed2', 3: 'speed3', 4: 'speed4', 18: 'max' },
        rawType: 'number',
        role: 'value.speed',
    },
    // Timer write triggers a firmware bug that switches the device off - keep strictly read-only.
    // Fan reports a code string (e.g. '2h'), so force the type explicitly instead of letting
    // inferType() default numeric D-codes to 'number'.
    D03110: { name: 'timerCode', type: 'string', role: 'text' },
    D03211: { name: 'timerMinutes', role: 'value.interval', unit: 'min' },

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
 * Per-model read/write controls. Only one model's table is merged into the active mapping at a
 * time, which is what makes the D03102 / D0310C / D03130 raw-key overlap between AC3221 and
 * CX3550 safe - they never coexist in the same active mapping.
 */
const MODEL_MAPPING = {
    AC2889: {
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
        cl: { name: 'childLock', options: { 1: true, 0: false }, control: true },
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
        dt: { name: 'timerHours', control: true, role: 'level.timer', unit: 'hours' },
    },

    // Philips/Versuni CX3550/01 fan. Friendly names are generic (no "cx" prefix) since only one
    // model's controls are ever active at a time.
    CX3550: {
        D03102: { name: 'power', options: { 1: true, 0: false }, control: true, rawType: 'number' },
        D0310C: {
            name: 'mode',
            options: { 1: 'speed1', 2: 'speed2', 3: 'speed3', 17: 'sleep', '-126': 'naturalBreeze' },
            control: true,
            rawType: 'number',
            role: 'level.mode',
        },
        D0320F: {
            name: 'oscillation',
            options: { 23040: true, 0: false },
            // Read reports raw 23040, but writing needs raw 90 - the device silently ignores 23040 on
            // write. buildControlPayload() prefers writeOptions over options for exactly this reason.
            writeOptions: { 90: true, 0: false },
            control: true,
            rawType: 'number',
        },
        D03130: { name: 'beep', options: { 100: true, 0: false }, control: true, rawType: 'number' },
    },

    // AC3221 new-gen air purifier.
    AC3221: {
        D03102: { name: 'power', options: { 1: true, 0: false }, control: true, rawType: 'number' },
        // One attribute covers both fan speed levels and named modes; the device self-shifts speed
        // while in auto mode. Corrected against live logs/App labels (GitHub #347): 0=auto (not
        // sleep), 5=speed5 (not turbo), 17=sleep (not auto), 18=turbo, 19=medium (not autoMedium).
        D0310C: {
            name: 'mode',
            options: {
                '-16': 'off',
                0: 'auto',
                1: 'speed1',
                2: 'speed2',
                3: 'speed3',
                4: 'speed4',
                5: 'speed5',
                17: 'sleep',
                18: 'turbo',
                19: 'medium',
            },
            control: true,
            rawType: 'number',
        },
        // Display backlight. +100 offset, not linear: 101=auto (not low), 115=low (not mid).
        D03105: {
            name: 'displayBrightness',
            options: { 0: 'off', 101: 'auto', 115: 'low', 123: 'high' },
            control: true,
            rawType: 'number',
        },
        D03135: {
            name: 'lampMode',
            options: { 0: 'off', 1: 'airQuality', 2: 'ambient' },
            control: true,
            rawType: 'number',
        },
        D03103: { name: 'childLock', options: { 1: true, 0: false }, control: true, rawType: 'number' },
        D03130: { name: 'beep', options: { 100: true, 0: false }, control: true, rawType: 'number' },
        D0312A: { name: 'preferredIndex', options: { 1: 'pm2.5' }, control: true, rawType: 'number' },
        D03180: { name: 'autoPlusAi', options: { 1: true, 0: false }, control: true, rawType: 'number' },
    },

    // No device-specific controls; useful as an explicit "read-only" choice.
    Generic: {},
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
 * Build the model-bound mapping and helpers for a given device model.
 *
 * Falls back to the AC2889 (classic) control set both when `model` is undefined (existing installs
 * without a configured model) AND when it is an unknown/mistyped model string - a plain `model ||
 * default` would only catch the first case, silently dropping all controls for a typo.
 *
 * @param model the configured device model (e.g. 'AC2889', 'AC3221', 'CX3550', 'Generic')
 * @returns `{ mapping, channelOf, stateCommon, renameReported, buildControlPayload }` bound to the
 *   active (STANDARD + model) mapping
 */
function createMapping(model) {
    const controls = Object.prototype.hasOwnProperty.call(MODEL_MAPPING, model)
        ? MODEL_MAPPING[model]
        : MODEL_MAPPING.AC2889;
    const activeMapping = { ...STANDARD_MAPPING, ...controls };

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
            const map = activeMapping[attr];
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
        Object.keys(activeMapping)
            .filter(attr => activeMapping[attr].control)
            .forEach(attr => {
                const map = activeMapping[attr];
                if (!Object.prototype.hasOwnProperty.call(settings, map.name)) {
                    return;
                }
                const writeOptions = map.writeOptions || map.options;
                if (writeOptions) {
                    const key = Object.keys(writeOptions).find(k => writeOptions[k] == settings[map.name]);
                    if (key === undefined) {
                        throw new Error(
                            `Invalid option for ${map.name}: ${settings[map.name]}. Supported only: ${JSON.stringify(writeOptions)}`,
                        );
                    }
                    payload[attr] = map.rawType === 'number' ? Number(key) : key;
                } else {
                    payload[attr] = map.rawType === 'number' ? Number(settings[map.name]) : settings[map.name];
                }
            });
        return payload;
    }

    return { mapping: activeMapping, channelOf, stateCommon, renameReported, buildControlPayload };
}

module.exports = {
    createMapping,
    STANDARD_MAPPING,
    MODEL_MAPPING,
    channelOf,
    inferType,
    stateCommon,
};
