# Philips device connections

Reverse-engineering notes for identifying connection families before adding
devices to this adapter. These are implementation observations, not an official
Philips protocol specification.

Analysis date: 2026-10-26. The inventory below describes static app analysis.
Subsequent authorized tests verified account login, discovery and read-only MQTT
status for an AC0651; see [Cloud setup and limits](../cloud.md). Physical commands
remain untested. An app code path does not establish firmware compatibility.

## Sources and evidence

The supplied Android APK was inspected statically with Androguard 4.1.4.
Class and method names below refer to this exact artifact; obfuscated names can
change between releases.

| Property | Value |
| --- | --- |
| Supplied filename | `com.philips.ph.homecare_3.19.0-112_minAPI29(nodpi).apk` |
| Size | 86,545,939 bytes |
| SHA-256 | `1c79f75b7562eaa122abfadc44c41cad1462015ca21c3ec4f817e28e9105278c` |
| Bytecode | `classes.dex`, `classes2.dex`, `classes3.dex` |
| Method | DEX string inspection followed by method disassembly |

The version in the filename is the supplied label. APK publisher identity and
signature authenticity have not been verified. No APK code was executed.

Other sources:

- Current adapter [CoAP transport][], [HTTP transport][] and [HTTP client][].
- Current [model mapping][] and [protocol selection][].
- [AC0651 issue #237][] and its maintainer comments from June 2026.

## Detailed references and coverage

- [Legacy CDP/CDP2](legacy-http.md): SSDP/mDNS discovery, HTTP/DH,
  UDP notifications, Wi-Fi setup and the separate SDK HTTPS/PIN branch.
- [Gaoda / MXCHIP](gaoda-mqtt.md): MQTT, broker information,
  simultaneous LAN/cloud connection and transport preference.
- [DA IoT cloud](da-iot-mqtt.md): model routing, environment inputs,
  Home.ID/PKCE, token/signature acquisition, MQTT topics and REST shadow reads.
- [Account authentication](account-authentication.md): decoded client IDs, PKCE,
  token response parsing, encrypted app storage and refresh/provider wiring.
- [DA REST APIs](da-iot-rest.md): device listing/identity, homes,
  pairing, sharing, schedules and migration operations.
- [AC0651 schema](ac0651-control.md): exact ports, commands, sensor keys,
  filter totals/reset writes and inherited-field boundaries.
- [Shared Cloud profiles](cloud-device-profiles.md): app-derived purifier
  families, mode overrides and capability-discovery limits.
- [Provisioning wire formats](espressif-provisioning.md): Espressif
  session, configuration and scan protobuf schemas and security handshakes.
- [Local onboarding](device-provisioning.md): DA Espressif BLE/SoftAP,
  capability-selected session security, certificate provisioning, Gaoda
  TCP/SoftAP, BLE keys and the separate diagnostic key.

Class inventory covered all three DEX files. Relevant discovery, control,
provisioning and account entry points were followed into callers; the detailed
references distinguish actual application wiring from library-only branches.
This is an inventory of discovered connection families, not proof that every
network call, firmware variant or complete wire schema has been reconstructed.
Weather, analytics, advertising, content downloads and generic Android/library
network facilities are outside the device-connection scope.

## Connection families

| Family | Establishment | Status/control | Adapter support |
| --- | --- | --- | --- |
| Legacy CDP/CDP2 HTTP | SSDP/mDNS, Diffie-Hellman exchange | AES-CBC HTTP; app also supports UDP status subscriptions | HTTP implemented; UDP subscription path absent |
| Plain CoAP app branch | No sync in the inspected branch | CoAP observe and POST | Not selected by current adapter |
| Encrypted CoAP, legacy secret | `/sys/dev/sync` | CoAP, AES-CBC and SHA-256 frame digest | Implemented |
| Encrypted CoAP, negotiated secret | RSA exchange at `/sys/dev/info/tls`, then sync | CoAP, AES-GCM and SHA-256 frame digest | Not implemented |
| Gaoda cloud path | Server-supplied broker information | MQTT shadow and AI notices, combined LAN/cloud selection | Not implemented |
| Philips DA IoT remote path | Token, signature, configured WebSocket URL | MQTT shadow/port operations and REST shadow read | Cloud transport implemented; live acceptance pending |
| DA IoT onboarding | BLE or SoftAP, Espressif session negotiation | Wi-Fi setup and protobuf certificate provisioning | Not implemented |
| Gaoda onboarding | TCP SoftAP or BLE with backend key | Wi-Fi setup, separate encrypted configuration | Not implemented |
| Legacy SDK HTTPS/PIN branch | Pairing/PIN authorization | HTTPS with `PHILIPS-Condor` authorization; legacy app factory explicitly chooses HTTP | Not implemented |

The Gaoda app path starts LAN and cloud together and prefers the first
connected transport, with LAN first; see the detailed routing reference. This
does not assign every model to it. Likewise, the app's `isTls` name does not prove
that its CoAP packets use TLS or DTLS: the inspected branch constructs
`coap://` URLs on port 5683 and performs application-level key exchange.

## Local discovery and connection selection

Evidence in `classes.dex`:

- `com.gaoda.sdk.coap.SearchLanDeviceList.searchLanDeviceList`.
- `SearchLanDeviceList$b.run`, `SearchLanDeviceList$c.receiveResponse`.
- `com.gaoda.sdk.coap.FogCoap.<init>`.
- `com.gaoda.util.OptionUtil.isTls`.

The discovery worker always requests:

```text
GET coap://224.0.1.187:5683/sys/dev/info/encryption
```

When its boolean argument is true, it also requests:

```text
GET coap://224.0.1.187:5683/sys/dev/info
```

`coapGetRequest` uses a random Accept value from `nextInt(65535)`.
The response interceptor obtains the source IP and parses a
`FoundDeviceInfoBean`, including `option` and `didt`.

For `option == "3"` or the app's TLS flag, discovery decrypts `didt` using
AES-CBC. Its MD5 input combines the SDK discovery secret and the phone's local
IP address. The hexadecimal digest is split into key and IV text halves.
Consequently, a discovery response should not be assumed to be a plain model
description or to be decryptable using another host's address.

`FogCoap` chooses its engine from the decimal `option` string:

```text
if option is present:
    flags = parseInt(option)
    if ((flags >>> 6) & 1) == 1:
        v80(option, deviceId, host)    # negotiated-secret branch
    else if (flags & 0x07) != 0:
        v80(deviceId, host)            # encrypted branch
    else:
        jf1(deviceId, host)            # plain branch
```

In the inspected constructor, an empty `option` leaves the engine unset.
This is a description of the app, not a recommended adapter fallback.
Do not select encryption solely from a marketing model number.

## Encrypted CoAP with the legacy secret

Adapter evidence: `sync`, `_subscribe`, `encryptPayload`, `decryptPayload` and
`control` in [CoAP transport][]. App evidence: `v80.e0`, `v80.a0`,
`v80$a.run` and `v80$c.onLoad` in `classes.dex`.

```text
Client                         Device, UDP 5683
POST /sys/dev/sync   ---------> 8 ASCII hexadecimal counter characters
                     <--------- counter returned by device
GET /sys/dev/status  ---------> Observe registration
                     <--------- encrypted status notifications
POST /sys/dev/control --------> encrypted desired state
```

The adapter and inspected APK use the fixed legacy protocol secret below.
These are shared protocol constants, not a user's account credentials.

| Name | Exact value | Evidence |
| --- | --- | --- |
| Adapter `SECRET_KEY` | `JiangPan` | `lib/coap.js`, used by `encryptPayload` and `decryptPayload` |
| APK `CoapConstants.FOUND_DEVICE_SECRET` | `JiangPan` | `SearchLanDeviceList.searchLanDeviceList` assigns the literal; `v80` constructors use it as the initial secret |

Both names refer to the same case-sensitive, eight-byte UTF-8/ASCII value:

```text
Text: JiangPan
Hex:  4A 69 61 6E 67 50 61 6E
```

Discovery derives its AES-CBC key material from `JiangPan` plus the phone's
local IP text. Legacy encrypted commands derive theirs from `JiangPan` plus
the counter text, as described below. The string is not itself the final
16-byte AES key. No additional fixed secret for the AC0651 cloud path has
been established by this analysis. The separate Gaoda diagnostic AES key is
`1551F7B9A135714B737A588726442228` (32 hexadecimal characters, decoded to
16 AES key bytes). Its `gz0.c` CLI/log handshake and zero-IV framing are
described in [onboarding](device-provisioning.md#gaoda-ble-backend-issued-key-then-encrypted-json); it is not a purifier control key. Additional shared app IDs/signing secrets are
listed exactly in [Gaoda configuration](gaoda-mqtt.md#fixed-app-ids-and-signing-secrets),
and fixed APK string/storage decoder keys in [authentication](account-authentication.md).
These constants have different scopes; account tokens and device session keys
remain runtime material.

The adapter frame is ASCII hexadecimal:

| Position | Content |
| --- | --- |
| First 8 characters | Counter, uppercase hexadecimal |
| Middle | AES-CBC ciphertext, uppercase hexadecimal |
| Last 64 characters | SHA-256 hex digest of counter text plus ciphertext text |

Key derivation in the adapter:

```text
digest = UPPERCASE_HEX(MD5(UTF8(legacySecret + counterText)))
key    = UTF8(digest[0:16])
iv     = UTF8(digest[16:32])
```

The key and IV are bytes of hexadecimal text, not hex-decoded digest halves.
AES-128-CBC uses padding. The outer SHA-256 is an unkeyed digest, despite the
app's log label `hmacSha256`; it must not be implemented as HMAC.

The adapter increments the command counter as an unsigned 32-bit value.
The inspected app instead resets its command counter from 2,000,000,000 to 1.
Preserve this distinction when creating interoperability fixtures.

Status JSON is consumed under `state.reported`. The adapter sends control JSON
under `state.desired`, including `CommandType: "app"`, `DeviceId` and
`EnduserId`. Discovery IDs and command fields must not be confused with the
model-dependent D-code mapping.

## CoAP with RSA negotiation and AES-GCM

This branch exists in the APK and is absent from the current adapter.
It has not been assigned to the AC0651 by this analysis.

Evidence in `classes.dex`:

- `v80.c`: optional exchange before calling `e0` for sync.
- `v80.d`: response processing and session-secret derivation.
- `com.gaoda.util.TSLKeyPairGenerator`: RSA and SHA-256 operations.
- `v80$a.run`: command encryption and framing.
- `com.gaoda.util.AESCBCUtil.encryptNew` / `decryptNew`: AES-GCM.

When option bit 6 is set and no key pair exists, the app:

1. Generates an RSA-1024 key pair.
2. Exports its public key in PEM `PUBLIC KEY` form.
3. Chooses `random2 = Random.nextInt(8999) + 1000`.
4. Sends this JSON with CoAP Content-Format 50:

   ```text
   POST coap://<device>:5683/sys/dev/info/tls
   {"type":"config_encrypt","random2":<integer>,"pk":<PEM public key>}
   ```

5. Reads `prekey` and `random1` from the response JSON.
6. Hex-decodes `prekey`, decrypts it with `RSA/ECB/PKCS1Padding`, reverses
   its bytes into hexadecimal text and parses that text as a Java integer.
7. Adds that integer, `random1` and `random2` using Java integer arithmetic.
8. Hashes the sum encoded as four little-endian bytes with SHA-256.
9. Uses the first 16 hexadecimal characters, uppercased, as the session
   secret, provided the previous secret still equals the discovery default.
10. Proceeds to the normal `/sys/dev/sync` exchange and status observation.

The app can proceed to sync when the exchange callback receives no response.
That fallback is not evidence that a device will accept legacy encryption.

For a negotiated secret, command key derivation changes:

```text
digest = UPPERCASE_HEX(MD5(HEX_DECODE(sessionSecret) + UTF8(counterText)))
key    = UTF8(digest[0:16])
ivText = digest[16:32]
nonce  = UTF8(ivText[0:12])
```

`encryptNew` uses AES-GCM with a 128-bit authentication tag and the key bytes
as additional authenticated data (AAD). The hexadecimal cipher output retains
the outer counter/ciphertext/SHA-256 frame. The `ivText` truncation and AAD are
essential compatibility details; merely changing CBC to GCM is insufficient.

RSA plaintext length, integer range, response framing and failure cases still
need device fixtures. Do not copy legacy cryptographic choices into unrelated
new protocols; these details describe existing app interoperability.

## Plain CoAP branch

`jf1$b.run` observes `coap://<device>:5683/sys/dev/status` directly.
`jf1$a.run` posts `ControlUtils.getContent(...)` to
`coap://<device>:5683/sys/dev/control` without the `v80` encryption sequence.
`ControlUtils.getContent` wraps the supplied control JSON in `state.desired`.

No model has been verified against this branch on hardware in this analysis.
The adapter currently always starts CoAP with encrypted sync, so this branch
cannot be enabled by selecting `Generic`.

## Philips DA IoT remote path and AC0651

The AC0651 has a direct model branch in `classes2.dex`:

```text
mj1.p(oj0): "AC0651" -> new uj1(..., IoTConnect, ...)
uj1 extends ri1 extends qi1 extends aj1
aj1 constructor -> IoTConnect.getRemoteClient()
                -> DaIoTRemoteControlClient
```

The shared base invokes remote-client operations including `getPort`,
`observePort`, `observeDeviceState` and `setPort`. AC0650 selects a different
concrete class, `tj1`; similar model numbers are not interchangeable evidence.

The concrete SDK wiring continues as follows:

```text
IoTConnect.Companion.invoke -> DaIotConnect
DaIotConnect.getRemoteClient -> DaRemoteControlClient
DaRemoteControlClient       -> DaMqttClient / DaMqttClientImpl
DaMqttClientImpl            -> Paho MQTT over WebSocket
```

`DaIotConnect.f` builds the remote client with both MQTT and HTTP clients.
`DaRemoteControlClient` delegates device observations and control commands to
the MQTT client. The connection setup uses:

| Source | Value or operation |
| --- | --- |
| `MqttConnectionInfoProvider$fetch$2` | Gets the signature using HTTP `GET user/self/signature` under the configured platform base URL, or reuses a signature for the token |
| `FusionConfiguration.getAwsIotDeviceControlUrl...` | Supplies the WebSocket server URL |
| `DaMqttClientImpl.createMqttConnectOptions` | Sets custom WebSocket headers and the actual server URI |
| `TopicPublish` | Defines `/shadow/get` and `/shadow/update` suffixes |

The custom WebSocket headers are:

```text
x-amz-customauthorizer-name: CustomAuthorizer
x-amz-customauthorizer-signature: <signature>
token-header: Bearer <access token>
tenant: <configured tenant>
content-type: application/json
```

The inspected connection options set a 10-second connect timeout, a 30-second
keepalive, clean session enabled and Paho automatic reconnect disabled.
The last setting does not prove that higher SDK layers never reconnect.

The server is obtained from runtime configuration, not a fixed local device IP.
A `wss://localhost.com` constructor value in the APK is a placeholder; the
connection options replace the server URI. It is not a usable broker address.
Topic construction, account/PKCE entry points, refresh forms and configuration
inputs, URI construction, response correlation and retries are expanded in
[DA IoT cloud](da-iot-mqtt.md). Token lifecycle and AC0651 command shapes
are specified in the linked authentication and model references. Firmware and
server behavior remain untested.

This is stronger evidence than assuming every new purifier uses the adapter's
local CoAP handshake. It establishes an app remote-control path for AC0651,
but does not prove that its firmware has no additional local interface.

The supplied adapter 2.2.0 log fails during `POST /sys/dev/sync`, before status
decoding or model controls. Neither a new D-code mapping nor choosing
`Generic` repairs that missing response. Network reachability and firmware
behavior remain separate, untested questions.

## Encrypted HTTP reference

The existing [HTTP client][] describes another distinct local family:

1. `PUT /di/v1/products/0/security` with `{"diffie":<public key hex>}`.
2. Parse `hellman` and encrypted `key` from the response.
3. Compute the Diffie-Hellman secret using the source's fixed parameters.
4. Use its first 16 bytes to AES-CBC-decrypt the returned key, with a zero IV.
5. Retain the first 16 decrypted bytes as the session key.
6. Read status and metadata via GET; write air controls via PUT.

| Endpoint | Purpose |
| --- | --- |
| `/di/v1/products/1/air` | Status and control |
| `/di/v1/products/0/firmware` | Firmware information |
| `/di/v1/products/1/fltsts` | Filter status |
| `/di/v1/products/0/wifi` | Wi-Fi information |

Payloads use AES-128-CBC, a zero IV, manual PKCS#7 padding, an `AA` plaintext
prefix and Base64 wire encoding. The transport uses the minimal HTTP headers
documented in the source because embedded servers can reject other clients'
headers. This paragraph describes the adapter: the APK's `ha` crypto
implementation instead prepends two random bytes. The app additionally
registers HTTP subscriptions and receives encrypted UDP notifications on local
port 8080. Discovery, subscription endpoints and the app's explicit HTTP
selection are documented in [legacy connections](legacy-http.md).
HTTP compatibility is not implied by a CoAP timeout.

## Evidence needed for another device

For each additional device, record its exact model suffix, firmware, discovery
response and app model branch. Classify the connection before mapping values.

| Observation | Next responsible layer |
| --- | --- |
| Legacy sync and status decode work | Shared model mapping; verify controls separately |
| Discovery advertises negotiated-secret branch | Validate RSA exchange and GCM fixtures first |
| App selects plain CoAP | Verify plain observe/control framing before transport changes |
| App selects DA IoT remote client | Use the cloud reference; verify account lifecycle and model-specific port schema |
| No device response | Establish reachability and actual endpoint behavior first |

For a verified connection, retain sanitized request/response fixtures covering
handshake, one status update, one harmless control and its acknowledged state.
Include malformed payload, invalid digest/tag, timeout, reconnect and shutdown
cases. Keep read/write meanings model-specific in [model mapping][].

Current checks live in `test/testCoap.js`, `test/testHttpClient.js`,
`test/testHttp.js` and `test/testMapping.js`. Synthetic tests prove parser and
transport behavior; successful communication and firmware compatibility need
separate device evidence.

Private captures, APKs, account credentials, session secrets and identifying
device payloads remain local. The analysis tools and disassemblies under
`tmp/` are working artifacts, not adapter runtime dependencies.

[CoAP transport]: ../../lib/coap.js
[HTTP transport]: ../../lib/http.js
[HTTP client]: ../../lib/httpClient.js
[model mapping]: ../../lib/mapping.js
[protocol selection]: ../../main.js
[AC0651 issue #237]: https://github.com/iobroker-community-adapters/ioBroker.philips-air/issues/237
