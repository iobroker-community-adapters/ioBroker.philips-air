# Optimization summary (philips-air adapter)

Working notes for the connection/stability overhaul. Verified live against an **AC2889** (CoAP).

Branches (each based on the previous):

- `fix/connection-stability` — Phase 1 stability bugfixes
- `feat/http-node-fetch` — Phase 2 (node:fetch migration) + all later fixes (current working branch)

## What was fixed / optimized

### CoAP ([lib/coap.js](lib/coap.js))
- **No more crashes on POST timeout.** A confirmable POST with no reply was kept alive by node-coap for its full `exchangeLifetime` (~247 s) and then emitted a listener-less `error` → `UNCAUGHT_EXCEPTION`. `_post` now bounds the wait to `aliveTimeout` and calls `req.reset()` (clears the library's internal retry timer).
- **Survive node-coap "Empty messages must be empty"** (issue #175) on observe `reset()` — guarded in `_closeStatusRequest()`, so a failed cleanup never breaks re-subscription.
- **Keepalive instead of idle reconnect.** While connected, the watchdog runs a light keepalive sync and keeps the existing observe alive; full reconnect only on real failure. Removes the 30 s reconnect churn and the observer leak.
- Deferred initial connect (`setImmediate`) so the caller's event listeners catch the first events.
- Guarded synchronous decrypt failures (corrupted packet can't crash the adapter).
- Rejects hanging requests instead of leaking them; `destroy()` guards against timers re-arming after shutdown.

### HTTP ([lib/http.js](lib/http.js), [lib/httpClient.js](lib/httpClient.js))
- **Rewritten on `node:fetch` + `node:crypto`** — dropped the `philips-air` dependency and its outdated `axios 0.20` / `aes-js` / `pkcs7-padding` chain. Crypto verified byte-for-byte identical; DH handshake + status/control verified against a simulated device.
- **Fixed runaway reconnect loop** (sync→_reconnect→sync with no delay → dozens/s). `_reconnect()` now only schedules one delayed retry.
- **Fixed silent startup failures**: first connection error was swallowed; `Buffer.from(null)` crashed on a fresh install with no stored key.
- One-time hint to switch to CoAP when the device refuses HTTP (`ECONNREFUSED`/`EHOSTUNREACH`), with the real cause appended.

### Shared / both protocols
- **Correct value types**: `renameAttributes` no longer stringifies everything — numbers/booleans stay native (air quality, filter hours, etc.); `childLock` mapped to boolean. Fixes "has to be type number/boolean but received string" and missing updates.
- Lazy-load the protocol module so a missing optional dep can't crash the other protocol.
- Replaced stray `console.*` with adapter logging; added info-level lifecycle logs (connecting/connected/lost) with device context.
- Async `control()` rejection caught in [main.js](main.js) so a failed command can't crash the adapter.
- JSDoc added; **lint is 0 errors / 0 warnings**; `test:package` 57 passing.

## Still open (not started)

Phase 2 leftovers:
- Bump `coap` `^1.4.2` → `^1.5.0`.
- Define `device.overTheAirUpdates` as `string` directly in `io-package.json` and drop the runtime type-patch in `main.js`.
- Add IP/host validation in `admin/jsonConfig.json`.

Phase 3 (feature):
- Add `plain_coap` protocol (third option) for devices that speak unencrypted CoAP.
- Extract the shared `NAME_MAPPING` / `renameAttributes` / `control` into a common module.

Phase 4 (tests):
- Unit tests for `decryptPayload`/`encryptPayload` and `renameAttributes` (the `httpClient._crypto` test export already exists).

## Manual test helper
- [test/live.js](test/live.js): `node test/live.js <ip> [coap|http]` — drives the real protocol class against a device without touching an ioBroker install.
