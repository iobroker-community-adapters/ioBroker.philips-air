const crypto = require('node:crypto');

// Diffie-Hellman parameters used by the Philips "encrypted HTTP" protocol.
// Ported from the `philips-air` npm package (HttpClient) to drop the axios/aes-js/pkcs7-padding
// dependency chain in favour of the built-in node:crypto and the global fetch API.
const G =
    'A4D1CBD5C3FD34126765A442EFB99905F8104DD258AC507FD6406CFF14266D31266FEA1E5C41564B777E690F5504F213160217B4B01B886A5E91547F9E2749F4D7FBD7D3B9A92EE1909D0D2263F80A76A6A24C087A091F531DBF0A0169B6A28AD662A4D18E73AFA32D779D5918D08BC8858F4DCEF97C2A24855E6EEB22B3B2E5';
const P =
    'B10B8F96A080E01DDE92DE5EAE5D54EC52C99FBCFB06A3C69A6A9DCA52D23B616073E28675A23D189838EF1E2EE652C013ECB4AEA906112324975C3CD49B83BFACCBDD7D90C4BD7098488E9C219A73724EFFD6FAE5644738FAA31A4FF55BCCC0A151AF5F0DC8B4BD45BF37DF365C1A65E68CFDA76D4DA708DF1FB2BC2E4A4371';

// The protocol uses AES-128-CBC with a fixed all-zero IV and raw (un-padded) block operations.
// PKCS#7 padding is applied manually around the cipher, just like the original implementation.
const ZERO_IV = Buffer.alloc(16, 0);

/**
 * Decrypt raw AES-128-CBC data (no automatic padding handling).
 *
 * @param data hex string or raw buffer to decrypt
 * @param key 16-byte AES key buffer
 * @returns the decrypted bytes
 */
function aesDecrypt(data, key) {
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, ZERO_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(input), decipher.final()]);
}

/**
 * Encrypt raw AES-128-CBC data (no automatic padding handling).
 *
 * @param data already PKCS#7-padded plaintext buffer
 * @param key 16-byte AES key buffer
 * @returns the encrypted bytes
 */
function aesEncrypt(data, key) {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, ZERO_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * Pad a buffer to a multiple of the block size using PKCS#7.
 *
 * @param buf data buffer to pad
 * @param blockSize AES block size
 * @returns the PKCS#7-padded buffer
 */
function pkcs7Pad(buf, blockSize = 16) {
    const padLen = blockSize - (buf.length % blockSize) || blockSize;
    return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

/**
 * Remove the PKCS#7 padding from a buffer.
 *
 * @param buf PKCS#7-padded buffer
 * @returns the buffer with the padding removed
 */
function pkcs7Unpad(buf) {
    const padLen = buf[buf.length - 1];
    return buf.subarray(0, buf.length - padLen);
}

/**
 * Decrypt a base64 payload returned by the device.
 *
 * @param data base64 encoded payload
 * @param key 16-byte AES key buffer
 * @returns the decrypted plaintext
 */
function decrypt(data, key) {
    const payload = Buffer.from(data, 'base64');
    // The first two bytes are a fixed 'AA' marker prepended on encryption.
    const decrypted = aesDecrypt(payload, key).subarray(2);
    return pkcs7Unpad(decrypted).toString('latin1');
}

/**
 * Encrypt a plaintext payload for the device.
 *
 * @param data plaintext to encrypt
 * @param key 16-byte AES key buffer
 * @returns the base64 encoded payload
 */
function encrypt(data, key) {
    const padded = pkcs7Pad(Buffer.from(`AA${data}`, 'latin1'), 16);
    return aesEncrypt(padded, key).toString('base64');
}

/**
 * Minimal client for the Philips encrypted HTTP protocol, backed by node:crypto and global fetch.
 */
class HttpClient {
    /**
     * @param host device IP or hostname
     * @param timeout request timeout in ms
     * @param key previously negotiated AES key buffer (optional)
     */
    constructor(host, timeout = 5000, key) {
        this.host = host;
        if (key && key.length) {
            this.key = key;
        }
        this.timeout = timeout;
    }

    /**
     * Perform a fetch with the configured timeout and assert a successful status.
     *
     * @param url full request URL
     * @param init fetch init options
     * @returns the fetch response
     */
    async _fetch(url, init = {}) {
        const response = await fetch(url, { signal: AbortSignal.timeout(this.timeout), ...init });
        if (!response.ok) {
            throw new Error(`Unexpected response ${response.status} ${response.statusText} for ${url}`);
        }
        return response;
    }

    /**
     * Perform the Diffie-Hellman key exchange and store the negotiated AES key.
     *
     * @returns the negotiated 16-byte AES key buffer
     */
    async getKey() {
        const dh = crypto.createDiffieHellman(P, 'hex', G, 'hex');
        dh.generateKeys();
        const response = await this._fetch(`http://${this.host}/di/v1/products/0/security`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ diffie: dh.getPublicKey('hex') }),
        });
        const data = await response.json();
        const secret = dh.computeSecret(data.hellman, 'hex', 'hex');
        const secretBytes = Buffer.from(secret, 'hex').subarray(0, 16);
        this.key = aesDecrypt(data.key, secretBytes).subarray(0, 16);
        return this.key;
    }

    /**
     * Send a control payload to the device.
     *
     * @param values control payload to send
     */
    async setValues(values) {
        if (!this.key) {
            this.key = await this.getKey();
        }
        const encrypted = encrypt(JSON.stringify(values), this.key);
        await this._fetch(`http://${this.host}/di/v1/products/1/air`, {
            method: 'PUT',
            body: encrypted,
        });
    }

    /**
     * Fetch and decrypt a single endpoint.
     *
     * @param endpoint device endpoint path
     * @returns the decrypted response body
     */
    async getOnce(endpoint) {
        if (!this.key) {
            this.key = await this.getKey();
        }
        const response = await this._fetch(`http://${this.host}${endpoint}`);
        return decrypt(await response.text(), this.key);
    }

    /**
     * Fetch and parse a device endpoint, renegotiating the key once on failure.
     *
     * @param endpoint device endpoint path
     * @returns the parsed response object
     */
    getData(endpoint) {
        return this.getOnce(endpoint)
            .catch(() => this.getKey())
            .then(() => this.getOnce(endpoint))
            .then(data => JSON.parse(data));
    }

    /**
     * @returns the parsed device status (air values)
     */
    getStatus() {
        return this.getData('/di/v1/products/1/air');
    }

    /**
     * @returns the parsed firmware information
     */
    getFirmware() {
        return this.getData('/di/v1/products/0/firmware');
    }

    /**
     * @returns the parsed filter information
     */
    getFilters() {
        return this.getData('/di/v1/products/1/fltsts');
    }

    /**
     * @returns the parsed wifi information
     */
    getWifi() {
        return this.getData('/di/v1/products/0/wifi');
    }
}

module.exports = HttpClient;
module.exports.HttpClient = HttpClient;
// Exported for unit testing of the crypto layer only.
module.exports._crypto = { aesDecrypt, aesEncrypt, pkcs7Pad, pkcs7Unpad, encrypt, decrypt };
