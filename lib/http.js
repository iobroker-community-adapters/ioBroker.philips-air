const EventEmitter = require('node:events');
const HttpClient = require('./httpClient');
const { NAME_MAPPING, renameReported, buildControlPayload } = require('./mapping');

// events:
// - 'status', data
// - 'connected', true
// - 'connected', false

/**
 * HTTP client for Philips air purifiers, emitting status/connected/info/debug/error events.
 */
class AirPurifier extends EventEmitter {
    /**
     * @param deviceIp device IP or hostname
     * @param options adapter config (aliveTimeout, reconnectInterval)
     * @param adapter the ioBroker adapter instance (state access and logging)
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

        this.adapter.getState('info.key', async (err, state) => {
            if (this.destroyed) {
                return;
            }
            if (err) {
                this.emit('error', `Cannot read stored key: ${err.message ? err.message : err}`);
            }
            // On a fresh install there is no stored key yet - start with an empty buffer and let the
            // HTTP client negotiate a new one. Previously Buffer.from(null) threw and crashed startup.
            const storedKey = state && state.val;
            this.clientKey = storedKey ? Buffer.from(storedKey, 'base64') : Buffer.alloc(0);
            this.client = new HttpClient(deviceIp, this.aliveTimeout, this.clientKey);
            // Attempt the first connection immediately; sync() schedules its own retry on failure.
            this.sync();
        });
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
     * Stop all timers and release the HTTP client.
     */
    destroy() {
        this.destroyed = true;
        this.pingTimeout && clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
        this.client = null;
    }

    /**
     * Persist a refreshed key, mark the connection alive and emit the renamed status.
     *
     * @param status a parsed or raw response from the device
     */
    async processResponse(status) {
        const key = this.client.key.toString('base64');
        if (this.clientKey !== key) {
            this.emit('debug', `Update client key: ${this.clientKey}`);
            this.clientKey = key;
            // store new key
            await this.adapter.setStateAsync('info.key', this.clientKey, true);
        }
        if (!this.connected) {
            this.connected = true;
            this.emit('connected', true);
            this.emit('info', `Connected to ${this.deviceIp} using HTTP`);
        }
        if (typeof status !== 'object') {
            try {
                status = JSON.parse(status);
            } catch {
                this.emit('error', `Cannot parse: ${status}`);
                return;
            }
        }
        this.renameAttributes(status);
        this.emit('status', status);
    }
    /**
     * Poll the device for status, firmware, filters and wifi, scheduling the next poll or a retry.
     */
    async sync() {
        this.emit('debug', `Syncing with ${this.deviceIp} (HTTP)...`);
        try {
            const status = await this.client.getStatus();
            await this.processResponse(status);
            const firmware = await this.client.getFirmware();
            await this.processResponse(firmware);
            const filters = await this.client.getFilters();
            await this.processResponse(filters);
            const wifi = await this.client.getWifi();
            await this.processResponse(wifi);
        } catch (error) {
            // Always surface the failure - previously the first connection error was swallowed because
            // `this.connected` was still false, which left the user without any log output at all.
            // node's fetch hides the real reason in error.cause (ECONNREFUSED, EHOSTUNREACH, ...),
            // which is what actually tells the user whether the device is down or not speaking HTTP.
            const message = error && error.message ? error.message : error;
            const code = error && error.cause && error.cause.code;
            const cause = error && error.cause ? ` (${code || error.cause.message || error.cause})` : '';
            this.emit(
                'error',
                `Connection to ${this.deviceIp} (HTTP) failed, retry in ${Math.round(this.reconnectInterval / 1000)}s: ${message}${cause}`,
            );
            // Help the user interpret the failure: a refused/unreachable connection on the HTTP port
            // almost always means the device only supports CoAP. Emit the hint once, not every retry.
            if (!this._hintShown && ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) {
                this._hintShown = true;
                this.emit(
                    'info',
                    `The device at ${this.deviceIp} refused or did not answer the HTTP connection (${code}). ` +
                        `Most Philips air devices only support CoAP - try switching "Communication protocol" to "CoAP" in the instance settings.`,
                );
            }
            if (this.connected) {
                this.connected = false;
                this.emit('connected', false);
            }

            this._reconnect();
            return;
        }
        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;

        this.pingTimeout && clearTimeout(this.pingTimeout);
        this.pingTimeout = setTimeout(() => {
            this.pingTimeout = null;
            this.sync();
        }, this.aliveTimeout);
    }

    /**
     * Schedule a single delayed reconnect attempt. It must NOT call sync() directly: sync()'s catch
     * calls _reconnect(), so an immediate sync() here would create a tight retry loop with no delay.
     */
    _reconnect() {
        if (this.destroyed) {
            return;
        }
        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
        this.pingTimeout && clearTimeout(this.pingTimeout);
        this.pingTimeout = null;

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.sync();
        }, this.reconnectInterval);
    }

    /**
     * Send a control command to the device.
     *
     * @param settings mapping of state names to desired values
     * @returns the parsed device response
     */
    control(settings) {
        const payload = buildControlPayload(settings);

        return this.client.setValues(payload).then(async data => {
            const key = this.client.key.toString('base64');
            if (this.clientKey !== key) {
                this.emit('debug', `Update client key: ${this.clientKey}`);
                this.clientKey = key;
                // store new key
                await this.adapter.setStateAsync('info.key', this.clientKey, true);
            }

            this.pingTimeout && clearTimeout(this.pingTimeout);
            this.pingTimeout = setTimeout(() => this.sync(), this.aliveTimeout);

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
        renameReported(status);
    }
}

module.exports = AirPurifier;
