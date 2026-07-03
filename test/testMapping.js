const { expect } = require('chai');
const { createMapping, channelOf, STANDARD_MAPPING, MODEL_MAPPING } = require('../lib/mapping');

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
    it('falls back to AC2889 controls for an undefined model', () => {
        const { mapping } = createMapping(undefined);
        expect(mapping.pwr).to.deep.equal(MODEL_MAPPING.AC2889.pwr);
    });

    it('falls back to AC2889 controls for an unknown/mistyped model string', () => {
        const { mapping } = createMapping('AC2889-typo');
        expect(mapping.pwr).to.deep.equal(MODEL_MAPPING.AC2889.pwr);
        expect(mapping.D03102).to.be.undefined;
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
        const { mapping } = createMapping('AC2889');
        expect(mapping).to.not.have.property('D03105');
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
