# Node-RED Home Automation

[![CI](https://github.com/avantics-hq/node-red-home-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/avantics-hq/node-red-home-automation/actions/workflows/ci.yml)

State-aware Node-RED controllers for reliable lighting and home-theatre automation.

**[View the smart-home programme and completed project records →](https://avantics-hq.github.io/node-red-home-automation/)**

Most home automations translate an event directly into a command. This package adds a deterministic control layer between them: it tracks desired and observed state, preserves manual control, confirms outcomes, retries bounded failures, and rejects stale work.

## What it solves

- **Occupancy without flicker:** combine PIR motion with optional presence sensing before changing room state.
- **Adaptive lighting with manual ownership:** calculate circadian brightness and colour temperature without immediately overwriting wall-switch changes.
- **Honest wall inputs:** preserve restart baselines while exposing unconfirmed, stale and unavailable physical-input evidence.
- **Reliable AV transitions:** coordinate AVR inputs, TV power, projector warm-up and cooldown, and motorised screens from observed state rather than blind toggles.
- **Honest source readiness:** model controllable, externally controlled, and unavailable playback sources without claiming success from an input selection alone.
- **Owned theatre atmosphere:** apply activity lighting only to active, non-manual room lights and confirm TV backlighting independently.
- **Bounded receiver volume:** coordinate absolute and relative requests through one transport owner while preserving later physical adjustments.
- **Recoverable automation:** adopt one fresh, uniquely matching physical activity after lost state; otherwise coordinate a safe Off request.

```mermaid
flowchart LR
  E[Events and requests] --> N[Node-RED adapter]
  N --> R[Deterministic reducer]
  R --> C[Semantic commands]
  C --> D[Device or transport]
  D --> O[Observed state]
  O --> N
  R --> S[Status and trace events]
```

## Included nodes

| Node | Purpose |
|---|---|
| `home-occupancy-fusion` | Combines PIR motion with optional presence sensing. |
| `home-motion-lighting-policy` | Converts occupancy and illuminance into lighting intent with observable wall-input baselines. |
| `home-switch-lighting-policy` | Converts raw edges or pre-classified button actions into lighting intent while exposing input freshness and availability. |
| `home-room-lighting-controller` | Owns adaptive room commands, manual overrides, and lighting state. |
| `home-avr-controller` | Owns AVR power, zones, source selection and bounded absolute or relative volume from observed state. |
| `home-display-mode-controller` | Coordinates TV, projector, and screen transitions. |
| `home-source-capability-controller` | Gates source readiness on fresh availability, active-device, application or playback evidence. |
| `home-activity-lighting-controller` | Applies activity styles without taking room power or manual ownership. |
| `home-backlighting-controller` | Owns TV-backlight power with observation-gated confirmation. |
| `home-theatre-activity-controller` | Owns latest-request-wins activity state and aggregates target evidence. |
| `home-theatre-state-contract` | Bridges non-retained activity requests to retained MQTT truth and HA discovery. |

Pure TypeScript policy modules live in `lib/`; thin Node-RED runtime and editor adapters live in `nodes/`.

Executable, deployment-neutral examples live in [`examples/`](examples/) and exercise the same reducers as the runtime adapters.

## Requirements

- Node.js 22.9 or newer
- Node-RED 5.0.x

## Install

In Node-RED, open **Manage palette → Install** and search for
`@avantics/node-red-home-automation`. Or install it from your Node-RED user
directory (usually `~/.node-red`) and restart Node-RED:

```sh
npm install @avantics/node-red-home-automation
```

Each [GitHub Release](https://github.com/avantics-hq/node-red-home-automation/releases)
also attaches the package tarball and its SHA-256 checksum. Install a downloaded
tarball through **Manage palette → Install → Upload module**, or with:

```sh
npm install /path/to/avantics-node-red-home-automation-2.0.3.tgz
```

Add the installed nodes from the Node-RED palette, then configure the room, device hosts, MQTT topics, source mappings, and timing limits for your deployment.

The whole-theatre MQTT contract uses non-retained requests at
`home/<area>/theatre/request`; every request supplies a unique `requestId` and an
explicit configured activity. Controller output is retained under `desired`,
`current`, `phase`, `failure`, `availability`, `metrics`, `slo`, and
`health/<target>`. Metrics expose transition latency and outcome counts plus
per-target retry, fallback, confirmation-latency, failure, manual-override, and
availability evidence. The SLO evaluator keeps a bounded outcome window,
publishes success rate plus p50/p95 transition latency, and exposes an
actionable Home Assistant problem sensor. Defaults are a 60-second transition
budget, 95% success objective, 20 outcomes and five samples before normal
evaluation; active timeouts and explicit failures breach immediately. Expected
`waiting_for_source` and physical manual ownership do not create false
operational failures. Retained request messages are deliberately inert.

MQTT state topics may be retained so controllers can rebuild observed state
after a restart. Command and request topics must not be retained. Raw wall-input
reducers preserve a persisted baseline but report it as unconfirmed until this
runtime receives an observation. Retained observations and messages marked
`msg.baseline = true` establish an inert baseline; duplicate observations
refresh freshness without replaying commands. When no baseline exists, a live
non-retained state change remains an actionable edge for event-only inputs.
Send source `switch-availability` to invalidate a disconnected input baseline;
the first recovered observation then re-baselines without a gesture. An
observation timestamp may be supplied as `msg.observedAt` or
`msg.payload.observedAt`; otherwise only live, non-retained observations receive
the current timestamp.

Unsolicited display, AVR, source, and backlighting changes latch manual
ownership instead of issuing corrective commands. A newer explicit activity
request resumes automation. Recovery adopts physical state only when fresh
display, AVR, source, and backlighting evidence matches exactly one configured
profile; missing or ambiguous startup evidence invokes the configured Off
activity.

## Room light control

The room lighting controller gives each target one control state:

- `in-control`: circadian lighting may style and refresh the light (the default).
- `overridden`: another owner, such as an activity or a scene, holds the light;
  refresh and circadian changes leave it alone until it is released.
- `manual`: a person changed the light.

Add `owner` to an intent to override the targets it switches on. With
`preserveManual: true`, manual lights are skipped:

```js
msg.lighting = {
  kind: "intent",
  targets: ["wall", "lamp"],
  state: "ON",
  source: "activity",
  owner: "theatre",
  values: {brightness: 64, color_temp: 400},
  preserveManual: true
};
```

Release overridden targets (default: all; with `owner`, only that owner's
lights). Released lights that are on are restyled as a refresh would:

```js
msg.lighting = {kind: "release", targets: ["wall", "lamp"], owner: "theatre"};
```

Switching a light off, from any source, returns it to `in-control`. On startup
and whenever a target's state changes, the controller sends a retained message
on its command output:

```js
{topic: "home/<area>/lighting/<target>/control", payload: {state: "overridden", owner: "theatre"}, retain: true}
```

Flows that filter that output by topic must pass the `/control` topics through.

## Receiver volume ownership

Send semantic requests to the AVR controller rather than publishing protocol
commands directly:

```js
msg.avr = {
  kind: "volume",
  requestId: "volume-control-1",
  mode: "relative",
  value: 1
};
```

`mode` may be `absolute` or `relative`. The controller resolves relative input
from fresh observed volume, accumulates rapid requests against the pending
target, applies configured half-step bounds, retries through the existing
bounded transport path, and confirms completion from fresh receiver evidence.
Once confirmed, it releases the volume target; a later physical or external
adjustment becomes the new baseline instead of being corrected.

## Contract examples

Build and run all seven public contracts:

```sh
npm run examples
```

| Example | Boundary demonstrated |
|---|---|
| [`occupancy-fusion.mjs`](examples/occupancy-fusion.mjs) | Motion establishes occupancy; optional presence can hold it. |
| [`motion-lighting.mjs`](examples/motion-lighting.mjs) | Occupancy and illuminance produce semantic lighting intent. |
| [`switch-gestures.mjs`](examples/switch-gestures.mjs) | Wall actions produce toggle or explicit manual-brightness intent. |
| [`room-lighting.mjs`](examples/room-lighting.mjs) | The room owner converts semantic intent into a transport command. |
| [`source-readiness.mjs`](examples/source-readiness.mjs) | Fresh application evidence confirms source readiness. |
| [`volume-ownership.mjs`](examples/volume-ownership.mjs) | Bounded relative requests accumulate and release ownership after fresh confirmation. |
| [`theatre-activity.mjs`](examples/theatre-activity.mjs) | Coordinated activity waits for fresh target-owner evidence. |

Each example uses synthetic identifiers and configuration, asserts its central invariant, and prints the complete input/output contract as JSON.

## Configuration and security

The repository contains no home-network addresses, deployment coordinates, or live credentials. Device hosts and room coordinates are required configuration where applicable.

The display controller stores its Bravia PSK as a Node-RED credential. Keep credentials in Node-RED's encrypted credential store rather than flow fields or repository files.

Report suspected vulnerabilities privately using the process in
[`SECURITY.md`](SECURITY.md), not through a public issue.

## Public repository boundary

This repository contains reusable controller code and general delivery status.
Live flows, private hostnames and IP addresses, Home Assistant entity IDs,
backup paths, credentials, and infrastructure operations belong only in the
private deployment repositories. `npm run scan:public` enforces the machine-
detectable parts of that boundary.

## Development

```sh
npm ci
npm test
npm run examples
```

The strict TypeScript build, compiled test suite, executable contract examples, dependency audit, public-content scan, and secret scan run in CI. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and the optional pre-commit setup.

## License

[MIT](LICENSE)
