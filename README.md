# matterbridge-adax

Matterbridge plugin for Adax WiFi heaters.

Exposes Adax WiFi heaters as Matter thermostats via [Matterbridge](https://github.com/Luligu/matterbridge).

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.9.0
- Node.js >= 20.3
- An Adax WiFi account with heaters configured in the Adax WiFi app
- API credentials generated in the Adax WiFi app (Account → Remote user client API → Add Credential)

## Installation

### Via Matterbridge frontend (if published on npm)

```
matterbridge --add matterbridge-adax
matterbridge --enable matterbridge-adax
```

### Manual installation

Clone or copy the plugin to your Matterbridge plugins directory:

```bash
git clone https://github.com/maxbengtzen/matterbridge-adax.git ~/Matterbridge/matterbridge-adax
matterbridge --add ~/Matterbridge/matterbridge-adax
matterbridge --enable ~/Matterbridge/matterbridge-adax
```

## Configuration

Configure via Matterbridge frontend UI at `http://<host>:8283` or by editing the auto-generated config file.

### Getting API credentials

1. Open the Adax WiFi app
2. Go to **Account** → **Remote user client API** → **Add Credential**
3. Give the credential a name and copy the generated password (Client Secret)
4. Note your numeric **Account ID** from the Account section

### Configuration fields

| Field | Type | Default | Description |
|---|---|---|---|
| `accountId` | number | (required) | Your numeric Adax account ID from the Adax WiFi app |
| `clientSecret` | string | (required) | Client secret generated in Adax WiFi app |
| `pollInterval` | number | `60000` | Polling interval in milliseconds (minimum 30000) |
| `unregisterOnShutdown` | boolean | `false` | Unregister devices when Matterbridge stops (development only; loses room assignments in Apple Home) |
| `debug` | boolean | `false` | Enable verbose debug logging |

### Example

```json
{
  "accountId": 123456,
  "clientSecret": "your-generated-secret",
  "pollInterval": 60000,
  "debug": false
}
```

## How it works

The plugin authenticates with the Adax cloud API using OAuth2 (password grant), fetches the rooms and polls their status at the configured interval. Each room is exposed as a Matter thermostat with:

- Current temperature (`localTemperature`)
- Target temperature (`occupiedHeatingSetpoint` / `occupiedCoolingSetpoint`, always the same value)
- System mode (off / heat)
- Reachability: after 3 failed polls in a row the devices show as unreachable until the API answers again

Changes made in Apple Home (or any Matter controller) are sent to the Adax cloud via REST. Slider drags are debounced, changes to several rooms are sent in a single request, and the state is re-read shortly after each command to confirm the result. Rooms added in the Adax app later are registered automatically.

## Rate limiting

The Adax API answers HTTP 429 if it is called too often, in practice about once per 30 seconds (Adax's public documentation does not state a limit; 30 s is the value used by the pyAdax library). The plugin therefore spaces **all** API calls at least 30 seconds apart, sends commands before polls, merges pending changes into one request, and pauses for a minute after a 429. The consequence is that a change in Home can take up to about 30 seconds to reach the heater if another request was just made; the controller shows the new value immediately in the meantime. Keep `pollInterval` at 60000 or higher.

## Development

The plugin is written in TypeScript. `src/` is the source; `dist/` is the JavaScript that Matterbridge loads (`main` in `package.json`) and is built from `src/` with `tsc`. `dist/` is committed so the plugin can be installed straight from a git clone without a build step; CI fails if it does not match `src/`.

`src/adax.ts` holds the API client and the mapping logic and has no Matterbridge dependency; `src/module.ts` is the Matterbridge platform.

Requires Node.js 24 or later for development (the tests run the TypeScript directly). The built plugin still runs on Node.js >= 20.3.

```bash
npm install     # TypeScript and Node types
npm run setup   # matterbridge, for its types only (see below)
npm run check   # typecheck, tests, build dist/
```

| Script | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | Type check `src/` and `test/` without writing files |
| `npm test` | Unit tests and platform tests (`node:test`) against a fake Adax API and a stubbed Matterbridge, no network |
| `npm run check` | All of the above |

`matterbridge` is not listed in `package.json`: Matterbridge refuses to load a plugin that has it in any dependency list. `npm run setup` installs it without saving it (the version the server runs), the same role `npm link matterbridge` has in the official plugin template. A later `npm install` removes it again; rerun `npm run setup`.

To release, add the changes to `CHANGELOG.md` and run `npm version patch|minor|major`. It runs `npm run check` first and commits a freshly built `dist/` together with the version bump.

## API Reference

Adax API documentation: https://adax.no/se/wi-fi/api-development-2/

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
