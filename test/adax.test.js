import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  AdaxClient,
  AuthError,
  backoffDelay,
  controlRoomBody,
  isLocalContext,
  MAX_BACKOFF,
  normalizePollInterval,
  parseRoom,
  RateLimitError,
} from '../dist/adax.js';
import { fakeApi } from './fake-api.js';

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const tick = async (ms) => {
  mock.timers.tick(ms);
  await flush();
};

describe('parseRoom', () => {
  it('maps a room and keeps unknown readings unknown', () => {
    assert.deepEqual(parseRoom({ id: 7, name: 'Living', temperature: 2112, targetTemperature: 2200, heatingEnabled: true }), {
      id: 7, name: 'Living', temperature: 2112, target: 2200, heating: true,
    });
    const r = parseRoom({ id: 8 });
    assert.deepEqual(r, { id: 8, name: 'Room 8', temperature: null, target: null, heating: false });
  });

  it('accepts string values', () => {
    const r = parseRoom({ id: 1, temperature: '2000', targetTemperature: '0', heatingEnabled: 'true' });
    assert.equal(r.temperature, 2000);
    assert.equal(r.target, 0);
    assert.equal(r.heating, true);
  });
});

describe('controlRoomBody', () => {
  it('uses string values as the API expects', () => {
    assert.deepEqual(controlRoomBody(5, { targetTemperature: 2150, heatingEnabled: true }), {
      id: 5, targetTemperature: '2150', heatingEnabled: 'true',
    });
  });

  it('only sends heatingEnabled when turning off', () => {
    assert.deepEqual(controlRoomBody(5, { targetTemperature: 2150, heatingEnabled: false }), {
      id: 5, heatingEnabled: 'false',
    });
  });

  it('can change the target alone', () => {
    assert.deepEqual(controlRoomBody(5, { targetTemperature: 1900 }), { id: 5, targetTemperature: '1900' });
  });
});

describe('scheduling helpers', () => {
  it('normalizePollInterval enforces the 30 s minimum', () => {
    assert.equal(normalizePollInterval(10_000), 30_000);
    assert.equal(normalizePollInterval(120_000), 120_000);
    assert.equal(normalizePollInterval('90000'), 90_000);
    assert.equal(normalizePollInterval(undefined), 60_000);
    assert.equal(normalizePollInterval('x'), 60_000);
  });

  it('backoffDelay doubles and is capped', () => {
    assert.equal(backoffDelay(60_000, 0), 60_000);
    assert.equal(backoffDelay(60_000, 2), 240_000);
    assert.equal(backoffDelay(60_000, 3), MAX_BACKOFF);
    assert.equal(backoffDelay(60_000, 99), MAX_BACKOFF);
  });

  it('isLocalContext tells plugin changes from controller changes', () => {
    assert.equal(isLocalContext({ offline: true }), true);
    assert.equal(isLocalContext({}), true);
    assert.equal(isLocalContext({ session: {}, fabric: 1 }), false);
    assert.equal(isLocalContext(undefined), false);
  });
});

describe('AdaxClient', () => {
  let api;
  let client;
  const rooms = () => [
    { id: 1, name: 'A', temperature: 2000, targetTemperature: 2100, heatingEnabled: true },
    { id: 2, name: 'B', temperature: 1900, targetTemperature: 0, heatingEnabled: false },
  ];

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    api = fakeApi(rooms());
    client = new AdaxClient({ accountId: 123, clientSecret: 's3cret', fetchImpl: api.fetch });
  });

  afterEach(() => {
    client.close();
    mock.timers.reset();
  });

  it('authenticates with the password grant and uses the bearer token', async () => {
    const { rooms: got } = await client.fetchRooms();
    assert.equal(got.length, 2);
    const [auth, content] = api.requests;
    assert.equal(auth.path, '/auth/token');
    assert.equal(auth.body.get('grant_type'), 'password');
    assert.equal(auth.body.get('username'), '123');
    assert.equal(auth.body.get('password'), 's3cret');
    assert.equal(content.headers.Authorization, 'Bearer tok1');
  });

  it('reuses the token and authenticates only once for several requests', async () => {
    await client.fetchRooms();
    const second = client.fetchRooms();
    await tick(30_000);
    await second;
    assert.equal(api.tokenCalls, 1);
  });

  it('re-authenticates once on 401 and retries', async () => {
    await client.fetchRooms(); // token 1
    api.nextStatus.push(401);
    const second = client.fetchRooms();
    await tick(30_000);
    const { rooms: got } = await second;
    assert.equal(got.length, 2);
    assert.equal(api.tokenCalls, 2);
    assert.equal(api.requests.at(-1).headers.Authorization, 'Bearer tok2');
  });

  it('reports bad credentials clearly', async () => {
    api.authStatus = 401;
    await assert.rejects(client.fetchRooms(), (err) => err instanceof AuthError && /accountId and clientSecret/.test(err.message));
  });

  it('never sends two requests closer than 30 s, and the first goes out immediately', async () => {
    await client.fetchRooms();
    const second = client.fetchRooms();
    const third = client.control({ id: 1, targetTemperature: 2200, heatingEnabled: true });
    await tick(29_999);
    assert.equal(api.requests.filter((r) => r.path !== '/auth/token').length, 1);
    await tick(1);
    await tick(30_000);
    await Promise.all([second, third]);
    const times = api.requests.filter((r) => r.path !== '/auth/token').map((r) => r.at);
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 30_000, `gap ${times[i] - times[i - 1]}`);
  });

  it('sends commands before a waiting poll', async () => {
    await client.fetchRooms();
    const poll = client.fetchRooms();
    const control = client.control({ id: 1, targetTemperature: 2300, heatingEnabled: true });
    await tick(30_000);
    await control;
    assert.equal(api.requests.at(-1).path, '/rest/v1/control/');
    await tick(30_000);
    await poll;
    assert.equal(api.requests.at(-1).path, '/rest/v1/content/');
  });

  it('shares one request between callers that poll at the same time', async () => {
    await client.fetchRooms();
    const [a, b] = [client.fetchRooms(), client.fetchRooms()];
    await tick(30_000);
    assert.equal((await a).rooms.length, (await b).rooms.length);
    assert.equal(api.polls().length, 2);
  });

  it('merges all pending changes into one control request', async () => {
    await client.fetchRooms();
    const sent = [
      client.control({ id: 1, targetTemperature: 2200, heatingEnabled: true }),
      client.control({ id: 2, targetTemperature: 1800, heatingEnabled: true }),
      client.control({ id: 1, targetTemperature: 2300 }),
    ];
    await tick(30_000);
    await Promise.all(sent);
    assert.equal(api.controls().length, 1);
    assert.deepEqual(api.controls()[0], [
      { id: 1, targetTemperature: '2300', heatingEnabled: 'true' },
      { id: 2, targetTemperature: '1800', heatingEnabled: 'true' },
    ]);
  });

  it('tells callers when the request was actually sent', async () => {
    await client.fetchRooms();
    const control = client.control({ id: 1, heatingEnabled: false });
    await tick(30_000);
    assert.equal((await control).startedAt, 30_000);
  });

  it('backs off after a 429 and reports it as a RateLimitError', async () => {
    await client.fetchRooms();
    api.nextStatus.push(429);
    const limited = client.fetchRooms();
    const assertion = assert.rejects(limited, RateLimitError);
    await tick(30_000);
    await assertion;
    const retry = client.fetchRooms();
    await tick(59_999);
    assert.equal(api.polls().length, 2); // blocked for 2 x 30 s after the 429
    await tick(1);
    await retry;
    assert.equal(api.polls().length, 3);
  });

  it('turns non-OK responses and hangs into readable errors', async () => {
    api.nextStatus.push(500);
    await assert.rejects(client.fetchRooms(), /HTTP 500/);

    const slow = new AdaxClient({
      accountId: 1,
      clientSecret: 'x',
      timeout: 20,
      fetchImpl: (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason))),
    });
    const pending = assert.rejects(slow.fetchRooms(), /timed out after 0\.02s/);
    await tick(25);
    await pending;
    slow.close();
  });

  it('close() rejects queued work and aborts the request in flight', async () => {
    await client.fetchRooms();
    const queued = client.fetchRooms();
    const control = client.control({ id: 1, heatingEnabled: false });
    const checks = Promise.all([assert.rejects(queued, /Client closed/), assert.rejects(control, /Client closed/)]);
    client.close();
    await checks;
    await assert.rejects(client.fetchRooms(), /Client closed/);
  });
});
