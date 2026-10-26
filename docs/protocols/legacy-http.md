# Legacy CDP / CDP2 LAN connections

This supplements [the connection inventory][] for the same Air+ 3.19.0 APK.
Analysis date: 2026-10-26. Evidence is static DEX disassembly; no app, device,
account or network session was exercised. Obfuscated names identify this APK
only. CDP and CDP2 package names coexist in one working legacy stack; they do
not by themselves establish two different wire protocols.

## Actual application path

The following calls are in `classes2.dex`:

```text
vs.<init>
  -> xv0.<init>                 LAN/discovery factory
  -> xv0.g(new ha())            app CryptoInterface implementation
  -> new ja(xv0, appContext)    legacy appliance factory
  -> new z91(ja, ..., [xv0])    discovery/device management

ja.b(NetworkNode)
  -> NetworkNode.useLegacyHttp()
  -> xv0.c(NetworkNode)
  -> new qv0(...)               LanCommunicationStrategy
  -> new xn([qv0])              exactly one communication strategy here
  -> model-specific appliance
```

`ja.a` checks `NetworkNode.getDeviceType()` against the application's supplied
list from `kk1.i()`. `ja.b` selects the appliance class using the discovered
model ID. This is a concrete consumer of `dicommclient`, not merely a bundled
library. The selected factory explicitly disables HTTPS before making its LAN
strategy. It does not fall back to MQTT or CoAP in this method.

The class choices below are ordered branches in `ja.b`, with predicates in
`a5`. They describe this factory after a device reaches it; they are **not** a
statement that every firmware or suffix of each model uses legacy HTTP.

| Discovered model condition | Predicate | Appliance class |
| --- | --- | --- |
| Empty, `AC4373` or `AC4375` | `K` / empty check | `gs0` |
| Starts `AC28` | `I` | `co` |
| Starts `AC12` | `b0` | `lc2` |
| Exactly `AS3501` | `d0` | `ak2` |
| Exactly `AS3502` | `e0` | `uo2` |
| Starts `AC3259` | `a0` | `zv1` |
| Starts `AC3829` | `O` | `a31` |
| Starts `AC56` | `T` | `s61` |
| Exactly `AC6675` | `N` | `wz0` |
| Starts `AC66`, or exactly `AC6918` | `M` | `vz0` |
| Starts `AC86`, or exactly `AC8988` | `Z` | `ps1` |
| Starts `AC27` | `V` | `t61` |
| Starts `FC8932` or `FC88` | `X` | `fs1` |
| Starts `FC87` | `L` | `sw0` |
| Remaining models | default | `dp2` |

The `AC6675` branch precedes the broader `AC66` branch. Several predicates
also contain redundant exact matches already covered by their prefix; the
table preserves the effective conditions. Robot-vacuum branches are included
because the APK supports more than air purifiers; their port schemas must not
be copied into purifier controls.

## Discovery: SSDP plus mDNS

`xv0.e` builds `sv0` (`LanDiscovery`). Its `r` method starts both `p10` (SSDP)
and `k11` (mDNS) while its LAN/enable conditions hold. Errors are surfaced as
`DiscoveryException`; stopping closes both discovery mechanisms and releases
the multicast lock.

| Mechanism | Evidence | Wire observation from code |
| --- | --- | --- |
| SSDP | `p10.<init>`, `p10.v`, `p10.w` | Destination initially `239.255.255.250:1900`; accepts `HTTP/1.1 200 OK` responses and `NOTIFY * HTTP/1.1` announcements |
| SSDP lifetime | `p10.t` | Handles `ssdp:alive`, `ssdp:update` and `ssdp:byebye` |
| SSDP description | `y32.b`, `x32.y/z/B` | Reads `LOCATION` and opens the supplied device-description URL |
| mDNS | `k11.k/l` | Adds/removes service listener for `_philipscondor._tcp.local.` |
| Discovery normalization | `sv0.p` | Converts `w50` into `NetworkNode` with CPP ID, host, name, model, device type, boot ID, current SSID and expiration period |
| Filtering | `sv0.t` | An empty filter accepts all; otherwise model ID or device type must be present in the filter |

`p10$a.run` and `y32$a` construct the following search. `y32.toString`
uses CRLF separators and a final empty line; header-map iteration does not
establish a stable header order.

```http
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 5
ST: urn:philips-com:device:DiProduct:1

```

In IPv4 broadcast mode it can first send this to the interface broadcast
address on port 1900, then switch to multicast (`p10$a.run`).

`x32$b` expects `<root>` and `<device>` in XML namespace
`urn:schemas-upnp-org:device-1-0`. It reads these device text elements:

| XML element | Use in discovery normalization |
| --- | --- |
| `cppId` | `NetworkNode` CPP ID |
| `friendlyName` | Node name |
| `modelNumber` | Node model ID |
| `modelName` | Node device type used by `sv0.p` |
| `bootId` | Parsed initially; replaced by `BOOTID.UPNP.ORG` response header |
| `ipAddress` | Parsed initially; replaced by `LOCATION` URL host |
| `deviceType`, `manufacturer`, `manufacturerURL`, `modelDescription`, `modelURL`, `serialNumber`, `UDN`, `presentationURL` | Retained in description object; not used by `sv0.p` to select the appliance |

Unknown XML elements are skipped. `x32` sets discovery expiration to 15,000 ms;
`sv0.p` passes this to the device-expiration tracker. The description URL's
scheme is recorded as HTTPS in `x32`, but `sv0.p` creates a fresh node and the
legacy appliance factory explicitly selects HTTP.

For mDNS, `k11$a` in `classes3.dex` requests service info when a service is
added and converts resolved/removed services through `l11`. Its TXT mapping is:

| TXT key | `w50` / node field |
| --- | --- |
| `fn` | Friendly name / node name |
| `id` | CPP ID |
| `mn` | Device type (not the separate model-ID field) |

`l11` takes the first IPv4 address if available, otherwise the first IPv6
address. It does not read the advertised service port in the inspected
constructor and leaves model ID and boot ID unset. Its expiration value is
31,536,000,000 ms. Missing/non-numeric boot ID becomes `-1` in `sv0.p`.
Service removal is also reported explicitly. These facts should be preserved
when reproducing discovery instead of inventing a model ID from TXT `mn`.
This discovery path is separate from Gaoda's CoAP multicast discovery.

## HTTP request and encryption path

`uv0.<init>` builds the request URL from `NetworkNode`, port name and product:

```text
http://<host>/di/v<protocolVersion>/products/<product>/<port>
https://<host>/di/v<protocolVersion>/products/<product>/<port>
```

`NetworkNode.getDICommProtocolVersion()` returns `1` in this APK. The URL
contains no explicit port; these forms therefore use the scheme default unless
the supplied host contains a port. The legacy factory above selects HTTP.
`qv0.T0`, `D0`, `a0`, `W` and `T` enqueue GET, PUT, POST, DELETE and
subscription POST requests respectively.

`uv0.d` opens a connection through the selected Android `Network`; unavailable
network throws `TransportUnavailableException`. It sets `content-type:
application/json`, `connection: close`, and 30-second connect/read timeouts.
Before sending, `uv0.e` Base64-encodes byte-array map values, serializes JSON,
and calls `DISecurity.encryptData` only when `isHttps == false` and a
`DISecurity` instance is present (`uv0.m`). Responses follow the matching
conditional decryption path. A malformed or undecryptable response is returned
as a failed request, not treated as valid status.

For HTTP, `qv0.p` queues key establishment before requests when the node has no
key. `qv0.o` selects `ra0` and puts it at the front of the request queue:

```text
PUT /di/v1/products/0/security
{"diffie":"<public DH value in hexadecimal>"}

response fields: hellman, key
```

`ByteUtil.generateRandomNum` creates the private exponent with
`BigInteger.probablePrime(224, SecureRandom)`. `EncryptionUtil.generateDiffieKey`
and `generateSecretKey` use the fixed modulus and generator also present in
[the adapter HTTP client][]. The key exchange computes the DH shared secret,
normalizes its hexadecimal representation to an even length, decrypts the
hex-encoded response `key` through `CryptoInterface.aesDecryptData`, and stores
the resulting key as uppercase hexadecimal (`DISecurity.extractEncryptionKey`,
`qv0$b`). Encryption/decryption failure callbacks clear the cached key and
schedule establishment again (`qv0$a`, `qv0.s`).

The installed application crypto is `ha`, selected by `vs.<init>`:

- AES/CBC/PKCS7Padding with a 16-byte all-zero IV.
- The hexadecimal key is converted through `BigInteger.toByteArray`; a leading
  sign byte is removed when present, and the resulting first 16 bytes are used.
- `ByteUtil.addRandomBytes` prepends **two random bytes** before encryption;
  `removeRandomBytes` removes the first two decrypted bytes.
- `DISecurity.encryptData` Base64-encodes encrypted bytes without line wraps.

The adapter currently uses a fixed `AA` plaintext prefix. The app uses random
prefix bytes. Both reserve two bytes before the JSON; this static comparison
alone does not prove a firmware compatibility problem or require changing the
adapter. Sanitized device fixtures would establish which framing is accepted.

## Subscription: HTTP registration, UDP events

This stack has its own event transport. It does not use CoAP Observe.

`qv0.T` enables `ey0` (`LocalSubscription`), then registers a subscription
with an HTTP POST for the requested port. `sg1.a` / `sg1$a` construct:

```json
{"subscriber":"deadbeef<eight lowercase hex digits>","ttl":300}
```

The subscriber is not an IP, callback URL or account token. `eo.<clinit>`
creates a singleton `p9`; its constructor formats one `Random.nextInt()` as
`deadbeef%08x`. The value remains the same while that singleton lives. Generate
a client-local value; the example above is a format, not a literal request.
The app's exact prefix is `deadbeef`; firmware requirements for the prefix
have not been tested.

`qv0.k` returns TTL `300` seconds. `DICommPort.subscribe` registers the event
listener, removes any queued renewal callback and schedules `cw.run` after
300,000 ms using `Handler.postDelayed`. `cw.run` calls
`refreshSubscriptionIfNecessary`, which calls `subscribe` again when still
subscribed. The callback is scheduled when subscription is requested, not only
after a successful HTTP response. The inspected code does not subtract an
expiry margin. `stopResubscribe` removes callbacks and clears subscription
state. This describes app scheduling, not a firmware guarantee of TTL behavior.

`DICommPort.performSubscribe` supplies the port name and product ID directly;
`AirPort` uses `air` and product `1`, so its registration is POST
`/di/v1/products/1/air`. On the HTTP branch the JSON above is encrypted like
other request bodies. `qv0.h1` sends DELETE to the same port with a body
containing only `subscriber`; it stops reception when its listener set is
empty. The returned registration payload is processed as port status by
`DICommPort$4.onSuccess`.

`ey0.enableSubscription -> qo2.g/h -> ro2.run` starts a `DatagramSocket` bound
to **local UDP port 8080** with address reuse (`ro2.h`). The constant `4919`
in `ro2.run` is an Android TrafficStats tag, not a device port. `ro2.f` receives
into a 1024-byte buffer and splits the decoded packet at newlines:

1. Parse the first line as space-delimited text; use its second token as a path.
2. Split that path on `/` and join components from index 4 as the port path.
3. Treat the final line as the payload and retain the datagram source IP.
4. `ey0.a` accepts events only from the associated node's IP, decrypts the
   payload via `DISecurity`, then dispatches the port event to listeners.

`DICommPort$1.pathMatchesMyPort` accepts the extracted path as either the
port name (`air`) or `<product>/<port>` (`1/air`). A matching decryption failure
schedules an HTTP property reload. The parser only uses the first and last
lines: it does not establish the required method token, intermediate headers,
content length or sender port. It converts the entire 1024-byte buffer to a
string and trims it rather than decoding only `DatagramPacket.getLength()`.

A synthetic parser example is therefore:

```text
<method> /di/v1/products/1/air <version>
<optional intermediate lines>
<Base64 AES-CBC payload>
```

The path above extracts `1/air`; `/di/v1/products/air` extracts `air`. These are
parser examples, not captured or firmware-validated packets. No sample packet
was captured. The SDK's
`AirPort.processProperties` accepts a JSON wrapper with `port: "air"` and a
`data` object, or an unwrapped object. `FilterPort.processResponse` does the
same for `port: "fltsts"`. JSON envelope variants still need fixtures before an implementation.

## Additional SDK HTTPS branch: distinguish reachability

The generic LAN strategy also contains a different security mode:

- `qv0.o` selects `ak0` when `NetworkNode.isHttps()` is true.
- `ak0` performs GET on product 0 `security` and reads its `key` field.
- `qv0.n` creates a TLS context with `xd2` (`SslPinTrustManager`). It remembers
  the first certificate pin in the node, accepts subsequent matches and raises
  `PinMismatchException` for mismatches.
- `uv0.m` skips application payload encryption on HTTPS.
- `vb` adds `Authorization` from cached node credentials or a challenge-derived
  value. Its 16-byte `WWW-Authenticate` challenge is combined with decoded
  client ID and secret: `Base64(clientId || SHA256(challenge || clientId ||
  clientSecret))`, preceded by the scheme `PHILIPS-Condor` supplied by `mm1`.

These methods establish an SDK capability. The traced `ja.b` application
factory calls `useLegacyHttp`, so it is incorrect to label these legacy model
branches as actively using HTTPS solely because these classes are bundled.
The authorization scheme and hash construction are static protocol constants;
client ID, client secret, challenge and certificate pin are per-node/runtime
values. No universal credential value is established by this path.
No automatic downgrade from a failed TLS connection has been demonstrated;
`useLegacyHttp` is an explicit factory decision before connection.

## Legacy Wi-Fi provisioning path

`oa0.l` constructs a `NetworkNode`, explicitly selects legacy HTTP, sets boot
ID to `-1`, sets its name/CPP ID and uses the literal setup address
`192.168.1.1`. This is an APK protocol/setup constant, not a captured private
installation address. It builds a LAN strategy through `vs.j().b(node)`.

`oa0$e` creates `WifiNetworksPort` and `WifiPort`. The concrete operations
are:

| Operation | HTTP endpoint | Decoded JSON |
| --- | --- | --- |
| `oa0.j -> WifiNetworksPort.reloadProperties` | GET `/di/v1/products/0/wifi/networks` | `strongestssids` array, entries with case-sensitive `SSID` string and `RSSI` integer |
| `oa0.k -> WifiPort.reloadProperties` | GET `/di/v1/products/0/wifi` | Wi-Fi properties listed below |
| `oa0.m -> oa0$e.p2 -> WifiPort.setWifiNetworkDetails` | PUT `/di/v1/products/0/wifi` | `{"ssid":"<network>","password":"<password>"}` |

The response name `strongestssids` is verified from
`WifiNetworksPortProperties.wifiNetworksList`'s `SerializedName` annotation.
The custom collection deserializer skips null entries, empty SSIDs, literal
`"null"` SSIDs and SSIDs starting with NUL (`WifiNetworkPortResponseDeserializer`).
It does not infer a security type from RSSI.

`WifiPortProperties` has string fields `cppid`, `gateway`, `ipaddress`,
`macaddress`, `netmask`, `password`, `protection`, `ssid`, `travelpassword` and
`travelssid`, plus nullable Boolean `dhcp`. There are no field-name remapping
annotations on this class. The property object's existence does not prove
that every device returns every field or allows each one to be written.

A separate six-argument SDK overload writes `ssid`, `password`, `ipaddress`,
Boolean `dhcp`, `netmask` and `gateway`. The traced `oa0$e.p2` setup flow uses
the **two-argument** overload, so it sends only SSID/password and does not force
static addressing or an explicit protection mode. Neither Wi-Fi port supports
subscriptions in its implementation.

`oa0.r` recreates the node when the CPP ID is updated and retains the previous
encryption key. The flow uses the ordinary HTTP key establishment/encryption
path described above; no hardcoded Wi-Fi password or account credential is
needed in this description. Complete UI entry conditions and device acceptance
of the provisioned network remain unverified.

## Boundaries and remaining evidence

The evidence adds a used CDP/CDP2 HTTP family with SSDP/mDNS discovery, encrypted
HTTP control and UDP notifications, plus its legacy setup flow. It does not
establish that every bundled common port (BLE, backend, HSDP pairing, firmware,
scheduling) is enabled for air purifiers. No legacy WebSocket transport was
identified in the traced LAN factory/strategy chain.

Remaining work for a compatible independent client: sanitized real discovery
and UDP packets, model-specific air/filter/control schemas, pairing
prerequisites, complete setup UI routing, and device-based
timeout/reconnect/shutdown verification.
Account credentials, live configuration and generated disassemblies remain
outside committed documentation. [The existing HTTP client][] provides the
adapter's current implementation; this document changes no runtime behavior.

[the connection inventory]: README.md
[the adapter HTTP client]: ../../lib/httpClient.js
[The existing HTTP client]: ../../lib/httpClient.js
