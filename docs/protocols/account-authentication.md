# Home.ID / OneID authentication reconstruction

Static specification for the HomeCare 3.19.0 (112) APK identified in
[the inventory](README.md#sources-and-evidence), inspected 2026-10-26.
This supplements [DA cloud connections](da-iot-mqtt.md). The reconstruction
below is static evidence. Later authorized runtime checks completed account
login, token exchange, device discovery and read-only MQTT status; see
[Cloud setup and verification limits](../cloud.md). No device command was sent.
Class/method names below are artifact-specific evidence, not stable SDK APIs.

## Environment and public client configuration

Evidence: `classes2.dex`, `uz0.<init>`, its `wh1` implementation and
`uz0.getClientId`; `classes2.dex`, `tj0`.

Only an exact account-environment value `Production` selects production;
other values select acceptance. This account switch is separate from the DA
platform Testing/Staging/Production switch.

| Value | Production | Acceptance |
| --- | --- | --- |
| Public OAuth client ID | `-XsK7O6iEkLml77yDGDUi0ku` | `CmNYj6q1wBk-IEX38KRRkVVl` |
| OIDC base | `https://cdc.accounts.home.id/oidc/op/v1.0/4_JGZWlP8eQHpEqkvQElolbA` | `https://cdc.accounts.home.id/oidc/op/v1.0/4_iX8FG_ECkagDbamClfS7Fg` |
| Auth UI base | `https://www.accounts.home.id/authui` | `https://acc.accounts.home.id/authui` |

These client IDs are fixed application identifiers decoded from the distributed
APK, not personal credentials. No OAuth client secret is supplied by the
inspected authorization/code/refresh builders. This does not establish server
permission to register another redirect URI or use this client in an adapter.

| Method | Endpoint |
| --- | --- |
| `uz0.h` | OIDC base + `/authorize` |
| `uz0.f`, `uz0.c` | OIDC base + `/oauth/token` |
| `uz0.a` | OIDC base + `/userinfo` |
| `uz0.d` | Auth UI base + `/client/account` |
| `uz0.e` | Auth UI base + `/api/autologin` |
| `uz0.i` | Auth UI base + `/api/Account/self` |
| `uz0.l` | Auth UI base + `/api/Account/self/ConsentGrant` |
| `uz0.m` | Auth UI base + `/api/Consent` |

`uz0.j/k` both return `com.philips.air://loginredirect`. The external URI
handler `OneIdAuth.a` checks scheme `com.philips.air`, then host
`loginredirect` or `accounteditredirect`. The latter finishes account editing.
The exact same `j/k` callback configuration makes the legacy WebView path
`OneIdAuth.J` worth checking separately before reuse: its `j` check precedes
its `k` check. An Android callback is not a working ioBroker callback.

## Reproducing the decoded client identifiers

`tj0.b(s,n)` Base64-decodes `s`, converts the result to a string/characters,
adds `n` to each UTF-16 character modulo 65536 and returns the result.
The constructor takes `(encodedKey, encodedIV, shift)`: the key is
`Base64Decode(b(encodedKey,-shift))`; the IV is bytes of
`b(encodedIV,+shift)`. `tj0.h` Base64-decodes its argument and decrypts with
`AES/GCM/NoPadding`, a 128-bit tag, this key and this IV, without supplied AAD.
The GCM ciphertext has its 16-byte tag appended. These ASCII intermediates
make the app's default charset conversions unambiguous for these constants.

`tj0.f` creates the outer decoder with shift 35. `tj0.d` first decodes its
constructor arguments with `f`, then creates a second decoder with shift 51.
The resulting fixed decoder material is:

| Decoder | AES key (hex) | IV / nonce (ASCII, 16 bytes) |
| --- | --- | --- |
| `f` | `3e14544db37ec42a5df11ce1295d0de313803a9b18a2c8368f26c42f05f66336` | `X&BY5bEYgvUcxfh=` |
| `d` | `5aac93ab1bfdf14a545a4f078e527bb1265b76f7172b777f72f48b2bbcac753d` | `AdZY#K7GQ3bPbF9=` |

The `uz0.getClientId` ciphertexts, using decoder `d`, are:

```text
Production: CbImEfRB4oD93x55+5rcD3eTMCGUQZY3guW2tGlqfRLE/y8GSiHFcg==
Acceptance: Z4cbA6k4pdjP9jk53uizRQufJiaWJ6suc8XJWOBN4thlkAPw5xseiw==
```

An offline reproduction is `Base64Decode(ciphertext)` followed by AES-256-GCM
decryption using the `d` row. Both tag verifications succeeded and produced
the IDs above. A synthetic plaintext round-trip verified the decoder mechanics.
These keys unwrap distributed constants; they are not account tokens, MQTT
signatures, or an OAuth client secret. Fixed GCM nonces are observed app
obfuscation and must not be copied as a general credential-storage design.

## Additional shared APK decoders

The same `tj0` constructor and GCM mechanics also expose these fixed shared
constants. `tj0.c` lazily creates field `tj0.g` using shift 88; `tj0.e` creates
field `tj0.f` using shift 53. Both first unwrap their constructor arguments
with the outer `tj0.f(String)` decoder above. Do not confuse the overloaded
method names with the static instance-field names.

| Entry point / use | AES key (hex) | Key length | IV / nonce (ASCII) | IV length |
| --- | --- | --- | --- | --- |
| `tj0.c` / `tj0.j`, instance `g`, app database column read/write | `40dbb62c479c8759faddf98e0ea5ba6dab7671610e02f928` | 24 bytes (AES-192) | `MR6obSnB8mSFthr=` | 16 bytes |
| `tj0.e`, instance `f`, shared configuration including Gaoda-related app constants | `613a1bc8d70d2f0c3766c82d90134197529ec40f9dba37971ab7bb953e8d8e02` | 32 bytes (AES-256) | `e7CwUERuKJb6w&jg` | 16 bytes |

The earlier `f` and `d` decoder keys are each 32 bytes (AES-256), with 16-byte
IVs. Every GCM path here uses a 16-byte authentication tag, appended to the
ciphertext, and no supplied AAD. `tj0.i` is a separate AES/CBC/PKCS5Padding
reader using the `g` instance's key and IV; `tj0.c` itself calls the GCM reader
`h`. The presence of that compatibility method does not change the proven
`sb0` write/Cursor-read path described below.

Reproducible synthetic fixtures, plaintext UTF-8 `synthetic-storage-fixture`,
using the exact fixed material above (ciphertext + GCM tag, standard Base64):

```text
g / AES-192-GCM: vf1wkQPqqO06eQA7WqQCHrpERetGcMvQFffsfPOmBEheH/0qIptRHUw=
f / AES-256-GCM: CkwR6PvYH4YvKTWwCXHLVunwIDCXRRXdd6RJj9VZiRs3XBHudaJnoio=
```

Offline checks reconstructed both keys from the original wrapped literals,
asserted exact key/IV byte lengths, reproduced these authenticated ciphertexts,
decrypted them back to the synthetic plaintext and rejected a one-bit tag
modification. No private database or personal token was opened. These are
bundled obfuscation/storage constants, not evidence of a device-session key or
hardware-backed storage; their fixed nonce scheme must not be reused for new
credential storage.

## Interactive authorization and PKCE

Evidence: `classes.dex`, `OneIdAuth.r/s/u`, `cn.c/d/e/f`,
`OneIdAuth.a/b`, `OneIdAuth.z`, `OneIdAuth$g.a`.

1. `r` (WebView) or `s` (external browser/custom tab) generates a new verifier
   with `cn.d`, stores it in the `OneIdAuth.d` instance field, then calls `u`.
   The inspected storage is in memory; persistence of an in-flight verifier
   through process death has not been established.
2. `cn.d/e` uses 64 SecureRandom bytes. Android Base64 flags 11 mean URL-safe,
   no padding and no line wrapping; verifier length is 86 ASCII characters.
3. `cn.c` hashes the verifier's ISO-8859-1 bytes using SHA-256 and applies the
   same encoding. `cn.f` returns `S256` when SHA-256 exists, otherwise `plain`;
   the plain fallback is app behavior, not a recommendation.
4. `u` constructs the following browser GET. `D` forms `ui_locales` from the
   current locale as `language-country` (for example `de-DE`).

```text
<oidc>/authorize?client_id=<client ID>
  &code_challenge=<base64url(SHA256(verifier))>
  &code_challenge_method=S256
  &response_type=code
  &redirect_uri=com.philips.air://loginredirect
  &ui_locales=<language-country>
  &scope=<space-separated scopes, URL-encoded>
```

The scopes, in app order, are:

```text
openid email profile address offline_access DI.Account.read DI.Account.write
DI.AccountProfile.read DI.AccountProfile.write DI.AccountGeneralConsent.read
DI.AccountGeneralConsent.write DI.GeneralConsent.read subscriptions
profile_extended consents DI.AccountSubscription.read DI.AccountSubscription.write
```

`u` contains no `state` or `nonce` parameter and `b` reads only `code` and
`reason`; no state/nonce validation was identified in those methods. This is
an observed limit of the inspected flow. A new callback must validate its
expected redirect and correlate the authorization attempt; server acceptance
of such a client change is untested.

`b` forwards a nonempty code to the authorization callback unless `reason`
is `LOGOUT` (case-insensitive); missing/empty code or logout invokes the
completion callback. `W` starts `OneIdAuth$g`, which sends the following
form POST using `z` and `Q`:

```http
POST <oidc>/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=<client ID>&code=<authorization code>&grant_type=authorization_code&redirect_uri=com.philips.air://loginredirect&code_verifier=<original verifier>
```

The app concatenates code, redirect and verifier directly in `z`; it does not
call URLEncoder on each of them. An implementation should use a real form
encoder so special characters cannot alter fields. No Basic/client-secret
header is added by this code exchange task.

Synthetic deterministic PKCE fixture (bytes 0..63, never use as live verifier):

```text
verifier: AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw
challenge: wsNdZaf3VpLTsEDmR5gPk2C6xYVWxKb0xcaG3O6kX10
```

## Token response, profile and expiry

Evidence: `PHAccount.<init>(String)`, `PHAccount.a`, `OneIdAuth.G`,
`OneIdAuth$g.a`, `OneIdAuth$e.a`, `com.philips.ph.homecare.bean.c.p/q/l`.

| JSON member | PHAccount field | Meaning |
| --- | --- | --- |
| `token_type` | `b` | Parsed string; bearer headers are hard-coded separately |
| `access_token` | `d` | Account access token |
| `refresh_token` | `c` | Account refresh token |
| `id_token` | `e` | Identity token supplied to DA federated-user lookup |
| `expires_in` | `j` after conversion | Absolute expiry `nowMillis + expires_in * 1000` |

Strings use `optString`; expiry uses `optLong`. Thus absent members can become
empty strings/zero duration rather than a parse failure. Malformed JSON raises
an exception caught by the task. No JWT signature, issuer, audience or `exp`
validation is performed by this constructor; do not infer verified ID-token
claims merely from its successful parsing.

`PHAccount.a()` returns true when `expiry-now <= 60000` milliseconds, including
already expired tokens. DA token retrieval checks this 60-second margin on
use; no periodic refresh timer was found in this path. The persisted app bean's
separate `l()` checks `expiry <= now` without the margin; these are different
predicates and must not be conflated.

`OneIdAuth.G` GETs `/userinfo` with `Authorization: Bearer <access_token>`.
It fills name (`i`), picture (`h`) and email (`f`), falls back from empty name
to given/family name and then the email local part. Initial `OneIdAuth$g.a`
calls this helper, then GETs Auth UI `/api/Account/self` with bearer access
token and requires JSON string `uid` as account field `a`. A missing response,
missing required uid or exception returns null. The helper's nullable return
is ignored by the initial task, so profile enrichment failure alone is not
necessarily fatal if the subsequent account-self request succeeds.

## Refresh and persistence

Evidence: `OneIdAuth.U/y/L`, `OneIdAuth$e.a/b`, `dm1$a$a/$b`, their `$a`
callbacks, `sb0.i0/y0/J0`, app account bean `c.<init>(Cursor)/p/q`.

Refresh POST uses the same token endpoint and form content type:

```text
client_id=<client ID>&grant_type=refresh_token&refresh_token=<URL-encoded refresh token>&access_token=<URL-encoded access token>
```

Both tokens are encoded using `URLEncoder.encode(token,"utf-8")` by `y`.
The access-token field is explicitly part of this app's refresh form; do not
omit it based only on a generic OAuth example. `U` is synchronized, adds a
callback if absent and starts one AsyncTask only while no unfinished,
uncancelled refresh task exists. The completed task invokes queued callbacks
in reverse list order with the resulting account or null, then clears the list.

`OneIdAuth$e.a` parses a new PHAccount, calls profile enrichment and returns it;
its profile helper return is also ignored. It does not copy the old refresh
or ID token when the response omits them. The DA callbacks restore the old
account UID into the result, update the app bean using `p`, persist with
`sb0.y0`, then emit the requested access/ID token. All returned token fields
replace the previous values together with expiry; empty omitted fields can
therefore replace previously populated fields in the observed implementation.
Whether the provider always returns all fields is unknown.

SQLite table `t_user` contains `user_id`, `email`, `access_token`, `id_token`,
`refresh_token`, `expires`, `account_platform`, profile fields and login time.
`sb0.i0` transactionally deletes previous `V`/`P` platform rows and inserts a
new `V` account. `y0` transactionally updates tokens and expiry by UID, adding
nickname only when nonempty. `J0` separately updates email/name/avatar.
UID/email/tokens pass through `tj0.j` on write and `tj0.c` on Cursor read;
these use the shared `tj0.g` AES-GCM instance, not the OAuth `d` decoder.
This proves app-level encrypted columns with APK-bundled decoder material,
not hardware-backed secure storage. No private database was inspected.

## DA authentication wiring and recovery boundary

`dm1.h` passes concrete provider `dm1$a` through `mj1$b` into `mj1`.
`mj1.C` calls `IoTConnect.setAuthenticationProvider` before asking
`authenticationService.federatedUserId()`. The provider implements
`getAccessToken` and `getIdToken` through separate Rx Single subclasses.

Each reads current app account `App.t().q()`. Missing account or the app's
`UDIFakeEmpty` test flag produces `Failed to get Token`; `dm1$a.e` broadcasts
an authentication event and reports a RuntimeException. Otherwise it returns
the stored token when the forced-refresh flag is false and more than 60 seconds
remain. If forced or near expiry, it resets that flag and invokes `OneIdAuth.U`.
Null refresh results use the same error/broadcast route. Successful callbacks
restore UID and persist the new token set as described above. `mj1$b.a(boolean)`
allows the owning layer to mark the provider for refresh.

The DA SDK additionally defines `ClientAuthenticationFailureHandler`.
`ClientAuthenticationInterceptor.a` signs the initial REST request with access
token. For 401 and a configured failure handler it locks a mutex, reads the
provider token again, compares it with the failed token, clears the cached
MQTT signature and calls `refreshAccessToken` only if unchanged. It closes
the original response body and retries the original request once with the
selected token. This method does not loop over repeated 401 responses or
handle 403 identically. The inspected app provider registration proves token
supply; a concrete app registration of the separate optional failure handler
has not been established, so SDK capability must not be reported as guaranteed
app execution on every 401.

The DA platform UID is separately obtained from `POST user/self/get-id` with
JSON `idToken`; it is not automatically the Home.ID profile uid. MQTT signatures
come from `GET user/self/signature` and are cached against their matching access
token. See [cloud connection details](da-iot-mqtt.md#platform-identity-rest-authorization-and-mqtt-signature).

## Failure handling and implementation gaps

`OneIdAuth.Q` sets a 15000 ms connection timeout, POST form content type and
reads 200..299 responses as success. It consumes the error stream otherwise
and returns null; exceptions also result in null after cleanup. No read timeout
or structured OAuth error (`invalid_grant`, retry-after etc.) mapping is set
in this method. Refresh/code tasks catch exceptions and surface a null account;
they do not establish retry/backoff, permanent-login expiry or revocation policy.
The app logs URLs, bodies and PHAccount.toString (which includes tokens) in
some debug paths. Never copy that logging into an adapter.

A later authorized test accepted the registered mobile callback with this
adapter's PKCE/state, exchanged tokens and discovered an AC0651. A local proxy
prototype also intercepted the callback automatically. This is a runtime result
for one account, not a provider support commitment or permission to register
another callback.

Remaining proof: integrated HTTPS/Admin login, country and account migration
differences, other consent/sign-in paths, exact error responses,
refresh rotation and lifetime rules, logout/revocation behavior, process-death
recovery, optional SDK failure-handler registration, and live account/device
behavior. Public constants and offline fixtures make reconstruction repeatable;
they do not establish a working cloud integration or permission to reuse the
mobile client's server-side registration.
