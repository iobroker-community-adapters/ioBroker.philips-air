# Espressif provisioning wire reference

Companion to [onboarding connections](device-provisioning.md). Evidence
is the same supplied APK identified in [device connections](README.md),
statically inspected on 2026-10-26. These are recovered wire contracts and
APK behavior, not a claim of verified hardware compatibility.

## Encoding and endpoints

`proto-ver` exchanges version/capability JSON. `ESPDevice$14` sends ASCII
`ESP` through the transport. `ESPDevice.initSession` reads
`prov.ver` and `prov.sec_ver` from the returned JSON. The latter selects
security scheme 0, 1 or 2 as described in the onboarding reference.

`prov-session` exchanges **unencrypted protobuf session envelopes**.
Embedded verification fields can themselves contain encrypted bytes.
After session establishment, `prov-config`, `prov-scan` and Philips
`da-iot-service` requests pass through `Session.sendDataToDevice` and its
security cipher; `Session$2.onSuccess` decrypts responses before parsing.
There is no Philips FF/length chunk header around `prov-session`,
`prov-config` or `prov-scan`. That header belongs to the Philips custom
endpoint only.

The tables below describe every field in the generated APK messages.
Notation: `number name:type`; `bytes` and nested messages use protobuf
wire type 2, `string` is UTF-8 wire type 2, enums/bools/integers use wire
type 0. Negative `int32` uses normal protobuf varint encoding, not zigzag.
Unlisted fields are not defined in these message descriptors. Ordinary
proto3 defaults can be omitted; an explicitly selected empty command
message still has a length-delimited tag and zero length.

## Session protobufs

Generated class names use `espressif.<family>$<message>`.

| Class | Fields |
| --- | --- |
| `Session$SessionData` | `2 sec_ver:SecScheme`; oneof `10 sec0:Sec0Payload`, `11 sec1:Sec1Payload`, `12 sec2:Sec2Payload` |
| `Sec0$Sec0Payload` | `1 msg:Sec0Msg`; oneof `20 sc:S0SessionCmd`, `21 sr:S0SessionResp` |
| `Sec0$S0SessionCmd` | Empty |
| `Sec0$S0SessionResp` | `1 status:Status` |
| `Sec1$Sec1Payload` | `1 msg:Sec1Msg`; oneof `20 sc0:SessionCmd0`, `21 sr0:SessionResp0`, `22 sc1:SessionCmd1`, `23 sr1:SessionResp1` |
| `Sec1$SessionCmd0` | `1 client_pubkey:bytes` |
| `Sec1$SessionResp0` | `1 status:Status`, `2 device_pubkey:bytes`, `3 device_random:bytes` |
| `Sec1$SessionCmd1` | `2 client_verify_data:bytes` |
| `Sec1$SessionResp1` | `1 status:Status`, `3 device_verify_data:bytes` |
| `Sec2$Sec2Payload` | `1 msg:Sec2Msg`; oneof `20 sc0:S2SessionCmd0`, `21 sr0:S2SessionResp0`, `22 sc1:S2SessionCmd1`, `23 sr1:S2SessionResp1` |
| `Sec2$S2SessionCmd0` | `1 client_username:bytes`, `2 client_pubkey:bytes` |
| `Sec2$S2SessionResp0` | `1 status:Status`, `2 device_pubkey:bytes`, `3 device_salt:bytes` |
| `Sec2$S2SessionCmd1` | `1 client_proof:bytes` |
| `Sec2$S2SessionResp1` | `1 status:Status`, `2 device_proof:bytes`, `3 device_nonce:bytes` |

| Enum / APK class | Numeric values |
| --- | --- |
| SecScheme / `i92` | 0 SecScheme0, 1 SecScheme1, 2 SecScheme2 |
| Sec0Msg / `j62` | 0 S0_Session_Command, 1 S0_Session_Response |
| Sec1Msg / `l62` | 0 Session_Command0, 1 Session_Response0, 2 Session_Command1, 3 Session_Response1 |
| Sec2Msg / `n62` | 0 S2Session_Command0, 1 S2Session_Response0, 2 S2Session_Command1, 3 S2Session_Response1 |
| Status / `ir` | 0 Success, 1 InvalidSecScheme, 2 InvalidProto, 3 TooManySessions, 4 InvalidArgument, 5 InternalError, 6 CryptoError, 7 InvalidSession |

Security0 sends SecScheme0/Sec0Payload/sc, receives sr, then leaves
application bytes unchanged. Synthetic complete request: `52 03 A2 01 00`
(scheme and message enums are their zero defaults).

## Security1 handshake and cipher order

Evidence: `Security1.getStep0Request/getStep1Request`,
`processStep0Response/processStep1Response`, `encrypt/decrypt`, and `lw2`.

1. Generate fresh 32-byte Curve25519 private key `a` and public key `A`.
   Send SessionData `sec_ver=1`, `sec1.msg=0`, `sec1.sc0.client_pubkey=A`.
2. Receive `sec1.sr0.device_pubkey=B` and `device_random=IV`. Both public
   keys are the raw 32-byte Curve25519 representation, not PEM or hex.
   Compute `shared = X25519(a, B)`.
3. If proof of possession is nonempty, replace `shared` with
   `shared XOR SHA256(proofOfPossession.getBytes())`. Android's default
   string encoding is used by this constructor. Empty proof does not
   add an all-zero or empty-string hash.
4. Initialize **one** AES-256-CTR cipher with that 32-byte key and the
   device random as IV (`AES/CTR/NoPadding`, encryption mode). Encrypt
   `B` with `cipher.update`: these 32 bytes are `client_verify_data`.
5. Send SessionData `sec_ver=1`, `sec1.msg=2`,
   `sec1.sc1.client_verify_data=<ciphertext>`.
6. Receive `sec1.sr1.device_verify_data`, pass it through the same
   cipher's next `update`, and require equality with `A`.
7. Continue using that **same advancing CTR stream** for application
   request encryption and response decryption in actual exchange order.
   Neither method reinitializes the cipher or prepends a fresh IV.

`Session.init` recursively sends `getNextRequestInSession` output to
`prov-session`; a null next request means establishment is complete.
The code shares the cipher across directions, so independent transmit
and receive counters, resetting at the first application message or
parallel requests would not reproduce this client.

The private-key helper clamps the scalar for X25519 and uses base point
9. Shared key and IV are established at runtime; there is no fixed
Security1 AES key in this path. Authentication failure/error propagation
needs independent implementation review: some parse/crypto exceptions in
the inspected SDK are logged rather than consistently propagated.

## Security2: SRP and GCM as implemented in this APK

Evidence: `Security2`, `SRP6ClientSession.step2_for_client_evidence`,
`XRoutineWithUserIdentity`, `ClientSRP6Routines`, `SRP6Routines`,
`BigIntegerUtils` and `SRP6CryptoParams`.

1. Constructor calls SRP `step1(username, password)`; the password is
   the configured proof of possession. SRP uses the 3072-bit group,
   generator **5**, and SHA-512.
2. Send `sec_ver=2`, `sec2.msg=0`,
   `sc0.client_username=username.getBytes()` and
   `sc0.client_pubkey=A`, where `A=g^a mod N`.
3. Receive `sr0.device_pubkey=B` and `device_salt`. Validate
   `B mod N != 0`; derive SRP shared key and client proof `M1`.
4. Send `sec2.msg=2`, `sc1.client_proof=M1`.
5. Receive `sr1.device_proof=M2` and `device_nonce`. `step3` compares
   the server proof; the AES key becomes the first 32 bytes of the
   unsigned serialized SRP shared key `K`.

Exact byte arithmetic used by the default routines:

```text
H = SHA512
U(n) = unsigned big-endian integer bytes without leading zero bytes
PAD(n) = U(n) left-padded with zeroes to 384 bytes
I = UTF-8 username; P = UTF-8 password
s = U(unsigned_integer(device_salt))
k = unsigned_integer(H(PAD(N) || PAD(g)))
u = unsigned_integer(H(PAD(A) || PAD(B)))
x = unsigned_integer(H(s || H(I || ASCII(":") || P)))
S = (B - k * g^x)^(a + u*x) mod N
K = unsigned_integer(H(U(S)))
M1 = H((H(U(N)) XOR H(PAD(g))) || H(I) || s || U(A) || U(B) || U(K))
M2 = H(U(A) || U(unsigned_integer(M1)) || U(K))
```

The client transmits proofs after unsigned-integer serialization, so a
leading zero hash byte can disappear. The salt is likewise converted to
an unsigned integer and serialized again in this path. These details
matter when selecting a generic SRP implementation. `N` is the 3072-bit
modulus embedded in `SRP6CryptoParams.N_3072`, reproduced below.

```text
FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74
020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437
4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED
EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05
98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB
9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B
E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718
3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33
A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7
ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864
D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2
08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF
```

For every application encrypt/decrypt operation, `Security2` constructs
an AES key from those first 32 bytes and an `IvParameterSpec` from
the stored `device_nonce`, reinitializes `AES/GCM/NoPadding`, then calls
`doFinal`. The method contains **no nonce increment, transmitted nonce
prefix, AAD, or explicit tag-length setting**. It returns the provider's
GCM output directly; decryption supplies that output directly to
`doFinal`. Android-provider tag length, nonce acceptance and whether
real selected devices support this exact branch remain unverified.
Do not substitute an inferred nonce-counter protocol or describe this
APK behavior as a recommended encryption design.

## Wi-Fi configuration protobufs

| Class | Fields |
| --- | --- |
| `WifiConfig$WiFiConfigPayload` | `1 msg:ConfigMsg`; oneof `10 cmd_get_status:CmdGetStatus`, `11 resp_get_status:RespGetStatus`, `12 cmd_set_config:CmdSetConfig`, `13 resp_set_config:RespSetConfig`, `14 cmd_apply_config:CmdApplyConfig`, `15 resp_apply_config:RespApplyConfig` |
| `WifiConfig$CmdGetStatus` | Empty |
| `WifiConfig$CmdSetConfig` | `1 ssid:bytes`, `2 passphrase:bytes`, `3 bssid:bytes`, `4 channel:int32` |
| `WifiConfig$CmdApplyConfig` | Empty |
| `WifiConfig$RespSetConfig` | `1 status:Status` |
| `WifiConfig$RespApplyConfig` | `1 status:Status` |
| `WifiConfig$RespGetStatus` | `1 status:Status`, `2 sta_state:WifiStationState`; oneof `10 fail_reason:WifiConnectFailedReason`, `11 connected:WifiConnectedState` |
| `WifiConstants$WifiConnectedState` | `1 ip4_addr:string`, `2 auth_mode:WifiAuthMode`, `3 ssid:bytes`, `4 bssid:bytes`, `5 channel:int32` |

| Enum / APK class | Numeric values |
| --- | --- |
| ConfigMsg / `at2` | 0 TypeCmdGetStatus, 1 TypeRespGetStatus, 2 TypeCmdSetConfig, 3 TypeRespSetConfig, 4 TypeCmdApplyConfig, 5 TypeRespApplyConfig |
| WifiStationState / `ft2` | 0 Connected, 1 Connecting, 2 Disconnected, 3 ConnectionFailed |
| WifiConnectFailedReason / `et2` | 0 AuthError, 1 NetworkNotFound |
| WifiAuthMode / `dt2` | 0 Open, 1 WEP, 2 WPA_PSK, 3 WPA2_PSK, 4 WPA_WPA2_PSK, 5 WPA2_ENTERPRISE, 6 WPA3_PSK, 7 WPA2_WPA3_PSK |

`ESPDevice.sendWiFiConfig` builds the set-config request from SSID and
password bytes, then `applyWiFiConfig` applies it and
`pollForWifiConnectionStatus` queries status. Synthetic application
plaintext: get-status `52 00`; apply-config `08 04 72 00`.
These bytes must pass through the selected session cipher before the
`prov-config` transport call. The schema's additional BSSID/channel
fields are not proof that the Philips UI supplies them.

## Wi-Fi scan protobufs

| Class | Fields |
| --- | --- |
| `WifiScan$WiFiScanPayload` | `1 msg:ScanMsg`, `2 status:Status`; oneof `10 cmd_scan_start:CmdScanStart`, `11 resp_scan_start:RespScanStart`, `12 cmd_scan_status:CmdScanStatus`, `13 resp_scan_status:RespScanStatus`, `14 cmd_scan_result:CmdScanResult`, `15 resp_scan_result:RespScanResult` |
| `WifiScan$CmdScanStart` | `1 blocking:bool`, `2 passive:bool`, `3 group_channels:uint32`, `4 period_ms:uint32` |
| `WifiScan$RespScanStart` | Empty |
| `WifiScan$CmdScanStatus` | Empty |
| `WifiScan$RespScanStatus` | `1 scan_finished:bool`, `2 result_count:uint32` |
| `WifiScan$CmdScanResult` | `1 start_index:uint32`, `2 count:uint32` |
| `WifiScan$RespScanResult` | `1 entries:repeated_WiFiScanResult` |
| `WifiScan$WiFiScanResult` | `1 ssid:bytes`, `2 channel:uint32`, `3 rssi:int32`, `4 bssid:bytes`, `5 auth:WifiAuthMode` |

ScanMsg / APK `ht2`: 0 TypeCmdScanStart, 1 TypeRespScanStart,
2 TypeCmdScanStatus, 3 TypeRespScanStatus, 4 TypeCmdScanResult,
5 TypeRespScanResult. Status and authentication enums are shared above.

`ESPDevice.startNetworkScan`, `getFullWiFiList`, `getWiFiScanList` and
their response callbacks implement start/status/result paging through
`prov-scan`. Synthetic query-status plaintext is `08 02 62 00`.
No live scan, locale/SSID encoding edge case, SRP test vector or
Android crypto-provider comparison was executed in this analysis.
