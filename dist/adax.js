// Pure helpers and the cloud API client for Adax WiFi heaters.
// Nothing in this file depends on Matterbridge so it can be unit tested on its own.

export const API_BASE = 'https://api-1.adax.no/client-api';
// The API is not documented to have a rate limit, but it answers 429 if called more often than about once per 30 s
// (same limit as the pyAdax library). All requests are spaced at least this far apart.
export const MIN_REQUEST_INTERVAL = 30_000;
export const HTTP_TIMEOUT = 10_000;
export const DEFAULT_POLL_INTERVAL = 60_000;
export const MAX_BACKOFF = 300_000;

export class RateLimitError extends Error {
  constructor(message = 'API rate limited (HTTP 429)') {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Configuration and scheduling
// ---------------------------------------------------------------------------

export function normalizePollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL;
  return Math.max(n, MIN_REQUEST_INTERVAL);
}

/** Exponential backoff on consecutive failures: base, 2x, 4x ... capped at MAX_BACKOFF. */
export function backoffDelay(base, consecutiveErrors) {
  return Math.min(base * 2 ** Math.min(consecutiveErrors, 5), MAX_BACKOFF);
}

/**
 * True when an attribute change came from inside the plugin (our own updateAttribute), not from a Matter controller.
 * `offline` is the long-standing marker; newer matter.js prefers the absence of a fabric/session.
 */
export function isLocalContext(context) {
  if (!context) return false;
  if (context.offline === true) return true;
  return context.offline === undefined && context.session === undefined && context.fabric === undefined;
}

// ---------------------------------------------------------------------------
// Adax -> Matter
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one room from `/rest/v1/content/`. Temperatures are in hundredths of a degree, as in the API.
 * Missing readings are `null` rather than invented defaults. `target` is 0 while the heater is off.
 */
export function parseRoom(room) {
  return {
    id: room.id,
    name: room.name ?? `Room ${room.id}`,
    temperature: toNumber(room.temperature),
    target: toNumber(room.targetTemperature),
    heating: room.heatingEnabled === true || room.heatingEnabled === 'true',
  };
}

// ---------------------------------------------------------------------------
// Matter -> Adax
// ---------------------------------------------------------------------------

/** One room entry of a `/rest/v1/control/` request body (the API wants string values). */
export function controlRoomBody(id, change) {
  const body = { id };
  if (change.heatingEnabled === false) {
    body.heatingEnabled = 'false';
    return body;
  }
  if (change.targetTemperature != null) body.targetTemperature = String(Math.round(change.targetTemperature));
  if (change.heatingEnabled === true) body.heatingEnabled = 'true';
  return body;
}

// ---------------------------------------------------------------------------
// Cloud client
// ---------------------------------------------------------------------------

/**
 * Talks to the Adax cloud. Every API call is spaced at least `minInterval` apart. Commands go before polls, a poll
 * that is already waiting is shared, and all pending room changes are sent in a single control request, so a burst of
 * changes costs one request instead of one per change.
 */
export class AdaxClient {
  #token = null;
  #tokenExpires = 0;
  #authPromise = null;
  #poll = null;
  #control = null;
  #pumping = false;
  #lastStart = -Infinity;
  #blockedUntil = 0;
  #abort = new AbortController();
  #wake = null;
  #fetch;
  #now;

  constructor({
    accountId,
    clientSecret,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    minInterval = MIN_REQUEST_INTERVAL,
    timeout = HTTP_TIMEOUT,
    apiBase = API_BASE,
  }) {
    this.accountId = accountId;
    this.clientSecret = clientSecret;
    this.minInterval = minInterval;
    this.timeout = timeout;
    this.apiBase = apiBase;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  /** Fetch all rooms. Resolves `{ rooms, startedAt }`, where `startedAt` is when the request was actually sent. */
  fetchRooms() {
    const task = (this.#poll ??= this.#defer());
    this.#pump(); // may take the task off the queue straight away, so keep our own reference
    return task.promise;
  }

  /**
   * Queue a change for one room: `{ id, targetTemperature?, heatingEnabled? }` (temperature in hundredths).
   * Changes to the same room are merged. Resolves `{ startedAt }` once the request has been sent.
   */
  control(change) {
    const task = (this.#control ??= { ...this.#defer(), changes: new Map() });
    const { id, ...fields } = change;
    task.changes.set(id, { ...task.changes.get(id), ...fields });
    this.#pump();
    return task.promise;
  }

  /** Abort the in-flight request, reject everything queued and refuse new work. */
  close() {
    this.#abort.abort();
    this.#wake?.();
    for (const task of [this.#poll, this.#control]) task?.reject(new Error('Client closed'));
    this.#poll = null;
    this.#control = null;
  }

  #defer() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {}); // callers handle rejections; don't also report them as unhandled
    return { promise, resolve, reject };
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async #pump() {
    if (this.#pumping) return;
    if (this.#abort.signal.aborted) {
      for (const task of [this.#poll, this.#control]) task?.reject(new Error('Client closed'));
      this.#poll = this.#control = null;
      return;
    }
    this.#pumping = true;
    try {
      while (!this.#abort.signal.aborted && (this.#control || this.#poll)) {
        const wait = Math.max(this.#lastStart + this.minInterval, this.#blockedUntil) - this.#now();
        if (wait > 0) {
          await this.#sleep(wait);
          continue; // re-evaluate: a command may have arrived while waiting
        }
        const startedAt = this.#now();
        this.#lastStart = startedAt;
        if (this.#control) {
          const task = this.#control;
          this.#control = null;
          try {
            await this.#sendControl(task.changes);
            task.resolve({ startedAt });
          } catch (err) {
            task.reject(err);
          }
        } else {
          const task = this.#poll;
          this.#poll = null;
          try {
            task.resolve({ rooms: await this.#loadRooms(), startedAt });
          } catch (err) {
            task.reject(err);
          }
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #loadRooms() {
    const res = await this.#fetchAuth(`${this.apiBase}/rest/v1/content/`);
    this.#checkStatus(res);
    const data = await res.json();
    return data.rooms ?? [];
  }

  async #sendControl(changes) {
    const rooms = [...changes].map(([id, change]) => controlRoomBody(id, change));
    const res = await this.#fetchAuth(`${this.apiBase}/rest/v1/control/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rooms }),
    });
    this.#checkStatus(res);
  }

  #checkStatus(res) {
    if (res.status === 429) {
      this.#blockedUntil = this.#now() + 2 * this.minInterval; // back off properly after being rate limited
      throw new RateLimitError();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async #authenticate() {
    this.#authPromise ??= (async () => {
      try {
        const res = await this.#request(`${this.apiBase}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'password',
            username: String(this.accountId),
            password: this.clientSecret,
          }),
        });
        if (res.status === 400 || res.status === 401) {
          throw new AuthError(`Authentication failed (HTTP ${res.status}): check accountId and clientSecret`);
        }
        if (!res.ok) throw new Error(`Auth HTTP ${res.status}`);
        const data = await res.json();
        if (!data.access_token) throw new Error('Auth response contained no access_token');
        this.#token = data.access_token;
        this.#tokenExpires = this.#now() + (data.expires_in ?? 3600) * 1000 - 60_000;
      } finally {
        this.#authPromise = null;
      }
    })();
    return this.#authPromise;
  }

  async #fetchAuth(url, options = {}) {
    if (!this.#token || this.#now() >= this.#tokenExpires) await this.#authenticate();
    const attempt = () =>
      this.#request(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${this.#token}` },
      });
    let res = await attempt();
    if (res.status === 401) {
      this.#token = null;
      await this.#authenticate();
      res = await attempt();
    }
    return res;
  }

  async #request(url, options) {
    if (this.#abort.signal.aborted) throw new Error('Client closed');
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeout), this.#abort.signal]);
    try {
      return await this.#fetch(url, { ...options, signal });
    } catch (err) {
      if (this.#abort.signal.aborted) throw new Error('Client closed');
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout / 1000}s`);
      }
      throw err;
    }
  }
}
