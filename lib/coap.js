const EventEmitter = require('node:events');
const coap = require('coap');
const crypto = require('node:crypto');
const { NAME_MAPPING, renameReported, buildControlPayload } = require('./mapping');

const ALGORITHM = 'aes-128-cbc';
const SECRET_KEY = 'JiangPan';

// events:
// - 'status', data
// - 'connected', true
// - 'connected', false

/**
 * Encrypted-CoAP client for Philips air purifiers, emitting status/connected/info/debug/error events.
 */
class AirPurifier extends EventEmitter {
    /**
     * @param deviceIp device IP or hostname
     * @param options adapter config (aliveTimeout, reconnectInterval)
     * @param adapter the ioBroker adapter instance (managed timers and logging)
     */
    constructor(deviceIp, options, adapter) {
        super();
        this.adapter = adapter;
        options = Object.assign({ aliveTimeout: 30000, reconnectInterval: 30000 }, options);

        this.deviceIp = deviceIp;

        this.clientKey = '';

        this.connected = false;

        this.aliveTimeout = parseInt(options.aliveTimeout, 10) || 30000;
        this.reconnectInterval = parseInt(options.reconnectInterval, 10) || 30000;
        this.subscribeTimeout = Math.max(
            parseInt(options.subscribeTimeout, 10) || this.aliveTimeout,
            this.aliveTimeout,
        );
        // A retry must not fire before an in-flight request has timed out, otherwise overlapping
        // /sys/dev/sync POSTs pile up against the device. The per-request bound is aliveTimeout. The
        // admin config already flags this (validator), but enforce it here too and tell the user.
        if (this.reconnectInterval < this.aliveTimeout) {
            this.adapter.log.warn(
                `Reconnect interval (${this.reconnectInterval} ms) is shorter than Alive timeout ` +
                    `(${this.aliveTimeout} ms); using ${this.aliveTimeout} ms to avoid overlapping requests.`,
            );
            this.reconnectInterval = this.aliveTimeout;
        }
        // The observe subscription is push-based: the device sends status spontaneously (a heartbeat
        // every few minutes plus on change). Treat the stream as dead only after several missed
        // heartbeats, not after a single aliveTimeout, so normal quiet periods are not mistaken for a
        // disconnect. Kept well above the observed ~3 min device heartbeat.
        this.staleTimeout = Math.max(this.aliveTimeout * 10, 120000);
        // Defer the initial connect so the caller (main.js) can attach its event listeners first -
        // otherwise the first debug/error/info events emitted during connect would be lost.
        setImmediate(() => this._reconnect());
    }

    /**
     * @returns the attribute name mapping used by this protocol
     */
    static getMapping() {
        return NAME_MAPPING;
    }

    /**
     * @returns whether the device is currently connected
     */
    getConnected() {
        return this.connected;
    }

    /**
     * Stop all timers and tear down the observe request.
     */
    destroy() {
        this.destroyed = true;
        this.pingTimeout && this.adapter.clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
        this.reconnectTimeout && this.adapter.clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
        this._closeStatusRequest();
    }

    /**
     * Stop a CoAP request without crashing the process.
     *
     * req.reset() generates an RST (empty 0.00) message from the request packet but leaves its
     * options in place, producing an invalid empty message. node-coap re-parses outgoing messages
     * without a try/catch (retry_send), throwing "Empty messages must be empty" - sometimes
     * asynchronously from a retransmit timer, which crashes the whole adapter (node-coap issue #175).
     * Resetting the sender directly stops the retransmission timers the same way the library does
     * internally, without generating or re-parsing any message.
     *
     * @param req the CoAP request to stop
     */
    _safeReset(req) {
        if (!req) {
            return;
        }
        try {
            if (req.sender && typeof req.sender.reset === 'function') {
                req.sender.reset();
            }
        } catch (err) {
            this.emit('debug', `Could not reset request: ${err && err.message ? err.message : err}`);
        }
    }

    /**
     * Safely tear down the current observe request.
     */
    _closeStatusRequest() {
        this._safeReset(this._statusRequest);
        this._statusRequest = null;
    }

    /**
     * Negotiate a fresh client key with the device.
     */
    async sync() {
        const syncRequest = [0, 0, 0, 0]
            .map(() =>
                Math.round(Math.random() * 0xff)
                    .toString(16)
                    .padStart(2, '0'),
            )
            .join('')
            .toUpperCase();
        this.clientKey = (await this._post('/sys/dev/sync', syncRequest)).toString();
    }

    /**
     * Send a CoAP POST and resolve with the response buffer.
     *
     * @param path request path
     * @param payload request body
     * @returns the response buffer
     */
    _post(path, payload) {
        return new Promise((resolve, reject) => {
            const req = coap.request({
                method: 'POST',
                pathname: path,
                host: this.deviceIp,
            });
            this.emit('debug', `POST ${path} to ${this.deviceIp}`);

            let settled = false;
            // Bound the wait ourselves and always reset the request when done. If the device never
            // answers a confirmable POST, the coap library otherwise keeps the exchange alive for its
            // full exchangeLifetime (~247s) and then emits a late 'error' on its internal retry timer.
            // That emission has no listener and crashed the whole adapter (UNCAUGHT_EXCEPTION).
            // reset() clears that internal timer, so the late error can never fire.
            const settle = (fn, arg, doReset) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.adapter.clearTimeout(timer);
                if (doReset) {
                    this._safeReset(req);
                }
                fn(arg);
            };
            const timer = this.adapter.setTimeout(
                () => settle(reject, new Error(`No response from ${this.deviceIp} for POST ${path}`), true),
                this.aliveTimeout,
            );

            req.on('response', res => {
                this.emit('debug', `Response incoming`);
                const data = [];
                res.on('error', err => {
                    this.emit('error', `Error by receiving: ${err}`);
                    res.close();
                    settle(reject, err, true);
                });

                res.on('data', chunk => {
                    this.emit('debug', `Response data incoming: ${JSON.stringify(chunk)}`);
                    data.push(chunk);
                });

                res.on('end', () => {
                    const received = Buffer.concat(data);
                    this.emit('debug', `Received: ${received.toString()}`);
                    settle(resolve, received, false);
                });
            });
            req.on('error', err => {
                this.emit('error', `Error by sending: ${err}`);
                settle(reject, err, true);
            });
            req.write(Buffer.from(payload));
            req.end();
        });
    }

    /**
     * Re-establish the connection: schedule the next retry, then sync and subscribe.
     */
    async _reconnect() {
        if (this.destroyed) {
            return;
        }
        if (this.connected) {
            this.connected = false;
            this.emit('connected', false);
            this.emit('info', `Connection to ${this.deviceIp} (CoAP) lost, reconnecting...`);
        }

        this.reconnectTimeout && this.adapter.clearTimeout(this.reconnectTimeout);

        this.reconnectTimeout = this.adapter.setTimeout(() => {
            this.reconnectTimeout = null;
            this._reconnect();
        }, this.reconnectInterval);

        try {
            // Sync MUST run before subscribing: the device only starts pushing observe notifications on
            // /sys/dev/status once the /sys/dev/sync handshake has established the session. Subscribing
            // first would wait forever for data that never comes. The keepalive is what changed (it no
            // longer re-syncs, see _checkAlive) - the connect handshake itself stays sync-then-subscribe.
            this.emit('debug', `Connecting to ${this.deviceIp} (CoAP): syncing key...`);
            await this.sync();
            this.emit('debug', `Key synced (${this.clientKey || 'empty'}), subscribing to status...`);
            this._markConnected(`Connected to ${this.deviceIp} using CoAP`);
            await this._subscribeOnStatus();
        } catch (err) {
            // sync()/subscribe may now reject (e.g. device offline). The reconnect timer scheduled above
            // will retry, so just surface the error instead of producing an unhandled rejection.
            this._failedAttempts = (this._failedAttempts || 0) + 1;
            this.emit(
                'error',
                `Connection to ${this.deviceIp} (CoAP) failed, retry in ${Math.round(this.reconnectInterval / 1000)}s: ${err && err.message ? err.message : err}`,
            );
            // After a few failed attempts in a row, hint at a device power-cycle. Philips devices are
            // known to stop answering until restarted. Emit once (=== threshold) to avoid log spam.
            if (this._failedAttempts === 3) {
                this.emit(
                    'info',
                    `${this.deviceIp} has not answered for several attempts. If it stays unreachable, try power-cycling the device (unplug it briefly) - Philips air devices can stop responding until restarted.`,
                );
            }
        }
    }

    /**
     * Watchdog for the push-based observe stream. It fires only when no status arrived for staleTimeout,
     * i.e. several device heartbeats were missed, so the subscription (or the device) is gone and we
     * re-establish. We deliberately do NOT probe with a /sys/dev/sync POST: some firmwares (e.g. AC2889
     * fw 1.0.7) never answer it even while happily pushing status, which caused false "connection lost"
     * flapping. Liveness is inferred from incoming observe data instead (see _subscribeOnStatus).
     */
    _checkAlive() {
        if (this.destroyed) {
            return;
        }
        this.emit(
            'debug',
            `No status from ${this.deviceIp} (CoAP) for ${Math.round(this.staleTimeout / 1000)}s, reconnecting...`,
        );
        this._reconnect();
    }

    /**
     * Mark the CoAP session as usable and arm the quiet-stream watchdog.
     *
     * @param message connection message emitted when the session was previously disconnected
     */
    _markConnected(message) {
        if (!this.connected) {
            this.connected = true;
            this._failedAttempts = 0;
            this.emit('connected', true);
            this.emit('info', message);
        }
        this.reconnectTimeout && this.adapter.clearTimeout(this.reconnectTimeout);
        this.pingTimeout && this.adapter.clearTimeout(this.pingTimeout);
        this.pingTimeout = this.adapter.setTimeout(() => this._checkAlive(), this.staleTimeout);
    }

    /**
     * Subscribe to the device status via a CoAP observe request.
     *
     * @returns resolves once the subscription is established
     */
    _subscribeOnStatus() {
        return new Promise((resolve, reject) => {
            this.emit('debug', `GET /sys/dev/status to ${this.deviceIp}`);
            // Close any previous observe request before opening a new one, otherwise every reconnect
            // leaks an additional CoAP observer that keeps receiving and decrypting payloads.
            // reset() on an observe request that already received data can throw "Empty messages must
            // be empty" (node-coap issue #175). Guard it so a failed cleanup never aborts the
            // re-subscription - otherwise the connection can never recover.
            this._closeStatusRequest();

            // Bound the wait for the first notification. Some CX3550/01 firmwares keep the observe
            // stream quiet after a successful sync even though control commands work. Treat that as a
            // usable but quiet session and keep the observe request open for later status packets.
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.adapter.clearTimeout(timer);
                fn(arg);
            };
            const timer = this.adapter.setTimeout(() => {
                this._markConnected(
                    `Connected to ${this.deviceIp} using CoAP; waiting for status updates from quiet observe stream`,
                );
                this.emit(
                    'debug',
                    `No status from ${this.deviceIp} after subscribe within ${Math.round(
                        this.subscribeTimeout / 1000,
                    )}s; keeping observe stream open`,
                );
                settle(resolve);
            }, this.subscribeTimeout);

            this._statusRequest = coap.request({
                method: 'GET',
                pathname: '/sys/dev/status',
                host: this.deviceIp,
                observe: true,
                confirmable: false,
            });

            this._statusRequest.on('response', res => {
                res.on('error', err => {
                    this.emit('error', `Error by receiving: ${err}`);
                    res.close();
                    settle(reject, err);
                });

                res.on('data', chunk => {
                    this.emit('debug', `Subscription data incoming: ${JSON.stringify(chunk)}`);
                    // decryptPayload may throw synchronously (e.g. corrupted message) - guard it so a single
                    // bad packet cannot crash the adapter, and surface the reason in the log.
                    let decryptPromise;
                    try {
                        decryptPromise = this.decryptPayload(chunk);
                    } catch (err) {
                        this.emit('warn', `Ignoring undecryptable status packet from ${this.deviceIp}: ${err.message}`);
                        return;
                    }
                    decryptPromise
                        .then(status => {
                            this.emit('debug', `Received status: ${status}`);
                            try {
                                status = JSON.parse(status);
                                this.renameAttributes(status);
                            } catch (err) {
                                this.emit(
                                    'error',
                                    `Cannot parse status from ${this.deviceIp}: ${
                                        err && err.message ? err.message : err
                                    }; raw=${status}`,
                                );
                                return;
                            }

                            // Each incoming notification re-arms the staleness watchdog: as long as the
                            // device keeps pushing status we leave the observe untouched. Only a full
                            // staleTimeout of silence (several missed heartbeats) triggers a reconnect.
                            this._markConnected(`Connected to ${this.deviceIp} using CoAP`);

                            if (status && status.state && status.state.reported) {
                                this.emit('status', status.state.reported);
                            }
                        })
                        .catch(err => {
                            this.emit(
                                'warn',
                                `Ignoring undecryptable status packet from ${this.deviceIp}: ${
                                    err && err.message ? err.message : err
                                }`,
                            );
                        });

                    // Any notification proves the subscription is live - resolve the subscribe once.
                    settle(resolve);
                });
            });
            this._statusRequest.on('error', err => {
                this.emit('error', `Error by sending: ${err}`);
                settle(reject, err);
            });
            this._statusRequest.end();
        });
    }

    /**
     * Decrypt and verify an encrypted status payload from the device.
     *
     * @param encryptedData the encrypted payload buffer
     * @returns the decrypted plaintext
     */
    decryptPayload(encryptedData) {
        //payload = Buffer.from('ADFDB0A71FD72EC5D21C2A238846F3FB4D4A533299A43AA1748132DA0B950E05F1100B369641DD6A37F2479DA568D294ACB0970085ACDFA3C1EAED8084DDF28E19F86727F4E0381D34387DB059A8B7CC53C2109368EC6FCA48FCA427A2E4A4993A27627D52FDC2833871C8FB01A3CEF12A068BE7CB82E9A34A8D0A9BDEE8D0022BC2FE0863A13823CA4FF0F0F29A59A569148BBA5E7A7C8798F298A2150BB3723DBEB393735100E5C3AE88A80331CFEC89DDD22ED3E3157136A2CD9F856D6F18334716E679D3D2DF501621FBCD6645DAD8D8350DB812DE910F3AD98054807B8A8D40A5897A057AFA0DCEBDAFE2C7FFA113244936C6E7810B7FF2CA8EF4822B7CF4B0234BF28AA4CBA08BC83CA22A48686354CDB55302D50D9BF7AF3F8BE15F8DA3612DA0BE41BBC1596EC26D09EA4E64F5D862CAC0A58E40CCC53D095D4505D87A69845384F7B300175E6BA0904AFF7EDEA8FE00CC140B97E89BDA32CB761DE9EB06DE4EB6A3D2997900AEDBF1D2916AEF4427A46FF34DBA0930E2492B71C9D2D8E66E81E9BD155E056185D6FF304A2088B4D2D247C4E4DECA67A66EBE4AFCBD5D39242F5F2518DA9A996DBBE81BECA23FC44618FF4D6A125152CD64ECB1425930B273AE56DE5F79ADF20363D90D78933D8D5B241089A788780CCDC65660BB2E9AEB0B7C76FED1253CD81488C4B027B1219E20550DC697D1300DC520E0A25B496A59946FE5FBB7EFC3C91C44E6F3276C35014F35BFA75978834B366A8814A323D4A67DBA673A812C137FC9D48C03577B37B0A4277C2D82AA21F3959476A16B11467A8043A79643F8142D875AA3F6D7DB6742EB90B5CFC6F23C7BDEDB8415F9D598F9D32FF285D8BDBE0671E67672F0D098059A098A4EB62AA982C64EB2F14F54A43E2E6C');
        const encryptedDataStr = encryptedData.toString('utf8').replace(/\0/g, '');
        if (!/^[0-9A-Fa-f]+$/.test(encryptedDataStr) || encryptedDataStr.length < 72) {
            throw new Error(
                `Unexpected encrypted payload format: length=${encryptedDataStr.length}, head=${encryptedDataStr.substring(
                    0,
                    16,
                )}`,
            );
        }
        const encodedCounter = encryptedDataStr.substring(0, 8).toUpperCase();

        const keyAndIV = crypto
            .createHash('md5')
            .update(Buffer.from(SECRET_KEY + encodedCounter))
            .digest('hex')
            .toUpperCase();
        const halfKeyLen = Math.round(keyAndIV.length / 2);
        const secretKey = keyAndIV.slice(0, halfKeyLen);
        const iv = keyAndIV.slice(halfKeyLen);
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(secretKey), Buffer.from(iv));

        const encrypted = encryptedDataStr.substring(8, encryptedDataStr.length - 64);
        const strDigest = encodedCounter + encrypted;
        const hash = crypto.createHash('sha256').update(Buffer.from(strDigest)).digest('hex').toUpperCase();

        const digest = encryptedDataStr.substring(encryptedDataStr.length - 64);
        if (digest !== hash) {
            this.emit('debug', 'Ignoring status packet with invalid digest (Message corrupted)');
            throw new Error('Message corrupted');
        }
        let decrypted = '';
        try {
            decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
        } catch (err) {
            throw new Error(`Could not decrypt payload: ${err && err.message ? err.message : err}`);
        }
        return Promise.resolve(decrypted);
    }

    /**
     * Increment the client key counter used for the next encrypted command.
     */
    updateClientKey() {
        // Use >>> 0 (unsigned 32-bit) - & 0xffffffff would yield a negative number for keys with the
        // high bit set (>= 0x80000000), producing a broken "-..." key and corrupting control commands.
        this.clientKey = (((parseInt(this.clientKey, 16) || 0) + 1) >>> 0).toString(16).padStart(8, '0').toUpperCase();
        this.emit('debug', `Update client key: ${this.clientKey}`);
    }

    /**
     * Encrypt a control payload and append the integrity digest.
     *
     * @param payload the plaintext payload (object or string)
     * @returns the encrypted payload string
     */
    encryptPayload(payload) {
        this.updateClientKey();
        const keyAndIV = crypto
            .createHash('md5')
            .update(Buffer.from(SECRET_KEY + this.clientKey))
            .digest('hex')
            .toUpperCase();
        const halfKeyLen = Math.round(keyAndIV.length / 2);
        const secretKey = keyAndIV.slice(0, halfKeyLen);
        const iv = keyAndIV.slice(halfKeyLen);
        const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(secretKey), Buffer.from(iv));
        if (typeof payload === 'object') {
            payload = JSON.stringify(payload);
        }
        let encrypted = cipher.update(payload, 'utf8', 'hex').toUpperCase();
        encrypted += cipher.final('hex').toUpperCase();
        const strDigest = this.clientKey + encrypted;

        const hash = crypto.createHash('sha256').update(Buffer.from(strDigest)).digest('hex').toUpperCase();

        return Promise.resolve(this.clientKey + encrypted + hash);
    }

    /**
     * Send a control command to the device.
     *
     * @param settings mapping of state names to desired values
     * @returns the parsed device response
     */
    control(settings) {
        const payload = {
            state: {
                desired: {
                    CommandType: 'app',
                    DeviceId: '',
                    EnduserId: '',
                    ...buildControlPayload(settings),
                },
            },
        };

        return this.encryptPayload(payload)
            .then(encryptedPayload => this._post('/sys/dev/control', encryptedPayload))
            .then(data => {
                try {
                    data = JSON.parse(data);
                } catch {
                    this.emit('error', `Cannot parse: ${data}`);
                }
                this.emit('debug', `Data: ${JSON.stringify(data)}`);
                return data;
            });
    }

    /**
     * Rename raw device attributes to friendly state names and map option/typed values in place.
     *
     * @param status the parsed device status object
     */
    renameAttributes(status) {
        if (status && status.state) {
            renameReported(status.state.reported);
        }
    }
}

module.exports = AirPurifier;
