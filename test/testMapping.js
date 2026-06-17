const { expect } = require('chai');
const { NAME_MAPPING, renameReported, buildControlPayload } = require('../lib/mapping');

describe('mapping - renameReported', () => {
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

describe('mapping - buildControlPayload', () => {
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

describe('mapping - NAME_MAPPING', () => {
    it('is a non-empty shared object used by both protocols', () => {
        expect(NAME_MAPPING).to.be.an('object');
        expect(Object.keys(NAME_MAPPING).length).to.be.greaterThan(30);
        expect(NAME_MAPPING.err.name).to.equal('error');
    });
});
