# Documentation

Start with the [adapter README](../README.md#usage) for connection selection and
supported devices.

## Setup and device guides

| Guide | Scope |
| --- | --- |
| [Philips Cloud](cloud.md) | Browser login, certificates, automatic account-device discovery and verification limits |
| [CX3550/01](devices/cx3550.md) | Local CoAP setup, tested controls and read-only timer limitation |
| [CX7550/01](devices/cx7550.md) | Local CoAP setup, tested controls, timer, display and temperature |

HTTP and CoAP connect one local device per instance. Cloud discovers all account
devices and uses separate device object trees. Local model guides do not imply
Cloud compatibility.

## Technical reference

[Protocol inventory](protocols/README.md) contains app-derived authentication,
transport, provisioning and device-profile evidence. App observations and
synthetic tests are distinguished from verified hardware behavior.

The device guides also retain the observed CoAP register tables, firmware
identifiers and known undecoded fields.
