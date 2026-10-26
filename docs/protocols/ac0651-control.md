# AC0651 application schema

Static reconstruction of the AC0651 control path in the APK identified in
[connection sources][]. This describes app code, not a firmware specification
or a completed adapter implementation. No device/account communication was
performed. Obfuscated symbols apply only to that APK.

## Model and transport selection

In `classes2.dex`, `oj0.b(Device)` copies `Device.getCtn()` into inherited
field `la.e`; the JSON constructor obtains the same field from `ctn`.
`mj1.p(oj0)` checks that model string against `AC0651` and constructs `uj1`
with the application's `IoTConnect` instance. The class chain is:

```text
uj1 (MUJI plus) -> ri1 (AirPurifier) -> qi1 -> aj1
aj1 -> IoTConnect.getRemoteClient() -> DaIoTRemoteControlClient
```

The concrete cloud/MQTT wiring, authentication and message envelopes are
documented in [DA IoT cloud][]. This branch does not establish an AC0651
local CoAP interface. AC0650 has a separate `tj1` branch.

## Port ownership and state flow

`aj1.<init>` defines the following case-sensitive names. A port's properties
are a map; D-code values in the methods below are JSON numbers converted with
Java `Number.intValue()`. They are not strings or wire booleans unless stated.

| Port | App use | Source |
| --- | --- | --- |
| `Config` | Received port cached as `aj1.H`; metadata/configuration | `aj1.j3`, `aj1.P` |
| `Status` | Received port cached as `aj1.I`; all D-code status getters below | `aj1.j3`, `aj1.V2` |
| `devRd` | Received port cached as `aj1.K`; distinct from `Status` | `aj1.<init>`, `aj1.j3` |
| `Control` | WRITE `PortInfo` cached as `aj1.G`; normal D-code commands | `aj1.<init>`, `aj1.u3` |
| `filtRd` | READ `PortInfo` `aj1.E`; received port `aj1.J` | `aj1.<init>`, `aj1.H2`, `aj1.R2` |
| `filtWr` | WRITE `PortInfo` `aj1.F`; filter resets | `aj1.<init>`, `aj1.Q2`, `qi1.t0` |

These names are SDK port names, not independent network endpoints.
`aj1.E2()` requests `allPorts`; `aj1.d3()` requests `allReadablePorts`.
`aj1.f3()` subscribes with `observePort` for supplied port definitions.
`aj1.j3(Port)` merges properties into a combined cache, updates the dedicated
port cache, and invokes the model's `o3(Port)` hook. `uj1.o3` refreshes sensor
presentation only when the received name equals `Status`.

`aj1.u3(properties)` calls `setPort(device, Control/WRITE, properties)` and
subscribes to completion/error callbacks. It does not assign those properties
to the local `Status` cache. A completed command therefore must not be treated
as a newly observed device state. Filter reset uses a separate call with
`filtWr/WRITE`.

`aj1.C2()` starts the connection-state observer (`l3`) and device-state
observer (`m3`) when its local connection state is initially disconnected.
Their Rx timeouts are one and two minutes respectively. `f3` applies a
two-minute timeout to each port observation and keeps subscriptions by port
name. `aj1.D2()` resets the local connection flag, removes handler messages,
disposes the stored connection/device/read subscriptions, clears pending-post
disposables and disposes the per-port subscriptions. These are app observer
lifecycle rules; they do not establish device keepalive timing. Retry helpers
and callbacks also participate, so the timeouts alone are not a complete
reconnect policy.

## AC0651 mode and fan commands

These choices are explicitly defined by `uj1`, rather than merely inherited
from a generic appliance class. Examples below are the properties passed to
`setPort`, not complete MQTT messages.

| Setting | `Control` property | Numeric value | Source |
| --- | --- | --- | --- |
| Auto | `D0310C` | `0` | `uj1.n1`, `uj1.J3`, `ri1.Y` |
| Gentle/medium label | `D0310C` | `1` | `uj1.n1`, `gw1.i`, `ri1.Y` |
| Sleep | `D0310C` | `17` | `uj1.n1`, `ri1.Y` |
| Turbo | `D0310C` | `18` | `uj1.n1`, `ri1.Y` |
| Fan level 1 / 2 / 3 | `D0310D` | `1` / `2` / `3` | `uj1.N0`, `ri1.a` |
| Fan turbo | `D0310D` | `18` | `uj1.N0`, `ri1.a` |

```json
{"D0310C":17}
```

```json
{"D0310D":2}
```

`ri1.m0()` reads the reported mode from `Status.D0310C`; `ri1.z1()` reads
the reported fan value from `Status.D0310D`. Both accept `Number` and compare
its integer value with the choice list. Unknown values are retained in fallback
choice objects (`ri1.V3`, `ri1.W3`), not silently mapped to Auto.
The fan-level command does not also send a mode field in this code path.

## Power is a shadow boolean

`qi1.M(boolean)` constructs `ControlCommand.UpdatePowerState` and calls
`publishDeviceCommand`. Its constructor serializes this desired-state shape:

```json
{"state":{"desired":{"powerOn":true}}}
```

The status reader `qi1.D()` reads
`DeviceState.reported.powerOn`, returning `false` when the state/reported
object is absent. Power is not implemented as a `D03102` port write in this
class chain. The command's desired boolean and the device's reported boolean
are separate values.

## Sensors and filter state

| Reported location | Meaning established by app | Conversion / absent value | Source |
| --- | --- | --- | --- |
| `Status.D03120` | Indoor allergen index (`iaql`, label `/12`) | Integer; missing/non-number becomes `0` | `qi1.b1`, `qi1.S3`, `PHAirReading.h` |
| `Status.D03221` | PM2.5, app unit resource `unit_ugm3_text` (µg/m³) | Integer; no decimal scaling; missing/non-number becomes `0` | `qi1.c1`, `qi1.S3`, `PHAirReading.i` |
| `Status.D03240` | Status/error bit field | Integer; missing/non-number becomes `0` | `qi1.O0`, `qi1.l0`, `ri1.U3` |
| `filtRd.D05207` | Cleaning filter total counter | Integer passed as total | `ri1.U3` |
| `filtRd.D0520D` | Cleaning filter remaining counter | Integer passed as remaining | `ri1.U3` |
| `filtRd.D05408` | Replacement filter total counter | Integer passed as total | `ri1.T3` |
| `filtRd.D0540E` | Replacement filter remaining counter | Integer passed as remaining | `ri1.T3` |

`uj1` selects PM2.5 as the primary displayed reading and orders its readings
PM2.5, then allergen index. `qi1.S3` stores the raw integer for each. The
allergen presentation helper `a5.c` treats `0` as no value; its nonzero bands
are `<4` good, `<7` fair, `<10` poor and otherwise very poor. Its normalized
gauge value is `index / 12`. PM2.5 keeps its raw concentration; its gauge can
use a runtime calibration list from `kk1.o`, and its quality text/color are
copied from the allergen reading. Those gauge values are presentation data,
not another physical measurement or a fixed PM2.5 conversion.

`PHFilter.g(total, remaining)` disables the filter's available-value flag
when `total == 0` or `remaining == 65535`. Otherwise it stores both counters
and calculates `ceil(100 * remaining / total)` as the displayed percentage.
This code does not establish a seconds-to-hours conversion. Counter units and
actual firmware ranges still need a device fixture; the adapter's existing
hour-based mapping is separate evidence.

`qi1.l0` tests `(error & 32781) == 32781` or
`(error & 32782) == 32782`. `ri1.U3` flags a cleaning-filter condition when
`(error & 193) == 193` or `(error & 49153) == 49153` and passes that flag,
remaining counter and filter to `kk1.v`. Individual bit meanings cannot be
deduced from those compound tests alone. `ri1.T3` passes replacement remaining
counter and filter to `kk1.d`; its error-argument parameter is not used.

## Filter reset commands

`uj1.getFilters()` constructs a cleaning filter (type `1`, initial total
`360`, reset key `D0520D`) and a replacement filter (type `2`, reset key
`D0540E`). `PHFilter` selects clean/replace label resources from those types.
When `filtRd` is available, `ri1.U3/T3` update the totals from `D05207/D05408`.

`qi1.t0(filter)` sends `{filter.v: filter.e}` to `filtWr`, where `v` is the
reset key and `e` is the current total. It does not send `0` or `true`:

```text
Cleaning:    filtWr properties = {"D0520D": current D05207 total}
Replacement: filtWr properties = {"D0540E": current D05408 total}
```

The initial cleaning total `360` is a constructor default, not a verified
universal reset value. The replacement filter has no explicit nonzero default
in this constructor. A consumer must obtain valid filter state before reset
and confirm the resulting reported counters separately. The app's generic
reset method itself does not enforce that prerequisite.

## Other inherited fields: exact operations, limited model proof

The methods below exist in the AC0651 inheritance chain. Their existence does
not establish that AC0651 firmware supplies every field, or that its UI exposes
every setter. Names not independently identified remain method names here;
semantics from another model must not be transferred automatically.
All writes below target `Control` through `aj1.u3`.

| Property | Report reader in `qi1` | Command method and exact conversion |
| --- | --- | --- |
| `D03103` | `A1`: true exactly when numeric integer is `1`, otherwise false | `G(boolean)`: integer `1` or `0` |
| `D03104` | `K1`: integer, default `0`; `b2`: true exactly for integer `1` | `g0(boolean)`: `100` or `0`; `z(int)` writes the integer plus `D03105=0` if zero, otherwise `100` |
| `D03110` | `N1`: integer, default `0` | `d1(int)`: unchanged integer |
| `D0312A` | `ri1.U0` looks up its integer in `A0()` choices | `ri1.g1`: selected choice value; `qi1.A0()` returns null for this chain |
| `D0312C` | `p1`: finds value in `[1,4,7,10]` and returns 1-based position; unmatched becomes `1`, absent port becomes `0` | `H0(position)`: writes `[1,4,7,10][position-1]`; no local bounds guard |
| `D03130` | `M0`: integer, default `0` | `v(int)`: unchanged integer |
| `D03133` | `f0`: true for integer `1`; no port/properties defaults true, missing/non-number field defaults false | `V(boolean)`: integer `1` or `0` |
| `D03134` | `H1`: same boolean/default rules as `f0` | `J1(boolean)`: integer `1` or `0` |
| `D03135` | `g`: integer, default `0` | `F1(int)`: unchanged; `o1(int,int)`: same first integer and adds `D03137` only if second argument is positive |
| `D03136` | `aj1.k0`: integer, default `0` | No dedicated setter found in this chain |
| `D03137` | `z0`: integer, default `0` | Through `o1`, as above |
| `D0313F` | `P0`: integer; non-number field `-1`, absent port/properties `0` | No setter found in this chain |
| `D03211` | `Z1`: integer, default `0` | No setter found in this chain |

`aj1.n()` checks only whether `Status` contains key `D03115`; it does not
decode its value. `aj1.i(key,value)` is also a generic one-property writer to
`Control`; its existence does not establish support for arbitrary keys.

The `D03104` reader/setter difference (`1` versus `100`) is preserved from
the bytecode. It must not be normalized into a claimed symmetric boolean
contract without firmware evidence. `qi1.Y0` also defines presentation choices
`0,25,50,75,100`; it does not prove which AC0651 firmware property accepts
each value. `qi1.B0` tests `D0310C == 49`, while `F0` compares its raw value
with string `"M"`; neither value appears in the AC0651 choice list above.

## Evidence and remaining boundaries

All class/method evidence above comes from `classes2.dex`, including
`io.airmatters.philips.model.PHFilter`, `PHAirReading`, `gw1`, `a5` and
`com.philips.cl.daconnect.device_control.model.remote.ControlCommand$UpdatePowerState`.
Extraction retained complete method instruction sequences, not string matches
alone. Local working dumps are `tmp/apk-model-analysis/{route,parents,fields}.txt`;
they are not distribution files or permanent documentation dependencies.

The inspected methods establish consumed keys and constructed commands, not
a complete server/device JSON schema. Additional properties can exist in
runtime port maps. Unknown fields should remain observable until sanitized
fixtures establish type, unit, range and firmware-specific meaning. No local
transport, physical effect, reset outcome, regional calibration payload or
long-term behavior has been verified.

[connection sources]: README.md#sources-and-evidence
[DA IoT cloud]: da-iot-mqtt.md
