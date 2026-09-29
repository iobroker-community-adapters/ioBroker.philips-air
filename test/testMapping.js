const { expect } = require('chai');
const {
    createMapping,
    channelOf,
    STANDARD_MAPPING,
    MODEL_MAPPING,
    modelsOwningRawKey,
    bestMatchingModels,
    resolveModel,
    DEFAULT_MODEL,
} = require('../lib/mapping');

describe('mapping - renameReported (AC2889)', () => {
    const { renameReported } = createMapping('AC2889');

    it('renames attributes, maps options and keeps native types', () => {
        const reported = { pm25: 7, pwr: '1', cl: 0, mode: 'M', om: 'a', name: 'Schlafzimmer' };
        renameReported(reported);
        expect(reported).to.deep.equal({
            pm25: 7,
            power: true,
            childLock: false,
            mode: 'manual',
            fanSpeed: 'auto',
            name: 'Schlafzimmer',
        });
    });

    it('maps known error codes and keeps unknown ones numeric', () => {
        const r = { err: 193 };
        renameReported(r);
        expect(r.error).to.equal('pre-filter must be cleaned');
        const u = { err: 12345 };
        renameReported(u);
        expect(u.error).to.equal(12345);
    });

    it('ignores unknown attributes and tolerates a missing object', () => {
        const r = { somethingUnknown: 5 };
        renameReported(r);
        expect(r).to.deep.equal({ somethingUnknown: 5 });
        expect(() => renameReported(undefined)).to.not.throw();
    });
});

describe('mapping - buildControlPayload (AC2889)', () => {
    const { buildControlPayload } = createMapping('AC2889');

    it('resolves option values back to their raw device codes', () => {
        expect(buildControlPayload({ power: true })).to.deep.equal({ pwr: '1' });
        expect(buildControlPayload({ fanSpeed: 'auto', mode: 'manual' })).to.deep.equal({ om: 'a', mode: 'M' });
        expect(buildControlPayload({ childLock: false })).to.deep.equal({ cl: '0' });
    });

    it('passes through non-option control values', () => {
        expect(buildControlPayload({ lightBrightness: 50, timerHours: 2 })).to.deep.equal({ aqil: 50, dt: 2 });
    });

    it('only includes control-capable settings', () => {
        // pm25 is read-only (no control flag) and must not end up in the payload
        expect(buildControlPayload({ pm25: 5, power: true })).to.deep.equal({ pwr: '1' });
    });

    it('throws for an invalid option value', () => {
        expect(() => buildControlPayload({ fanSpeed: 'hurricane' })).to.throw(/Invalid option for fanSpeed/);
    });
});

describe('mapping - CX3550', () => {
    const { renameReported, buildControlPayload, mapping } = createMapping('CX3550');

    it('maps CX3550 reported values with generic names and keeps timer read-only', () => {
        const reported = {
            D01S03: 'Ventilator',
            D01S05: 'CX3550/01',
            D03102: 1,
            D0310C: -126,
            D0310D: 3,
            D0320F: 23040,
            D03110: '2h',
            D03211: 120,
            D03130: 100,
        };
        renameReported(reported);
        expect(reported).to.deep.equal({
            name: 'Ventilator',
            modelId: 'CX3550/01',
            power: true,
            mode: 'naturalBreeze',
            fanSpeedReported: 'speed3',
            oscillation: true,
            timerCode: '2h',
            timerMinutes: 120,
            beep: true,
        });
    });

    it('maps CX3550 control/status values as soon as they are reported', () => {
        const reported = {
            D03102: 1,
            D0310C: 17,
            D0310D: 2,
            D0320F: 23040,
            D03130: 100,
        };
        renameReported(reported);
        expect(reported).to.deep.equal({
            power: true,
            mode: 'sleep',
            fanSpeedReported: 'speed2',
            oscillation: true,
            beep: true,
        });
    });

    it('builds numeric CX3550 control payloads without timer controls, oscillation write uses raw 90', () => {
        expect(
            buildControlPayload({
                power: true,
                mode: 'sleep',
                oscillation: true,
                beep: false,
                timerCode: '2h',
                timerMinutes: 120,
            }),
        ).to.deep.equal({
            D03102: 1,
            D0310C: 17,
            D0320F: 90,
            D03130: 0,
        });
    });

    it('places CX3550 writable states under control and reported speed/timers under status', () => {
        const expectedPaths = {
            D03102: 'control.power',
            D0310C: 'control.mode',
            D0320F: 'control.oscillation',
            D03130: 'control.beep',
            D0310D: 'status.fanSpeedReported',
            D03110: 'status.timerCode',
            D03211: 'status.timerMinutes',
        };

        Object.entries(expectedPaths).forEach(([attr, path]) => {
            const item = mapping[attr];
            expect(`${channelOf(item)}.${item.name}`).to.equal(path);
        });
    });

    it('carries verbatim metadata required for correct raw en/decoding (Datentreue-Checkliste)', () => {
        expect(mapping.D03102).to.include({ control: true, rawType: 'number' });
        expect(mapping.D03102.options).to.deep.equal({ 1: true, 0: false });

        expect(mapping.D0310C).to.include({ control: true, rawType: 'number', role: 'level.mode' });
        expect(mapping.D0310C.options).to.deep.equal({
            1: 'speed1',
            2: 'speed2',
            3: 'speed3',
            17: 'sleep',
            '-126': 'naturalBreeze',
        });

        expect(mapping.D0320F).to.include({ control: true, rawType: 'number' });
        expect(mapping.D0320F.options).to.deep.equal({ 23040: true, 0: false });
        expect(mapping.D0320F.writeOptions).to.deep.equal({ 90: true, 0: false });

        expect(mapping.D03130).to.include({ control: true, rawType: 'number' });
        expect(mapping.D03130.options).to.deep.equal({ 100: true, 0: false });

        expect(mapping.D03110.type).to.equal('string');
        expect(mapping.D03110.control).to.be.undefined;
    });

    it('exposes the fan-only registers D0310A/D03105 read-only under device.* (no invented heater/light semantics)', () => {
        // The CX3550 fan reports D0310A (=1) and D03105 (=100) but has neither a heater nor a display,
        // so they are exposed read-only under their raw code - never mislabelled as circulation/backlight.
        ['D0310A', 'D03105'].forEach(attr => {
            expect(mapping[attr]).to.include({ device: true, type: 'number' });
            expect(mapping[attr].control).to.be.undefined;
            expect(channelOf(mapping[attr])).to.equal('device');
        });
        const reported = { D0310A: 1, D03105: 100 };
        renameReported(reported);
        // Renamed to themselves (raw code = friendly name), native number kept - so they land in a
        // known device.* state instead of unknownStates.
        expect(reported).to.deep.equal({ D0310A: 1, D03105: 100 });
    });
});

describe('mapping - CX7550', () => {
    const { renameReported, buildControlPayload, mapping } = createMapping('CX7550');

    it('maps the full live status frame of a CX7550/01 (GitHub #372)', () => {
        const reported = {
            D01S03: 'Turmventilator',
            D01S04: 'Babel',
            D01S05: 'CX7550/01',
            D01S12: '0.2.9',
            D03102: 1,
            D03104: 100,
            D03105: 123,
            D0310C: 82,
            D0310D: 82,
            D0320F: 0,
            D03110: 0,
            D03211: 0,
            D03224: 240,
            D0312A: 7,
            D0312B: 7,
            D03130: 100,
        };
        renameReported(reported);
        expect(reported).to.deep.equal({
            name: 'Turmventilator',
            platform: 'Babel',
            modelId: 'CX7550/01',
            softwareVersion: '0.2.9',
            power: true,
            temperatureColorDisplay: true,
            displayBrightness: 'high',
            mode: 'speed12',
            fanSpeedReported: 'speed12',
            oscillation: false,
            timerCode: 'off',
            timerMinutes: 0,
            temperature: 24,
            persistentDisplay: 'fanSpeed',
            persistentDisplayReported: 'fanSpeed',
            beep: true,
        });
    });

    it('covers all twelve speeds plus AutoAdapt, sleep and natural breeze', () => {
        const rawToFriendly = {
            0: 'auto',
            1: 'speed1',
            2: 'speed2',
            3: 'speed3',
            4: 'speed4',
            5: 'speed5',
            6: 'speed6',
            7: 'speed7',
            8: 'speed8',
            9: 'speed9',
            10: 'speed10',
            17: 'sleep',
            81: 'speed11',
            82: 'speed12',
            '-126': 'naturalBreeze',
        };
        Object.entries(rawToFriendly).forEach(([raw, friendly]) => {
            const reported = { D0310C: Number(raw) };
            renameReported(reported);
            expect(reported.mode).to.equal(friendly);
            // Round trip: the friendly value must resolve back to the very same raw code.
            expect(buildControlPayload({ mode: friendly })).to.deep.equal({ D0310C: Number(raw) });
        });
    });

    it('overrides the shared reported-speed entry so speeds 5-12 do not stay raw numbers', () => {
        [5, 6, 7, 8, 9, 10].forEach(raw => {
            const reported = { D0310D: raw };
            renameReported(reported);
            expect(reported.fanSpeedReported).to.equal(`speed${raw}`);
        });
        const high = { D0310D: 81 };
        renameReported(high);
        expect(high.fanSpeedReported).to.equal('speed11');
        expect(mapping.D0310D.control).to.be.undefined;
    });

    it('uses raw 80 for oscillation on both read and write (not the CX3550 23040/90 pair)', () => {
        const reported = { D0320F: 80 };
        renameReported(reported);
        expect(reported.oscillation).to.be.true;
        expect(mapping.D0320F.writeOptions).to.be.undefined;
        expect(buildControlPayload({ oscillation: true })).to.deep.equal({ D0320F: 80 });
        expect(buildControlPayload({ oscillation: false })).to.deep.equal({ D0320F: 0 });
    });

    it('exposes the timer as a writable control with friendly durations', () => {
        expect(channelOf(mapping.D03110)).to.equal('control');
        const rawToFriendly = {
            0: 'off',
            2: '1h',
            3: '2h',
            4: '3h',
            5: '4h',
            6: '5h',
            7: '6h',
            8: '7h',
            9: '8h',
            10: '9h',
            11: '10h',
            12: '11h',
            13: '12h',
        };
        Object.entries(rawToFriendly).forEach(([raw, friendly]) => {
            const reported = { D03110: Number(raw) };
            renameReported(reported);
            expect(reported.timerCode).to.equal(friendly);
            expect(buildControlPayload({ timerCode: friendly })).to.deep.equal({ D03110: Number(raw) });
        });
    });

    it('scales the room temperature register from tenths of a degree', () => {
        [
            [240, 24],
            [255, 25.5],
            [0, 0],
        ].forEach(([raw, expected]) => {
            const reported = { D03224: raw };
            renameReported(reported);
            expect(reported.temperature).to.equal(expected);
        });
        // Reuses the friendly name of the classic `temp` key - a device sends only one of the two.
        expect(mapping.D03224.name).to.equal(STANDARD_MAPPING.temp.name);
        expect(mapping.D03224.control).to.be.undefined;
    });

    it('maps the display group this model adds on top of the CX3550 controls', () => {
        expect(buildControlPayload({ displayBrightness: 'low' })).to.deep.equal({ D03105: 115 });
        expect(buildControlPayload({ temperatureColorDisplay: false })).to.deep.equal({ D03104: 0 });
        expect(buildControlPayload({ persistentDisplay: 'temperature' })).to.deep.equal({ D0312A: 5 });
        // The echoed setting is status only, never writable.
        expect(channelOf(mapping.D0312B)).to.equal('status');
        expect(buildControlPayload({ persistentDisplayReported: 'temperature' })).to.deep.equal({});
    });

    it('leaves the still-undecoded registers unmapped so they surface as unknownStates', () => {
        ['D0310A', 'D03133', 'D03240', 'D0313B'].forEach(attr => {
            expect(mapping).to.not.have.property(attr);
        });
        const reported = { D03133: 1, D0313B: 20 };
        renameReported(reported);
        expect(reported).to.deep.equal({ D03133: 1, D0313B: 20 });
    });

    it('places the writable states under control and the reported ones under status', () => {
        const expectedPaths = {
            D03102: 'control.power',
            D0310C: 'control.mode',
            D0320F: 'control.oscillation',
            D03110: 'control.timerCode',
            D03130: 'control.beep',
            D03105: 'control.displayBrightness',
            D03104: 'control.temperatureColorDisplay',
            D0312A: 'control.persistentDisplay',
            D0310D: 'status.fanSpeedReported',
            D0312B: 'status.persistentDisplayReported',
            D03211: 'status.timerMinutes',
            D03224: 'status.temperature',
        };

        Object.entries(expectedPaths).forEach(([attr, path]) => {
            const item = mapping[attr];
            expect(`${channelOf(item)}.${item.name}`).to.equal(path);
        });
    });

    it('does not leak its raw values into the CX3550 table', () => {
        // Both fans share the D-code namespace with different values - the whole point of the
        // per-model table. Guard the pairs that actually differ.
        const cx3550 = createMapping('CX3550');
        expect(cx3550.buildControlPayload({ oscillation: true })).to.deep.equal({ D0320F: 90 });
        expect(cx3550.mapping.D0310C.options[82]).to.be.undefined;
        expect(cx3550.mapping.D03110.control).to.be.undefined;
        expect(cx3550.mapping.D03105.control).to.be.undefined;
    });
});

describe('mapping - boolean controls written as text', () => {
    // ioBroker states can be written as the string "true"/"false" (script, VIS widget, REST call).
    // Loose equality does not save us here - `false == 'false'` is false - so without normalization
    // the write was rejected with "Invalid option" and the command never reached the device.
    it('accepts "true"/"false" for boolean controls of every model', () => {
        expect(createMapping('CX7550').buildControlPayload({ power: 'false' })).to.deep.equal({ D03102: 0 });
        expect(createMapping('CX7550').buildControlPayload({ power: 'true' })).to.deep.equal({ D03102: 1 });
        expect(createMapping('CX3550').buildControlPayload({ oscillation: 'false' })).to.deep.equal({ D0320F: 0 });
        expect(createMapping('AC2889').buildControlPayload({ childLock: 'true' })).to.deep.equal({ cl: '1' });
    });

    it('still rejects a value that is not a valid option', () => {
        expect(() => createMapping('CX7550').buildControlPayload({ power: 'yes' })).to.throw(
            /Invalid option for power/,
        );
    });

    it('does not touch non-boolean option values that happen to be strings', () => {
        expect(createMapping('CX7550').buildControlPayload({ mode: 'sleep' })).to.deep.equal({ D0310C: 17 });
    });
});

describe('mapping - AC3221', () => {
    const { renameReported, mapping } = createMapping('AC3221');

    it('D0310C covers all 10 emitted values with the corrected labels (no fall-through)', () => {
        const rawToFriendly = {
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
        };
        Object.entries(rawToFriendly).forEach(([raw, friendly]) => {
            const reported = { D0310C: Number(raw) };
            renameReported(reported);
            expect(reported.mode).to.equal(friendly);
        });
    });

    it('maps the corrected D03105 display brightness options', () => {
        const reported = { D03105: 101 };
        renameReported(reported);
        expect(reported.displayBrightness).to.equal('auto');
    });

    it('keeps D03110 (timer) read-only with an explicit string type', () => {
        expect(mapping.D03110.type).to.equal('string');
        expect(mapping.D03110.control).to.be.undefined;
    });
});

describe('mapping - Generic', () => {
    it('has no controls, so unmapped attributes stay untouched (handled upstream as unknownStates)', () => {
        const { mapping, renameReported } = createMapping('Generic');
        expect(MODEL_MAPPING.Generic).to.deep.equal({});
        expect(Object.values(mapping).some(item => item.control)).to.be.false;

        const reported = { someUnmappedDCode: 42 };
        renameReported(reported);
        expect(reported).to.deep.equal({ someUnmappedDCode: 42 });
    });
});

describe('mapping - createMapping fallback', () => {
    const expectReadOnly = model => {
        const { mapping } = createMapping(model);
        expect(mapping).to.deep.equal(createMapping('Generic').mapping);
        expect(Object.values(mapping).some(item => item.control)).to.be.false;
        expect(mapping.pwr, 'no classic control').to.be.undefined;
        expect(mapping.D03102, 'no next-generation control').to.be.undefined;
    };

    it('falls back to Generic (no controls) for a missing or empty model', () => {
        expectReadOnly(undefined);
        expectReadOnly(null);
        expectReadOnly('');
    });

    it('falls back to Generic (no controls) for an unknown/mistyped model string', () => {
        expectReadOnly('AC2889-typo');
        // Names inherited from Object.prototype must not pass as a model either.
        expectReadOnly('constructor');
    });

    it('resolveModel keeps every known model and maps everything else to the default', () => {
        for (const model of Object.keys(MODEL_MAPPING)) {
            expect(resolveModel(model)).to.equal(model);
        }
        expect(DEFAULT_MODEL).to.equal('Generic');
        expect(resolveModel(undefined)).to.equal(DEFAULT_MODEL);
        expect(resolveModel('')).to.equal(DEFAULT_MODEL);
        expect(resolveModel('AC2889-typo')).to.equal(DEFAULT_MODEL);
    });

    it('ships Generic as the default model in io-package.json and in the admin settings', () => {
        expect(require('../io-package.json').native.model).to.equal(DEFAULT_MODEL);
        expect(require('../admin/jsonConfig.json').items.model.default).to.equal(DEFAULT_MODEL);
    });
});

describe('mapping - STANDARD_MAPPING', () => {
    it('is a non-empty shared object used by all models', () => {
        expect(STANDARD_MAPPING).to.be.an('object');
        expect(Object.keys(STANDARD_MAPPING).length).to.be.greaterThan(15);
        expect(STANDARD_MAPPING.err.name).to.equal('error');
    });

    it('does not contain the model-specific control D-codes (only one model is ever active)', () => {
        ['D03102', 'D0310C', 'D03130'].forEach(attr => {
            expect(STANDARD_MAPPING).to.not.have.property(attr);
        });
    });

    it('does not expose D03105 as a control state for AC2889/CX3550', () => {
        // AC2889 has no D03105 at all; CX3550 exposes it read-only (device.*), never as a control.
        expect(createMapping('AC2889').mapping).to.not.have.property('D03105');
        const cx = createMapping('CX3550').mapping;
        expect(cx).to.have.property('D03105');
        expect(cx.D03105.control).to.be.undefined;
        expect(cx.D03105.device).to.be.true;
    });

    it('maps diagnostic/telemetry keys as read-only device.* states (Umbau-Schritt 4, Part A)', () => {
        const diagnosticKeys = ['rssi', 'free_memory', 'otacheck', 'wifilog', 'blelog'];
        diagnosticKeys.forEach(attr => {
            expect(STANDARD_MAPPING).to.have.property(attr);
            const item = STANDARD_MAPPING[attr];
            expect(item.device).to.be.true;
            expect(item.control).to.be.undefined;
            expect(channelOf(item)).to.equal('device');
        });
        expect(STANDARD_MAPPING.rssi.type).to.equal('number');
        expect(STANDARD_MAPPING.free_memory.type).to.equal('number');
        expect(STANDARD_MAPPING.otacheck.type).to.equal('boolean');
        expect(STANDARD_MAPPING.wifilog.type).to.equal('boolean');
        // blelog is typed string, not number: coerceToType cannot coerce TO number, so a numeric type
        // would risk a rejected-state crash if firmware ever sends log text; string is always safe.
        expect(STANDARD_MAPPING.blelog.type).to.equal('string');
    });

    it('maps the lowercase new-gen device-info aliases to the same friendly names as the classic keys', () => {
        expect(STANDARD_MAPPING.uptime.name).to.equal('uptime');
        expect(STANDARD_MAPPING.uptime.name).to.equal(STANDARD_MAPPING.Runtime.name);
        expect(STANDARD_MAPPING.productId.name).to.equal(STANDARD_MAPPING.ProductId.name);
        expect(STANDARD_MAPPING.deviceId.name).to.equal(STANDARD_MAPPING.DeviceId.name);
        expect(STANDARD_MAPPING.wifiVersion.name).to.equal(STANDARD_MAPPING.WifiVersion.name);
        expect(STANDARD_MAPPING.statusType.name).to.equal(STANDARD_MAPPING.StatusType.name);
        expect(STANDARD_MAPPING.connectType.name).to.equal(STANDARD_MAPPING.ConnectType.name);
        // 'key' is intentionally not mapped (potentially sensitive).
        expect(STANDARD_MAPPING).to.not.have.property('key');
    });

    it('renames a lowercase uptime frame the same way as the classic Runtime key', () => {
        const { renameReported } = createMapping('AC3221');
        const reported = { uptime: 12345 };
        renameReported(reported);
        expect(reported).to.deep.equal({ uptime: 12345 });
    });
});

describe('mapping - unknownStates classification (Umbau-Schritt 4, Part B)', () => {
    // main.js builds `knownNames = new Set(Object.values(activeMapping).map(m => m.name))` once and
    // routes any status key NOT in that set (and not 'key') to unknownStates. Exercise the same
    // classification here at the mapping level, since a full adapter run is out of scope for this
    // unit test file.
    it('excludes an invented/unmapped raw attribute from the known friendly names', () => {
        const { mapping } = createMapping('AC3221');
        const knownNames = new Set(Object.values(mapping).map(item => item.name));
        expect(knownNames.has('someTotallyInventedRawDCode')).to.be.false;
    });

    it('includes the new diagnostic/device-info friendly names in the known set (so they do NOT route to unknownStates)', () => {
        const { mapping } = createMapping('AC3221');
        const knownNames = new Set(Object.values(mapping).map(item => item.name));
        ['rssi', 'freeMemory', 'otaCheck', 'wifiLog', 'bleLog', 'uptime', 'productId', 'deviceId'].forEach(name => {
            expect(knownNames.has(name)).to.be.true;
        });
    });
});

describe('mapping - bestMatchingModels (model hint for Generic)', () => {
    // Same counting as updateUnknownStates() in main.js: with 'Generic' no control is mapped, so
    // every raw key of the frame is counted for each model that owns it as a control.
    const count = frame => {
        const counts = new Map();
        for (const rawKey of Object.keys(frame)) {
            for (const owner of modelsOwningRawKey(rawKey)) {
                counts.set(owner, (counts.get(owner) || 0) + 1);
            }
        }
        return counts;
    };

    it('names AC2889 for a classic status frame', () => {
        const result = bestMatchingModels(count({ pwr: '1', om: 'a', mode: 'M', cl: false, pm25: 7 }));
        expect(result.models).to.deep.equal(['AC2889']);
        expect(result.count).to.be.at.least(4);
    });

    it('names every model that ties, in a stable order', () => {
        const result = bestMatchingModels(count({ D03102: 1 }));
        expect(result).to.deep.equal({ models: ['AC3221', 'CX3550', 'CX7550'], count: 1 });
    });

    it('prefers the model that claims more controls', () => {
        const result = bestMatchingModels(
            new Map([
                ['AC3221', 3],
                ['CX7550', 5],
                ['AC2889', 1],
            ]),
        );
        expect(result).to.deep.equal({ models: ['CX7550'], count: 5 });
    });

    it('names nothing when no model claims a control', () => {
        expect(bestMatchingModels(new Map())).to.deep.equal({ models: [], count: 0 });
        expect(bestMatchingModels(count({ pm25: 7, D09999: 1 }))).to.deep.equal({ models: [], count: 0 });
    });
});

describe('mapping - modelsOwningRawKey (wrong-model hint)', () => {
    it('names the model that owns a classic control key', () => {
        expect(modelsOwningRawKey('pwr')).to.deep.equal(['AC2889']);
    });

    it('names every model that owns a shared new-gen control key', () => {
        // D03102 (power) is a control of every new-gen table - a Generic/AC2889 user seeing it should
        // be pointed at all candidates.
        expect(modelsOwningRawKey('D03102')).to.have.members(['CX3550', 'CX7550', 'AC3221']);
    });

    it('returns no owner for a genuinely unknown raw attribute', () => {
        expect(modelsOwningRawKey('D09999')).to.deep.equal([]);
    });

    it('does not treat read-only STANDARD keys as owned by a model', () => {
        // Shared read-only attributes (e.g. the D0310D reported speed) live in STANDARD, not in any
        // model table, so they must never trigger a wrong-model hint.
        expect(modelsOwningRawKey('D0310D')).to.deep.equal([]);
    });

    it('does not treat a model read-only register as owned (control-only)', () => {
        // D0310A/D03105 are exposed read-only in the CX3550 table, not as controls, so a correctly
        // configured fan reporting them must never be nagged with a wrong-model hint. D03105 is still
        // owned by AC3221 and CX7550 (there it IS a control), but no longer by CX3550.
        expect(modelsOwningRawKey('D0310A')).to.deep.equal([]);
        expect(modelsOwningRawKey('D03105')).to.have.members(['CX7550', 'AC3221']);
    });
});

describe('mapping - AC4236/14 classic attributes (GitHub #150)', () => {
    const { renameReported } = createMapping('AC2889');

    it('resolves the combined allergen+sleep preset in both mode and fan speed', () => {
        // The device reports the pair mode 'AS' / om 'as' for what the German UI calls
        // "Allergie-/Ruhemodus". Before this both fell through and left the raw codes in the state.
        const reported = { mode: 'AS', om: 'as' };
        renameReported(reported);
        expect(reported).to.deep.equal({ mode: 'allergenSleep', fanSpeed: 'allergenSleep' });
    });

    it('maps the total filter hours next to the remaining ones', () => {
        const reported = { fltsts0: 403, flttotal0: 720, fltsts1: 1248, flttotal1: 4800, flttotal2: 65535 };
        renameReported(reported);
        expect(reported).to.deep.equal({
            preFilterCleanInHours: 403,
            preFilterTotalHours: 720,
            hepaFilterReplaceInHours: 1248,
            hepaFilterTotalHours: 4800,
            activeCarbonFilterTotalHours: 65535,
        });
    });

    it('files the classic device-info strings under device.* instead of unknownStates', () => {
        const reported = { language: 'EN', DeviceVersion: '4.1.8' };
        renameReported(reported);
        expect(reported).to.deep.equal({ language: 'EN', deviceVersion: '4.1.8' });
        expect(channelOf(STANDARD_MAPPING.language)).to.equal('device');
        expect(channelOf(STANDARD_MAPPING.DeviceVersion)).to.equal('device');
    });

    it('shares the total-filter names with the AC3221 D-code spellings', () => {
        // Same friendly names on both generations: a device only ever sends one of the two
        // spellings, and updateStatus() guards against writing a name twice per frame.
        expect(STANDARD_MAPPING.flttotal0.name).to.equal(MODEL_MAPPING.AC3221.D05207.name);
        expect(STANDARD_MAPPING.flttotal1.name).to.equal(MODEL_MAPPING.AC3221.D05408.name);
    });

    it('still exposes the eight classic controls that a wrong model selection hides', () => {
        // The AC4236/14 log from #150: with AC3221 selected these all fell through to
        // unknownStates.*, which is what "operation mode is missing" was about.
        ['om', 'pwr', 'cl', 'aqil', 'uil', 'aqit', 'ddp', 'mode'].forEach(rawKey => {
            expect(modelsOwningRawKey(rawKey)).to.deep.equal(['AC2889']);
        });
    });
});

describe('mapping - renameReported reports what it actually renamed', () => {
    it('returns the assigned friendly names, not merely the keys present afterwards', () => {
        const { renameReported } = createMapping('AC2889');
        const reported = { pwr: '1', pm25: 7, D09999: 1 };
        const renamed = renameReported(reported);
        expect(renamed).to.be.instanceOf(Set);
        expect([...renamed].sort()).to.deep.equal(['pm25', 'power']);
        // The unmapped D-code survives untouched and is NOT reported as renamed.
        expect(reported.D09999).to.equal(1);
    });

    it('does not claim a raw key that only collides with a friendly name (GitHub #150)', () => {
        // With AC3221 selected, `mode` is the friendly name of the D0310C control - but the raw key
        // `mode` sent by a classic device is not mapped at all. Reporting it as renamed made the
        // adapter write the raw code "AG" into control.mode and hid it from unknownStates.
        const { renameReported } = createMapping('AC3221');
        const reported = { mode: 'AG', D03102: 1 };
        const renamed = renameReported(reported);
        expect(renamed.has('power')).to.be.true;
        expect(renamed.has('mode')).to.be.false;
        expect(reported.mode).to.equal('AG');
    });

    it('claims a key whose raw spelling equals its own friendly name', () => {
        // `pm25` and `name` are mapped to themselves - those must count as renamed, or a correctly
        // mapped sensor would end up in unknownStates.
        const { renameReported } = createMapping('AC2889');
        const renamed = renameReported({ pm25: 7, name: 'Galerie' });
        expect(renamed.has('pm25')).to.be.true;
        expect(renamed.has('name')).to.be.true;
    });

    it('returns an empty set for a missing status', () => {
        const { renameReported } = createMapping('AC2889');
        expect([...renameReported(undefined)]).to.deep.equal([]);
    });
});
