import {
  bridgedNode,
  powerSource,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  thermostat,
} from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';

const API_BASE = 'https://api-1.adax.no/client-api';

export default function initializePlugin(matterbridge, log, config) {
  return new AdaxMatterbridgePlatform(matterbridge, log, config);
}

export class AdaxMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  _rooms = [];
  _interval;
  _token = null;
  _tokenExpires = 0;
  _lastApiValues = new Map();

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
        'accountId and clientSecret must be configured. Generate credentials in Adax WiFi app: Account → Remote user client API → Add Credential',
      );
      return;
    }

    await this._authenticate();

    const rooms = await this._fetchRooms();
    for (const room of rooms) {
      await this._createDevice(room);
    }

    const pollInterval = this.config.pollInterval ?? 30_000;
    this._interval = setInterval(() => this._pollAll(), pollInterval);
    setTimeout(() => this._pollAll(), 3_000);
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
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this._token}`,
      },
    });
    if (res.status === 401) {
      await this._authenticate();
      return await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${this._token}`,
        },
      });
    }
    return res;
  }

  async _fetchRooms() {
    const res = await this._fetchWithAuth(`${API_BASE}/rest/v1/content/`);
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
      [thermostat, bridgedNode, powerSource],
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
        this.log.info(`${name}: heatingSetpoint changed to ${temp}C`);
        this._setTargetTemp(room.id, name, temp);
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
        this.log.info(`${name}: coolingSetpoint changed to ${temp}C`);
        this._setTargetTemp(room.id, name, temp);
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
      this._setTargetTemp(room.id, name, newSetpoint);
    });

    this._rooms.push({ id: room.id, name, device, serial });
    this.log.info(`Registered room "${name}" (${id})`);
  }

  _handleModeChange(roomId, name, systemMode) {
    if (systemMode === 0) {
      this._setTargetTemp(roomId, name, 7);
    } else {
      const deviceData = this._rooms.find((r) => r.id === roomId);
      if (deviceData) {
        const current = deviceData.device.getAttribute(
          Thermostat.id,
          'occupiedHeatingSetpoint',
          this.log,
        );
        this._setTargetTemp(roomId, name, (current ?? 2100) / 100);
      }
    }
  }

  async _setTargetTemp(roomId, name, temperature) {
    const tempHundredths = Math.round(temperature * 100);
    try {
      const res = await this._fetchWithAuth(`${API_BASE}/rest/v1/control/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rooms: [{ id: roomId, targetTemperature: String(tempHundredths) }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.log.info(`${name}: set target to ${temperature.toFixed(1)}C`);
    } catch (err) {
      this.log.error(`${name}: Set temp failed: ${err.message}`);
    }
  }

  async _pollAll() {
    try {
      const rooms = await this._fetchRooms();
      for (const room of rooms) {
        const deviceData = this._rooms.find((r) => r.id === room.id);
        if (!deviceData) continue;
        this._updateState(deviceData.device, room, deviceData.name);
      }
    } catch (err) {
      this.log.error(`Poll error: ${err.message}`);
    }
  }

  _updateState(device, room, name) {
    const currentTemp = (room.temperature ?? 2100) / 100;
    const targetTemp = (room.targetTemperature ?? 2100) / 100;
    const heating = room.heatingEnabled === true;
    const systemMode = heating ? 4 : 0;

    this._lastApiValues.set(room.id, {
      mode: systemMode,
      setpoint: Math.round(targetTemp * 100),
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
      Math.round(targetTemp * 100),
      this.log,
    );
    device.updateAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      Math.round(targetTemp * 100),
      this.log,
    );

    device.updateAttribute(Thermostat.id, 'systemMode', systemMode, this.log);
  }

  async onShutdown(reason) {
    if (this._interval) clearInterval(this._interval);
    this._rooms.forEach(({ device }) => {
      this.unregisterDevice(device).catch(() => {});
    });
    this._rooms = [];
    this.log.info('Adax plugin shutdown');
  }
}
