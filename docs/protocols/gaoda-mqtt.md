# Gaoda / MXCHIP cloud MQTT and local routing

Static reference for the Gaoda SDK in the supplied Philips Android APK.
The [connection overview](README.md#sources-and-evidence) records the
artifact name, SHA-256 and analysis method. This document uses that same APK,
not a different SDK release. No app execution, cloud login, packet capture or
device communication was performed. Names such as `bn` are release-specific
DEX identifiers.

## Scope and transport selection

The app has a combined local/cloud transport for its MXCHIP device path.
This is distinct from the Philips DA IoT remote client described in the
[overview](README.md). An MQTT class being present does not assign every
Philips model to it.

Evidence: `classes2.dex`, `e01.v2`, `bo`, `wv0`, `bn`, `qc2`.

```text
e01.v2():
    if deviceRecord.m:
        transport = qc2(context, deviceId)       # asset simulator
    else:
        transport = bo([
            wv0(context, deviceId, localHost, option),
            bn(deviceId)
        ])
```

`qc2` identifies itself as `Simulator` and loads `simulator/<deviceId>` from
Android assets. It is not another network protocol.

The non-simulator branch has the following behavior:

| Method | Observed behavior |
| --- | --- |
| `bo.a` | Attaches callbacks and starts both child transports. |
| `bo.i` | Sends a command through the first child whose `e()` returns true, then returns. LAN precedes cloud. |
| `bo.i`, no connected child | Adds the command string to an in-memory list. |
| `bo$b.c` / `bo.q` | On a state callback, forwards state and retries the first queued command. |
| `bo.l` | Passes local address/option updates to children. |
| `bo.m` | Passes MQTT host information to children. |
| `bo.b` | Detaches callbacks and disconnects both children. |

This is connection-based preference and fallback. The inspected sender does
not retry an individual command over MQTT after a local send error; it picks
one currently connected transport. Starting cloud and LAN together also means
it is incorrect to describe cloud connection as beginning only after a CoAP
timeout.

## LAN side of the combined transport

Evidence: `classes2.dex`, `wv0.a`, `wv0.e`, `wv0.i`, `wv0.l`, `wv0$b`;
`classes.dex`, `com.gaoda.sdk.coap.FogCoap`.

`wv0.a()` needs a non-null local host and connection state zero. It sets state
one, constructs `FogCoap(String.valueOf(option), deviceId, host)` and creates
an observation. `wv0.e()` considers LAN available only when its internal
state is two and Android reports a connected network of type one (Wi-Fi).
Commands go to `FogCoap.sendMessage`. Changes to local host or relevant option
information tear down the old CoAP object and start connection again.

The actual plain, legacy-encrypted and negotiated-secret CoAP engines are
selected inside `FogCoap`, as documented in the [overview](README.md).
The combined transport itself introduces no fourth CoAP cipher.

## Broker information and cloud setup

Evidence: `classes.dex`, `com.gaoda.sdk.mqtt.MxMqttClient` constructors,
`MxMqttClient$d.run`; `classes2.dex`, `f71.<init>`, `bn.m`, `bn.s`.

`f71` extends `com.gaoda.sdk.bean.mqtt.HostBean`. Its JSON constructor reads:

```json
{
  "device_id": "<device identifier>",
  "client_id": "<MQTT client identifier>",
  "endpoint": "<server supplied>",
  "host": "<server supplied broker URI>",
  "path": "<server supplied>"
}
```

It converts `device_id` into the one-element `device_list` expected by
`HostBean`. `bn.m` stores this information and starts the MQTT client.
The `HostBean` constructor of `MxMqttClient` takes `host`, `client_id` and the
first `device_list` item. A second constructor accepts `MqttInfoBean.MqttInfos`
and takes its singular `device_id` instead. These are two input shapes for
the same client, not evidence for two different MQTT protocols.

`MxMqttClient$d.run` creates a Paho `MqttClient(host, clientId,
MemoryPersistence)`, installs callbacks, creates `MqttConnectOptions`, sets
`skipPortDuringHandshake` to true and calls `connectWithResult`.
It does not explicitly set MQTT username/password, certificates or an SSL
socket factory in that method. The URI comes from the server-supplied `host`;
its actual scheme, port, signed query parameters and expiry cannot be inferred
from this method alone. In particular, do not turn the lack of an explicit
password setter into a claim that the broker permits anonymous access.

The SDK also contains these broker-discovery HTTP methods:

| Method | Request |
| --- | --- |
| `HttpRequestManager.getDeviceHost` | GET `<HOST>enduser/mqttInfo/`, query `device_id` |
| `HttpRequestManager.getDeviceHostV2` | POST `<HOST>enduser/v2/mqttInfo/`, JSON `device_id` containing an array of identifiers |

Evidence: `classes.dex`, `HttpRequestManager.getDeviceHost`,
`getDeviceHostV2`, `ge.getHostUrl`, `ge.getHostUrlV2`.
The app uses the V2 method, not merely an unused SDK entry point. The
recovered call chain is:

```text
za1.B(deviceIds)
  → ab1.O(deviceIds, listener)
  → HttpRequestManager.getDeviceHostV2
  → POST <HOST>enduser/v2/mqttInfo/
  → ab1$c.onSuccess: response.data.mqttinfos[]
  → f71(each item)
  → za1$a: look up device by f71.deviceId
  → e01.b3 → bo.m → bn.m → bn.s → MxMqttClient
```

The request body is `{"device_id":["<id>","<id>"]}`.
`za1.B` uses an in-flight boolean to suppress concurrent requests; both the
success and error callbacks in `za1$a` clear it. A JSON parsing exception in
`ab1$c.onSuccess` only prints the exception in the inspected method, so that
exception path does not visibly clear the manager flag.

### Region and environment

Evidence: `classes2.dex`, `mk1.w`, `a5.G`, `App.m`, `App.s`, `od`;
`ab1.<init>`, `tj0.e`, `tj0.f`, `tj0.h`.

`mk1.w()` builds the configuration supplied through `bb1.w()` to `ab1`.
`a5.G(region)` compares the region with `CN`, ignoring case. `App.m()` returns
the app's selected backend region; if unset, it defaults to `UK`, switching to
`CN` when `App.h()` returns `CN`, and persists the choice. The environment
comes from `App.s()`. `Development`, `Testing` and `Staging` have explicit
branches; other environment values reach the production branch.

The following base URLs were recovered from the constants in `mk1.w` using
the APK's string-decoding operations. Both nested AES-GCM authentication tags
validated during local decoding. This decrypts embedded configuration strings,
not network traffic or private account data.

| Environment | `CN` backend | Other backend region |
| --- | --- | --- |
| Development | `https://philipsapi.fogcloud.io/` | `https://philipsapi.fogcloud.io/` |
| Testing | `https://philipsapi-cn.fogcloud.io/` | `https://philipsapi-de.fogcloud.io/` |
| Staging | `https://airapi.fogcloud.io/` | `https://airapifr.fogcloud.io/` |
| Production branch | `https://www.api.air.philips.com.cn/` | `https://www.api.air.philips.com/` |

These are exact APK configuration values, not a claim that each service is
currently reachable. `ab1.<init>` sets SDK host, application signing secret and
any stored account token from this configuration. App IDs and signing secrets
also vary by this branch; they must not be confused with a user password,
account token, CoAP secret or MQTT client ID.

### Fixed app IDs and signing secrets

These are shared application constants embedded in this APK's `mk1.w` path,
not personal credentials, account tokens or broker URLs. The table records the
exact decoded text; pass the ASCII/UTF-8 bytes of the secret to HMAC, including
its `a_` prefix. Do not hex-decode the app ID or secret. No account or live
configuration was read to obtain them.

| Backend/environment | App ID (`od.a`) | Signing secret (`od.b`) |
| --- | --- | --- |
| CN / Development | `85de0a4ff14c11e8ac91f8cab81d2c1a` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| CN / Testing | `60ddc560960211e8b3a9066cf4d4679c` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| CN / Staging | `bae27e8698b111e9b4d90619fb770252` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| CN / Production branch | `9b6cb0e09c6b11e98cf8062e84275fee` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| Other / Development | `85de0a4ff14c11e8ac91f8cab81d2c1a` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| Other / Testing | `cf9ccc28c14811e892040afc02e5d660` | `a_85de0a4ff14c11e8ac91f8cab81d2c1a` |
| Other / Staging | `942a9e9498b211e9a50b02539fbc60ac` | `a_z6hq010n55mdtu7u234tbz3f4lbviktz` |
| Other / Production branch | `9fd505fa9c7111e9a1e3061302926720` | `a_c57842684d0411f184bfacde48001122` |

The CN branch assigns the common secret before selecting its environment.
The non-CN branch assigns it separately for Development and Testing and uses
the distinct secrets shown for Staging and production. This scope matters:
matching only the hostname suffix or taking the SDK constructor's default
secret does not reproduce every app branch.

### Account token acquisition

Evidence: `classes2.dex`, `ab1.J`, `ab1.F`, `mk1.b`, `ab1$k`, `xa1`;
`classes.dex`, `HttpRequestManager.getTokenV2`,
`HttpRequestManager$a.onSuccess`, `HMACSHA256Utils.sha256_HMAC`,
`ge.getServerTimeUrl`, `ge.getTokenV2Url`, `fe.OkEncryptionPost`.

`ab1.J()` calls `getTokenV2(context, username, configuredAppId, callback)`.
`mk1.b()` supplies the username as `PHILIPS:<account field b>` when the app has
an account record, or `ahc:id=<App.e()>` when it does not. The latter is
identified as the anonymous-account path by `dn0$q`'s error log; the regular
account path is identified by `dn0$m`. This does not establish how to obtain
a real Philips account identity outside the app's account subsystem.

The SDK performs:

1. GET `<HOST>device/serverTime/`.
2. Read `timestamp2` from the JSON encoded in response `data`.
3. Construct JSON containing `timestamp`, unescaped `username` and `app_id`.
4. Construct signing text in this exact order:
   `app_id=<appId>&timestamp=<timestamp>&username=<urlEncodedUsername>`.
   The username encoding is Java `URLEncoder.encode(username, "utf-8")`.
5. Compute lowercase hex HMAC-SHA256 of that text using the configured app
   secret. Compute a second lowercase hex HMAC-SHA256 of that **hex string**,
   using the raw username as key.
6. POST the JSON to `<HOST>enduser/v2/getToken/` with the second result in the
   `Signature` header.

`sha256_HMAC` takes `(message, key)`. The SDK's `getBytes()` calls use the
platform default charset; the explicit URL-encoding charset is UTF-8.
`OkEncryptionPost` is the method name; its inspected body writes JSON without
an additional payload cipher. Its nonempty existing token, if present, is
also added as `Authorization: jwt <token>`.

`xa1` accepts a response whose `meta.code` is zero and reads
`data.enduser_id`, `data.token` and `data.ur_id`. `ab1$k.onSuccess` installs the
new token in the HTTP client, stores the session through `bb1.c` or updates its
token through `bb1.r`, and calls the request listener. The `mk1` implementation
persists these through the app's `sb0` storage. `ab1.q()` clears the in-memory
session and SDK token.

Subsequent SDK GET/POST requests, including broker discovery, use
`Authorization: jwt <token>` when configured. `dn0.W0`, `dn0.i0` and
`dn0.X0` call `ab1.J`; successful login callbacks then continue device-list or
session initialization. No password is supplied directly to this Gaoda token
request. The larger Philips/OneID authentication flow remains a separate
subsystem, not a reconstructed login API in this document.

### Broker renewal boundary

`ab1$c` does not assemble or sign a WebSocket URL. It copies `host`, `path`,
`endpoint`, `client_id` and `device_id` from the server response through `f71`.
`MxMqttClient` passes `host` unchanged to Paho. No AWS access key, SigV4 signer,
URL-expiry parser or signed-query renewal appears in that recovered chain.
This establishes server-supplied broker configuration, not the concrete URI
format or whether the returned host includes a signature.

The app refreshes broker information on disconnected transport checks, as
detailed below. It does not visibly renew a still-connected broker URI on an
expiry timer in this chain. The exact server-issued URI and its validity
period require a sanitized response fixture; inventing a fixed broker host or
client-generated signing scheme would exceed the evidence.

## MQTT topics

Evidence: `classes.dex`, `g71.a` through `g71.g`,
`MxMqttClient.o`, `MxMqttClient$b.run`, `MxMqttClient$f.messageArrived`.
Here `<id>` is the device identifier passed into `MxMqttClient`.
Topic spelling and capitalization below are literal APK constants.

| Helper | Topic | Use in inspected client |
| --- | --- | --- |
| `g71.f` | `$aws/things/<id>/shadow/get/#` | Subscribe after connect; unsubscribe after accepted initial read. |
| `g71.c` | `$aws/things/<id>/shadow/get/accepted` | Recognize initial state response. |
| `g71.a` | `$aws/things/<id>/shadow/update/accepted` | Subscribe. |
| `g71.e` | `$aws/things/<id>/shadow/update/rejected` | Subscribe. |
| `g71.b` | `Philips/<id>/ai-notice` | Subscribe and recognize AI notices. |
| `g71.d` | `$aws/things/<id>/shadow/get` | Publish empty MQTT message for state read. |
| `g71.g` | `$aws/things/<id>/shadow/update` | Publish control payload. |

`MxMqttClient.o` subscribes to the four listed subscription filters, publishes
an initial empty state-read message and starts a timer. `n` schedules that
timer immediately and every 20,000 ms. The timer checks connectivity and
publishes another empty state read when the listener's
`isPublishGetDataTopic()` returns true. The app listener `bn$b` always returns
true. These reads are separate from the MQTT protocol keepalive; no explicit
keepalive override occurs in the inspected connect method.

The incoming listener tests for the accepted read topic, the update-topic
prefix and the AI notice topic. It converts the MQTT message directly into a
JSON response bean and passes both parsed and raw forms to the app listener.
The update test uses `contains`, so it covers both accepted and rejected
suffixes; this method alone does not establish complete rejection handling.

## Control and received state

Evidence: `classes.dex`, `MxMqttClient$b.run`,
`com.gaoda.util.ControlUtils.getContent`, `MxMqttClient.m`;
`classes2.dex`, `bn$b.onMessageArrived`.

The caller supplies a JSON object string. `ControlUtils.getContent` wraps it
in the AWS-shadow-shaped desired state:

```json
{"state":{"desired":{"<model-specific-key>":"<value>"}}}
```

The publisher sends that JSON as message bytes with QoS 1 and retained false
on `$aws/things/<id>/shadow/update`. There is no application-level AES,
Base64, digest or signature transformation in this inspected MQTT
publish/receive path. That differs from the local encrypted CoAP framing;
transport security still depends on the server-supplied URI and connection.

`bn$b.onMessageArrived` handles raw JSON as follows:

- A top-level `D0BJ80` or `eco` property takes the notice callback path.
- Otherwise, it looks for the top-level `state` object.
- `state.desired` without `state.reported` triggers the command callback.
- Other state objects take the state-data callback path.

Thus a desired-state response is not automatically proof that the appliance
has applied a control. A model's reported values, units, accepted controls and
acknowledgement timing still need separate evidence.

## Reconnect and limits

Evidence: `classes.dex`, `MxMqttClient.reConnect`, `disconnect`, `l`,
`MxMqttClient$a.run`; `classes2.dex`, `bn$b.onConnectionLost`, `bn.h`.

The MQTT timer signals connection loss when Paho is disconnected.
`MxMqttClient$e.connectionLost` also cancels the timer and signals the listener.
The app listener `bn$b` clears its connection status, calls `reConnect` on the
existing client and forwards loss to its parent. `reConnect` invokes Paho
`reconnect()` and starts `MxMqttClient$c`, which polls `isConnected()` every
500 ms. Once connected, it re-subscribes and restarts state reads through `o`.
No polling timeout or cancellation flag is visible in that worker loop.
The connect action's `onFailure` callback only logs in the inspected method.

There is a second recovery layer above Paho:

```text
za1.D starts appliance connections and schedules za1$d
za1$d message 3 runs every 20,000 ms
  → za1.k gathers devices where e01.F2() is true
  → e01.F2 → combinedTransport.h → bn.h
  → za1.B requests fresh MQTT configuration
  → response → bn.m → bn.s creates a new MxMqttClient
```

`bn.h` requests information when Paho is disconnected, except while status is
one and the current connection attempt is younger than 30,000 ms.
`bn.s` sets that status/time, disconnects an existing MQTT client and constructs
a new one with the latest server response. `za1.o` stops the periodic manager
message and disconnects its active appliance transports. This explains an
app-level route to fresh server-issued broker URLs after failure, independent
of a reconnect using the old Paho URI. The tick is 20 seconds; it does not
promise a precise 30-second retry, nor an overall retry limit or exponential
backoff. HTTP/account failure policy beyond these callbacks is not established.

`disconnect()` detaches listeners and cancels/purges the MQTT timer.
`onPause()` calls `close()` when connected; it is a separate lifecycle method,
not evidence of orderly unsubscribe or an expired-URL refresh.

The combined transport's queue is an `ArrayList<String>` owned by `bo`:
commands are appended only when no child is connected. `bo.q` removes the
first item and sends it via `bo.i`; if still disconnected, that send appends
it again. One state-data callback advances one item, and fresh state callbacks
can continue draining the queue. No size bound, persistence, expiry,
deduplication or explicit queue clear appears in `bo`'s inspected methods.
An already-selected transport's publish failure only logs in the SDK worker;
it does not return that command to this queue or automatically send it through
the other transport. These are app observations, not recommended adapter
queue semantics.

Open work before implementing another client:

- Reconstruct Philips/OneID account identity acquisition if implementing cloud
  login outside the app; validate account expiry and error recovery.
- Obtain a sanitized actual broker response to establish URI scheme, signing
  parameters and expiry, rather than inferring them from Paho.
- Match exact models and firmware to this combined transport versus DA IoT.
- Obtain sanitized discovery, MQTT state and harmless-control fixtures.
- Validate local/cloud transition, command rejection, reconnect, session expiry
  and shutdown with an authorized test device/account.

No cloud service availability, local fallback success, firmware compatibility
or exhaustive inventory of all network code in the APK is claimed here.
