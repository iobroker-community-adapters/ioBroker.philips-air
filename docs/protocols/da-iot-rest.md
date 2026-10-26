# DA IoT REST API and device identity

Static API inventory from the APK identified in [sources and evidence](README.md#sources-and-evidence), inspected 2026-10-26. No requests were sent. These are SDK request builders and response models, not a public service contract or verified server responses. Authentication, environment selection and MQTT are in [cloud connections](da-iot-mqtt.md); local provisioning is in [onboarding](device-provisioning.md).

## Request conventions

All paths below append to `FusionConfiguration.getArchPlatformBaseUrl...`:

```text
https://<configured platform REST host>/api/<tenant>
```

Production inputs in this artifact are `prod.eu-da.iot.versuni.com` and tenant `da`; dynamic configuration can replace the hosts. Use its actual result rather than deriving a host from a model. `ClientAuthenticationInterceptor` signs requests with the account access token. Authentication recovery is described in the cloud reference.

`IoTServiceClient` builds path components using `HttpUrl.Builder.addPathSegment` and query parameters with `addQueryParameter`: encode each value, rather than concatenating unescaped IDs or codes. JSON bodies use `StringKt.toRequestBodyWithJsonMediaType`; operations called “empty POST” below use `RequestKt.EMPTY_REQUEST`. DELETE operations use OkHttp's default empty-body DELETE. The exact empty request media type is not established here.

Method references omit Kotlin's generated name suffix. All API methods in the endpoint tables belong to `com.philips.cl.daconnect.iot.IoTServiceClient`, `classes2.dex`, unless another source is named. Response field names below were checked against DEX Gson `SerializedName` annotations, not inferred from Java getter names.

## Discover already paired devices

| Method | Request | Result decoded by SDK |
| --- | --- | --- |
| `getUserDevices` | `GET user/self/device` | Top-level array of `DeviceResponse` |
| `getDevicesFromHome` | `GET home/{homeId}/device` | Device list |
| `updateDevice` | `PATCH device/{deviceId}` with `{"friendlyName":"<name>"}` | Completion |
| `deleteDevice` | `DELETE device/{deviceId}?option=confirm` or `option=force` | Completion; publishes `DeviceDeletedEvent` after success |
| `getDeviceUsers` | `GET device/{deviceId}/users` | Device users |
| `updateDeviceUser` | `PATCH device/{deviceId}/users/{userId}` | Member update body below |
| `removeDeviceUser` | `DELETE device/{deviceId}/users/{userId}` | Completion |

`getUserDevices -> IoTServiceClient$m0 -> iot.u$b.onResponse` parses `DeviceResponse[]` directly; there is no `data` wrapper in that decoder. A synthetic shape, with placeholder values only:

```json
[
  {
    "id": "<platform-device-id>",
    "homeId": "<home-id>",
    "localCredentials": "<private-runtime-value>",
    "macAddress": "<device-mac>",
    "thingName": "<mqtt-thing-name>",
    "ctn": "<model-ctn>",
    "friendlyName": "<user-name>",
    "isOwner": true,
    "role": "OWNER"
  }
]
```

| Field | Decoded type and use |
| --- | --- |
| `id` | String; platform `DeviceId`, used in REST device paths |
| `homeId` | Nullable string; mapped to optional `HomeId` |
| `thingName` | String; separate `ThingName`, used in MQTT topics |
| `localCredentials` | String in response model; private material, not a fixed protocol secret |
| `macAddress` | String; available to local-control information |
| `ctn` | String; model/product identifier |
| `friendlyName` | String; user's device name |
| `isOwner` | Boolean in network response model |
| `role` | Serialized enum `OWNER` or `USER`; used by the domain mapper |

`iot.mappers.h.toDomainModel` maps `id` and `thingName` independently. It uses `role`, not `isOwner`, to construct the domain `Device.myMemberRole`. `Device.getRemoteControlInfo` retains both identifiers; REST shadow reads use `deviceId`, MQTT uses `thingName`. `Device.getLocalControlInfo` uses device ID and MAC. Do not substitute CTN, MAC, invitation ID or pairing-claim ID for either remote identifier.

Both `device(...)` overloads search the result of `getUserDevices` locally with `mapOptional`; they do not establish a separate `GET device/{id}` detail endpoint. `device(LocalDeviceInfo)`, `canControlDevice` and `isOwner` build on device lookup and role information.

## Provisioning and account pairing

| Method | Request | Decoded response |
| --- | --- | --- |
| `getDeviceProvisionConfiguration` | `GET provision-configuration/{model}` | `DeviceProvisionConfigurationResponse` |
| `createTemporaryProvisionClaim` | Empty `POST provisioning-templates/{templateName}/provisioning-claim` | `TemporaryProvisionClaimResponse` |
| `createPairingClaim` | `POST user/self/pairing-claim`, `{"claimCertificateId":"<certificate-id>"}` | `PairingClaimResponse` |
| `getPairingClaimState` | `GET user/self/pairing-claim/{claimId}` | `PairingClaimStateResponse` |

Provision configuration fields:

```json
{
  "defaultWifiProvisionType": "BLE",
  "minFirmwareVersion": "<minimum-version>",
  "provisionTemplateName": "<template>",
  "provisionType": "CLAIM",
  "supportedWifiProvisionTypeDetails": {
    "ap": {"searchConfig": {"ssidPrefix": "<prefix>"}},
    "ble": {"searchConfig": {"namePrefix": "<prefix>"}}
  }
}
```

This is a field illustration, not a claim that both transports are returned for every device. Serialized enums are `AP` / `BLE` and `CLAIM` / `TRUSTED_USER`. The BLE wire field is singular `namePrefix`; mapper `iot.mappers.a` wraps it into a domain list `namePrefixes`. Do not send the domain list field name to the API.

Temporary certificate response shape:

```json
{
  "certificateId": "<id>",
  "certificatePem": "<certificate-pem>",
  "expiration": 0,
  "keyPair": {"PrivateKey": "<private-key-pem>", "PublicKey": "<public-key-pem>"}
}
```

`expiration` is decoded as `BigDecimal`; its time unit is not established by this model. `PrivateKey` and `PublicKey` have capital initial letters. Certificate/key values are runtime credentials, never fixture literals or logs. The [onboarding reference](device-provisioning.md) describes how they reach the appliance.

Pairing-create fields are `id`, `thingName`, `status`. Pairing-status fields are `thingName`, `status`, `deviceId`; do not assume the claim response already contains the platform device ID. Status wire strings are `PENDING`, `ACTIVE`, `FAILED`, `DELETED` (`StatusResponse` annotations).

`pollActivePairingClaim` reads status immediately and repeats while `PENDING` with a constant three-second delay. It applies a caller-supplied overall timeout. `IoTServiceClient$s0` handles the terminal status: `ACTIVE` returns; `FAILED` raises `CLOUD_PAIRING_CLAIM_FAILED`; `DELETED` raises `CLOUD_PAIRING_CLAIM_DELETED`; timeout raises `CLOUD_PAIRING_CLAIM_ACTIVE_PAIRING_STATE_TIMEOUT`. Platform request errors are mapped to `CLOUD_GET_PAIRING_CLAIM_STATUS_UPDATE_FAILED`. `subscribeToActivePairingClaimState` discards the returned object; `subscribeToDeviceActive` extracts `deviceId` and fails with `CLOUD_PAIRING_CLAIM_FAILED` if it is missing. These names describe REST polling, not an MQTT subscription.

Application evidence includes `io.airmatters.philips.daconnect.PDAProvisioning` calling provision-configuration and temporary-claim methods, then its worker `$f` calling `createPairingClaim`. The presence of a provisioning endpoint alone does not prove every device uses that provisioning type or that repeating a claim is idempotent.

## Homes and sharing

| Method | Request | Body/query |
| --- | --- | --- |
| `getUserHomes` | `GET user/self/home` | None |
| `createHome` | `POST user/self/home` | `HomeInfo` JSON |
| `updateHome` | `PUT home/{homeId}` | `HomeInfo` JSON |
| `deleteHome` | `DELETE home/{homeId}` | None |
| `attachDeviceToHome` | `POST home/{homeId}/device` | `{"deviceId":"<device-id>"}` |
| `detachDeviceFromHome` | `DELETE home/{homeId}/device/{deviceId}` | None |
| `getHomeMembers` | `GET home/{homeId}/member` | None |
| `updateHomeMember` | `PATCH home/{homeId}/member/{memberId}` | Member update JSON |
| `deleteHomeMember` | `DELETE home/{homeId}/member/{memberId}` | None |
| `createHomeInvitation` | `POST home/{homeId}/share` | `{"nickname":"<nickname>"}` |
| `getActiveHomeInvitations` | `GET home/{homeId}/share` | None |
| `acceptHomeInvitation` | Empty `POST home/{homeId}/member` | Query `code`, `invitationId` |
| `createDeviceInvitation` | `POST device/{deviceId}/share` | `{"nickname":"<nickname>"}` |
| `getActiveDeviceInvitations` | `GET device/{deviceId}/share` | None |
| `acceptDeviceInvitation` | Empty `POST device/{deviceId}/accept` | Query `code`, `invitationId` |

`HomeInfo` contains `country`, `locale`, `name`, `timezone`, `nickname`. It is serialized directly with Gson, without a wrapper. `HomeResponse` contains `country`, `id`, `locale`, `name`, `timezone`, `isOwner`, `role`. `HomeInvitationResponse` contains `id`, `code`, `homeId`, `nickname`, `expiresAt`; `DeviceInvitationResponse` uses `deviceId` instead of `homeId`. Both expiry fields are Java `long`; unit and server enforcement remain unverified.

Member-update fields are `nickname` and `role`; the request directly serializes `MemberUpdateParams`. The request uses domain enum `ResourceMemberRole`, whose declared constants are `OWNER`, `USER`, without field rename annotations. With standard Gson enum serialization these produce the same uppercase strings; no custom enum adapter was established here. Device-user response identifier is JSON `userId`, although the Java field is named `id`. Home-member identifier is JSON `id`. Both include `name`, `nickname`, `isOwner`, `role`, `me`. Accepted resource invitations publish `ResourceAcceptedEvent` after completion.

App calls include `q7.J -> createDeviceInvitation`, `DeviceShareDelegate.d` and `MujiDevActivity.D2 -> acceptDeviceInvitation`, and `MujiDevActivity.L2 -> getActiveDeviceInvitations`. Home operations remain SDK capabilities in the inspected direct-caller inventory. These endpoints can change ownership, membership or account resources. Their inventory is static evidence, not authorization to exercise them. App usage must be established per feature; the SDK includes functionality beyond the observed purifier control flow.

## Device schedules

| Method | Request | Result |
| --- | --- | --- |
| `getDeviceTaskSchedules` | `GET device/{deviceId}/schedule` | Schedule list |
| `createDeviceTaskSchedule` | `POST device/{deviceId}/schedule` | Schedule |
| `updateDeviceTaskSchedule` | `PUT device/{deviceId}/schedule/{scheduleId}` | Completion |
| `deleteDeviceTaskSchedule` | `DELETE device/{deviceId}/schedule/{scheduleId}` | Completion |

Create/update builders (`iot.mappers.g`, `iot.mappers.x`) produce the same body keys:

```json
{
  "friendlyName": "<schedule-name>",
  "startTime": "<schedule-time-string>",
  "configuration": {
    "runWhenOffline": false,
    "standbyTask": false,
    "enabled": true
  },
  "taskCommand": {"<model-property>": "<value>"},
  "portName": "<port>"
}
```

`TaskScheduleResponse` has these fields plus `id`. The SDK domain names differ: `name -> friendlyName`, `scheduledTime -> startTime`, `command -> taskCommand`. Crucially `standbyTask = !requireWakeUp` in both request mappers; the response mapper reverses that boolean. A missing response `portName` defaults to `Control` in `iot.mappers.x`. The API accepts a string for `startTime`; its grammar, timezone and recurrence semantics are not established by these builders. The command map is model-specific, not a universal D-code contract. App class `br1` calls all four schedule operations; these are app-used, not just unused SDK methods.

## Capabilities, migration and auxiliary APIs

| Method | Request | Body/result |
| --- | --- | --- |
| `getDeviceCapabilities` | `GET device/{deviceId}/capabilities?proposition={ctn}&version={hostFirmwareVersion}` | SDK decoder targets a JSON string (`iot.l$b`); do not assume a plain object schema |
| `getDeviceOTAJobs` | `GET device/{deviceId}/jobs` | Device OTA jobs model |
| `getDeviceMigration` | `GET user/self/device-migration?ctn={ctn1}&ctn={ctn2}` | Repeated query parameter, one per input CTN |
| `migrate` | `POST user/self/device-migration` | `DeviceMigrationRequest` below |
| `currentUser` | `GET user/self` | User model (`id`, `name`) |
| `updateUser` | `PATCH user/self` | `{"name":"<username>"}`; wire annotation renames `username` |
| `convertTimeZone` | `GET timezone/convert?inputtzFmt={format}&desttzFmt={format}&value={timezone}` | Conversion result; format enum values require separate tracing |
| `enableExternalControlService` | `POST control/link/{deviceId}` | `{"skillId":"<id>","service":"<service>","ports":["<port-name>"]}` |
| `disableExternalControlService` | `DELETE control/link/{deviceId}/{service}/{skillId}` | Completion |

Migration body has exact fields `sourceAppId`, `deviceIds` (array of platform ID strings), optional `homeId`. `iot.mappers.d` maps `Application.appId` to `sourceAppId`. Migration-response models include `application: {"appId":"<id>"}` and `devices` (device-response list). The migration-read request adds one query parameter per CTN. The migration-write builder iterates an empty CTN list, so the inspected `migrate` method adds no CTN query parameters.

`DeviceOTAJobResponse` contains `deviceId`, `jobs`; each `OTAJobResponse` contains `executionNumber` (integer), `jobId`, `lastUpdatedAt`, `queuedAt` (strings). This exposes job information, not a verified firmware-update trigger API. `ControlServiceRequest` serializes port objects as a list of their `portName` strings, not property maps.

Application `aj1` calls `updateDevice` and `convertTimeZone`; `mj1.F` calls `getUserDevices`, `mj1.q` calls `deleteDevice`, `mj1.s` calls `currentUser`, and `mj1$f.b` calls `removeDeviceUser`. The endpoints in this section otherwise remain SDK capabilities unless a concrete app caller has been traced. Do not equate SDK availability with a feature enabled for AC0651, a supported third-party client, or a permission granted to a particular account.

## Error handling and independent-client boundary

Network response models include `ErrorResponse` with integer `code` and string `message`. `iot.u$b` distinguishes network IO errors (SDK code 1002, HTTP status -1), parse exceptions (1001), missing required data (1000), and non-success HTTP responses parsed by `CallKt.parseErrorResponse`. Arrays pass through its array branch; this does not prove element completeness or establish a server schema validator. Validate untrusted responses explicitly in a new client.

A minimal client for an already paired device needs account authentication, dynamic configuration, device enumeration, retention of both IDs, MQTT signature/session establishment, model-specific ports and safe token refresh. Homes, sharing, schedule writes, deletion, migration and provisioning are separate capabilities; none is required merely to read an already paired purifier.

Unresolved: live response fixtures and account permissions; pagination/rate limits; exact empty POST bytes; time and expiry units/grammar; capability content format beyond the string decoder; idempotency and retry safety of writes; migration selection rules; runtime account/region routing; device firmware acceptance. No runtime, account or device compatibility claim follows from this inventory.

## Reproduction evidence

All named classes above are from `classes2.dex` of the pinned APK. Local working artifacts, excluded from the protocol's runtime dependencies:

- `tmp/apk-onboarding-analysis/com_philips_cl_daconnect_iot_IoTServiceClient.txt`: full request builders and polling.
- Same directory, `com_philips_cl_daconnect_iot_response_*.txt`, `..._mappers_*.txt` and core `Device` disassemblies: model mapping and payload creation.
- `tmp/apk-rest-analysis/schema.py` / `schema.txt`: field types and exact Gson field/enum annotations extracted with Androguard.
- `tmp/apk-rest-analysis/callers.py` / `callers.txt`: direct calls to `DaIoTServiceClient` from outside the SDK across all three DEX files.

Validation is static cross-checking of builders, annotations, decoder targets and callers. These artifacts contain no captured account tokens, live device responses or request execution results.
