const { expect } = require('chai');
const AirPurifier = require('../lib/coap');

// Build an instance without running the constructor (which would start networking).
function makeInstance(clientKey = 'AABBCCDD') {
    const inst = Object.create(AirPurifier.prototype);
    inst.clientKey = clientKey;
    inst.deviceIp = '127.0.0.1';
    inst.emit = () => {};
    return inst;
}

describe('coap - encryption', () => {
    it('encryptPayload output can be decrypted back to the original payload', async () => {
        const inst = makeInstance();
        const payload = { state: { desired: { om: '1', pwr: '1', CommandType: 'app' } } };

        const encrypted = await inst.encryptPayload(payload);
        expect(encrypted).to.be.a('string');

        const decrypted = await inst.decryptPayload(Buffer.from(encrypted));
        expect(JSON.parse(decrypted)).to.deep.equal(payload);
    });

    it('decryptPayload rejects a tampered (corrupted) message', async () => {
        const inst = makeInstance();
        const encrypted = await inst.encryptPayload({ a: 1 });
        // flip a character in the encrypted body to break the digest
        const tampered = `${encrypted.slice(0, 12)}${encrypted[12] === '0' ? '1' : '0'}${encrypted.slice(13)}`;
        expect(() => inst.decryptPayload(Buffer.from(tampered))).to.throw(/corrupted/i);
    });

    it('updateClientKey increments the key as an 8-char uppercase hex counter', () => {
        const inst = makeInstance('0000000F');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('00000010');
    });

    it('updateClientKey handles keys with the high bit set (unsigned 32-bit)', () => {
        const inst = makeInstance('AABBCCDD');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('AABBCCDE');
    });

    it('updateClientKey wraps around at 0xFFFFFFFF', () => {
        const inst = makeInstance('FFFFFFFF');
        inst.updateClientKey();
        expect(inst.clientKey).to.equal('00000000');
    });
});

describe('coap - renameAttributes', () => {
    function rename(reported) {
        const inst = makeInstance();
        const status = { state: { reported } };
        inst.renameAttributes(status);
        return status.state.reported;
    }

    it('keeps numeric and boolean values native instead of stringifying them', () => {
        const r = rename({ pm25: 7, aqil: 50, Runtime: 123456, fltsts1: 1804 });
        expect(r.pm25).to.equal(7);
        expect(r.lightBrightness).to.equal(50);
        expect(r.uptime).to.equal(123456);
        expect(r.hepaFilterReplaceInHours).to.equal(1804);
    });

    it('maps option values (power, childLock, mode, fanSpeed)', () => {
        const r = rename({ pwr: '1', cl: 0, mode: 'M', om: 'a' });
        expect(r.power).to.equal(true);
        expect(r.childLock).to.equal(false);
        expect(r.mode).to.equal('manual');
        expect(r.fanSpeed).to.equal('auto');
    });

    it('maps known error codes and keeps unknown ones numeric', () => {
        expect(rename({ err: 0 }).error).to.equal('none');
        expect(rename({ err: 193 }).error).to.equal('pre-filter must be cleaned');
        expect(rename({ err: 0x8000 }).error).to.equal('water tank open');
        expect(rename({ err: 12345 }).error).to.equal(12345);
    });
});
