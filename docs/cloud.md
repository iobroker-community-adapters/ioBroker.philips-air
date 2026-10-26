# Philips Cloud connection

Philips Cloud is an additional connection for devices already paired with the
Philips Air+ app. It needs an Internet connection and the manufacturer's
services. HTTP and CoAP remain local connections with their existing settings.
Cloud support currently targets the DA/NCP platform, not every Philips product
or every account platform described in the protocol inventory.

## Sign in and connect account devices

Cloud account administration requires the built-in `admin` user. Admin must
forward the authenticated socket user in the controller message (`obj.user`):
this path is verified in the published js-controller-adapter 7.2.5 and Admin
8.1.0/socket-classes 2.7.1 (also socket-classes 2.10.0). Actual forwarding is
required; a newer prerelease's version number alone is not proof. If that
context is absent or the user differs, account commands fail closed. A `user` field in request data
does not grant permission. Older controller/Admin versions retain their local
HTTP/CoAP support; their Cloud login path is unavailable.

1. Select **Philips Cloud**, enter the account's two-letter country code, save
   the settings and start the instance. A local host is not required.
2. Open the settings as **admin** and select **Sign in to Philips Cloud**.
   A temporary HTTPS login page opens in a new tab. Complete the Home.ID
   sign-in there, including an e-mail verification code if requested.
3. Wait for the sign-in confirmation, then return to the adapter settings and
   select **Reload after signing in**. The OAuth callback is captured
   automatically; no URL needs to be copied.
4. All account devices are discovered automatically after the login restart.
   No device selection or device ID is required. The country code is the
   account's two-letter country, for example `DE`, `AT`, `CH`, `GB` or `US`.

No e-mail address or password is stored in adapter settings. The opened page
serves Home.ID content through a temporary login proxy on your ioBroker host;
its address is your host, not the Home.ID domain. Login requests go to the
allowlisted Home.ID/Gigya services. Account tokens are stored in flat native
fields declared in both `encryptedNative` and `protectedNative`.
Administrative access to the installation still grants access to credentials.

### Temporary HTTPS login connection

- Admin and this adapter must run on the same ioBroker host. Login through a
  different host or an external reverse proxy that exposes only the Admin port
  is not supported by this flow.
- The login server uses Admin's selected public/private certificates and a
  temporary port. Your browser must be able to reach that host and port. The
  certificate must be trusted by the browser and cover the host name you use
  for Admin. Configure certificates in ioBroker before starting login; no
  unencrypted fallback is provided.
- Home.ID can change its login scripts. If the page stops progressing after an
  upstream change, the proxy may need an adapter update; social sign-in has not
  been verified.
- The login link is single-use. The session expires after ten minutes, closes
  after successful login and is discarded on stop or restart. Starting another
  login replaces it. If it expires, start again from adapter settings.
- Save the Cloud connection and country before signing in. After login, reload
  settings before saving again, to avoid overwriting new tokens with stale
  form values. Do not share login links, codes or tokens.

The controller restarts the instance after a successful token configuration
write. Initial login and refresh therefore interrupt the current connection;
the restarted instance reconnects using the saved token set. An in-flight
command can have an unknown outcome and is not replayed automatically.

An authorized account test completed Home.ID e-mail-code sign-in and token
exchange, found an AC0651 and received MQTT status. Automatic callback and token
exchange were also verified through the integrated HTTPS login proxy with a
local test certificate, both by hostname and IPv4 address. This does not
establish acceptance of the complete ioBroker Admin flow, social sign-in,
multiple real devices, token rotation across a controller restart or physical
controls. Never enter account data in an issue
or chat.

## Multiple devices and local connections

One Cloud instance discovers all devices in the signed-in account at startup.
Each device has a separate `devices.<deviceId>` object tree with its own
`control`, `status`, `device`, `filter`, `unknownStates` and `info` channels. Unsupported
characters in device IDs are encoded for safe, stable object IDs. Controls
always target the corresponding device. `devices.<deviceId>.info.connection`
shows that device's connection; the instance's `info.connection` is true while
at least one device is connected. Restart the instance to discover newly paired
devices. Previously created objects are retained.

HTTP and CoAP retain one configured local device per instance, their existing
state IDs, host field and manual model selection. Use another instance for
another local device. Cloud's automatic profiles and device trees apply only
to the Cloud connection.

## Shared profiles and observed controls

Cloud device discovery does not use a model whitelist. A shared DA/NCP property
mapping supplies a default for unknown devices; app-derived family differences
override that data rather than adding device-specific transport code. The
local HTTP/CoAP model tables are separate.

The [app-derived profiles](protocols/cloud-device-profiles.md) cover AC0650,
AC0651, the AC17 family and AC0710/AC0720/AC0721 mode differences. Unknown
models use the shared fallback, with no promise of firmware compatibility.

States are created as the corresponding properties arrive. Common shadow
`powerOn` supplies `control.power`; fan speed remains a separate reported
value. Mapped port controls require a corresponding Status property observed
in the current connection. Unknown properties remain read-only diagnostics.
Presence of a property does not prove that every standard command value is
accepted by a firmware. The default profile is a fallback, not a tested-device
compatibility claim. Device/server rejection is reported rather than treated
as successful control.

Observed values use `ack: true`. Sending a command never substitutes its desired
value for reported device state. MQTT acknowledgement proves transmission only;
port responses are correlated and followed by a status read. Power is confirmed
only by a subsequently reported shadow value.

## Filters and maintenance

Cleaning/replacement counters and percentages use the observed filter port.
Counter units have not been established, so the Cloud mapping does not label
them as hours. Zero totals, unavailable sentinels and invalid pairs do not
produce a percentage.

Reset buttons appear only after a valid corresponding filter counter pair is
observed. Write unacknowledged boolean `true` to `devices.<deviceId>.control.resetPreFilter` or
`devices.<deviceId>.control.resetHepaFilter` only after carrying out the appropriate maintenance.
The transport reads the current total, writes that total to the reset register
through `filtWr` and reads the counters again. It never uses a fixed reset value.
Startup, reconnect, normal status reads, acknowledged events and FALSE do not
reset a filter. A readback request alone does not establish that maintenance
counters physically changed; inspect the reported result.

Resetting changes device maintenance counters. A configuration backup does not
restore those counters. Live reset tests require separate explicit approval.

## Connection and verification limits

Reconnect retries use delays and stop after five consecutive failed attempts;
check the account/network and restart after exhaustion. Pending writes are
discarded, not replayed after an ambiguous timeout. Stop closes MQTT, aborts
account requests and clears owned timers. The default profile and all
app-derived profiles require hardware acceptance; no live installation or
device command was performed during implementation.

The adapter metadata uses `connectionType: cloud` because Cloud is now one of
its connection paths; the schema has no mixed local/cloud value. Choosing HTTP
or CoAP still uses the local transport.

Protocol evidence: [authentication](protocols/account-authentication.md),
[MQTT](protocols/da-iot-mqtt.md), [REST](protocols/da-iot-rest.md) and
[AC0651 properties](protocols/ac0651-control.md).
