# Changelog

## 0.4.0 — 2026-10-04

Reliability release: fixes bugs found in a code review, makes better use of the Adax API's rate limit, and adds a test suite. Existing installations upgrade without changes to their config or their Apple Home setup.

### Fixed
- `setpointRaiseLower` changed the setpoint by a tenth of the requested amount (a 0.1 °C-unit value was added to a 0.01 °C-unit value). "+1 °C" now raises by 1 °C, and repeated commands accumulate.
- If loading the rooms failed at startup (e.g. HTTP 429 or no network), no devices were registered and nothing tried again until the next restart. Rooms are now loaded by the poll loop, so devices appear as soon as the API answers, and rooms added in the Adax app later are registered automatically.
- A bad `accountId`/`clientSecret` aborted startup with an unhandled error. It is now logged ("check accountId and clientSecret") and retried with backoff.
- The poll loop could restart itself after shutdown if a poll was in flight, and in-flight requests were never aborted. Shutdown now stops timers and cancels requests.
- Echo suppression compared against the last *polled* value, so setting a value back to what the last poll saw was silently dropped, and attribute values restored at startup could be sent to the cloud as commands. Only changes made by a Matter controller are forwarded now.
- A poll that was already in flight when you changed something in Home could flip the controller back to the old value until the next poll. Polls that started before a change was sent no longer overwrite it.
- Missing readings were replaced by made-up defaults (21 °C). They are now left unknown.
- The 30 s spacing between API calls was not kept after a failed call (it waited 5 s). The spacing is now enforced for every request, and after an HTTP 429 requests are paused for 60 s.
- The config schema and README said the default poll interval is 30 s with a 10 s minimum, while the code used 60 s and 30 s. Schema and README now match the code.

### Added
- **All pending changes are sent in one request** (the API takes several rooms per control request), and commands go before polls. Dragging a slider or changing several rooms costs one API call instead of one per change.
- Slider drags are debounced: only the final value is sent.
- A command that is rate limited (HTTP 429) is retried up to 3 times.
- **Reachability**: devices show as unreachable ("No Response" in Apple Home) after 3 failed polls in a row and recover automatically.
- A confirmation poll after every command, and after a failed command, so controllers show what the heater really did.
- `clientSecret` is shown as a password field in the Matterbridge frontend.
- Test suite (`npm test`, 40 tests, no dependencies) against a fake Adax API and a stub of Matterbridge.
- `package.json`: `files`, `scripts`; `engines.node` raised to `>=20.3.0` (for `AbortSignal.any`).

### Changed
- Code split into `dist/module.js` (platform) and `dist/adax.js` (API client and mapping logic, no Matterbridge dependency).
- Poll failures are logged as a warning the first time and at debug level while the failure persists.

### Notes on earlier entries
- 0.3.0's "optimistic state updates" were not actually implemented in the code; 0.4.0 implements them.
- 0.2.0 mentions a `_polling` flag and a debounced post-command poll that were no longer present in 0.3.0.
- The 30 s limit comes from experience with the API (as in the pyAdax library); Adax's public documentation does not specify a rate limit.

### Upgrade notes
- No action needed. Device identities are unchanged, so rooms and automations in Apple Home are kept.
- Changes made in Apple Home reach the heater with a delay of up to ~30 s if another API call was just made. This is the API's rate limit, not a fault.
- A setpoint change in a controller still turns the heater on (as before).

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
