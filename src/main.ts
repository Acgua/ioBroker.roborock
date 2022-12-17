/**
 * -------------------------------------------------------------------
 * ioBroker Roborock Adapter
 * @github  https://github.com/Acgua/ioBroker.roborock
 * @author  Acgua <https://github.com/Acgua/ioBroker.roborock>
 * @created Adapter Creator v2.1.1
 * @license Apache License 2.0
 * -------------------------------------------------------------------
 * Many thanks to rovo89 (https://github.com/rovo89) for his awesome work on the development of
 * a full-working proof of concept and decryption of the Roborock API!
 *  - https://forum.iobroker.net/topic/56098/tester-gesucht-roborock-api
 *  - https://gist.github.com/rovo89/dff47ed19fca0dfdda77503e66c2b7c7
 * -------------------------------------------------------------------
 */

import * as utils from '@iobroker/adapter-core';
import EventEmitter from 'node:events';

/**
 * Developer setup:
 * For all following NPM modules: open console, change dir e.g. to "C:\iobroker\node_modules\ioBroker.roborock\",
 * and execute "npm install <module name>", ex: npm install axios.
 */
import axios from 'axios';
import { Parser } from 'binary-parser';
import CRC32 from 'crc-32';
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import zlib from 'zlib';

// import methods lib
import { err2Str, isEmpty, wait } from './lib/methods';

// Constants
// This value is stored hardcoded in librrcodec.so, encrypted by the value of "com.roborock.iotsdk.appsecret" from AndroidManifest.xml.
const salt = 'TXdfu$jyZ#TZHsg4';

/**
 * Main Adapter Class
 * Note: "export" keyword used due to access to class instance in lib/methods
 */
export class Roborock extends utils.Adapter {
    // Imported methods from ./lib/methods
    public err2Str = err2Str.bind(this);
    public wait = wait.bind(this);
    public isEmpty = isEmpty.bind(this);
    // Other
    public userdata = {} as { [k: string]: any };
    public homedata = {} as { [k: string]: any };

    /**
     * Constructor
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'roborock' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Called once ioBroker databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        try {
            // Reset the connection indicator during startup
            this.setState('info.connection', { val: false, ack: true });

            /**
             * User settings verification
             */
            // Basic verification of user name and pw
            if (!this.config.username || this.config.username.trim().length < 1) throw `Not valid username '${this.config.username}' set in adapter configuration!`;
            if (!this.config.password || this.config.password.trim().length < 2) throw `Not valid password '${this.config.password}' set in adapter configuration`;

            // Create objects
            // TODO: We will actually not need these states, this is just temporarily...
            await this.setObjectNotExistsAsync('userdata', { type: 'state', common: { name: 'Roborock userdata', type: 'string', role: 'json', read: true, write: false, def: '' }, native: {} });
            await this.setObjectNotExistsAsync('homedata', { type: 'state', common: { name: 'Roborock homedata', type: 'string', role: 'json', read: true, write: false, def: '' }, native: {} });

            // Get userdata and homedata
            await this.getRoborockUserHomedata();

            // Create objects
            for (const prod of this.homedata.products) {
                this.log.debug(`Creating objects for ${prod.name} - id: ${prod.id} ...`);
                await this.setObjectNotExistsAsync(prod.id, { type: 'device', common: { name: prod.name }, native: {} });
                await this.setObjectNotExistsAsync(`${prod.id}.info`, { type: 'channel', common: { name: 'Information' }, native: {} });
                // Erst mal alle als String
                // TODO: Verbessern
                for (const itm of prod.schema) {
                    this.log.debug(`Create state for ${prod.id}.info.${itm.code} ...`);
                    await this.setObjectNotExistsAsync(`${prod.id}.info.${itm.code}`, { type: 'state', common: { name: `${itm.code}`, type: 'string', role: 'info', read: true, write: false, def: '' }, native: {} });
                }
            }

            // TODO: This just as a test, to wait certain seconds
            this.log.info(`- wait 2 seconds ----------------------------------------`);
            await this.wait(2000);

            await this.main();
        } catch (e) {
            this.log.error(this.err2Str(e));
        }
    }

    private async main(): Promise<void> {
        try {
            const rriot = this.userdata.rriot;
            const devices = this.homedata.devices.concat(this.homedata.receivedDevices);
            const localKeys = new Map(devices.map((device: { [k: string]: any }) => [device.duid, device.localKey]));

            let seq = 1;
            let random = 4711; // Should be initialized with a number 0 - 1999?
            let idCounter = 1;

            const endpoint = this.md5bin(rriot.k).subarray(8, 14).toString('base64'); // Could be a random but rather static string. The app generates it on first run.
            const nonce = crypto.randomBytes(16);

            const mqttMessageParser = new Parser().endianess('big').string('version', { length: 3 }).uint32('seq').uint32('random').uint32('timestamp').uint16('protocol').uint16('payloadLen').buffer('payload', { length: 'payloadLen' }).uint32('crc32');

            const protocol301Parser = new Parser().endianess('little').string('endpoint', { length: 15, stripNull: true }).uint8('unknown1').uint16('id').buffer('unknown2', { length: 6 });

            const mqttUser = this.md5hex(rriot.u + ':' + rriot.k).substring(2, 10);
            const mqttPassword = this.md5hex(rriot.s + ':' + rriot.k).substring(16);

            /**
             * Connect MQTT
             */
            const rr = new EventEmitter();
            let client: mqtt.Client;
            try {
                client = mqtt.connect(rriot.r.m, { username: mqttUser, password: mqttPassword, keepalive: 30 });
                client.on('connect', () => {
                    // MQTT subscribe
                    client.subscribe(`rr/m/o/${rriot.u}/${mqttUser}/#`, (err, granted) => {
                        // handle err
                        if (err) throw `${this.homedata.name}: Connection error occcurred while trying to establish MQTT connection`;

                        this.log.debug(`${this.homedata.name} -- Granted variable: ${JSON.stringify(granted)}`);
                        // TODO: we will need to cover all devices, and not just the first one.
                        const deviceId = devices[0].duid; // Simply use the first device.
                        sendRequest(this, deviceId, 'get_prop', ['get_status']).then((result) => {
                            this.log.info(`${this.homedata.name}: First device get_prop RESULT: ${JSON.stringify(result)}`);
                        });
                        sendRequest(this, deviceId, 'get_map_v1', [], true).then((result) => {
                            //this.log.info(`${this.homedata.name}: First device get_map_v1 RESULT: ${result}`);
                        });
                    });
                });

                /**
                 * MQTT: on message
                 */
                client.on('message', (topic: string, message) => {
                    try {
                        // topic looks like: 'rr/m/o/xxxxxx/yyyyyyy/zzzzzz' (x,y,z replaced)
                        const deviceId = topic.split('/').slice(-1)[0]; // last part of topic string, e.g. zzzzzz
                        const lclKey = localKeys.get(deviceId);
                        if (!lclKey || typeof lclKey !== 'string') throw `localKeys.get(deviceId) failed: not existing or not a string`;
                        const data = _decodeMsg(this, message, lclKey);
                        if (!data) throw `message could not be decoded!`;
                        rr.emit('response.raw', deviceId, data);
                        if (!data.payload || this.isEmpty(data.payload)) throw `no data.payload available!`;
                        switch (data.protocol) {
                            case 102:
                                this.log.debug(`--------- reached data protocol 102`);
                                const pl = JSON.parse(data.payload);
                                if (!pl.dps || !pl.dps['102']) throw `data.payload.dps / data.payload.dps['102] is not available!`;
                                const dps = JSON.parse(pl.dps['102']);
                                if (!dps || !dps.result) {
                                    this.log.error(`dps / dps.result is not available!`);
                                    throw `data.payload: ${JSON.stringify(data.payload)}`;
                                }

                                rr.emit('response.102', deviceId, dps.id, dps.result[0]);
                                break;
                            case 301:
                                this.log.debug(`--------- reached data protocol 301`);
                                const data2 = protocol301Parser.parse(data.payload.subarray(0, 24));
                                if (endpoint.startsWith(data2.endpoint)) {
                                    const iv = Buffer.alloc(16, 0);
                                    const decipher = crypto.createDecipheriv('aes-128-cbc', nonce, iv);
                                    let decrypted = Buffer.concat([decipher.update(data.payload.subarray(24)), decipher.final()]);
                                    decrypted = zlib.gunzipSync(decrypted);
                                    rr.emit('response.301', deviceId, data2.id, decrypted);
                                }
                                break;
                            default:
                                this.log.warn(`Not (yet) covered data.protocol: ${data.protocol}`);
                        }
                    } catch (e) {
                        this.log.error(`MQTT on message error: ${this.err2Str(e)}`);
                    }
                });
            } catch (e) {
                this.log.error(`MAIN: MQTT connect error: ${this.err2Str(e)}`);
            }

            /**
             * MQTT: send request
             * @param adapter  - "this"
             * @param deviceId - device id
             * @param method   - method
             * @param params   - parameter
             * @param secure   - if secure
             * @returns some result
             */
            async function sendRequest(adapter: Roborock, deviceId: string, method: string, params: any, secure = false): Promise<any> {
                const timestamp = Math.floor(Date.now() / 1000);
                const requestId = idCounter++;
                const inner = { id: requestId, method: method, params: params } as { [key: string]: any };
                if (secure) {
                    inner.security = { endpoint: endpoint, nonce: nonce.toString('hex').toUpperCase() };
                }
                const payload = JSON.stringify({ t: timestamp, dps: { '101': JSON.stringify(inner) } });
                return new Promise((resolve, reject) => {
                    rr.on('response.102', (deviceId, id, result) => {
                        if (id == requestId) {
                            if (secure) {
                                if (result !== 'ok') {
                                    reject(result);
                                }
                            } else {
                                resolve(result);
                            }
                        }
                    });
                    if (secure) {
                        rr.on('response.301', (deviceId, id, result) => {
                            if (id == requestId) {
                                resolve(result);
                            }
                        });
                    }
                    sendMsgRaw(adapter, deviceId, 101, timestamp, payload);
                });
            }

            /**
             * MQTT: send raw message
             * @param adapter   - "this"
             * @param deviceId  - device id
             * @param protocol  - protocol number
             * @param timestamp - timestamp
             * @param payload   - payload str
             */
            function sendMsgRaw(adapter: Roborock, deviceId: string, protocol: number, timestamp: number, payload: string): void {
                const localKey = localKeys.get(deviceId);
                const aesKey = adapter.md5bin(_encodeTimestamp(timestamp) + localKey + salt);
                const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
                const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
                const msg = Buffer.alloc(23 + encrypted.length);
                msg.write('1.0');
                msg.writeUint32BE(seq++ & 0xffffffff, 3);
                msg.writeUint32BE(random++ & 0xffffffff, 7);
                msg.writeUint32BE(timestamp, 11);
                msg.writeUint16BE(protocol, 15);
                msg.writeUint16BE(encrypted.length, 17);
                encrypted.copy(msg, 19);
                const crc32 = CRC32.buf(msg.subarray(0, msg.length - 4)) >>> 0;
                msg.writeUint32BE(crc32, msg.length - 4);
                client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${deviceId}`, msg);
            }

            /**
             * Encode timestamp
             * @param timestamp
             * @returns encoded timestamp
             */
            function _encodeTimestamp(timestamp: number): string {
                const hex = timestamp.toString(16).padStart(8, '0').split('');
                return [5, 6, 3, 7, 1, 2, 0, 4].map((idx) => hex[idx]).join('');
            }
            /**
             * Decode message
             * @param adapter - "this"
             * @param msg
             * @param localKey
             * @returns decoded message
             */
            function _decodeMsg(adapter: Roborock, msg: any, localKey: string): { [k: string]: any } | undefined {
                try {
                    // Do some checks before trying to decode the message.
                    if (msg.toString('latin1', 0, 3) !== '1.0') throw `Unknown protocol version`;

                    const crc32 = CRC32.buf(msg.subarray(0, msg.length - 4)) >>> 0;
                    const expectedCrc32 = msg.readUint32BE(msg.length - 4);
                    if (crc32 != expectedCrc32) throw `Wrong CRC32 ${crc32}, expected ${expectedCrc32}`;

                    const data = mqttMessageParser.parse(msg);
                    delete data.payloadLen;
                    const aesKey = adapter.md5bin(_encodeTimestamp(data.timestamp) + localKey + salt);
                    const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null);
                    data.payload = Buffer.concat([decipher.update(data.payload), decipher.final()]);
                    return data;
                } catch (e) {
                    adapter.log.error(`_decodeMsg(): ${adapter.err2Str(e)}`);
                    return undefined;
                }
            }
        } catch (e) {
            this.log.error(`MAIN (outer): ${this.err2Str(e)}`);
        }
    }

    private async getRoborockUserHomedata(): Promise<void> {
        try {
            /********************************
             * Initialize the login API (which is needed to get access to the real API).
             ********************************/
            this.log.debug(`${this.config.username}: Initializing the login API...`);
            const loginApi = axios.create({
                baseURL: 'https://euiot.roborock.com',
                headers: {
                    header_clientid: crypto.createHash('md5').update(this.config.username).update('should_be_unique').digest().toString('base64'),
                },
            });
            // api/v1/getUrlByEmail(email = ...)

            /*********************************
             * Get userdata
             *********************************/
            this.log.debug(`${this.config.username}: Getting user data...`);
            //let userdata = {} as { [k: string]: any };
            let updateUserdata = false as true | false;
            // Get existing data from ioBroker state 'userdata'
            const userdataObj = await this.getStateAsync('userdata');
            if (userdataObj && userdataObj.val && typeof userdataObj.val === 'string') {
                this.userdata = JSON.parse(userdataObj.val);
                if (!this.userdata.token || this.userdata.token.length < 10) {
                    this.log.debug(`${this.config.username}: No token available, fetching new user data.`);
                    updateUserdata = true;
                }
                if (!updateUserdata) {
                    const lastChangeHours = Math.round((Date.now() - userdataObj.lc) / 1000 / 60 / 60); // Last state change, in hours
                    if (lastChangeHours > 24 * 30) {
                        this.log.debug(`${this.config.username}: Get new user data from cloud, since last update was more than 30 days ago`);
                        updateUserdata = true;
                    } else {
                        this.log.debug(`${this.config.username}: Last user data update from Cloud: ${lastChangeHours} hours ago. Since less than 30 days: not updating.`);
                    }
                }
            } else {
                updateUserdata = true;
            }
            if (updateUserdata) {
                this.log.debug(`${this.config.username}: Freshly getting user data from Roborock Cloud.`);
                // Log in.
                this.userdata = await loginApi
                    .post(
                        'api/v1/login',
                        new URLSearchParams({
                            username: this.config.username,
                            password: this.config.password,
                            needtwostepauth: 'false',
                        }).toString(),
                    )
                    .then((res) => res.data.data);
                await this.setStateAsync('userdata', { val: JSON.stringify(this.userdata), ack: true });
                // Alternative without password:
                // await loginApi.post('api/v1/sendEmailCode', new url.URLSearchParams({username: username, type: 'auth'}).toString()).then(res => res.data);
                // // ... get code from user ...
                // userdata = await loginApi.post('api/v1/loginWithCode', new url.URLSearchParams({username: username, verifycode: code, verifycodetype: 'AUTH_EMAIL_CODE'}).toString()).then(res => res.data.data);
            }

            /*********************************
             * Get home details
             *********************************/
            this.log.debug(`${this.config.username}: Getting home details...`);
            loginApi.defaults.headers.common['Authorization'] = this.userdata.token;
            const rriot = this.userdata.rriot;
            const homeId = await loginApi.get('api/v1/getHomeDetail').then((res) => res.data.data.rrHomeId);

            // Initialize the real API.
            this.log.debug(`${this.config.username}: Initializing the "real" Roborock API...`);
            const api = axios.create({
                baseURL: rriot.r.a,
            });
            api.interceptors.request.use((config) => {
                const timestamp = Math.floor(Date.now() / 1000);
                const nonce = crypto.randomBytes(6).toString('base64').substring(0, 6).replace('+', 'X').replace('/', 'Y');
                const url = new URL(api.getUri(config));
                const prestr = [rriot.u, rriot.s, nonce, timestamp, this.md5hex(url.pathname), /*queryparams*/ '', /*body*/ ''].join(':');
                const mac = crypto.createHmac('sha256', rriot.h).update(prestr).digest('base64');
                if (!config?.headers) throw `Expected 'config' and 'config.headers' not to be undefined`;
                config.headers.Authorization = `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
                return config;
            });
            this.homedata = await api.get(`user/homes/${homeId}`).then((res) => res.data.result);
            if (!this.homedata || !this.homedata.id || !this.homedata.name || !this.homedata.products) throw `${this.config.username}: Could not receive valid home data!`;
            for (const product of this.homedata.products) {
                this.log.debug(`${this.homedata.name}: Received ${product.name} (model: ${product.model})`);
            }
            await this.setStateAsync('homedata', { val: JSON.stringify(this.homedata), ack: true });
        } catch (e) {
            this.log.error(this.err2Str(e));
        }
    }

    /**
     * convert MD5 to HEX
     * @param str MD5
     * @returns hex
     */
    private md5hex(str: string): string {
        return crypto.createHash('md5').update(str).digest('hex');
    }

    /**
     * convert MD5 to BIN
     * @param str MD5
     * @returns BIN buffer
     */
    private md5bin(str: string): Buffer {
        return crypto.createHash('md5').update(str).digest();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            // clearInterval(interval1);

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Roborock(options);
} else {
    // otherwise start the instance directly
    (() => new Roborock())();
}
