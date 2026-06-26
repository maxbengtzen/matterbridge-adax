# matterbridge-adax

Matterbridge plugin for Adax WiFi heaters.

Exposes Adax WiFi heaters as Matter thermostats via [Matterbridge](https://github.com/Luligu/matterbridge).

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.9.0
- Node.js >= 20
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
git clone https://github.com/YOUR_USER/matterbridge-adax.git /root/Matterbridge/matterbridge-adax
matterbridge --add /root/Matterbridge/matterbridge-adax
matterbridge --enable /root/Matterbridge/matterbridge-adax
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
| `pollInterval` | number | `30000` | Polling interval in milliseconds (minimum 10000) |
| `debug` | boolean | `false` | Enable verbose debug logging |

### Example

```json
{
  "accountId": 123456,
  "clientSecret": "your-generated-secret",
  "pollInterval": 30000,
  "debug": false
}
```

## How it works

The plugin authenticates with the Adax cloud API using OAuth2 (password grant), fetches the list of rooms/heaters, and polls their status at the configured interval. Each heater is exposed as a Matter thermostat with:

- Current temperature (`localTemperature`)
- Target temperature (`occupiedHeatingSetpoint`)
- System mode (off/heat)
- Power source information

Changes made in Apple Home (or any Matter controller) are sent back to the Adax cloud API via REST.

## Rate Limiting

The Adax API enforces a rate limit of 1 request per 30 seconds. The plugin handles this by sharing the same API session across all rooms. Keep `pollInterval` at 30000 or higher to stay within limits.

## API Reference

Adax API documentation: https://adax.no/se/wi-fi/api-development-2/

## License

MIT
