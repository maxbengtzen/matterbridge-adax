# Changelog

## 0.3.0 — 2026-06-29

### Added
- Adax 30-second API rate limit is strictly respected (matches pyAdax library behaviour)
- Serialised API request queue prevents concurrent fetch collisions between poll and commands
- Exponential backoff on consecutive poll failures (doubles interval up to 5 min)
- 10-second HTTP timeout on all API calls prevents event-loop blocking
- Optimistic state updates after commands (no post-command poll that triggered rate limits)
- Poll interval default changed to 60s (minimum 30s) to stay within API rate limit

### Fixed
- Eliminated "No Response" by serialising all API traffic and preventing rate-limit cascading failures

## 0.2.1 — 2026-06-26

### Fixed
- `onShutdown` now calls `super.onShutdown()` to persist endpoint number mappings across restarts
- `unregisterDevice` only runs when `unregisterOnShutdown` config is `true` (default `false`), preventing Apple Home from losing room assignments after bridge restart

## 0.2.0 — 2026-06-26

### Added
- `heatingEnabled` field in Adax API control requests for proper on/off
- HTTP 429 (rate limit) detection and logging
- `_lastNonZeroTarget` Map preserves last setpoint when API returns 0 (heater off)
- Concurrent poll guard (`_polling` flag) to prevent overlapping poll cycles
- Debounced post-command poll (`_pollTimer`) for faster state reflection

### Fixed
- Removed `powerSource` cluster from wired heaters (no battery to report)
- Handle `targetTemperature: 0` from API gracefully (keep last known setpoint)
- Race condition in `_lastApiValues` Map prevents poll-echo from triggering spurious API commands
- Cleaner shutdown with timer cleanup

## 0.1.0 — 2026-06-25

### Added
- Initial release
- Matter thermostat support for Adax WiFi heaters
- OAuth2 (password grant) authentication
- Poll-based state synchronisation
- Temperature and on/off control via Apple Home
- Multi-room support
