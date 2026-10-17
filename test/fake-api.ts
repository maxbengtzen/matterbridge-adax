// A fake Adax cloud: auth, rooms and control. Records every request with the (mocked) time it arrived.
import type { ApiRoom, ControlRoomBody } from '../src/adax.ts';

export interface FakeRoom extends ApiRoom {
  temperature?: number;
  targetTemperature?: number;
  heatingEnabled?: boolean;
}

export interface RecordedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any; // URLSearchParams for auth, a JSON string otherwise
  at: number;
}

const response = (status: number, body?: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

export function fakeApi(rooms: FakeRoom[]) {
  const api = {
    rooms,
    requests: [] as RecordedRequest[],
    tokenCalls: 0,
    authStatus: null as number | null, // make /auth/token fail with this status
    nextStatus: [] as number[], // statuses to answer the next content/control requests with (e.g. 429, 401, 500)
    gate: null as Promise<unknown> | null, // when set, content requests wait for this promise (to simulate a slow response)

    async fetch(url: string | URL | Request, options: RequestInit = {}): Promise<Response> {
      const path = new URL(String(url)).pathname.replace('/client-api', '');
      api.requests.push({
        path,
        method: options.method ?? 'GET',
        headers: options.headers as Record<string, string>,
        body: options.body,
        at: Date.now(),
      });

      if (path === '/auth/token') {
        api.tokenCalls++;
        if (api.authStatus) return response(api.authStatus);
        return response(200, { access_token: `tok${api.tokenCalls}`, expires_in: 3600 });
      }

      const status = api.nextStatus.shift();
      if (status !== undefined) return response(status, {});

      if (path === '/rest/v1/content/') {
        if (api.gate) await api.gate;
        return response(200, { rooms: structuredClone(api.rooms) });
      }

      if (path === '/rest/v1/control/') {
        const { rooms: changes } = JSON.parse(String(options.body)) as { rooms: ControlRoomBody[] };
        for (const change of changes) {
          const room = api.rooms.find((r) => r.id === change.id)!;
          if (change.heatingEnabled !== undefined) room.heatingEnabled = change.heatingEnabled === 'true';
          if (change.targetTemperature !== undefined) room.targetTemperature = Number(change.targetTemperature);
          if (change.heatingEnabled === 'false') room.targetTemperature = 0; // the real API reports 0 while off
        }
        return response(200, {});
      }

      return response(404);
    },

    /** Bodies of the control requests, in order. */
    controls: () =>
      api.requests
        .filter((r) => r.path === '/rest/v1/control/')
        .map((r) => (JSON.parse(r.body) as { rooms: ControlRoomBody[] }).rooms),
    polls: () => api.requests.filter((r) => r.path === '/rest/v1/content/'),
  };
  return api;
}
