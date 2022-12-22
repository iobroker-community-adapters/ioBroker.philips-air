const EventEmitter = require('events');
const { HttpClient } = require('philips-air');

const NAME_MAPPING = {
    om:          {name: 'fanSpeed', options: {'s': 'silent', 't': 'turbo', 'a': 'auto', '1': '1', '2': '2', '3': '3'}, control: true},
    pwr:         {name: 'power', options: {'1': true, '0': false}, control: true},
    mode:        {name: 'mode', options: {'P': 'auto', 'A': 'allergen', 'S': 'sleep', 'M': 'manual', 'B': 'bacteria', 'N': 'night', 'T': 'turbo',  'AG': 'automode', 'GT': 'gentle'}, control: true},
    rhset:       {name: 'targetHumidity', control: true},
    func:        {name: 'function', options: {'P': 'purification', 'PH': 'humidification'}, control: true},
    aqil:        {name: 'lightBrightness', control: true},
    ddp:         {name: 'usedIndex', options: {'3': 'humidity', '1': 'pm2.5', '0': 'iai'}, control: true},
    uil:         {name: 'buttonLight', options: {'1': true, '0': false}, control: true},
    dt:          {name: 'timerHours', control: true},
    cl:          {name: 'childLock', control: true},

    aqit:        {name: 'airQualityNotificationThreshold', control: true},

    rh:          {name: 'humidity'},
    iaql:        {name: 'allergenIndex'},
    temp:        {name: 'temperature'},
    wl:          {name: 'waterLevel'},
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
    rddp:        {name: 'rddp'},
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
    constructor(deviceIp, options, adapter) {
        super();
        this.adapter = adapter;
        options = Object.assign({aliveTimeout: 30000, reconnectInterval: 30000}, options);

        this.deviceIp = deviceIp;

        this.clientKey = '';

        this.connected = false;

        this.aliveTimeout      = parseInt(options.aliveTimeout, 10)      || 30000;
        this.reconnectInterval = parseInt(options.reconnectInterval, 10) || 30000;

        this.adapter.getState('info.key', async (err, state) => {
            if (err) {
                adapter.log.error(err);
            } else {
                this.clientKey = state && state.val;
                this.clientKey = Buffer.from(this.clientKey, 'base64');
            }
            // check key
            this.client = new HttpClient(deviceIp, this.aliveTimeout, this.clientKey);
            await this._reconnect();
        });
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

    sync() {
        this.adapter.log.debug('Syncing...');
        return this.client.getStatus()
            .then(async status => {
                this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;

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
                }
                if (typeof status !== 'object') {
                    try {
                        status = JSON.parse(status);
                    } catch (e) {
                        this.emit('error', `Cannot parse: ${status}`);
                        return console.error(`Cannot parse: ${status}`);
                    }
                }
                this.renameAttributes(status);
                this.emit('status', status);

                this.pingTimeout && clearTimeout(this.pingTimeout);
                this.pingTimeout = setTimeout(() => {
                    this.pingTimeout = null;
                    this.sync();
                }, this.aliveTimeout);
            })
            .catch(error => {
                if (this.connected) {
                    this.emit('error', error);
                    this.connected = false;
                    this.emit('connected', false);
                }

                this._reconnect();
            });
    }

    _reconnect() {
        this.reconnectTimeout && clearTimeout(this.reconnectTimeout);
        this.pingTimeout && clearTimeout(this.pingTimeout);
        this.pingTimeout = null;

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this._reconnect();
        }, this.reconnectInterval);

        return this.sync();
    }

    control(settings) {
        const payload = {};

        Object.keys(NAME_MAPPING).filter(attr => NAME_MAPPING[attr].control).forEach(attr => {
            if (Object.prototype.hasOwnProperty.call(settings, NAME_MAPPING[attr].name)) {
                if (NAME_MAPPING[attr].options) {
                    const name = Object.keys(NAME_MAPPING[attr].options).find(name => NAME_MAPPING[attr].options[name] == settings[NAME_MAPPING[attr].name]);
                    if (name) {
                        payload[attr] = name;
                    } else {
                        throw new Error(`Invalid option for ${NAME_MAPPING[attr].name}: ${settings[NAME_MAPPING[attr].name]}. Supported only: ${JSON.stringify(NAME_MAPPING[attr].options)}`);
                    }
                } else {
                    payload[attr] = settings[NAME_MAPPING[attr].name];
                }
            }
        });

        return this.client.setValues(payload)
            .then(async data => {
                const key = this.client.key.toString('base64');
                if (this.clientKey !== key) {
                    this.emit('debug', `Update client key: ${this.clientKey}`);
                    this.clientKey = key;
                    // store new key
                    await this.adapter.setStateAsync('info.key', this.clientKey, true);
                }

                this.pingTimeout && clearTimeout(this.pingTimeout);
                this.pingTimeout = setTimeout(() => this._reconnect(), this.aliveTimeout);

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
        if (status) {
            Object.keys(status).forEach(attr => {
                if (NAME_MAPPING[attr]) {
                    const val = status[attr];
                    delete status[attr];
                    if (NAME_MAPPING[attr].options && Object.prototype.hasOwnProperty.call(NAME_MAPPING[attr].options, val)) {
                        status[NAME_MAPPING[attr].name] = NAME_MAPPING[attr].options[val];
                    } else {
                        status[NAME_MAPPING[attr].name] = val;
                    }
                }
            });
        }
    }
}

module.exports = AirPurifier;
