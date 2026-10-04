import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import './helpers/register-stubs.js';
import { fakeApi } from './fake-api.js';

const { AdaxMatterbridgePlatform } = await import('../dist/module.js');

const THERMOSTAT = 513;
const BRIDGED_BASIC_INFO = 57;

const makeRooms = () => [
  { id: 1, name: 'Living', temperature: 2100, targetTemperature: 2200, heatingEnabled: true },
  { id: 2, name: 'Hall', temperature: 1900, targetTemperature: 0, heatingEnabled: false },
];

const makeLog = () => {
  const lines = [];
  const log = { lines };
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...a) => lines.push([level, a.join(' ')]);
  return log;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const tick = async (ms) => {
  mock.timers.tick(ms);
  await flush();
};

// Advance time in small steps so chained work (poll -> response -> next timer) can run between timers.
const advance = async (ms, step = 1_000) => {
  for (let t = 0; t < ms; t += step) await tick(Math.min(step, ms - t));
};

describe('AdaxMatterbridgePlatform', () => {
  let api;
  let realFetch;
  let platform;
  let log;

  const start = async (config = {}, { before } = {}) => {
    api = fakeApi(makeRooms());
    before?.(api);
    globalThis.fetch = api.fetch;
    log = makeLog();
    platform = new AdaxMatterbridgePlatform({ matterbridgeVersion: '3.10.0' }, log, {
      accountId: 123,
      clientSecret: 'secret',
      pollInterval: 60_000,
      ...config,
    });
    const started = platform.onStart('test');
    await flush();
    await started;
    await flush();
    return platform.registered;
  };
  const room = (id) => platform._rooms.get(id);
  const get = (device, attribute) => device.getAttribute(THERMOSTAT, attribute);

  beforeEach(() => {
    realFetch = globalThis.fetch;
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  });

  afterEach(async () => {
    await platform?.onShutdown('test');
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  it('registers one thermostat per room with stable identities', async () => {
    const [living, hall] = await start();
    assert.deepEqual([living.id, hall.id], ['adax-1', 'adax-2']);
    assert.deepEqual(living.calls.basicInfo.slice(0, 2), ['Living', 'ADX1']);
    assert.deepEqual(living.calls.thermostat, [21, 22, 22]);
    assert.deepEqual(hall.calls.thermostat, [19, 21, 21]); // heater off: target 0 falls back to 21 °C
    assert.ok(living.calls.wired);
  });

  it('logs an error and does nothing without credentials', async () => {
    await start({ accountId: '', clientSecret: '' });
    assert.equal(platform.registered.length, 0);
    assert.equal(api.requests.length, 0);
    assert.ok(log.lines.some(([level]) => level === 'error'));
  });

  it('applies polled state and keeps the last real target while the heater is off', async () => {
    const [living, hall] = await start();
    api.rooms[0].temperature = 2150;
    api.rooms[0].targetTemperature = 0; // off
    api.rooms[0].heatingEnabled = false;
    api.rooms[1].targetTemperature = 2300;
    api.rooms[1].heatingEnabled = true;
    await tick(60_000);
    assert.equal(get(living, 'localTemperature'), 2150);
    assert.equal(get(living, 'systemMode'), 0);
    assert.equal(get(living, 'occupiedHeatingSetpoint'), 2200); // remembered, not 0
    assert.equal(get(hall, 'systemMode'), 4);
    assert.equal(get(hall, 'occupiedHeatingSetpoint'), 2300);
    assert.equal(get(hall, 'occupiedCoolingSetpoint'), 2300);
  });

  it('does not invent a temperature when the API has none', async () => {
    const [living] = await start();
    delete api.rooms[0].temperature;
    await tick(60_000);
    assert.equal(get(living, 'localTemperature') ?? null, null);
  });

  it('never echoes its own attribute changes to the cloud', async () => {
    const [living] = await start();
    await living.updateAttribute(THERMOSTAT, 'systemMode', 0);
    await living.updateAttribute(THERMOSTAT, 'occupiedHeatingSetpoint', 2800);
    await tick(120_000);
    assert.deepEqual(api.controls(), []);
  });

  it('turns a heater off from a controller', async () => {
    const [living] = await start();
    living.writeFromController(THERMOSTAT, 'systemMode', 0);
    await tick(800);
    await tick(30_000); // requests are at least 30 s apart
    assert.deepEqual(api.controls(), [[{ id: 1, heatingEnabled: 'false' }]]);
  });

  it('turns a heater on with the last target', async () => {
    const [, hall] = await start();
    hall.writeFromController(THERMOSTAT, 'systemMode', 4);
    await tick(800);
    await tick(30_000);
    assert.deepEqual(api.controls(), [[{ id: 2, targetTemperature: '2100', heatingEnabled: 'true' }]]);
  });

  it('sends only the final setpoint of a slider drag, and mirrors it to both setpoints', async () => {
    const [living] = await start();
    for (const c of [2210, 2250, 2300]) living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', c);
    await flush();
    assert.equal(get(living, 'occupiedCoolingSetpoint'), 2300);
    await tick(800);
    await tick(30_000);
    assert.deepEqual(api.controls(), [[{ id: 1, targetTemperature: '2300', heatingEnabled: 'true' }]]);
  });

  it('puts changes to several rooms into one request', async () => {
    const [living, hall] = await start();
    living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2300);
    hall.writeFromController(THERMOSTAT, 'systemMode', 4);
    await tick(800);
    await tick(30_000);
    assert.equal(api.controls().length, 1);
    assert.equal(api.controls()[0].length, 2);
  });

  it('setpointRaiseLower raises by the requested tenths of a degree (regression: was 0.1 x too little)', async () => {
    const [living] = await start();
    const handler = living.commandHandlers.get('setpointRaiseLower');
    handler({ request: { mode: 0, amount: 10 } }); // +1.0 °C
    handler({ request: { mode: 0, amount: 5 } }); // +0.5 °C on top
    await flush();
    assert.equal(get(living, 'occupiedHeatingSetpoint'), 2350);
    await tick(800);
    await tick(30_000);
    assert.deepEqual(api.controls(), [[{ id: 1, targetTemperature: '2350', heatingEnabled: 'true' }]]);
  });

  it('confirms with a poll after a command and shows the cloud\'s answer', async () => {
    const [living] = await start();
    living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2400);
    await tick(800);
    await tick(30_000); // command sent
    const pollsAfterCommand = api.polls().length;
    await tick(60_000); // confirmation poll
    assert.ok(api.polls().length > pollsAfterCommand);
    assert.equal(api.rooms[0].targetTemperature, 2400);
    assert.equal(get(living, 'occupiedHeatingSetpoint'), 2400);
  });

  it('does not let a stale in-flight poll flip a controller change back', async () => {
    const [living] = await start();
    let release;
    api.gate = new Promise((r) => (release = r)); // the next poll is slow
    await tick(60_000); // poll starts and hangs, carrying the old state
    living.writeFromController(THERMOSTAT, 'systemMode', 0);
    release();
    await flush();
    assert.equal(get(living, 'systemMode'), 0); // not reverted to 4
    api.gate = null;
    await tick(800);
    await tick(60_000);
    await tick(60_000);
    assert.equal(api.rooms[0].heatingEnabled, false);
    assert.equal(get(living, 'systemMode'), 0);
  });

  it('retries a command that gets rate limited', async () => {
    const [living] = await start();
    api.nextStatus.push(429);
    living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2400);
    await tick(800);
    await tick(30_000); // first attempt -> 429
    await tick(60_000); // blocked for 2 x 30 s, then the retry goes out
    assert.equal(api.controls().length, 2);
    assert.equal(api.rooms[0].targetTemperature, 2400);
    assert.ok(log.lines.some(([level, msg]) => level === 'warn' && msg.includes('rate limited')));
  });

  it('shows what the heater really did after a command fails', async () => {
    const [living] = await start();
    api.nextStatus.push(500);
    living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2400);
    await tick(800);
    await tick(30_000);
    await tick(60_000); // resync poll
    assert.equal(get(living, 'occupiedHeatingSetpoint'), 2200);
  });

  it('keeps all requests at least 30 s apart, whatever happens', async () => {
    const [living, hall] = await start();
    for (let i = 0; i < 6; i++) {
      living.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2200 + i * 50);
      hall.writeFromController(THERMOSTAT, 'systemMode', i % 2 ? 0 : 4);
      await advance(5_000);
    }
    await advance(300_000);
    const times = api.requests.filter((r) => r.path !== '/auth/token').map((r) => r.at);
    assert.ok(times.length > 3);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 30_000, `gap ${times[i] - times[i - 1]} at #${i}`);
  });

  it('recovers when the first load fails: no devices at first, then they appear', async () => {
    await start({}, { before: (a) => a.nextStatus.push(500) });
    assert.equal(platform.registered.length, 0);
    assert.ok(log.lines.some(([level, msg]) => level === 'error' && msg.includes('Could not load rooms')));
    await tick(30_000);
    assert.equal(platform.registered.length, 2);
  });

  it('registers rooms that are added in the Adax app later', async () => {
    await start();
    api.rooms.push({ id: 3, name: 'Bathroom', temperature: 2300, targetTemperature: 2400, heatingEnabled: true });
    await tick(60_000);
    assert.equal(platform.registered.length, 3);
    assert.equal(platform.registered[2].id, 'adax-3');
  });

  it('marks devices unreachable after repeated failures and recovers', async () => {
    const [living, hall] = await start();
    api.nextStatus.push(500, 500, 500);
    await tick(60_000); // failure 1, next poll after 2 x interval
    assert.deepEqual(living.events, []);
    await tick(120_000); // failure 2, next after 4 x interval
    await tick(240_000); // failure 3
    for (const device of [living, hall]) {
      assert.deepEqual(device.events, [{ cluster: BRIDGED_BASIC_INFO, event: 'reachableChanged', payload: { reachableNewValue: false } }]);
    }
    await advance(300_000); // backoff is capped at 5 min; the API answers again
    for (const device of [living, hall]) {
      assert.equal(device.events.at(-1).payload.reachableNewValue, true);
      assert.equal(device.getAttribute(BRIDGED_BASIC_INFO, 'reachable'), true);
    }
  });

  it('stops polling and aborts on shutdown', async () => {
    await start();
    await platform.onShutdown('test');
    const before = api.requests.length;
    await tick(600_000);
    assert.equal(api.requests.length, before);
  });

  it('does not restart its timer when shutdown happens during a poll', async () => {
    await start();
    let release;
    api.gate = new Promise((r) => (release = r));
    await tick(60_000); // poll hangs
    const shutdown = platform.onShutdown('test');
    release();
    await shutdown;
    await flush();
    const before = api.requests.length;
    await tick(600_000);
    assert.equal(api.requests.length, before);
  });
});
