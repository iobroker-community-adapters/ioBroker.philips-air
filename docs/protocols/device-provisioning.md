# Local onboarding connections

Supplement to [device connections](README.md), using the same supplied
APK, SHA-256 and static-analysis boundary. Analysis date: 2026-10-26.
Names below identify DEX classes/methods in that artifact. No app execution,
account login, Bluetooth connection or device traffic was used.

Onboarding has **two distinct implementations**: Philips DA IoT uses Espressif
provisioning over BLE or SoftAP; Gaoda uses its own BLE and SoftAP protocols.
These connections configure Wi-Fi and cloud identity. They do not establish
an interchangeable LAN purifier status/control protocol.

Exact Espressif session, Wi-Fi configuration and scan messages, cipher
ordering and SRP arithmetic are in the
[provisioning wire reference](espressif-provisioning.md).

## Philips DA IoT: actual caller chain

`com.philips.cl.daconnect.DaIotConnect` constructs
`device_management.DaDeviceClient` with `g` implementing `DeviceBleClient`
and `i` implementing `DeviceSoftApClient`. This is caller evidence beyond
the mere inclusion of Espressif classes.

`DaDeviceClient.connectToDevice` dispatches by `BleOnboardingDevice` versus
`SoftApOnboardingDevice`; both clients use `ESPProvisionManager`:

| Path | Actual setup |
| --- | --- |
| BLE, `g.a` | `createESPDevice(TRANSPORT_BLE, SECURITY_1)`, then `connectBLEDevice(BluetoothDevice, parcelUuid.toString())` |
| SoftAP, `i.a` | `createESPDevice(TRANSPORT_SOFTAP, SECURITY_1)`, then `connectWiFiDevice(ssid, "")` |

The BLE service UUID comes from the onboarding device object. It should not
be replaced by the Gaoda UUIDs below. `BLETransport` maps endpoint names to
GATT characteristics by reading their descriptors; `sendConfigData` looks
up the requested path in this map. It also contains an explicit
`0000ff52-0000-1000-8000-00805f9b34fb` characteristic branch. A complete
device-specific characteristic map requires an actual service discovery.

`SoftAPTransport.<init>` defaults to `192.168.4.1:80`.
`sendPostRequest` builds `http://<baseUrl>/<endpoint>` and uses `POST`,
`Accept: text/plain`, and `Content-type: application/x-www-form-urlencoded`,
while sending the supplied bytes. This is an embedded HTTP provisioning
transport, separate from the adapter's `/di/v1/products/...` HTTP family.

| Endpoint | Inspected caller and purpose |
| --- | --- |
| `proto-ver` | `ESPDevice$14.run`, capability/version exchange; BLE also reads this mapped characteristic |
| `prov-session` | `Session.init`, security handshake |
| `prov-scan` | `ESPDevice.startNetworkScan/getWiFiScanList`, Wi-Fi scanning |
| `prov-config` | `ESPDevice.sendWiFiConfig/applyWiFiConfig/pollForWifiConnectionStatus`, Wi-Fi configuration and status |
| `da-iot-service` | Philips `TransportLayerImpl.a`, custom device information, authorization/status and provisioning messages |

For SoftAP these names form HTTP paths such as `/prov-session` and
`/da-iot-service`; BLE uses named GATT endpoints instead of HTTP URLs.

## DA session encryption and credentials

The explicit `SECURITY_1` constructor argument is an initial selection.
`ESPDevice.initSession` reads the `prov` object from version information:
when `sec_ver` exists, `0` selects Security0, `1` Security1, and other values
select Security2. Without it, an initial Security2 falls back to Security1.
Therefore the actual advertised security version matters.

| Security implementation | Bytecode evidence |
| --- | --- |
| `Security0` | Session handshake exists; `encrypt` and `decrypt` return the input bytes |
| `Security1` | Fresh 32-byte private/public keys through `lw2.b/c`; shared secret through `lw2.a`, implementing Curve25519 scalar clamping/base point 9; optional XOR with SHA-256 of nonempty proof of possession; device random as IV; `AES/CTR/NoPadding`; encrypted public-key verification |
| `Security2` | `getStep0Request/processStep0Response` use SHA-512 and the SRP6 client; payload cipher is `AES/GCM/NoPadding`; constructor accepts username and proof of possession/password |

`ESPDevice` initializes proof of possession to an empty string. The inspected
Philips `g.a` and `i.a` connection methods do not set it or a username.
This does not prove that every device accepts an empty proof or that no
other flow supplies one. Firmware requirements and negotiated version
remain untested.

Wi-Fi credentials follow an actual call:
`DaDeviceClient.provisionDevice-Rzoe31c` delegates through its matching ESP
device to `ESPDevice.provision(ssid, password, ProvisionListener)`.
The SDK sends and applies Wi-Fi configuration through `prov-config`, using
the established session.

Philips-specific cloud credentials use the separate custom endpoint:

1. `IoTServiceClient.getDeviceProvisionConfiguration-NWPrwBM` requests
   `GET <platformBase>/provision-configuration/<argument>`.
2. `createTemporaryProvisionClaim-1cvj_tg` requests
   `POST <platformBase>/provisioning-templates/<template>/provisioning-claim`
   with an empty request body. The response is mapped to
   `TemporaryProvisionClaim`, including certificate PEM and a key pair.
3. `TransportLayerImpl.sendProvisionInput` constructs
   `AWSCredentialsCommand` with certificate PEM, private key, provisioning
   template name and thing name. It wraps this in protobuf `Payload`,
   `PayloadType.REQUEST`, `ProtoVersion.VER_2`, then sends it to
   `da-iot-service` through `ESPDevice.sendDataToCustomEndPoint`.
4. `IoTServiceClient.createPairingClaim-OWvY0A4` separately posts
   `{"claimCertificateId": "<claim certificate ID>"}` to
   `<platformBase>/user/self/pairing-claim`.

These are runtime credentials from a backend response, not fixed APK keys.
The cloud base URL comes from `FusionConfiguration`; the method listing
does not supply a universal server or an account-independent identity.
The points above identify individual calls, not a proven complete temporal
ordering of every application onboarding variant.

`TransportLayerImpl.sendOnboardingConfiguration` similarly sends a
protobuf `OnboardingConfigCommand` containing POSIX/IANA time zones,
locale, IoT base URL and Wi-Fi country. `deviceInfo` and `deviceStatus`
use `GetDeviceInfoCommand` and `StatusCheckCommand`.

## DA custom endpoint framing

The following framing is inside the Espressif session encryption, before
the encrypted bytes reach HTTP or GATT. Evidence:
`extensions.ByteArrayKt.toChunk/toChunks`,
`TransportLayerImpl.sendPayloadToDevice/sendData`, and response mappers
`device_management.mappers.a/i`.

Let `P` be serialized protobuf bytes, `L = len(P)` and `K` the configured
chunk size. First chunk:

```text
FF | (L >> 8) & FF | L & FF | first min(L, K-3) payload bytes
```

If bytes remain, subsequent chunks are:

```text
sequence & FF | next at most K-1 payload bytes
```

Sequence starts at **0** for the first continuation and increments once
per continuation. There is no final-chunk flag: the first header's
big-endian 16-bit length determines completion. Concatenate payload bytes
after the three-byte first header and one-byte continuation headers until
`L` bytes have been collected. This describes the inverse of the APK's
transmit encoder; device-side validation/reassembly is not present in the
APK. The encoder narrows length/sequence to bytes without an explicit
overflow guard, so this is not proof of support beyond 65,535 bytes or
sequence wraparound.

| Client | K | First payload capacity | Continuation capacity | Per-chunk response timeout |
| --- | --- | --- | --- | --- |
| BLE, `g.<init>` | 256 | 253 | 255 | 5 seconds |
| SoftAP, `i.<init>` | 1024 | 1021 | 1023 | 10 seconds |

`toChunk` rejects a payload larger than `K-3`; it is used for device info
and status queries. `toChunks` is used for onboarding configuration and
AWS credentials. `Single.concat` sends chunks sequentially, waiting for
each endpoint response before proceeding. The response reducer retains
the latest response and a count; it does **not** concatenate replies.

Responses are asymmetric: empty bytes raise a communication error;
exactly one byte is a legacy `TransportLayerResponse`; longer responses
are parsed directly as `Payload` protobuf, without stripping the request
chunk header. Thus incoming protobuf must not blindly be reassembled
with the outgoing FF/sequence format. The APK mapper establishes this
client behavior, not every possible firmware response size.

Legacy response byte values:

| Hex | Meaning |
| --- | --- |
| `00` | NOT_PROVISIONED |
| `01` | UNKNOWN_ERROR |
| `02` | INVALID_CHUNK_FORMATTING |
| `03` | SEQUENCE_NUMBER_SKIPPED |
| `04` | MEMORY_ALLOCATION_ERROR |
| `05` | UNAUTHORIZED |
| `06` | WIFI_API_FAIL |
| `07` | ONLY_WIFI_PROVISIONED |
| `08` | ONLY_CLOUD_PROVISIONED |
| `09` | WIFI_AND_CLOUD_PROVISIONED |
| `0A` | CLOUD_PROVISIONING_IN_PROGRESS |
| `0B` | ERROR_DURING_AWS_PROVISIONING |
| `7F` | UNRECOGNIZED enum sentinel; other unmapped bytes also map here |

`k0` classifies 01-06, 0B and UNRECOGNIZED as errors; 05 produces the
specific proof-of-possession/ownership error. These legacy values differ
from protobuf status values below, especially value 7.

## DA protobuf wire schema

Reconstructed wire-compatible schema, not the publisher's original
`.proto` file. Evidence is the generated classes in
`com.philips.cl.daconnect.device`: `*_FIELD_NUMBER` constants, Java field
types, `dynamicMethod` message-info descriptors and enum `*_VALUE`
constants. The descriptor for `DeviceInfoResponse.revision` uses type
11 (`uint32`), not signed `int32`. Names/casing below are normalized for
readability; field numbers and wire types are decisive.

```proto
syntax = "proto3";

enum ProtoVersion { VER_0 = 0; VER_1 = 1; VER_2 = 2; }
enum PayloadType { REQUEST = 0; RESPONSE = 1; }
enum PayloadStatus {
  STATUS_OK = 0;
  ERR_UNKNOWN = 1;
  ERR_INVALID_CHUNK_FORMATTING = 2;
  ERR_SEQUENCE_MISSING = 3;
  ERR_MEMORY_FAIL = 4;
  ERR_UNAUTHORIZED = 5;
  ERR_WIFI_API_FAIL = 6;
  ERR_AWS_PROVISIONING = 7;
}
message Payload {
  PayloadType type = 1;
  ProtoVersion proto_ver = 2;
  PayloadStatus status = 3;
  oneof payload {
    AWSCredentialsCommand credentials_command = 10;
    StatusCheckCommand status_check_command = 11;
    OnboardingConfigCommand onboarding_config_command = 12;
    GetDeviceInfoCommand get_device_info_command = 13;
    StatusResponse status_response = 61;
    DeviceInfoResponse device_info_response = 62;
  }
}
message AWSCredentialsCommand {
  string cert = 1;
  string priv_key = 2;
  string thing_name = 3;
  string template_name = 4;
}
message StatusCheckCommand {}
message GetDeviceInfoCommand {}
message OnboardingConfigCommand {
  message Timezones { string posix = 1; string iana = 2; }
  string locale = 1;
  Timezones timezones = 2;
  string iot_base_url = 3;
  string wifi_country_code = 4;
}
message StatusResponse {
  bool wifi_provisioned = 1;
  bool wifi_connected = 2;
  bool aws_provisioned = 3;
  bool aws_provisioning_in_progress = 4;
}
message DeviceInfoResponse {
  optional string thing_name = 1;
  string mac_address = 2;
  string host_firmware_version = 3;
  string ncp_firmware_version = 4;
  string ctn = 5;
  string brand = 6;
  uint32 revision = 7;
}
```

Enums and booleans use protobuf wire type 0 (varint); strings and nested
messages use type 2 (length-delimited). `UNRECOGNIZED` is the generated
Java enum sentinel, not an additional normal protocol value.
`TransportLayerImpl$j` accepts protobuf replies only with `VER_2`, then
checks `PayloadStatus`; the single-byte legacy response has its own mapper.

Synthetic status request, with default REQUEST/status omitted:

```text
protobuf:    10 02 5A 00       # proto_ver=2, empty field 11 command
first chunk: FF 00 04 10 02 5A 00
```

The corresponding empty device-info command uses `6A 00` (field 13).
These examples describe bytes before session encryption. They are
source-derived fixtures, not captured device messages.

## Gaoda SoftAP: a different socket protocol

Application caller `iq1.E0/Y` invokes
`SoftAP_NetWorkConfigManager.startCheckSoftApVersion`; `iq1.g` invokes
`startSoftAp`, and `iq1.r` requests the Wi-Fi list. Thus this manager is
called by application code.

`startCheckSoftApVersion` special-cases the exact SSID `PHILIPS Setup`
to `10.0.0.1`. Its worker `SoftAP_NetWorkConfigManager$a.run` opens a TCP
socket on port **30123**, with an eight-second connect timeout.
This is not Espressif's `192.168.4.1:80` HTTP transport.

`startSoftAp` assembles Wi-Fi `ssid` and `password`, plus `ExtraData`
containing device name, notification registration/push fields, app ID,
secret and user ID. A `type: "config"`, `option`, `data` envelope is used.
`sendGetWifiListOrder` constructs a `type: "ssid"` request with RSSI and
`meta` fields; response parsing also handles `bind_token`.

The encrypted configuration branch is explicit:

1. `sendWifiInfoWithEncrypt` creates `TSLKeyPairGenerator`, generates a
   key pair and sends `{"type":"config_encrypt","random2":...,"pk":...}`.
2. Callback helper `SoftAP_NetWorkConfigManager.b` requires response
   `prekey`, hex-decodes and decrypts it with `decryptDataInternal`.
3. It reverse-hex parses that decrypted integer, adds device `random1`
   and client `random2`, and calls `getSHA256(sum)`.
4. It encrypts the configuration JSON with `AESUtil.encryptFog` using
   that derived hex key, then sends hex ciphertext as `data` in a
   `type: "config"` envelope with `option`.

`encryptFog` uses `AES/CBC/NoPadding`, converts the hex key to bytes,
uses a 16-byte zero IV, and zero-extends plaintext to a 16-byte boundary.
It does not use PKCS#7. `TSLKeyPairGenerator` generates RSA-1024 and
exports the Java public key's DER encoding as Android Base64 DEFAULT
between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`
(SubjectPublicKeyInfo PEM). `prekey` decryption uses
`RSA/ECB/PKCS1Padding`. `getSHA256(int)` hashes the four-byte
little-endian integer, not its decimal text, and returns lowercase
64-character hex. The derived AES key is therefore 32 bytes (AES-256).
The client random is `Random.nextInt(8999) + 1000` (1000 through 9998).

`SoftAP_NetWorkConfigManager.t` writes raw JSON bytes directly to the
TCP output stream and flushes; there is no added length prefix, newline
or HTTP wrapper. Its receive loop reads into a 10,000-byte buffer and
returns one read decoded as UTF-8 when re-encoding yields the same byte
count. It replaces, rather than accumulates, partial reads. The initial
device-info reader `s` has the same boundary weakness. Consequently the
APK does not define robust TCP stream reassembly: a new implementation
needs incremental JSON parsing and device traces to establish whether
multiple messages, embedded terminators or larger responses occur.

## Gaoda BLE: backend-issued key, then encrypted JSON

The app's `PhilipsPairingCommunicationFragment.I0`, `iq1.x0`, and
`PhilipsPairingWifiListFragment` reference Gaoda discovered-device objects.
`af.o` instantiates `gz0`, the `IViewMode` implementation used for its BLE
connections. These establish actual integration with the locklib layer.

`BleLockCharacteristics.<clinit>` defines:

| Role | UUID |
| --- | --- |
| Service | `00000922-0000-1000-8000-00805f9b34fb` |
| Command | `0000fed5-0000-1000-8000-00805f9b34fb` |
| Notification | `0000fed6-0000-1000-8000-00805f9b34fb` |
| Log write | `0000fff1-0000-1000-8000-00805f9b34fb` |
| Log read | `0000fff2-0000-1000-8000-00805f9b34fb` |

`af.l` extracts model ID, MAC and the device random from its discovery
record, then calls `HttpRequestManager.postDeviceVerifyUrl` with the
device's cipher value. That method posts JSON fields `modelid`, `mac`,
`random`, `cipher` to its configured device-verification URL.
`af$e.onSuccess` parses `DeviceBleKeyBean.data.ble_key` and stores it in
`af.d`. This is a backend-issued key, not the CoAP constant `JiangPan`.

When discovery option bit `0x20` is set, that callback sends:

```json
{"type":"ssid","rssi":-75,"meta":{"message":"scan ssid","code":200}}
```

`af.v` encrypts this JSON with `AESUtil.encryptFog(ble_key, jsonBytes)`
and forwards it to `IViewMode.writejson`. `af.x` applies the same
encryption to Wi-Fi provisioning JSON. The receive handler `ye.i`
distinguishes `cipher`, `ssid` and `config` replies and reports Wi-Fi
and pairing outcomes.

Gaoda BLE framing is implemented by `mi.a`, called by `ye.k/h` with
payload capacity **200**. It is separate from DA's FF/length framing:

| First byte | Meaning | Following bytes |
| --- | --- | --- |
| `02` | Complete single packet | Up to 200 payload bytes |
| `42` | First fragment | 200 payload bytes |
| `82` | Middle fragment | 200 payload bytes |
| `C2` | Final fragment | Remaining payload bytes |

For payload length greater than 200, `mi.a` emits
`floor(length / 200) + 1` fragments. An exact multiple therefore ends
with an empty `C2` fragment; do not silently omit it when reproducing
this encoder. For example, 400 bytes produce `42 + 200`, `82 + 200`,
then just `C2`. There are no sequence numbers or total-length bytes.
`ye.b` strips the first byte, resets its buffer on `42`, appends on
`82`, appends and parses on `C2`, and parses `02` directly. Unknown
headers are ignored. This parser does not validate fragment order.

`ye.i` decodes the resulting bytes directly as UTF-8 JSON; this receive
path does not invoke AES decryption. Requests encrypted by `af.v/x`
are therefore not evidence that all replies are encrypted. The actual
reply parser accepts `cipher`, `ssid` and `config`, plus diagnostic
`msgtype`/message forms. Exact verification URL resolution and the
complete authorization sequence remain open; device behavior for
malformed, reordered or missing fragments has not been tested.

The `gz0.c` CLI/log callback uses the fixed diagnostic AES key
`1551F7B9A135714B737A588726442228`. `AESUtil.encryptFog` hex-decodes
these 32 characters into 16 key bytes (AES-128); the IV is 16 zero bytes.
For an incoming 17-byte CLI packet whose first byte is `0x02`, this
callback removes that first byte, encrypts the remaining 16 bytes and
passes the result to `gz0.writeCli`. This is a shared APK protocol
constant, not an account or session credential. Its demonstrated scope
is the diagnostic CLI/log handshake; it does not establish a provisioning
key or an ordinary purifier control key.

## Boundary: DA local control has not been established

The DA SDK contains `LocalControllableDevice.getLocalControlInfo` and a
`LocalControlInfo` data class containing MAC address and device ID.
`Device.getLocalControlInfo` constructs that object. This is metadata,
not evidence of a listening LAN port, key exchange or usable control
client. No caller of `LocalControllableDevice.getLocalControlInfo` was
found in the three DEX files during this pass.

The proven DA local connections above perform onboarding, information
and provisioning-status operations. They do not establish ordinary
post-onboarding fan/power control over BLE, SoftAP or LAN. The app's
remote MQTT path is documented separately in [device connections](README.md).

Before implementation, obtain sanitized hardware traces for the selected
family, security version, discovery records, session negotiation and one
complete provisioning exchange. A model-by-model selection rule,
certificate lifetime/rotation, account authorization behavior, firmware
support and long-term connectivity are still unverified.
