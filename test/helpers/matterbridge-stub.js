// Minimal stand-in for the `matterbridge` package so the platform can be tested without a Matter stack.
// It mimics the parts of MatterbridgeEndpoint the plugin relies on, including matter.js firing attribute
// subscribers (with an "offline" context) when the plugin itself updates an attribute.

export const bridgedNode = { name: 'bridgedNode' };
export const thermostat = { name: 'thermostat' };

export class MatterbridgeEndpoint {
  constructor(deviceTypes, options, debug) {
    this.deviceTypes = deviceTypes;
    this.id = options.id;
    this.debug = debug;
    this.calls = {};
    this.state = new Map();
    this.listeners = new Map();
    this.commandHandlers = new Map();
    this.events = [];
    this.updates = [];
    this.children = [];
    this.log = { info() {}, warn() {}, error() {}, debug() {} };
  }

  #record(name, args) {
    this.calls[name] = args;
    return this;
  }
  createDefaultIdentifyClusterServer(...a) { return this.#record('identify', a); }
  createDefaultBridgedDeviceBasicInformationClusterServer(...a) { return this.#record('basicInfo', a); }
  createDefaultThermostatClusterServer(...a) { return this.#record('thermostat', a); }
  createDefaultPowerSourceWiredClusterServer(...a) { return this.#record('wired', a); }
  addRequiredClusterServers() { return this; }

  addChildDeviceType(name, deviceTypes) {
    const child = new MatterbridgeEndpoint(deviceTypes, { id: name }, this.debug);
    this.children.push(child);
    return child;
  }

  subscribeAttribute(cluster, attribute, listener) {
    const key = `${cluster}.${attribute}`;
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]);
    return this;
  }

  addCommandHandler(command, handler) {
    this.commandHandlers.set(command, handler);
    return this;
  }

  getAttribute(cluster, attribute) {
    return this.state.get(`${cluster}.${attribute}`);
  }

  async updateAttribute(cluster, attribute, value) {
    const key = `${cluster}.${attribute}`;
    const old = this.state.get(key);
    if (JSON.stringify(old) === JSON.stringify(value)) return false;
    this.state.set(key, value);
    this.updates.push([key, value]);
    for (const l of this.listeners.get(key) ?? []) l(value, old, { offline: true });
    return true;
  }

  async triggerEvent(cluster, event, payload) {
    this.events.push({ cluster, event, payload });
    return true;
  }

  /** Test helper: simulate a Matter controller writing an attribute. */
  writeFromController(cluster, attribute, value) {
    const key = `${cluster}.${attribute}`;
    const old = this.state.get(key);
    this.state.set(key, value);
    for (const l of this.listeners.get(key) ?? []) l(value, old, { session: {}, fabric: 1 });
  }
}

export class MatterbridgeDynamicPlatform {
  registered = [];
  constructor(matterbridge, log, config) {
    this.matterbridge = matterbridge;
    this.log = log;
    this.config = config;
    this.ready = Promise.resolve();
  }
  verifyMatterbridgeVersion() { return true; }
  async clearSelect() {}
  async registerDevice(device) { this.registered.push(device); }
  async unregisterDevice() {}
  async onConfigure() {}
  async onShutdown() {}
}
