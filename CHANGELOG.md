# Changelog

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
