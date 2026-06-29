import {
  bridgedNode,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  thermostat,
} from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';

const API_BASE = 'https://api-1.adax.no/client-api';
const MIN_REQUEST_INTERVAL = 30_000;
const HTTP_TIMEOUT = 10_000;

export default function initializePlugin(matterbridge, log, config) {
  return new AdaxMatterbridgePlatform(matterbridge, log, config);
}

export class AdaxMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  _rooms = [];
  _pollTimer = null;
  _token = null;
  _tokenExpires = 0;
  _lastApiValues = new Map();
  _lastNonZeroTarget = new Map();
  _lastApiCall = 0;
  _consecutiveErrors = 0;
  _apiQueue = [];
  _apiQueueProcessing = false;

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

    this._accountId = this.config.accountId ?? '';
    this._clientSecret = this.config.clientSecret ?? '';

    if (!this._accountId || !this._clientSecret) {
      this.log.error(
        'accountId and clientSecret must be configured. Generate credentials in Adax WiFi app: Account \u2192 Remote user client API \u2192 Add Credential',
      );
      return;
    }

    await this._authenticate();

    const rooms = await this._fetchRooms();
    if (rooms) {
      for (const room of rooms) {
        await this._createDevice(room);
      }
    }

    this._schedulePoll();

    this.log.info(
      `Adax plugin ready: ${this._rooms.length} device(s), poll interval ${Math.round(Math.max(this.config.pollInterval ?? 60_000, 30_000) / 1000)}s`,
    );
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _enqueueApiCall(fn) {
    return new Promise((resolve, reject) => {
      this._apiQueue.push({ fn, resolve, reject });
      this._processApiQueue();
    });
  }

  async _processApiQueue() {
    if (this._apiQueueProcessing) return;
    this._apiQueueProcessing = true;

    while (this._apiQueue.length > 0) {
      const elapsed = Date.now() - this._lastApiCall;
      const remaining = MIN_REQUEST_INTERVAL - elapsed;
      if (remaining > 0) {
        this.log.debug(`Rate limit: waiting ${remaining}ms before next API call`);
        await this._sleep(remaining);
      }

      const { fn, resolve, reject } = this._apiQueue.shift();
      try {
        const result = await fn();
        this._lastApiCall = Date.now();
        resolve(result);
      } catch (err) {
        this.log.debug(`API call failed, waiting 5s before next: ${err.message}`);
        await this._sleep(5_000);
        reject(err);
      }
    }

    this._apiQueueProcessing = false;
  }

  async _authenticate() {
    try {
      const res = await fetch(`${API_BASE}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          username: String(this._accountId),
          password: this._clientSecret,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      });
      if (!res.ok) throw new Error(`Auth HTTP ${res.status}`);
      const data = await res.json();
      this._token = data.access_token;
      this._tokenExpires = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
      this.log.info('Adax authentication successful');
    } catch (err) {
      this.log.error(`Authentication failed: ${err.message}`);
      throw err;
    }
  }

  async _ensureAuth() {
    if (!this._token || Date.now() >= this._tokenExpires) {
      await this._authenticate();
    }
  }

  async _fetchWithAuth(url, options = {}) {
    await this._ensureAuth();
    let res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this._token}`,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    }).catch((err) => {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`Request timed out after ${HTTP_TIMEOUT / 1000}s`);
      }
      throw err;
    });
    if (res.status === 401) {
      this.log.info('Token expired, re-authenticating');
      await this._authenticate();
      res = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${this._token}`,
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT),
      }).catch((err) => {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw new Error(`Request timed out after ${HTTP_TIMEOUT / 1000}s`);
        }
        throw err;
      });
    }
    return res;
  }

  async _fetchRooms() {
    const res = await this._fetchWithAuth(`${API_BASE}/rest/v1/content/`);
    if (res.status === 429) {
      this.log.warn('API rate limited during fetchRooms');
      return null;
    }
    if (!res.ok) throw new Error(`Fetch rooms HTTP ${res.status}`);
    const data = await res.json();
    return data.rooms ?? [];
  }

  async _createDevice(room) {
    const name = room.name ?? `Room ${room.id}`;
    const id = `adax-${room.id}`;
    const serial = `ADX${room.id}`;

    const targetTemp = (room.targetTemperature ?? 2100) / 100;
    const currentTemp = (room.temperature ?? targetTemp) / 100;

    const device = new MatterbridgeEndpoint(
      [thermostat, bridgedNode],
      { id },
      this.config.debug,
    )
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        0xfff1,
        'Adax',
        'WiFi Heater',
      )
      .createDefaultThermostatClusterServer(currentTemp, targetTemp, targetTemp)
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(device);

    device.subscribeAttribute(
      Thermostat.id,
      'systemMode',
      (value) => {
        const prev = this._lastApiValues.get(room.id);
        if (prev && prev.mode === value) return;
        this.log.info(`${name}: systemMode changed to ${value}`);
        this._handleModeChange(room.id, name, value);
      },
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      (value) => {
        const prevSetpoint = this._lastApiValues.get(room.id);
        if (prevSetpoint && prevSetpoint.setpoint === value) return;
        const temp = value / 100;
        this.log.info(`${name}: heatingSetpoint changed to ${temp}\u00b0C`);
        this._setTargetTemp(room.id, name, temp, true);
      },
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      (value) => {
        const prevCool = this._lastApiValues.get(room.id);
        if (prevCool && prevCool.setpoint === value) return;
        const temp = value / 100;
        this.log.info(`${name}: coolingSetpoint changed to ${temp}\u00b0C`);
        this._setTargetTemp(room.id, name, temp, true);
      },
      this.log,
    );

    device.addCommandHandler('identify', ({ request: { identifyTime } }) => {
      device.log.info(`Command identify called identifyTime ${identifyTime}`);
    });

    device.addCommandHandler('triggerEffect', ({ request: { effectIdentifier, effectVariant } }) => {
      device.log.info(
        `Command triggerEffect called ${effectIdentifier} ${effectVariant}`,
      );
    });

    device.addCommandHandler('setpointRaiseLower', ({ request: { mode, amount } }) => {
      const currentSetpoint = device.getAttribute(
        Thermostat.id,
        'occupiedHeatingSetpoint',
        this.log,
      );
      const newSetpoint = ((currentSetpoint ?? 2100) + amount) / 100;
      device.log.info(
        `setpointRaiseLower mode: ${['Heat', 'Cool', 'Both'][mode]} amount: ${amount / 10}`,
      );
      this._setTargetTemp(room.id, name, newSetpoint, true);
    });

    this._rooms.push({ id: room.id, name, device, serial });
    this.log.info(`Registered room "${name}" (${id})`);
  }

  _handleModeChange(roomId, name, systemMode) {
    this._setTargetTemp(roomId, name, undefined, systemMode !== 0);
  }

  async _setTargetTemp(roomId, name, temperature, heatingEnabled) {
    try {
      const body = { rooms: [{ id: roomId }] };
      if (heatingEnabled === true) {
        const prev = this._lastNonZeroTarget.get(roomId) ?? 2100;
        const setpoint = temperature != null ? Math.round(temperature * 100) : prev;
        body.rooms[0].targetTemperature = String(setpoint);
        body.rooms[0].heatingEnabled = 'true';
      } else if (heatingEnabled === false) {
        body.rooms[0].heatingEnabled = 'false';
      } else if (temperature != null) {
        body.rooms[0].targetTemperature = String(Math.round(temperature * 100));
      } else {
        return;
      }

      await this._enqueueApiCall(async () => {
        const res = await this._fetchWithAuth(`${API_BASE}/rest/v1/control/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          this.log.warn(`${name}: API rate limited`);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.log.info(`${name}: set target to ${JSON.stringify(body.rooms[0])}`);
      });
    } catch (err) {
      this.log.error(`${name}: Set temp failed: ${err.message}`);
    }
  }

  _schedulePoll(delay) {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    const base = Math.max(this.config.pollInterval ?? 60_000, 30_000);
    const factor = Math.min(this._consecutiveErrors, 5);
    const actualDelay = delay ?? Math.min(base * Math.pow(2, factor), 300_000);
    if (actualDelay !== base) {
      this.log.info(
        `Backoff active: next poll in ${Math.round(actualDelay / 1000)}s (base ${base / 1000}s, error #${this._consecutiveErrors})`,
      );
    }
    this._pollTimer = setTimeout(() => this._doPoll(), actualDelay);
  }

  async _doPoll() {
    try {
      const rooms = await this._enqueueApiCall(async () => {
        const roomsData = await this._fetchRooms();
        return roomsData;
      });

      if (rooms === null || rooms === undefined) {
        this._consecutiveErrors++;
        this.log.warn(`Poll returned null, consecutive errors: ${this._consecutiveErrors}`);
        return;
      }

      this._consecutiveErrors = 0;

      for (const room of rooms) {
        const deviceData = this._rooms.find((r) => r.id === room.id);
        if (!deviceData) continue;
        this._updateState(deviceData.device, room, deviceData.name);
      }
    } catch (err) {
      this._consecutiveErrors++;
      this.log.error(`Poll error: ${err.message}`);
    } finally {
      this._schedulePoll();
    }
  }

  _updateState(device, room, name) {
    const currentTemp = (room.temperature ?? 2100) / 100;
    const rawTarget = room.targetTemperature;
    const targetHundredths = rawTarget != null ? Number(rawTarget) : 2100;
    const heating = room.heatingEnabled === true;

    if (targetHundredths > 0) {
      this._lastNonZeroTarget.set(room.id, targetHundredths);
    }

    const displayTarget = targetHundredths > 0
      ? targetHundredths
      : (this._lastNonZeroTarget.get(room.id) ?? 2100);
    const systemMode = heating ? 4 : 0;

    this._lastApiValues.set(room.id, {
      mode: systemMode,
      setpoint: displayTarget,
    });

    device.updateAttribute(
      Thermostat.id,
      'localTemperature',
      Math.round(currentTemp * 100),
      this.log,
    );

    device.updateAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      displayTarget,
      this.log,
    );
    device.updateAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      displayTarget,
      this.log,
    );

    device.updateAttribute(Thermostat.id, 'systemMode', systemMode, this.log);
  }

  async onShutdown(reason) {
    this.log.info('Adax plugin shutdown', reason);
    if (this._pollTimer) clearTimeout(this._pollTimer);
    if (this.config.unregisterOnShutdown === true) {
      for (const { device } of this._rooms) {
        await this.unregisterDevice(device).catch(() => {});
      }
    }
    this._rooms = [];
    await super.onShutdown(reason);
  }
}
