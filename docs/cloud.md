# Philips Cloud connection

Philips Cloud is an additional connection for devices already paired with the
Philips Air+ app. It needs an Internet connection and the manufacturer's
services. HTTP and CoAP remain local connections with their existing settings.
Cloud support currently targets the DA/NCP platform, not every Philips product
or every account platform described in the protocol inventory.

## Sign in and connect account devices

Sign in as the built-in ioBroker `admin` user. Use an up-to-date ioBroker
Admin and js-controller. If login reports that authenticated user information
is missing, update both before trying again.

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

Complete any pending account registration or consent in the Philips app first.
Accounts that can sign in only through a social provider are not supported.
Requesting a new code replaces the previous attempt.

The settings show the saved sign-in status and access-token expiry. Tokens renew
automatically without restarting the adapter. If renewal is rejected, sign in
again. Refresh the settings to update the displayed status.

`info.cloudTokenExpiresAt` exposes the access-token expiry as a Unix timestamp
in milliseconds for scripts and visualizations. Zero means no saved token is
available at startup. This is not the end of the account session: the access
token renews automatically when needed.

Before the MQTT session's access token expires, the adapter obtains current
credentials and reconnects the device session. This causes a brief connection
interruption without restarting the adapter. Planned renewals are logged at
debug level; unexpected disconnects are warnings.

## Multiple devices and local connections

One Cloud instance discovers all devices in the signed-in account at startup.
Each device has a separate `devices.<deviceId>` object tree with its own
`control`, `status`, `device`, `filter`, `unknownStates` and `info` channels. Unsupported
characters in device IDs are encoded for safe, stable object IDs. Controls
always target the corresponding device. `devices.<deviceId>.info.connection`
shows that device's connection; the instance's `info.connection` is true while
at least one device is connected. Restart the instance to discover newly paired
devices. Previously created objects are retained.

HTTP and CoAP connect one configured local device per instance. Use another
instance for each additional local device. Switching protocols retains existing
objects and user customizations.

## Available readings and controls

Cloud profiles are selected automatically. See the
[supported-device list](../README.md#philips-cloud-air-account) for available
profiles and hardware compatibility.

Readings and controls appear as the device reports its capabilities. Available
controls depend on the model and firmware. Unknown properties are exposed
read-only under `unknownStates`.

`control.power` switches the device on or off. `device.platform` identifies its
platform; `status.statusBits` exposes its numeric status field for diagnostics.
Control values are updated from device reports. A sent command does not by
itself confirm that the device applied it.

## Filters and maintenance

Cleaning/replacement counters and percentages use the observed filter port.
Counter units have not been established, so the Cloud mapping does not label
them as hours. Zero totals, unavailable sentinels and invalid pairs do not
produce a percentage.

Reset buttons appear only after a valid corresponding filter counter pair is
observed. Write unacknowledged boolean `true` to `devices.<deviceId>.control.resetPreFilter` or
`devices.<deviceId>.control.resetHepaFilter` only after carrying out the appropriate maintenance.
The adapter reads the current counters before resetting and requests them again
afterwards. Check the reported counters to confirm the result. Resetting changes
device maintenance counters; an ioBroker configuration backup cannot undo it.

## Connection problems

The adapter retries a failed device connection up to five times. After those
attempts, check the network and account, then restart the instance. A command
with an unknown outcome is not retried automatically.

If saved credentials cannot be loaded, sign in again in the instance settings.
Keep ioBroker backups so credentials and configuration can be restored together.

Developer details: [authentication and token storage](protocols/account-authentication.md#adapter-credential-persistence),
[MQTT](protocols/da-iot-mqtt.md) and [device profiles](protocols/cloud-device-profiles.md).
