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

```bash
npm test        # unit tests + platform tests against a fake Adax API and a stubbed Matterbridge, no dependencies
npm run check   # syntax check
```

`dist/adax.js` holds the API client and the mapping logic and has no Matterbridge dependency; `dist/module.js` is the Matterbridge platform.

## API Reference

Adax API documentation: https://adax.no/se/wi-fi/api-development-2/

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
