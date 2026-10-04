import {
  bridgedNode,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  thermostat,
} from 'matterbridge';
import { BridgedDeviceBasicInformation, Thermostat } from 'matterbridge/matter/clusters';
import {
  AdaxClient,
  backoffDelay,
  isLocalContext,
  MIN_REQUEST_INTERVAL,
  normalizePollInterval,
  parseRoom,
  RateLimitError,
} from './adax.js';

// The cloud is reported as unreachable (shown as "No Response" in Apple Home) after this many failed polls in a row.
const UNREACHABLE_AFTER = 3;
// Controllers send a burst of writes while a slider is dragged; only the final state is sent.
const CHANGE_DEBOUNCE = 800;
// How many times a command is tried when the API answers 429.
const MAX_COMMAND_ATTEMPTS = 3;
// After a command, confirm with a poll. The client spaces requests, so this never breaks the API's rate limit.
const CONFIRM_DELAY = 5_000;
const DEFAULT_TARGET = 2100;

export default function initializePlugin(matterbridge, log, config) {
  return new AdaxMatterbridgePlatform(matterbridge, log, config);
}

export class AdaxMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  /** room id -> { id, name, device, state, lastTarget, pending, hold, changeTimer } */
  _rooms = new Map();
  _client = null;
  _timer = null;
  _polling = false;
  _errors = 0;
  _reachable = true;
  _stopped = false;
  _pollInterval = 60_000;

  constructor(matterbridge, log, config) {
    super(matterbridge, log, config);
    this.config = config;
    if (
      typeof this.verifyMatterbridgeVersion !== 'function' ||
      !this.verifyMatterbridgeVersion('3.9.0')
    ) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.9.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }
    this.log.info('Initializing Adax Matterbridge platform');
  }

  async onStart(reason) {
    this.log.info('onStart called with reason:', reason ?? 'none');
    await this.ready;
    await this.clearSelect();
    this._stopped = false;

    const accountId = this.config.accountId ?? '';
    const clientSecret = this.config.clientSecret ?? '';
    if (!accountId || !clientSecret) {
      this.log.error(
        'accountId and clientSecret must be configured. Generate credentials in Adax WiFi app: Account → Remote user client API → Add Credential',
      );
      return;
    }

    this._client = new AdaxClient({ accountId, clientSecret });
    this._pollInterval = normalizePollInterval(this.config.pollInterval);

    // Failing here is not fatal: rooms are (re)discovered by the poll loop, so a temporary API problem at startup
    // no longer leaves the plugin without devices until the next restart.
    let loaded = false;
    try {
      const { rooms } = await this._client.fetchRooms();
      await this._syncRooms(rooms);
      loaded = true;
    } catch (err) {
      this.log.error(`Could not load rooms at startup: ${err.message}. Retrying in ${MIN_REQUEST_INTERVAL / 1000}s.`);
    }

    this.log.info(
      `Adax plugin ready: ${this._rooms.size} device(s), poll interval ${Math.round(this._pollInterval / 1000)}s`,
    );
    this._schedulePoll(loaded ? undefined : MIN_REQUEST_INTERVAL);
  }

  async _createDevice(room) {
    const id = `adax-${room.id}`;
    const serial = `ADX${room.id}`;
    const { name } = room;

    const target = room.target > 0 ? room.target : DEFAULT_TARGET;
    const currentTemp = (room.temperature ?? target) / 100;

    const device = new MatterbridgeEndpoint([thermostat, bridgedNode], { id }, this.config.debug)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, 0xfff1, 'Adax', 'WiFi Heater')
      .createDefaultThermostatClusterServer(currentTemp, target / 100, target / 100)
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    const entry = {
      id: room.id,
      name,
      device,
      state: { systemMode: room.heating ? 4 : 0, setpoint: target },
      lastTarget: room.target > 0 ? room.target : null,
      pending: null,
      hold: null,
      changeTimer: null,
    };

    await this.registerDevice(device);

    // Only changes made by a Matter controller are forwarded; our own updateAttribute calls are ignored.
    const fromController = (handler) => (value, _old, context) => {
      if (isLocalContext(context)) return;
      handler(value);
    };

    device.subscribeAttribute(
      Thermostat.id,
      'systemMode',
      fromController((value) => {
        this.log.info(`${name}: systemMode changed to ${value}`);
        this._handleModeChange(entry, value);
      }),
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      fromController((value) => {
        this.log.info(`${name}: heatingSetpoint changed to ${value / 100}°C`);
        this._queueSetpoint(entry, value);
      }),
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      fromController((value) => {
        this.log.info(`${name}: coolingSetpoint changed to ${value / 100}°C`);
        this._queueSetpoint(entry, value);
      }),
      this.log,
    );

    device.addCommandHandler('identify', ({ request: { identifyTime } }) => {
      device.log.info(`Command identify called identifyTime ${identifyTime}`);
    });

    device.addCommandHandler('triggerEffect', ({ request: { effectIdentifier, effectVariant } }) => {
      device.log.info(`Command triggerEffect called ${effectIdentifier} ${effectVariant}`);
    });

    device.addCommandHandler('setpointRaiseLower', ({ request: { mode, amount } }) => {
      // `amount` is in steps of 0.1 °C; setpoint attributes are in steps of 0.01 °C.
      device.log.info(`setpointRaiseLower mode: ${['Heat', 'Cool', 'Both'][mode]} amount: ${amount / 10}`);
      const current = device.getAttribute(Thermostat.id, 'occupiedHeatingSetpoint', this.log);
      this._queueSetpoint(entry, (current ?? entry.lastTarget ?? DEFAULT_TARGET) + amount * 10);
    });

    this._rooms.set(room.id, entry);
    this.log.info(`Registered room "${name}" (${id})`);
  }

  /** Create devices for rooms we have not seen before (at startup, or when a room is added in the Adax app). */
  async _syncRooms(rooms, startedAt) {
    for (const raw of rooms) {
      const room = parseRoom(raw);
      const entry = this._rooms.get(room.id);
      try {
        if (entry) await this._applyRoom(entry, room, startedAt);
        else await this._createDevice(room);
      } catch (err) {
        this.log.error(`${room.name}: ${entry ? 'failed to apply state' : 'not registered'} — ${err.message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Matter -> Adax
  // -------------------------------------------------------------------------

  _handleModeChange(entry, systemMode) {
    if (entry.state.systemMode === systemMode) return;
    entry.state.systemMode = systemMode;
    if (systemMode === 0) {
      this._queueChange(entry, { ...entry.pending, heatingEnabled: false });
    } else {
      // Turning on needs a target; use the one the user picked last unless a new one is already pending.
      this._queueChange(entry, {
        targetTemperature: entry.lastTarget ?? DEFAULT_TARGET,
        ...entry.pending,
        heatingEnabled: true,
      });
    }
  }

  _queueSetpoint(entry, hundredths) {
    const target = Math.round(hundredths);
    entry.lastTarget = target;
    entry.state.setpoint = target;
    // Mirror to both setpoints right away (the heater has a single target) so controllers show it and
    // consecutive setpointRaiseLower commands accumulate. These are local changes and are not echoed back.
    for (const attribute of ['occupiedHeatingSetpoint', 'occupiedCoolingSetpoint']) {
      entry.device.updateAttribute(Thermostat.id, attribute, target, this.log).catch((err) => {
        this.log.debug(`${entry.name}: could not update ${attribute}: ${err.message}`);
      });
    }
    this._queueChange(entry, { ...entry.pending, targetTemperature: target, heatingEnabled: true });
  }

  _queueChange(entry, change) {
    entry.pending = change;
    // Until a poll that started after the command was sent has come back, polls must not overwrite the new values.
    entry.hold = { sentAt: null };
    if (entry.changeTimer) clearTimeout(entry.changeTimer);
    entry.changeTimer = setTimeout(() => this._flushChange(entry), CHANGE_DEBOUNCE);
  }

  async _flushChange(entry) {
    entry.changeTimer = null;
    const change = entry.pending;
    entry.pending = null;
    if (!change || this._stopped) return;

    for (let attempt = 1; attempt <= MAX_COMMAND_ATTEMPTS; attempt++) {
      try {
        const { startedAt } = await this._client.control({ id: entry.id, ...change });
        this.log.info(`${entry.name}: set ${JSON.stringify(change)}`);
        if (entry.hold) entry.hold.sentAt = startedAt;
        this._schedulePoll(CONFIRM_DELAY);
        return;
      } catch (err) {
        if (this._stopped) return;
        if (err instanceof RateLimitError && attempt < MAX_COMMAND_ATTEMPTS) {
          this.log.warn(`${entry.name}: API rate limited, retrying (${attempt}/${MAX_COMMAND_ATTEMPTS})`);
          continue;
        }
        this.log.error(`${entry.name}: command failed: ${err.message}`);
        entry.hold = null;
        this._schedulePoll(CONFIRM_DELAY); // show what the heater really did
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Adax -> Matter
  // -------------------------------------------------------------------------

  _schedulePoll(delay) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    const actualDelay = delay ?? backoffDelay(this._pollInterval, this._errors);
    if (delay === undefined && this._errors > 0) {
      this.log.debug(`Backoff: next poll in ${Math.round(actualDelay / 1000)}s (failure #${this._errors})`);
    }
    this._timer = setTimeout(() => this._poll(), actualDelay);
  }

  async _poll() {
    if (this._polling || this._stopped) return;
    this._polling = true;
    try {
      let result;
      try {
        result = await this._client.fetchRooms();
      } catch (err) {
        await this._onPollFailure(err);
        return;
      }
      this._errors = 0;
      await this._setReachable(true);
      await this._syncRooms(result.rooms, result.startedAt);
    } finally {
      this._polling = false;
      this._schedulePoll();
    }
  }

  async _onPollFailure(err) {
    if (this._stopped) return;
    this._errors++;
    if (this._errors === 1) this.log.warn(`Poll failed: ${err.message}`);
    else this.log.debug(`Poll failed (#${this._errors}): ${err.message}`);
    if (this._errors === UNREACHABLE_AFTER) {
      this.log.error(`The Adax API did not respond ${this._errors} times in a row, marking devices as unreachable`);
      await this._setReachable(false);
    }
  }

  async _setReachable(reachable) {
    if (this._reachable === reachable) return;
    this._reachable = reachable;
    if (reachable) this.log.info('The Adax API is reachable again');
    for (const { device } of this._rooms.values()) {
      const cluster = BridgedDeviceBasicInformation.id;
      await device.updateAttribute(cluster, 'reachable', reachable, this.log);
      await device.triggerEvent(cluster, 'reachableChanged', { reachableNewValue: reachable }, this.log);
    }
  }

  async _applyRoom(entry, room, startedAt) {
    const { device } = entry;

    if (room.temperature !== null) {
      await device.updateAttribute(Thermostat.id, 'localTemperature', Math.round(room.temperature), this.log);
    }

    // A change made in a controller is not in the cloud yet (or a poll that started before it was sent is still
    // arriving). Applying that reading would flip the controller back to the old value.
    const held = entry.hold && (entry.hold.sentAt === null || (startedAt !== undefined && startedAt < entry.hold.sentAt));
    if (held) return;
    entry.hold = null;

    // The API reports a target of 0 while the heater is off; keep showing the last real target.
    if (room.target > 0) entry.lastTarget = room.target;
    const setpoint = room.target > 0 ? room.target : entry.lastTarget;
    const systemMode = room.heating ? 4 : 0;
    entry.state = { systemMode, setpoint: setpoint ?? entry.state.setpoint };

    if (setpoint !== null && setpoint !== undefined) {
      await device.updateAttribute(Thermostat.id, 'occupiedHeatingSetpoint', setpoint, this.log);
      await device.updateAttribute(Thermostat.id, 'occupiedCoolingSetpoint', setpoint, this.log);
    }
    await device.updateAttribute(Thermostat.id, 'systemMode', systemMode, this.log);
  }

  // -------------------------------------------------------------------------

  async onShutdown(reason) {
    this.log.info('Adax plugin shutdown', reason);
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    for (const entry of this._rooms.values()) {
      if (entry.changeTimer) clearTimeout(entry.changeTimer);
    }
    this._client?.close();
    if (this.config.unregisterOnShutdown === true) {
      for (const { device } of this._rooms.values()) {
        await this.unregisterDevice(device).catch(() => {});
      }
    }
    this._rooms.clear();
    await super.onShutdown(reason);
  }
}
