const EventEmitter = require('events');
const coap         = require('coap');
const crypto       = require('crypto');

const ALGORITHM  = 'aes-128-cbc';
const SECRET_KEY = 'JiangPan';

const NAME_MAPPING = {
    rhset:       {name: 'targetHumidity', control: true},
    func:        {name: 'function', options: {'P': 'purification', 'PH': 'humidification'}, control: true},
    pwr:         {name: 'power', options: {'1': true, '0': false}, control: true},
    om:          {name: 'fanSpeed', options: {'s': 'silent', 't': 'turbo', 'a': 'auto', '1': '1', '2': '2', '3': '3'}, control: true},
    aqil:        {name: 'lightBrightness', control: true},
    aqit:        {name: 'airQualityNotificationThreshold', control: true},
    uil:         {name: 'buttonLight', options: {'1': true, '0': false}, control: true},
    rh:          {name: 'humidity'},
    iaql:        {name: 'allergenIndex'},
    temp:        {name: 'temperature'},
    wl:          {name: 'waterLevel'},
    cl:          {name: 'childLock', control: true},
    swversion:   {name: 'softwareVersion', device: true},
    name:        {name: 'name', device: true},
    type:        {name: 'type', device: true},
    modelid:     {name: 'modelId', device: true},
    WifiVersion: {name: 'wifiVersion', device: true},
    ProductId:   {name: 'productId', device: true},
    DeviceId:    {name: 'deviceId', device: true},
    StatusType:  {name: 'statusType', device: true},
    ConnectType: {name: 'connectType', device: true},
    ota:         {name: 'overTheAirUpdates', device: true},
    Runtime:     {name: 'uptime', device: true},
    pm25:        {name: 'pm25'},
    tvoc:        {name: 'totalVolatileOrganicCompounds'},
    mode:        {name: 'mode', options: {'P': 'auto', 'A': 'allergen', 'S': 'sleep', 'M': 'manual', 'B': 'bacteria', 'N': 'night', 'T': 'turbo',  'AG': 'automode'}, control: true},
    ddp:         {name: 'usedIndex', options: {'3': 'humidity', '1': 'pm2.5', '0': 'iai'}, control: true},
    rddp:        {name: 'rddp'},
    dt:          {name: 'timerHours', control: true},
    dtrs:        {name: 'timerMinutes'},
    fltt1:       {name: 'hepaFilterType', options: {'A3': 'NanoProtect Filter Series 3 (FY2422)'}, filter: true},
    fltt2:       {name: 'activeCarbonFilterType', options: {'C7': 'NanoProtect Filter AC (FY2420)'}, filter: true},
    fltsts0:     {name: 'preFilterCleanInHours', filter: true},
    fltsts1:     {name: 'hepaFilterReplaceInHours', filter: true},
    fltsts2:     {name: 'activeCarbonFilterReplaceInHours', filter: true},
    wicksts:     {name: 'wickFilterReplaceInHours', filter: true},
    err:         {name: 'error', options: {0: 'none', 0xC100: 'no water', 0x8000: 'water tank open', 0xC003: 'pre-filter must be cleaned'}, device: true},
};

// events:
// - 'status', data
// - 'connected', true
// - 'connected', false

class AirPurifier extends EventEmitter {
    constructor(deviceIp, options) {
        super();
        options = Object.assign({aliveTimeout: 30000, reconnectInterval: 30000}, options);

        this.deviceIp = deviceIp;

        this.clientKey = '';

        this.connected = false;

        this.aliveTimeout      = parseInt(options.aliveTimeout, 10)      || 30000;
        this.reconnectInterval = parseInt(options.reconnectInterval, 10) || 30000;
        this._reconnect();
    }

    static getMapping() {
        return NAME_MAPPING;
    }

    getConnected() {
        return this.connected;
    }

    destroy() {
        this.pingTimeout && clearTimeout(this.pingTimeout);
        this.pingTimeout = null;
        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
        this._statusRequest && this._statusRequest.reset();
    }

    async sync() {
        const syncRequest = [0, 0, 0, 0].map(() => Math.round(Math.random() * 0xFF).toString(16).padStart(2, '0')).join('').toUpperCase();
        this.clientKey = (await this._post('/sys/dev/sync', syncRequest)).toString();
    }

    _post(path, payload) {
        return new Promise((resolve, reject) => {
            const req = coap.request({
                method: 'POST',
                pathname: path,
                host: this.deviceIp
            });
            this.emit('debug', `POST ${path} to ${this.deviceIp}`);

            req.on('response', res => {
                this.emit('debug', `Response incoming`);
                const data = [];
                res.on('error', err => {
                    console.error(`Error by receiving: ${err}`);
                    this.emit('error', `Error by receiving: ${err}`);
                    res.close();
                    reject(err);
                });

                res.on('data', chunk => {
                    this.emit('debug', `Response data incoming: ${JSON.stringify(chunk)}`);
                    data.push(chunk);
                });

                //res.pipe(process.stdout);
                res.on('end', () => {
                    const received = Buffer.concat(data);
                    console.log(`Received: ${received.toString()}`);
                    this.emit('debug', `Received: ${received.toString()}`);
                    resolve(received);
                });
            });
            req.on('error', err => {
                console.error(`Error by sending: ${err}`);
                this.emit('error', `Error by sending: ${err}`);

                //avoid exception
                //TypeError: req.abort is not a function at OutgoingMessage.<anonymous> (/opt/iobroker/node_modules/iobroker.philips-air/lib/coap.js:126:25) at OutgoingMessage.emit (node:events:394:28) at RetrySend.emit (node:events:394:28) at Timeout._onTimeout (/opt/iobroker/node_modules/coap/lib/retry_send.js:77:12) at listOnTimeout (node:internal/timers:557:17) at processTimers (node:internal/timers:500:7)
                //req.abort();

                //avoid exception
                //Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch().
                //reject(err);
            });
            req.write(Buffer.from(payload));
            req.end();
        });
    }

    async _reconnect() {
        if (this.connected) {
            this.connected = false;
            this.emit('connected', false);
        }

        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this._reconnect();
        }, this.reconnectInterval);

        await this.sync();
        await this._subscribeOnStatus();
    }

    _subscribeOnStatus() {
        return new Promise((resolve, reject) => {
            this.emit('debug', `GET /sys/dev/status to ${this.deviceIp}`);
            this._statusRequest = coap.request({
                method: 'GET',
                pathname: '/sys/dev/status',
                host: this.deviceIp,
                observe: true,
                confirmable: false,
            });

            this._statusRequest.on('response', res => {
                res.on('error', err => {
                    console.error('Error by receiving: ' + err);
                    this.emit('error', 'Error by receiving: ' + err);
                    res.close();
                    reject(err);
                });

                res.on('data', chunk => {
                    this.emit('debug', `Subscription data incoming: ${JSON.stringify(chunk)}`);
                    this.decryptPayload(chunk)
                        .then(status => {
                            this.emit('debug', `Received status: ${status}`);
                            try {
                                status = JSON.parse(status);
                                this.renameAttributes(status);
                            } catch (e) {
                                this.emit('error', `Cannot parse: ${status}`);
                                return console.error(`Cannot parse: ${status}`);
                            }

                            if (!this.connected) {
                                this.connected = true;
                                this.emit('connected', true);
                            }
                            this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
                            this.pingTimeout      && clearTimeout(this.pingTimeout);

                            this.pingTimeout = setTimeout(() => this._reconnect(), this.aliveTimeout);

                            if (status && status.state && status.state.reported) {
                                this.emit('status', status.state.reported);
                            }
                        });

                    resolve && resolve();
                    resolve = null;
                });
            });
            this._statusRequest.on('error', err => {
                console.error(`Error by sending: ${err}`);
                this.emit('error', `Error by sending: ${err}`);
                reject(err);
            });
            this._statusRequest.end();
        });
    }

    decryptPayload(encryptedData) {
        //payload = Buffer.from('ADFDB0A71FD72EC5D21C2A238846F3FB4D4A533299A43AA1748132DA0B950E05F1100B369641DD6A37F2479DA568D294ACB0970085ACDFA3C1EAED8084DDF28E19F86727F4E0381D34387DB059A8B7CC53C2109368EC6FCA48FCA427A2E4A4993A27627D52FDC2833871C8FB01A3CEF12A068BE7CB82E9A34A8D0A9BDEE8D0022BC2FE0863A13823CA4FF0F0F29A59A569148BBA5E7A7C8798F298A2150BB3723DBEB393735100E5C3AE88A80331CFEC89DDD22ED3E3157136A2CD9F856D6F18334716E679D3D2DF501621FBCD6645DAD8D8350DB812DE910F3AD98054807B8A8D40A5897A057AFA0DCEBDAFE2C7FFA113244936C6E7810B7FF2CA8EF4822B7CF4B0234BF28AA4CBA08BC83CA22A48686354CDB55302D50D9BF7AF3F8BE15F8DA3612DA0BE41BBC1596EC26D09EA4E64F5D862CAC0A58E40CCC53D095D4505D87A69845384F7B300175E6BA0904AFF7EDEA8FE00CC140B97E89BDA32CB761DE9EB06DE4EB6A3D2997900AEDBF1D2916AEF4427A46FF34DBA0930E2492B71C9D2D8E66E81E9BD155E056185D6FF304A2088B4D2D247C4E4DECA67A66EBE4AFCBD5D39242F5F2518DA9A996DBBE81BECA23FC44618FF4D6A125152CD64ECB1425930B273AE56DE5F79ADF20363D90D78933D8D5B241089A788780CCDC65660BB2E9AEB0B7C76FED1253CD81488C4B027B1219E20550DC697D1300DC520E0A25B496A59946FE5FBB7EFC3C91C44E6F3276C35014F35BFA75978834B366A8814A323D4A67DBA673A812C137FC9D48C03577B37B0A4277C2D82AA21F3959476A16B11467A8043A79643F8142D875AA3F6D7DB6742EB90B5CFC6F23C7BDEDB8415F9D598F9D32FF285D8BDBE0671E67672F0D098059A098A4EB62AA982C64EB2F14F54A43E2E6C');
        const encryptedDataStr = encryptedData.toString('utf8');
        const encodedCounter = encryptedDataStr.substring(0, 8);

        const keyAndIV = crypto.createHash('md5').update(Buffer.from(SECRET_KEY + encodedCounter)).digest('hex').toUpperCase();
        const halfKeyLen = Math.round(keyAndIV.length / 2);
        const secretKey = keyAndIV.slice(0, halfKeyLen);
        const iv = keyAndIV.slice(halfKeyLen);
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(secretKey), Buffer.from(iv));

        const encrypted = encryptedDataStr.substring(8, encryptedDataStr.length - 64);
        const strDigest = encodedCounter + encrypted;
        const hash = crypto.createHash('sha256')
            .update(Buffer.from(strDigest))
            .digest('hex').toUpperCase();

        const digest = encryptedDataStr.substring(encryptedData.length - 64);
        if (digest !== hash) {
            this.emit('error', 'Message corrupted');
            throw new Error('Message corrupted');
        }
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return Promise.resolve(decrypted);
    }

    updateClientKey() {
        this.clientKey = ((parseInt(this.clientKey, 16) + 1) & 0xFFFFFFFF).toString(16).padStart(8, '0').toUpperCase();
        console.log(`Update client key: ${this.clientKey}`);
        this.emit('debug', `Update client key: ${this.clientKey}`);
    }

    encryptPayload(payload) {
        this.updateClientKey();
        const keyAndIV = crypto.createHash('md5').update(Buffer.from(SECRET_KEY + this.clientKey)).digest('hex').toUpperCase();
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

        const hash = crypto.createHash('sha256')
            .update(Buffer.from(strDigest))
            .digest('hex').toUpperCase();

        return Promise.resolve(this.clientKey + encrypted + hash);
    }

    control(settings) {
        const payload = {
            state: {
                desired: {
                    CommandType: 'app',
                    DeviceId: '',
                    EnduserId: '',
                }
            }
        };

        Object.keys(NAME_MAPPING).filter(attr => NAME_MAPPING[attr].control).forEach(attr => {
            if (Object.prototype.hasOwnProperty.call(settings, NAME_MAPPING[attr].name)) {
                if (NAME_MAPPING[attr].options) {
                    const name = Object.keys(NAME_MAPPING[attr].options).find(name => NAME_MAPPING[attr].options[name] == settings[NAME_MAPPING[attr].name]);
                    if (name) {
                        payload.state.desired[attr] = name;
                    } else {
                        throw new Error(`Invalid option for ${NAME_MAPPING[attr].name}: ${settings[NAME_MAPPING[attr].name]}. Supported only: ${JSON.stringify(NAME_MAPPING[attr].options)}`);
                    }
                } else {
                    payload.state.desired[attr] = settings[NAME_MAPPING[attr].name];
                }
            }
        });

        return this.encryptPayload(payload)
            .then(encryptedPayload => this._post('/sys/dev/control', encryptedPayload))
            .then(data => {
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    console.error(`Cannot parse: ${data}`);
                    this.emit('error', `Cannot parse: ${data}`);
                }
                console.log(`Data: ${JSON.stringify(data)}`);
                this.emit('debug', `Data: ${JSON.stringify(data)}`);
                return data;
            });
    }

    renameAttributes(status) {
        if (status && status.state && status.state.reported) {
            Object.keys(status.state.reported).forEach(attr => {
                if (NAME_MAPPING[attr]) {
                    const val = status.state.reported[attr];
                    delete status.state.reported[attr];
                    if (NAME_MAPPING[attr].options && Object.prototype.hasOwnProperty.call(NAME_MAPPING[attr].options, val)) {
                        status.state.reported[NAME_MAPPING[attr].name] = NAME_MAPPING[attr].options[val];
                    } else {
                        status.state.reported[NAME_MAPPING[attr].name] = val;
                    }
                }
            });
        }
    }
}

module.exports = AirPurifier;
