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

1. Select **Philips Cloud**, enter the account's two-letter country code (empty
   by default), save the settings and start the instance. The country is used
   for Cloud routing, for example `DE`, `AT`, `CH`, `GB` or `US`.
2. Open the settings as **admin**, enter your Cloud account email and select
   **Send verification code**. This sends an email through Philips/Home.ID.
3. Enter the six-digit code from that email and select **Confirm verification
   code**. No account password is required. A rejected code can be corrected;
   after ten minutes or an instance restart, request a new code.
4. After successful login, the controller restarts the instance and settings
   reload automatically. If the restart interrupts the response, wait for the
   instance and refresh the browser before saving settings again.
5. All account devices are discovered automatically. No device selection,
   local device address or device ID is required.

Email and code fields are temporary Admin inputs: their underscore-prefixed
names prevent JSON Config from saving them to native configuration. The backend
keeps only the pending session in memory, tied to the authenticated Admin owner.
A new code request replaces the previous attempt. Codes and account tokens
must never be shared in issues or chat.

The adapter calls the Home.ID/Gigya email-OTP API and completes a passive PKCE
OAuth exchange, following the [Home Assistant Home.ID integration's HTTP
flow](https://github.com/renaudallard/homeassistant_philips_homeid/blob/ea3d1b76834adee15abc39165fe4f4e4333d126a/custom_components/philips_homeid/cloud_auth.py).
No browser proxy, extra port, Admin certificate or same-host Admin installation
is required for this login. The adapter needs outbound HTTPS to the Philips
services. Accounts requiring additional registration or consent must complete
that step in the official app first; social-provider login is not offered here.

Only the resulting access/refresh/ID tokens are persisted, in flat native fields
declared in both `encryptedNative` and `protectedNative`. Administrative access
to the installation still grants access to credentials. Keep Admin access
protected; the email and code travel through its existing connection.

The settings show the saved login status automatically when opened. This uses
the locally stored tokens, not a separate login request. It displays the current
access token's expiry without exposing cookies or tokens. The adapter refreshes
that token automatically when needed; its expiry is not the end of the account
session. Philips does not provide a fixed refresh-token lifetime. If renewal is
rejected, sign in again. After an instance restart or configuration reload the
status is read again; it is not a continuously polled service-health indicator.

The controller restarts the instance after a successful token configuration
write. Initial login and refresh therefore interrupt the current connection;
the restarted instance reconnects using the saved token set. An in-flight
command can have an unknown outcome and is not replayed automatically. Reload
settings after login before saving again, to avoid overwriting stored tokens
with stale form data.

The direct email-code path was tested with an authorized account: verification,
token exchange and discovery of one device succeeded. An earlier test also
verified AC0651 MQTT status. Protocol and security tests use synthetic fixtures.
End-to-end acceptance through ioBroker Admin, token rotation across a controller
restart, multiple real devices and physical controls remain unverified.

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
