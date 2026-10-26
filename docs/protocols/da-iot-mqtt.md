# Philips DA IoT cloud connections

Static connection reference for the APK identified in the
[connection inventory](README.md#sources-and-evidence). Analysis date:
2026-10-26. Class/method names refer to this artifact. This static reference is
separate from later authorized account and read-only MQTT tests on an AC0651;
see [Cloud setup and limits](../cloud.md). Hardware commands remain untested.

## Application routing and configuration

`classes2.dex`, `mj1.p` routes CTN `AC0651` to `uj1`, whose base chain
`ri1 -> qi1 -> aj1` obtains `IoTConnect.getRemoteClient()`. The concrete
implementation is `DaIotConnect`, constructing `DaRemoteControlClient` with
both MQTT and HTTP clients. AC0650 instead selects `tj1`. This proves an app
remote-control route, not the absence of a separate firmware LAN interface.

`dm1.h` chooses `pj1` for `Testing`, `rj1` for `Staging`, and `qj1`
otherwise. The following values are configuration inputs, not verified live
services or universal addresses for every account:

| Configuration | Tenant | REST host | MQTT host input |
| --- | --- | --- | --- |
| Production `qj1` | `da` | `prod.eu-da.iot.versuni.com` | `ats.prod.eu-da.iot.versuni.com` |
| Staging `rj1` | `da` | `acc.eu-da.iot.versuni.com` | `ats.acc.eu-da.iot.versuni.com` |
| Testing `pj1` | `ref` | Conditional `acc.eu-da.iot.versuni.com` or `dev.eu-da.iot.versuni.com` | Matching `ats.acc...` or `ats.dev...` |

Production additionally supplies:

```text
https://prod.global-da.iot.versuni.com/configuration
https://air.prod.eu-da.iot.versuni.com/api
```

Staging supplies `https://acc.global-da.iot.versuni.com/configuration`
and `https://air.acc.eu-da.iot.versuni.com/api`. Testing supplies
`https://dev.global-da.iot.versuni.com/configuration` and the same air API
as staging. The testing constructor's conditional host choice must not be
flattened into a single production address.

`FusionConfiguration.getArchPlatformBaseUrl...` constructs
`https://<platformRestApiBaseUrl>/api/<tenant>`. The dynamic-configuration
mapper `com.philips.cl.daconnect.l.apply` takes response fields `api` and
`iot` into the REST and MQTT configuration. `DaIotConnect.configure` also
accepts an explicit `IoTConfiguration`. The dynamic response has fields `version`, `region`, `iot`, `api`.
The inspected mapper consumes `api` and `iot` but uses the constructor's default
region `eu-west-1`, rather than the response's `region`. This is observed app
behavior, not proof of every account's true region. `DaIotConnect.c` builds a GET URL by adding `countryCode=<country>` to the
global discovery URL. `mj1.<init>` supplies the current locale country;
if its length is not two characters it substitutes `GB`. Worker `DaIotConnect$b.a(HttpUrl)` uses a separate HTTP
client, parses `DynamicConfigurationResponse`, maps `api`/`iot`, then updates
configuration. In the overload with fallback configuration, `$c.a` installs
the static fallback **on subscription**, before fetching dynamic values;
`$d.a` returns `Configuration.STATIC` if discovery ultimately fails. The retry
call passes count 2 and `IoTConnect.DYNAMIC_CONFIG_RETRY_DELAY`. This is not a
universal-region guarantee or proof that endpoint configuration never changes.

## OneID / Home.ID account connection

Evidence: `classes2.dex`, `uz0`; `classes.dex`,
`com.airmatters.oneid.OneIdAuth` and `cn`.

`uz0` selects these endpoints when the account environment equals
`Production`; other values select acceptance:

| Purpose | Production | Acceptance |
| --- | --- | --- |
| Auth UI base | `https://www.accounts.home.id/authui` | `https://acc.accounts.home.id/authui` |
| OIDC base | `https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA` | `https://cdc.accounts.home.id/oidc/op/v1.0/4_iX8FG_ECkagDbamClfS7Fg` |

| Base | Suffix | Purpose in inspected configuration |
| --- | --- | --- |
| OIDC | `/authorize` | Interactive authorization code request |
| OIDC | `/oauth/token` | Code exchange and refresh endpoint |
| OIDC | `/userinfo` | User information |
| Auth UI | `/client/account` | Account UI |
| Auth UI | `/api/autologin` | Autologin endpoint |
| Auth UI | `/api/Account/self` | Account profile |
| Auth UI | `/api/Account/self/ConsentGrant` | Consent grant |
| Auth UI | `/api/Consent` | Consent information |

The app config supplies `com.philips.air://loginredirect` as redirect URI.
`OneIdAuth.a` also recognizes the `accounteditredirect` host under the same
scheme. These Android callbacks are not an ioBroker callback implementation.
`uz0.getClientId` decodes an environment-specific literal using `tj0.d`;
the exact decoded identifiers, token parsing, persistence and refresh behavior
are specified in [account authentication](account-authentication.md).

The inspected flow is authorization code with PKCE:

1. `OneIdAuth.u` builds `/authorize` with `client_id`, `code_challenge`,
   `code_challenge_method`, `response_type=code`, redirect URI, locale and
   scopes. Scopes include `openid`, `email`, `profile`, `address`,
   `offline_access` and account/profile/consent/subscription permissions.
2. `cn.d/e` generates a verifier from 64 `SecureRandom` bytes, encoded as
   URL-safe Base64 without padding or wrapping. `cn.c` hashes its
   ISO-8859-1 bytes with SHA-256 and applies the same Base64 encoding.
   `cn.f` returns `S256` when SHA-256 is available; the helper contains a
   `plain` fallback if unavailable. That fallback is observed app behavior,
   not a recommendation for a new client.
3. The callback handler `OneIdAuth.b` reads the authorization `code`.
   `OneIdAuth.z` builds form fields `client_id`, `code`,
   `grant_type=authorization_code`, redirect URI and `code_verifier`.
   `OneIdAuth.Q` performs form POSTs.
4. `OneIdAuth.y` builds a refresh form with `client_id`,
   `grant_type=refresh_token`, URL-encoded refresh and access tokens. `OneIdAuth.G` adds bearer authorization for a profile
   request. Account persistence, expiry scheduling and all failure paths
   still need implementation-level tracing and authorized runtime proof.

Authorization codes, verifiers, refresh/access/ID tokens and profile data are
private runtime material. App logging of authentication URLs or token values
must not be copied into adapter diagnostics.

## Platform identity, REST authorization and MQTT signature

All paths below are relative to the configured platform base above.
Evidence is in `classes2.dex` under `com.philips.cl.daconnect`.

| Source | Request or behavior |
| --- | --- |
| `UserIdProvider$Companion.a` | `POST user/self/get-id`, JSON `{"idToken":"<ID token>"}` |
| `MqttConnectionInfoProvider$fetch$2` | `GET user/self/signature`; cached signature reused only for its matching access token |
| `ClientAuthenticationInterceptor.signRequest` | Gets access token and adds authorization through `RequestKt.addAuthorization...` |
| Same interceptor, HTTP 401 with failure handler | Serializes recovery with a mutex, re-reads current token, clears MQTT signature storage and calls `refreshAccessToken` if the failed token is still current; retries with the selected token |
| `DaAuthenticationService` | Exposes user ID, MQTT connection info, invalidation, signout and user-data clearing |

A signature is acquired for the account token. It is not the fixed legacy
CoAP secret and must not be hard-coded. The inspected 401 recovery branch
does not establish identical handling for HTTP 403 or unlimited safe retries.

## MQTT over WebSocket

Evidence: `DaMqttClientImpl.createMqttConnectOptions`, its publish worker `d`,
`TopicPublish`, `TopicSubscribe`, `TopicSubscribe$Companion.a`, and
`RemotePortCommand`, all in `classes2.dex`.

`FusionConfiguration.getAwsIotDeviceControlUrl...` supplies the broker host.
`MqttConnectionInfoProvider$fetch$2` wraps it in `core.models.WebSocketUrl`,
whose `getUrl...` constructs exactly `wss://<host>:443/mqtt`. For the production
fallback input this is `wss://ats.prod.eu-da.iot.versuni.com:443/mqtt`.
Dynamic discovery can supply another host. The constructor string `wss://localhost.com` is overwritten using
`setServerURIs`; it is a placeholder, not a broker to connect to.

Custom WebSocket headers:

```text
x-amz-customauthorizer-name: CustomAuthorizer
x-amz-customauthorizer-signature: <account MQTT signature>
token-header: Bearer <access token>
tenant: <configured tenant>
content-type: application/json
```

Connection options: timeout 10 seconds, keepalive 30 seconds, clean session
true, Paho automatic reconnect false. Higher SDK layers handle lifecycle:
`pauseInternal` / `doResumeInternal` and event worker `l` can disconnect and
resume/reconnect on lifecycle, user or device changes. A disabled Paho flag
does not mean the complete SDK never reconnects; the reconstructed retry/lifecycle rules appear below.

Here `<thing>` is the SDK thing identifier, not a marketing model number or
necessarily the platform device ID:

| Operation | Topic |
| --- | --- |
| Publish shadow read | `$aws/things/<thing>/shadow/get` |
| Publish shadow change | `$aws/things/<thing>/shadow/update` |
| Subscribe read result | `$aws/things/<thing>/shadow/get/accepted` and `/rejected` |
| Subscribe update result | `$aws/things/<thing>/shadow/update/accepted` and `/rejected` |
| Publish port command | `<tenant>_ctrl/<thing>/to_ncp` |
| Subscribe port response | `<tenant>_ctrl/<thing>/from_ncp` |

The shadow rejected suffixes replace `accepted`; they are not appended to it.
`TopicSubscribe` defaults the five subscriptions to `AT_MOST_ONCE` (QoS 0).
`RemotePortCommand` builds `_ctrl/<thing>/to_ncp`; the MQTT publisher prefixes
the configured tenant. Keep this distinct from Gaoda's `Philips/.../ai-notice`
and its subscription filters, described in [Gaoda connections](gaoda-mqtt.md).

## Port commands and REST shadow reads

`RemotePortCommand.toJson` builds:

```json
{"cid":"<correlation ID>","time":"<request time>","type":"command","cn":"getPort","ct":"mobile","data":{"portName":"<port>"}}
```

Command names include `getPort`, `setPort`, `updatePort` and `getAllPorts`.
Serialization requires nonempty correlation ID and command name; `data` is
optional. `DaRemoteControlClient.G` constructs a get-port payload with
`portName`; `m` adds the properties for a set-port request. Port operations
have 30-second timeout messages and distinguish `SUCCESS`, `ERROR`, `BUSY`.
Timestamp serialization and correlation are specified below; the AC0651
port/property mapping is documented in [AC0651 commands](ac0651-control.md).
A transport-level publish or accepted desired state is not physical proof.

There is also an HTTP read, beyond MQTT:
`device_control.remote.DaRemoteControlClient$t.a` builds
`GET <platformBase>/device/<deviceId>/shadow`. This uses platform device ID
from `RemoteControlInfo`, rather than assuming it equals the MQTT thing name.
Its error mapper turns HTTP 404 into `DeviceUnavailableException`, 408 into
`ResponseTimeoutException`, and other platform HTTP errors into
`ServiceUnavailableException`. This method alone does not prove that every
MQTT failure triggers a REST fallback.

AC0651 control values must stay model-specific. In particular, do not convert
`D0310D` blindly into boolean power; the existing model evidence uses it for
fan level. Filter resets, report semantics and all controls still need
sanitized device responses and real-device acceptance.

## Exact command payloads and response matching

Evidence: `RemotePortCommand.toJson`, `NcpRequestTime`, `UIntKt.generateId`,
`DaMqttClientImpl$d.a`, `DaRemoteControlClient.G/m/o`, `$l`, `$n`,
`NcpHeaderResponse` field annotations and `PortResponse`.

The UTF-8 JSON port payload is sent directly as the MQTT message body, without
CoAP counters, Base64 or application AES. Default port publish QoS is
`AT_LEAST_ONCE` (1); the publisher uses `MqttMessage`'s non-retained default.
`NcpRequestTime` takes UTC now and formats `yyyy-MM-dd'T'HH:mm:ss'Z'`, without
fractional seconds, for example `2026-01-01T12:00:00Z`.

Every publish attempt assigns a new `cid` and timestamp before serialization.
`UIntKt.generateId` obtains a random unsigned 32-bit integer, reverses its four
bytes, then renders lowercase hexadecimal in radix 16 **without padding**.
For example input `0x12345678` produces `78563412`; input `0x01000000`
produces `1`. This is a string identifier, not the MQTT message ID.

The following synthetic examples show the exact wrapper and data shape;
timestamps, IDs and properties are placeholders, not captured device values.

```json
{"cid":"1234abcd","time":"2026-01-01T12:00:00Z","type":"command","cn":"getPort","ct":"mobile","data":{"portName":"Status"}}
```

```json
{"cid":"1234abcd","time":"2026-01-01T12:00:00Z","type":"command","cn":"setPort","ct":"mobile","data":{"portName":"Control","properties":{"D0310D":1}}}
```

For `getAllPorts`, `DaRemoteControlClient.o` supplies no data object:

```json
{"cid":"1234abcd","time":"2026-01-01T12:00:00Z","type":"command","cn":"getAllPorts","ct":"mobile"}
```

`ControlCommand$GetCurrentState` publishes the two-byte JSON body `{}` to
`$aws/things/<thing>/shadow/get`. This differs from Gaoda's empty message body.
`ControlCommand$UpdateTimeZone` publishes
`{"state":{"desired":{"timezones":{"posix":"<POSIX>","iana":"<IANA>"}}}}`
to shadow/update. Those are additional shadow operations, not NCP port commands.
The separate power shadow command uses this wrapper on
`$aws/things/<thing>/shadow/update`:

```json
{"state":{"desired":{"powerOn":true}}}
```

`NcpHeaderResponse` parses fields `cid` (string), `time` (string), `ct`
(string), `type` (message enum), `status` (integer), `cn` (command enum),
and `data`. The exact message-type literals are `command`, `error`, `event`,
`response` (DEX enum annotations). Mapper `device_control.mappers.c.a` parses
time using the same seconds-only timestamp pattern, maps status 0 to SUCCESS,
1 to BUSY, other statuses to ERROR, and unknown codes to CLIENT_API_UNDEFINED.
A port result uses `data.portName` and `data.properties`, not
properties directly at the outer level. `PortResponse.getProperties` returns
an empty map when properties are absent. Unknown malformed responses must
not be reported as a successful physical command.

The command observable waits for MQTT connectivity. It listens for NCP
headers and combines them with the ID returned by the publisher; `$l.test`
accepts a matching `cid` using case-insensitive string equality. `$n.a`
passes SUCCESS through and converts ERROR or BUSY into `NcpException`.
`createRetryingNcpCommandObservable` retries only
`CLIENT_API_BUSY` (`DaRemoteControlClient.E`), at most three retries, with
random delay from a configured 300–1000 ms range. Every re-publish obtains
its own new correlation ID. The enclosing operations impose the documented
30-second response timeout; MQTT publishing has its own 10-second timeout.
Do not automatically replay arbitrary timed-out writes as though they were
known not to have executed.

`NcpStatusCode` numeric values come from its constructor's responseCode
argument, not its enum ordinal:

| Code | Meaning |
| --- | --- |
| -3 | Wrong port direction for this operation |
| -2 | Device subscription stopped |
| -1 | Undefined/unparseable response |
| 0 | OK |
| 1 | Device busy |
| 2 | JSON structure/parsing error |
| 3 | Missing/invalid correlation ID |
| 4 | Missing/invalid client type |
| 5 | Missing/invalid time |
| 6 | Missing/invalid message type |
| 7 | Missing/invalid command name |
| 8 | Missing/invalid port or missing property |
| 9 | Write to read-only port |
| 10 | Read from write-only port |
| 11 | MQTT serialization error |
| 12 | MQTT sending error |

Port observation has two paths. `observeNcpPortProperties` filters incoming
NCP messages to `type=event`, command `updatePort`, then the requested port
name. `observePort(PortInfo)` first validates read direction and gets the
initial port. The `observePort(Port)` overload seeds the property stream with
that initial state and merges subsequent updates using a scan. Preserve
previous properties when receiving a partial update.

`doVirtualSubscription` also merges a `getPort` refresh path: it combines an
initial timer value `-1` followed by a **single** 14-minute timer with local
events. Its predicate accepts the timer after expiry or `MQTTReconnected`.
`$q.apply` runs `getPort` and swallows that refresh error. The inspected code
uses `timer`, not `interval`; it must not be described as a guaranteed
periodic 14-minute polling loop. Terminal device/user events end the stream.

## MQTT lifecycle and retry contract

Evidence: `DaMqttClientImpl.<init>`, `h`, `handleReconnect`, `pauseInternal`,
`resumeInternal`, `logout`, workers `$e/$f/$g`,
`MQTTConnectionConfiguration$RetryConfiguration`, `ExponentialDelay`,
and `ObservableKt$retry$2` with its nested functions.

- The client ID is `<platform user ID>_<random UUID>` and uses in-memory
  persistence. Paho `setTimeToWait` is 10,000 ms.
- Connection publishes DISCONNECTED, CONNECTING or CONNECTED states.
  The connection worker avoids a second connect while CONNECTING and reuses
  an already connected client.
- The SDK default retry count is five, with delay function
  `1000 ms * 1.5^n`, where retry numbering starts at `n=1` (millisecond
  conversion truncates fractional milliseconds). This differs from enabling
  Paho's automatic reconnect. The outer connection acquisition timeout is
  the configured delay sum plus one second; slow connection attempts can
  therefore exhaust that outer timeout before every retry finishes.
- The retry predicate checks `hasConnectivity`; `handleReconnect` returns
  when that flag is false. `shouldReconnectOnInternetReachability` defaults
  false. When explicitly enabled it observes the SDK connectivity checker;
  `mj1.<init>` uses the default MQTT configuration in this app path.
- On recovery, `$e.a` rebinds each non-null device subject to all five topics.
  On exhausted recovery, `$f.a` errors the device subjects with a service
  exception, clears both subject/observable maps and sets DISCONNECTED.
- Background pause unsubscribes device topics. Resume cancels any previous
  resume job and schedules a new one; foreground handling can bind them again.
  `$o.connectionLost` schedules resume unless paused; `$o.a` requests an
  800 ms delay with connectivity monitoring enabled, otherwise zero delay.
  This Android lifecycle is not a requirement to pause an ioBroker daemon.
- Disposal removes the device subject and unsubscribes its topics.
  Logout disconnects/closes and resets the lazily created MQTT client.
  Shutdown must also cancel pending jobs, retry timers and observers.

These are static SDK rules. Server session expiry, throttling, permission
failures and long-term reconnect behavior still require authorized account
and hardware observations.

## Auxiliary account linking and sharing

These are app/account connections, separate from appliance transports.
Evidence: `classes2.dex`, `AirSettingsActivity$b.b`, `AlexaActivity.onCreate`
and `ProfileFragment.Y`.

- Sharing builds `https://www.api.air.philips.com/airplus/share/<runtime code>`.
- Alexa app-link handling builds
  `https://www.api.air.philips.com/accountlink/alexa/authorize?code=<runtime code>&type=applinking`
  and checks a state timestamp against application state.
- Account-link consent launches `https://alexa.amazon.com/spa/skill-account-linking-consent`
  or the fallback `https://www.amazon.com/ap/oa`, with scope
  `alexa::skills:account_linking`, stage `live` and redirect
  `https://www.api.air.philips.com/applink/alexa`.

Runtime share codes, account-link codes and signed URLs are not shared
protocol secrets. These entry points do not document the complete Amazon
or Philips account-linking server implementation.

## Remaining proof

This reference covers discovered connection families and inspected operations,
not a ready cloud adapter. Detailed [authentication](account-authentication.md),
[REST/device and pairing APIs](da-iot-rest.md), and
[AC0651 properties and commands](ac0651-control.md) complement the rules
above. Live account/device verification and undocumented firmware/server
behavior remain necessary; source reconstruction does not establish them. Provisioning
and certificate delivery are documented in [onboarding](device-provisioning.md).
