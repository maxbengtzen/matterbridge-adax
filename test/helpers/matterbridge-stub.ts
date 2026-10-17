// Minimal stand-in for the `matterbridge` package so the platform can be tested without a Matter stack.
// It mimics the parts of MatterbridgeEndpoint the plugin relies on, including matter.js firing attribute
// subscribers (with an "offline" context) when the plugin itself updates an attribute.

type Listener = (value: unknown, old: unknown, context: object) => void;
type CommandHandler = (data: { request: Record<string, number> }) => void;
const noop = () => {};

export const bridgedNode = { name: 'bridgedNode' };
export const thermostat = { name: 'thermostat' };

export class MatterbridgeEndpoint {
  deviceTypes: unknown[];
  id: string;
  debug: boolean | undefined;
  calls: Record<string, unknown[]> = {};
  state = new Map<string, unknown>();
  listeners = new Map<string, Listener[]>();
  commandHandlers = new Map<string, CommandHandler>();
  events: { cluster: number; event: string; payload: Record<string, unknown> }[] = [];
  updates: [string, unknown][] = [];
  children: MatterbridgeEndpoint[] = [];
  log = { info: noop, warn: noop, error: noop, debug: noop };

  constructor(deviceTypes: unknown[], options: { id: string }, debug?: boolean) {
    this.deviceTypes = deviceTypes;
    this.id = options.id;
    this.debug = debug;
  }

  #record(name: string, args: unknown[]) {
    this.calls[name] = args;
    return this;
  }
  createDefaultIdentifyClusterServer(...a: unknown[]) { return this.#record('identify', a); }
  createDefaultBridgedDeviceBasicInformationClusterServer(...a: unknown[]) { return this.#record('basicInfo', a); }
  createDefaultThermostatClusterServer(...a: unknown[]) { return this.#record('thermostat', a); }
  createDefaultPowerSourceWiredClusterServer(...a: unknown[]) { return this.#record('wired', a); }
  addRequiredClusterServers() { return this; }

  addChildDeviceType(name: string, deviceTypes: unknown[]) {
    const child = new MatterbridgeEndpoint(deviceTypes, { id: name }, this.debug);
    this.children.push(child);
    return child;
  }

  subscribeAttribute(cluster: number, attribute: string, listener: Listener) {
    const key = `${cluster}.${attribute}`;
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]);
    return this;
  }

  addCommandHandler(command: string, handler: CommandHandler) {
    this.commandHandlers.set(command, handler);
    return this;
  }

  getAttribute(cluster: number, attribute: string) {
    return this.state.get(`${cluster}.${attribute}`);
  }

  async updateAttribute(cluster: number, attribute: string, value: unknown) {
    const key = `${cluster}.${attribute}`;
    const old = this.state.get(key);
    if (JSON.stringify(old) === JSON.stringify(value)) return false;
    this.state.set(key, value);
    this.updates.push([key, value]);
    for (const l of this.listeners.get(key) ?? []) l(value, old, { offline: true });
    return true;
  }

  async triggerEvent(cluster: number, event: string, payload: Record<string, unknown>) {
    this.events.push({ cluster, event, payload });
    return true;
  }

  /** Test helper: simulate a Matter controller writing an attribute. */
  writeFromController(cluster: number, attribute: string, value: unknown) {
    const key = `${cluster}.${attribute}`;
    const old = this.state.get(key);
    this.state.set(key, value);
    for (const l of this.listeners.get(key) ?? []) l(value, old, { session: {}, fabric: 1 });
  }
}

export class MatterbridgeDynamicPlatform {
  registered: MatterbridgeEndpoint[] = [];
  matterbridge: unknown;
  log: unknown;
  config: unknown;
  ready = Promise.resolve();
  constructor(matterbridge: unknown, log: unknown, config: unknown) {
    this.matterbridge = matterbridge;
    this.log = log;
    this.config = config;
  }
  verifyMatterbridgeVersion() { return true; }
  async clearSelect() {}
  async registerDevice(device: MatterbridgeEndpoint) { this.registered.push(device); }
  async unregisterDevice() {}
  async onConfigure() {}
  async onShutdown() {}
}
