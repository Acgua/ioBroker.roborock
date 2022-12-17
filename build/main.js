var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  Roborock: () => Roborock
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_node_events = __toESM(require("node:events"));
var import_axios = __toESM(require("axios"));
var import_binary_parser = require("binary-parser");
var import_crc_32 = __toESM(require("crc-32"));
var import_mqtt = __toESM(require("mqtt"));
var import_node_crypto = __toESM(require("node:crypto"));
var import_zlib = __toESM(require("zlib"));
var import_methods = require("./lib/methods");
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
const salt = "TXdfu$jyZ#TZHsg4";
class Roborock extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "roborock" });
    this.err2Str = import_methods.err2Str.bind(this);
    this.wait = import_methods.wait.bind(this);
    this.isEmpty = import_methods.isEmpty.bind(this);
    this.userdata = {};
    this.homedata = {};
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    try {
      this.setState("info.connection", { val: false, ack: true });
      if (!this.config.username || this.config.username.trim().length < 1)
        throw `Not valid username '${this.config.username}' set in adapter configuration!`;
      if (!this.config.password || this.config.password.trim().length < 2)
        throw `Not valid password '${this.config.password}' set in adapter configuration`;
      await this.setObjectNotExistsAsync("userdata", { type: "state", common: { name: "Roborock userdata", type: "string", role: "json", read: true, write: false, def: "" }, native: {} });
      await this.setObjectNotExistsAsync("homedata", { type: "state", common: { name: "Roborock homedata", type: "string", role: "json", read: true, write: false, def: "" }, native: {} });
      await this.getRoborockUserHomedata();
      for (const prod of this.homedata.products) {
        this.log.debug(`Creating objects for ${prod.name} - id: ${prod.id} ...`);
        await this.setObjectNotExistsAsync(prod.id, { type: "device", common: { name: prod.name }, native: {} });
        await this.setObjectNotExistsAsync(`${prod.id}.info`, { type: "channel", common: { name: "Information" }, native: {} });
        for (const itm of prod.schema) {
          this.log.debug(`Create state for ${prod.id}.info.${itm.code} ...`);
          await this.setObjectNotExistsAsync(`${prod.id}.info.${itm.code}`, { type: "state", common: { name: `${itm.code}`, type: "string", role: "info", read: true, write: false, def: "" }, native: {} });
        }
      }
      this.log.info(`- wait 2 seconds ----------------------------------------`);
      await this.wait(2e3);
      await this.main();
    } catch (e) {
      this.log.error(this.err2Str(e));
    }
  }
  async main() {
    try {
      let sendMsgRaw = function(adapter, deviceId, protocol, timestamp, payload) {
        const localKey = localKeys.get(deviceId);
        const aesKey = adapter.md5bin(_encodeTimestamp(timestamp) + localKey + salt);
        const cipher = import_node_crypto.default.createCipheriv("aes-128-ecb", aesKey, null);
        const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
        const msg = Buffer.alloc(23 + encrypted.length);
        msg.write("1.0");
        msg.writeUint32BE(seq++ & 4294967295, 3);
        msg.writeUint32BE(random++ & 4294967295, 7);
        msg.writeUint32BE(timestamp, 11);
        msg.writeUint16BE(protocol, 15);
        msg.writeUint16BE(encrypted.length, 17);
        encrypted.copy(msg, 19);
        const crc32 = import_crc_32.default.buf(msg.subarray(0, msg.length - 4)) >>> 0;
        msg.writeUint32BE(crc32, msg.length - 4);
        client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${deviceId}`, msg);
      }, _encodeTimestamp = function(timestamp) {
        const hex = timestamp.toString(16).padStart(8, "0").split("");
        return [5, 6, 3, 7, 1, 2, 0, 4].map((idx) => hex[idx]).join("");
      }, _decodeMsg = function(adapter, msg, localKey) {
        try {
          if (msg.toString("latin1", 0, 3) !== "1.0")
            throw `Unknown protocol version`;
          const crc32 = import_crc_32.default.buf(msg.subarray(0, msg.length - 4)) >>> 0;
          const expectedCrc32 = msg.readUint32BE(msg.length - 4);
          if (crc32 != expectedCrc32)
            throw `Wrong CRC32 ${crc32}, expected ${expectedCrc32}`;
          const data = mqttMessageParser.parse(msg);
          delete data.payloadLen;
          const aesKey = adapter.md5bin(_encodeTimestamp(data.timestamp) + localKey + salt);
          const decipher = import_node_crypto.default.createDecipheriv("aes-128-ecb", aesKey, null);
          data.payload = Buffer.concat([decipher.update(data.payload), decipher.final()]);
          return data;
        } catch (e) {
          adapter.log.error(`_decodeMsg(): ${adapter.err2Str(e)}`);
          return void 0;
        }
      };
      const rriot = this.userdata.rriot;
      const devices = this.homedata.devices.concat(this.homedata.receivedDevices);
      const localKeys = new Map(devices.map((device) => [device.duid, device.localKey]));
      let seq = 1;
      let random = 4711;
      let idCounter = 1;
      const endpoint = this.md5bin(rriot.k).subarray(8, 14).toString("base64");
      const nonce = import_node_crypto.default.randomBytes(16);
      const mqttMessageParser = new import_binary_parser.Parser().endianess("big").string("version", { length: 3 }).uint32("seq").uint32("random").uint32("timestamp").uint16("protocol").uint16("payloadLen").buffer("payload", { length: "payloadLen" }).uint32("crc32");
      const protocol301Parser = new import_binary_parser.Parser().endianess("little").string("endpoint", { length: 15, stripNull: true }).uint8("unknown1").uint16("id").buffer("unknown2", { length: 6 });
      const mqttUser = this.md5hex(rriot.u + ":" + rriot.k).substring(2, 10);
      const mqttPassword = this.md5hex(rriot.s + ":" + rriot.k).substring(16);
      const rr = new import_node_events.default();
      let client;
      try {
        client = import_mqtt.default.connect(rriot.r.m, { username: mqttUser, password: mqttPassword, keepalive: 30 });
        client.on("connect", () => {
          client.subscribe(`rr/m/o/${rriot.u}/${mqttUser}/#`, (err, granted) => {
            if (err)
              throw `${this.homedata.name}: Connection error occcurred while trying to establish MQTT connection`;
            this.log.debug(`${this.homedata.name} -- Granted variable: ${JSON.stringify(granted)}`);
            const deviceId = devices[0].duid;
            sendRequest(this, deviceId, "get_prop", ["get_status"]).then((result) => {
              this.log.info(`${this.homedata.name}: First device get_prop RESULT: ${JSON.stringify(result)}`);
            });
            sendRequest(this, deviceId, "get_map_v1", [], true).then((result) => {
            });
          });
        });
        client.on("message", (topic, message) => {
          try {
            const deviceId = topic.split("/").slice(-1)[0];
            const lclKey = localKeys.get(deviceId);
            if (!lclKey || typeof lclKey !== "string")
              throw `localKeys.get(deviceId) failed: not existing or not a string`;
            const data = _decodeMsg(this, message, lclKey);
            if (!data)
              throw `message could not be decoded!`;
            rr.emit("response.raw", deviceId, data);
            if (!data.payload || this.isEmpty(data.payload))
              throw `no data.payload available!`;
            switch (data.protocol) {
              case 102:
                this.log.debug(`--------- reached data protocol 102`);
                const pl = JSON.parse(data.payload);
                if (!pl.dps || !pl.dps["102"])
                  throw `data.payload.dps / data.payload.dps['102] is not available!`;
                const dps = JSON.parse(pl.dps["102"]);
                if (!dps || !dps.result) {
                  this.log.error(`dps / dps.result is not available!`);
                  throw `data.payload: ${JSON.stringify(data.payload)}`;
                }
                rr.emit("response.102", deviceId, dps.id, dps.result[0]);
                break;
              case 301:
                this.log.debug(`--------- reached data protocol 301`);
                const data2 = protocol301Parser.parse(data.payload.subarray(0, 24));
                if (endpoint.startsWith(data2.endpoint)) {
                  const iv = Buffer.alloc(16, 0);
                  const decipher = import_node_crypto.default.createDecipheriv("aes-128-cbc", nonce, iv);
                  let decrypted = Buffer.concat([decipher.update(data.payload.subarray(24)), decipher.final()]);
                  decrypted = import_zlib.default.gunzipSync(decrypted);
                  rr.emit("response.301", deviceId, data2.id, decrypted);
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
      async function sendRequest(adapter, deviceId, method, params, secure = false) {
        const timestamp = Math.floor(Date.now() / 1e3);
        const requestId = idCounter++;
        const inner = { id: requestId, method, params };
        if (secure) {
          inner.security = { endpoint, nonce: nonce.toString("hex").toUpperCase() };
        }
        const payload = JSON.stringify({ t: timestamp, dps: { "101": JSON.stringify(inner) } });
        return new Promise((resolve, reject) => {
          rr.on("response.102", (deviceId2, id, result) => {
            if (id == requestId) {
              if (secure) {
                if (result !== "ok") {
                  reject(result);
                }
              } else {
                resolve(result);
              }
            }
          });
          if (secure) {
            rr.on("response.301", (deviceId2, id, result) => {
              if (id == requestId) {
                resolve(result);
              }
            });
          }
          sendMsgRaw(adapter, deviceId, 101, timestamp, payload);
        });
      }
    } catch (e) {
      this.log.error(`MAIN (outer): ${this.err2Str(e)}`);
    }
  }
  async getRoborockUserHomedata() {
    try {
      this.log.debug(`${this.config.username}: Initializing the login API...`);
      const loginApi = import_axios.default.create({
        baseURL: "https://euiot.roborock.com",
        headers: {
          header_clientid: import_node_crypto.default.createHash("md5").update(this.config.username).update("should_be_unique").digest().toString("base64")
        }
      });
      this.log.debug(`${this.config.username}: Getting user data...`);
      let updateUserdata = false;
      const userdataObj = await this.getStateAsync("userdata");
      if (userdataObj && userdataObj.val && typeof userdataObj.val === "string") {
        this.userdata = JSON.parse(userdataObj.val);
        if (!this.userdata.token || this.userdata.token.length < 10) {
          this.log.debug(`${this.config.username}: No token available, fetching new user data.`);
          updateUserdata = true;
        }
        if (!updateUserdata) {
          const lastChangeHours = Math.round((Date.now() - userdataObj.lc) / 1e3 / 60 / 60);
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
        this.userdata = await loginApi.post(
          "api/v1/login",
          new URLSearchParams({
            username: this.config.username,
            password: this.config.password,
            needtwostepauth: "false"
          }).toString()
        ).then((res) => res.data.data);
        await this.setStateAsync("userdata", { val: JSON.stringify(this.userdata), ack: true });
      }
      this.log.debug(`${this.config.username}: Getting home details...`);
      loginApi.defaults.headers.common["Authorization"] = this.userdata.token;
      const rriot = this.userdata.rriot;
      const homeId = await loginApi.get("api/v1/getHomeDetail").then((res) => res.data.data.rrHomeId);
      this.log.debug(`${this.config.username}: Initializing the "real" Roborock API...`);
      const api = import_axios.default.create({
        baseURL: rriot.r.a
      });
      api.interceptors.request.use((config) => {
        const timestamp = Math.floor(Date.now() / 1e3);
        const nonce = import_node_crypto.default.randomBytes(6).toString("base64").substring(0, 6).replace("+", "X").replace("/", "Y");
        const url = new URL(api.getUri(config));
        const prestr = [rriot.u, rriot.s, nonce, timestamp, this.md5hex(url.pathname), "", ""].join(":");
        const mac = import_node_crypto.default.createHmac("sha256", rriot.h).update(prestr).digest("base64");
        if (!(config == null ? void 0 : config.headers))
          throw `Expected 'config' and 'config.headers' not to be undefined`;
        config.headers.Authorization = `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
        return config;
      });
      this.homedata = await api.get(`user/homes/${homeId}`).then((res) => res.data.result);
      if (!this.homedata || !this.homedata.id || !this.homedata.name || !this.homedata.products)
        throw `${this.config.username}: Could not receive valid home data!`;
      for (const product of this.homedata.products) {
        this.log.debug(`${this.homedata.name}: Received ${product.name} (model: ${product.model})`);
      }
      await this.setStateAsync("homedata", { val: JSON.stringify(this.homedata), ack: true });
    } catch (e) {
      this.log.error(this.err2Str(e));
    }
  }
  md5hex(str) {
    return import_node_crypto.default.createHash("md5").update(str).digest("hex");
  }
  md5bin(str) {
    return import_node_crypto.default.createHash("md5").update(str).digest();
  }
  onUnload(callback) {
    try {
      callback();
    } catch (e) {
      callback();
    }
  }
  onStateChange(id, state) {
    if (state) {
      this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
    } else {
      this.log.info(`state ${id} deleted`);
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Roborock(options);
} else {
  (() => new Roborock())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Roborock
});
//# sourceMappingURL=main.js.map
