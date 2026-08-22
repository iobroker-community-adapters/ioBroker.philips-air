const { expect } = require('chai');
const crypto = require('node:crypto');
const http = require('node:http');
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

describe('httpClient - protocol (against a real HTTP server)', () => {
    let server;
    let device;
    let host;

    // A real server rather than a fetch/http stub: issue #383 was caused by the headers the client
    // put on the wire, which a stub cannot see. The device half of the protocol is simulated, the
    // transport is not.
    beforeEach(async () => {
        const dh = crypto.createDiffieHellman(P, 'hex', G, 'hex');
        dh.generateKeys();
        const sessionKey = crypto.randomBytes(16);
        device = { dh, sessionKey, lastControl: null, controlResponse: '', requestHeaderNames: [] };

        server = http.createServer((req, res) => {
            // rawHeaders preserves the spelling the client used - lower case names are what
            // undici sends and what the real devices choke on.
            device.requestHeaderNames = req.rawHeaders.filter((_, index) => index % 2 === 0);
            let body = '';
            req.setEncoding('utf8');
            req.on('data', chunk => (body += chunk));
            req.on('end', () => {
                const url = req.url ?? '';
                if (url.endsWith('/di/v1/products/0/security')) {
                    const secret = dh.computeSecret(JSON.parse(body).diffie, 'hex', 'hex');
                    const secretBytes = Buffer.from(secret, 'hex').subarray(0, 16);
                    const encKey = aesEncrypt(sessionKey, secretBytes).toString('hex');
                    res.end(JSON.stringify({ hellman: dh.getPublicKey('hex'), key: encKey }));
                    return;
                }
                if (url.endsWith('/di/v1/products/1/air') && req.method === 'PUT') {
                    device.lastControl = body;
                    res.end(device.controlResponse);
                    return;
                }
                if (url.endsWith('/di/v1/products/1/air')) {
                    res.end(encrypt(JSON.stringify({ om: 'a', pwr: '1' }), sessionKey));
                    return;
                }
                res.statusCode = 404;
                res.end();
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = /** @type {import('node:net').AddressInfo} */ (server.address());
        host = `127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    it('negotiates the session key via Diffie-Hellman and decrypts the status', async () => {
        const client = new HttpClient(host, 5000);
        const status = await client.getStatus();
        expect(status).to.deep.equal({ om: 'a', pwr: '1' });
        expect(Buffer.compare(/** @type {Buffer} */ (client.key), device.sessionKey)).to.equal(0);
    });

    it('encrypts control values the device can decrypt', async () => {
        const client = new HttpClient(host, 5000);
        await client.setValues({ om: 't' });
        expect(decrypt(device.lastControl, device.sessionKey)).to.equal(JSON.stringify({ om: 't' }));
    });

    it('returns the decrypted answer of a control command', async () => {
        const client = new HttpClient(host, 5000);
        await client.getStatus(); // negotiate the session key first
        device.controlResponse = encrypt(JSON.stringify({ om: 't', pwr: '1' }), device.sessionKey);
        expect(await client.setValues({ om: 't' })).to.equal(JSON.stringify({ om: 't', pwr: '1' }));
    });

    it('returns an empty string when the device answers a control command with an empty body', async () => {
        const client = new HttpClient(host, 5000);
        expect(await client.setValues({ om: 't' })).to.equal('');
    });

    it('gives up after the configured timeout when the device never answers', async () => {
        // A server that accepts the connection and then stays silent. node:http's own timeout
        // option fires on socket inactivity only; the hard deadline is what must end this.
        const silent = http.createServer(() => {});
        await new Promise(resolve => silent.listen(0, '127.0.0.1', () => resolve(undefined)));
        const silentAddress = /** @type {import('node:net').AddressInfo} */ (silent.address());
        try {
            const client = new HttpClient(`127.0.0.1:${silentAddress.port}`, 150);
            const started = Date.now();
            await client.getStatus().then(
                () => expect.fail('should have timed out'),
                error => {
                    expect(error.message).to.match(/No response from/);
                    expect(Date.now() - started).to.be.below(2000);
                },
            );
        } finally {
            await new Promise(resolve => silent.close(() => resolve(undefined)));
        }
    });

    // Regression guard for issue #383: the devices answer 1.3.0 but not the fetch-based 1.4.0.
    it('sends no header the embedded web server rejects', async () => {
        const client = new HttpClient(host, 5000);
        await client.getStatus();
        const names = device.requestHeaderNames.map(name => name.toLowerCase());
        // undici asks for compression and adds browser-style headers; the working clients do not
        expect(names).to.not.include('accept-encoding');
        expect(names).to.not.include('accept-language');
        expect(names).to.not.include('sec-fetch-mode');
        // and it writes every header name in lower case, which a case-sensitive server misses
        for (const name of device.requestHeaderNames) {
            expect(name[0]).to.equal(name[0].toUpperCase(), `header "${name}" must not be lower case`);
        }
    });
});
