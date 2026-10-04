# v0.4.0 — Reliability release

This release fixes several bugs, makes better use of the Adax API's rate limit, and adds a test suite. **Upgrading needs no changes**: device identities and the existing config keep working, so rooms and automations in Apple Home stay intact.

## Highlights

- **Fixed:** "+1 °C" from a controller (`setpointRaiseLower`) raised the setpoint by only 0.1 °C.
- **No more devices missing after a bad start.** If the API was unreachable (or rate limited) when Matterbridge started, no heaters were registered until the next restart. Rooms are now loaded by the poll loop, so they appear as soon as the API answers, and new rooms added in the Adax app show up automatically.
- **Changes are no longer flipped back.** A poll that was already in flight when you changed something in Home could reset the controller to the old value. It can't any more.
- **Fewer API calls, quicker changes.** Slider drags send only the final value, changes to several rooms go out in one request, and commands go before polls. After a 429 the command is retried.
- **"No Response" when it should be:** devices show as unreachable after 3 failed polls and recover automatically, instead of showing stale values as if everything were fine.
- **Clean shutdown:** polling really stops and in-flight requests are cancelled.
- **Wrong credentials are reported clearly** ("check accountId and clientSecret") instead of aborting startup with an unhandled error.
- Settings, schema and README now agree (poll interval default 60 s, minimum 30 s). `clientSecret` is a password field.

## Good to know

- The Adax API only allows about one request per 30 seconds, so a change in Home can take up to ~30 s to reach the heater if another request was just made. The controller shows the new value immediately.
- Requires Node.js >= 20.3 and Matterbridge >= 3.9.0 (developed and tested against Matterbridge 3.10.12).

## Internal

- Code split into a platform (`dist/module.js`) and a Matterbridge-independent API client (`dist/adax.js`).
- 40 tests (`npm test`) against a fake Adax API.

## Corrections to earlier notes

The 0.3.0 changelog described optimistic updates that were not implemented. See [CHANGELOG.md](./CHANGELOG.md).

**Full changelog:** https://github.com/maxbengtzen/matterbridge-adax/compare/v0.3.0...v0.4.0
