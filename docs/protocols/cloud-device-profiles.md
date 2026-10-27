# Shared DA/NCP device profiles

Static evidence from the HomeCare APK in the [inventory](README.md#sources-and-evidence),
SHA-256 `1c79f75b7562eaa122abfadc44c41cad1462015ca21c3ec4f817e28e9105278c`.
No account or device communication was performed. This extends the
[AC0651 analysis](ac0651-control.md) for the general Cloud connection requested
during implementation. It is not a tested-device list.

## Family routing

`classes2.dex`, `mj1.p(oj0)` routes model prefixes into these classes.
All inherit `ri1 -> qi1 -> aj1`; Pico additionally inherits `hk1`.
Mode choices are declared in each concrete class's `n1()`.

| App route | Class | `Control.D0310C` modes |
| --- | --- | --- |
| AC0650 | `tj1` / Muji | Gentle 1, Sleep 17, Turbo 18 |
| AC0651 | `uj1` / Muji plus | Auto 0, Gentle 1, Sleep 17, Turbo 18 |
| AC17 prefix, including AC1715 | `yj1` / Nala | Auto 0, Speed 1 = 1, Speed 2 = 2, Sleep 17, Turbo 18 |
| AC0710, AC0720, AC0721 | `zj1` / Pico | Gentle **19**, Sleep 17, Turbo 18 |

`gw1.i()` supplies semantic key `gentle` with value 1; `gw1.j()` supplies
the same key with value 19. Auto/AutoPlus presentation does not change the
numeric Auto value here. These differences are mapping data, not transport
branches. Unknown CTNs retain the default table with controls gated by
reported properties. That is the requested fallback policy, not evidence that
every unknown CTN shares these modes: the app's remaining route selects
`ik1 -> aj1`, which does not establish these purifier controls.

## Shared operations

`ri1.Y(gw1)` writes mode `D0310C`; `ri1.a(gw1)` writes fan `D0310D`,
both through `aj1.u3(HashMap)` and the `Control` WRITE port. Power uses
shadow `powerOn` separately. AC0651 `uj1.N0()` lists fan 1, 2, 3 and 18;
Nala `yj1.N0()` lists 1, 2, 3, 4 and 18. The adapter reports fan speed
separately without inferring a universal fan-command list.

All four filter lists use reset keys `D0520D` and `D0540E`.
Shared readers `ri1.U3/T3` consume remaining/total pairs `D0520D/D05207`
and `D0540E/D05408` from `filtRd`. Reset copies the current valid total
into its matching remaining register through `filtWr`. No constant target
or counter unit is established by these methods.

## Conditional standby monitor

Shared `qi1.H1()` reads `D03134`; `qi1.J1(boolean)` writes integer 1/0
through `aj1.u3`. The adapter exposes this control only after receiving a
valid reported 0/1 property. Inherited getter defaults do not establish support.

`AirSettingsActivity.onCheckedChanged` binds `philipsSetting_monitoring_id`
to `J1`, separately from `philipsSetting_standby_display_id -> V` (`D03133`).
Its `m2` initializes monitoring through `H1` only when presenter `m7.A()` is
true; that inspected method returns false unconditionally. No enabling
presenter override was proven. Actual AC0651 firmware/UI support remains open.

## Capability discovery boundary

The SDK exposes `GET device/{id}/capabilities?proposition={ctn}&version={firmware}`.
`iot.l$b` decodes the result as a string. A completed scan across all three DEX
found zero direct `getDeviceCapabilities` calls. Reflection/dynamic callers are
outside that result. No automatically consumable property schema, labels or
command ranges have been established, so that endpoint cannot yet replace the
mapping tables.

Reproduction artifacts remain private under `tmp/apk-cloud-profiles/`:
`profiles.py/profiles.txt`, `extra.py/extra.txt`, `capabilities.txt`, `standby.txt`.
Published documentation does not require those working files.
