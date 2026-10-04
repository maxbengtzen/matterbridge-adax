// A fake Adax cloud: auth, rooms and control. Records every request with the (mocked) time it arrived.
export function fakeApi(rooms) {
  const api = {
    rooms,
    requests: [],
    tokenCalls: 0,
    authStatus: null, // make /auth/token fail with this status
    nextStatus: [], // statuses to answer the next content/control requests with (e.g. 429, 401, 500)
    gate: null, // when set, content requests wait for this promise (to simulate a slow response)
  };

  api.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/client-api', '');
    api.requests.push({
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      at: Date.now(),
    });

    if (path === '/auth/token') {
      api.tokenCalls++;
      if (api.authStatus) return { ok: false, status: api.authStatus };
      return { ok: true, status: 200, json: async () => ({ access_token: `tok${api.tokenCalls}`, expires_in: 3600 }) };
    }

    if (api.nextStatus.length > 0) {
      const status = api.nextStatus.shift();
      return { ok: status < 400, status, json: async () => ({}) };
    }

    if (path === '/rest/v1/content/') {
      if (api.gate) await api.gate;
      const snapshot = structuredClone(api.rooms);
      return { ok: true, status: 200, json: async () => ({ rooms: snapshot }) };
    }

    if (path === '/rest/v1/control/') {
      for (const change of JSON.parse(options.body).rooms) {
        const room = api.rooms.find((r) => r.id === change.id);
        if (change.heatingEnabled !== undefined) room.heatingEnabled = change.heatingEnabled === 'true';
        if (change.targetTemperature !== undefined) room.targetTemperature = Number(change.targetTemperature);
        if (change.heatingEnabled === 'false') room.targetTemperature = 0; // the real API reports 0 while off
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }

    return { ok: false, status: 404 };
  };

  /** Bodies of the control requests, in order. */
  api.controls = () => api.requests.filter((r) => r.path === '/rest/v1/control/').map((r) => JSON.parse(r.body).rooms);
  api.polls = () => api.requests.filter((r) => r.path === '/rest/v1/content/');
  return api;
}
