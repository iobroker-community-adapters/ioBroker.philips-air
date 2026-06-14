const { expect } = require('chai');
const crypto = require('node:crypto');
const HttpClient = require('../lib/httpClient');

const { aesEncrypt, encrypt, decrypt, pkcs7Pad, pkcs7Unpad } = HttpClient._crypto;

// Diffie-Hellman parameters of the Philips encrypted-HTTP protocol (same as the client).
const G =
    'A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5';
const P =
    'B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371';

describe('httpClient - crypto', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

    it('pkcs7 pad/unpad round-trips and pads to the block size', () => {
        const padded = pkcs7Pad(Buffer.from('hello'), 16);
        expect(padded.length % 16).to.equal(0);
        expect(pkcs7Unpad(padded).toString()).to.equal('hello');
    });

    it('encrypt/decrypt round-trips JSON payloads of different lengths', () => {
        const samples = [
            JSON.stringify({ om: '3', pwr: '1' }),
            JSON.stringify({ mode: 'P', rhset: 60, name: 'Wohnzimmer' }),
            '{}',
            JSON.stringify({ long: 'value-crossing-an-aes-block-boundary-xxxxxxxxxx' }),
        ];
        for (const s of samples) {
            expect(decrypt(encrypt(s, key), key)).to.equal(s);
        }
    });
});

describe('httpClient - protocol (mocked device)', () => {
    let originalFetch;
    let device;

    beforeEach(() => {
        originalFetch = global.fetch;
        // simulated device performing the other half of the DH key exchange
        const dh = crypto.createDiffieHellman(P, 'hex', G, 'hex');
        dh.generateKeys();
        const sessionKey = crypto.randomBytes(16);
        device = { dh, sessionKey, lastControl: null };

        global.fetch = async (url, init = {}) => {
            if (url.endsWith('/di/v1/products/0/security')) {
                const body = JSON.parse(init.body);
                const secret = dh.computeSecret(body.diffie, 'hex', 'hex');
                const secretBytes = Buffer.from(secret, 'hex').subarray(0, 16);
                const encKey = aesEncrypt(sessionKey, secretBytes).toString('hex');
                return { ok: true, status: 200, statusText: 'OK', json: async () => ({ hellman: dh.getPublicKey('hex'), key: encKey }) };
            }
            if (url.endsWith('/di/v1/products/1/air') && init.method === 'PUT') {
                device.lastControl = init.body;
                return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
            }
            if (url.endsWith('/di/v1/products/1/air')) {
                return { ok: true, status: 200, statusText: 'OK', text: async () => encrypt(JSON.stringify({ om: 'a', pwr: '1' }), sessionKey) };
            }
            throw new Error(`unexpected url ${url}`);
        };
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('negotiates the session key via Diffie-Hellman and decrypts the status', async () => {
        const client = new HttpClient('127.0.0.1', 5000);
        const status = await client.getStatus();
        expect(status).to.deep.equal({ om: 'a', pwr: '1' });
        expect(Buffer.compare(client.key, device.sessionKey)).to.equal(0);
    });

    it('encrypts control values the device can decrypt', async () => {
        const client = new HttpClient('127.0.0.1', 5000);
        await client.setValues({ om: 't' });
        expect(decrypt(device.lastControl, device.sessionKey)).to.equal(JSON.stringify({ om: 't' }));
    });
});
