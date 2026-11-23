# Node-RED Home Automation

[![CI](https://github.com/avantics-hq/node-red-home-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/avantics-hq/node-red-home-automation/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-0969da)](https://avantics-hq.github.io/node-red-home-automation/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/avantics)

State-aware Node-RED controllers for reliable lighting and home-theatre automation.

**[View the smart-home programme and completed project records →](https://avantics-hq.github.io/node-red-home-automation/)**

Most home automations translate an event directly into a command. This package adds a deterministic control layer between them: it tracks desired and observed state, preserves manual control, confirms outcomes, retries bounded failures, and rejects stale work.

> [!NOTE]
> **Under active development.** This package is changing quickly. Versions follow semver, but an update can
> still change behaviour in ways that aren't marked as breaking. Read the release notes before updating, pin the
> version you run, and check your flows after each update.

## What it solves

- **Occupancy without flicker:** combine PIR motion with optional presence sensing before changing room state.
- **Circadian lighting with manual ownership:** calculate circadian brightness and colour temperature without immediately overwriting wall-switch changes.
- **Honest wall inputs:** preserve restart baselines while exposing unconfirmed, stale and unavailable physical-input evidence.
- **Reliable AV transitions:** coordinate AVR inputs, TV power, projector warm-up and cooldown, and motorised screens from observed state rather than blind toggles.
- **Honest source readiness:** model controllable, externally controlled, and unavailable playback sources without claiming success from an input selection alone.
- **Owned theatre atmosphere:** apply activity lighting only to active, non-manual room lights and confirm TV backlighting independently.
- **Bounded receiver volume:** coordinate absolute and relative requests through one transport owner while preserving later physical adjustments.
- **Recoverable automation:** adopt one fresh, uniquely matching physical activity after lost state; otherwise coordinate a safe Off request.

![Architecture diagram. Inputs (wall switches, motion and presence sensors, illuminance, and theatre requests over MQTT) feed two groups of nodes. Room lighting: occupancy-fusion, motion-lighting-policy and switch-lighting-policy feed room-lighting-controller, which sends set commands to the lights (for example Zigbee2MQTT) and reads back their observed state. Theatre activities: theatre-state-contract passes activity intents to theatre-activity-controller and publishes retained theatre state and Home Assistant discovery; your flow routes each theatreCommand by target to the theatre equipment controllers (AVR, display mode, source capability, backlighting), which command the devices, or to activity-lighting-controller, which holds room lights; both report target state back to the activity controller.](https://avantics-hq.github.io/node-red-home-automation/images/architecture.svg)

Each controller keeps the desired and the observed state, sends semantic
commands, and reports done only when fresh observations confirm them.

## Included nodes

The nodes come in three groups. Each group has an importable example flow
(**Import → Examples** in the Node-RED editor).

### Room lighting

Motion, presence, illuminance and wall switches drive one room's lights, with
circadian styling and manual ownership. Wire occupancy fusion into the motion
policy, wall switches into the switch policy, and both policies into the room
controller. The room controller keeps a light a person set after the room went
vacant, so motion doesn't switch it straight off. Circadian
levels follow the room controller's wake and bed times (default 07:00 and
23:00): they rise over the hour after waking, stay bright and cool through the
day, and wind down to the sleep settings over the three hours before bed. Times
are the Node-RED host's local time.
Example: [`Room lighting.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Room%20lighting.json).

| Node | Purpose |
|---|---|
| `home-occupancy-fusion` | Combines PIR motion with optional presence sensing. |
| `home-motion-lighting-policy` | Converts occupancy and illuminance into lighting intent. A `delay` message (in seconds) or `illuminance-cut-off` message overrides its settings until they are changed and redeployed. |
| `home-switch-lighting-policy` | Converts raw edges or pre-classified button actions into lighting intent while exposing input freshness and availability. |
| `home-room-lighting-controller` | Owns the room's light commands, adaptive styling, manual and held lights, and lighting state. |

### Home theatre equipment

Each controller owns one kind of device. It accepts a generation-scoped intent,
sends commands for your device transport on output 1, and reports target state
on output 2. Example: [`Home theatre equipment.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Home%20theatre%20equipment.json).

| Node | Purpose |
|---|---|
| `home-avr-controller` | Owns AVR power, zones, source selection and bounded absolute or relative volume from observed state. |
| `home-display-mode-controller` | Coordinates TV, projector, and screen transitions. |
| `home-source-capability-controller` | Gates source readiness on fresh availability, active-device, application or playback evidence. |
| `home-backlighting-controller` | Owns TV-backlight power with observation-gated confirmation. |

### Theatre activities

One request, such as "tv" or "off", drives every target. The state contract
turns MQTT requests into activity intents and publishes retained state; the
activity controller plans each target and sends `msg.theatreCommand` messages.
Your flow routes each command by its `target` (`avr`, `display`, `source`,
`lighting`, `backlighting`) to the matching controller's input
(`msg.avr`, `msg.display`, `msg.sourceCapability`, `msg.activityLighting`,
`msg.backlighting`); the example does this with one switch node and a change
node per target. Every controller reports its progress on output 2 as
`msg.theatre = {kind: "target_state", target, requestId, generation, status,
observedAt}`, alongside its own events: wire each controller's output 2 straight
back to the activity controller. The activity controller refreshes settled
targets, and each controller answers a refresh from fresh readings. Activity
lighting feeds the room lighting controller.
Example: [`Home theatre activity.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Home%20theatre%20activity.json).

| Node | Purpose |
|---|---|
| `home-theatre-state-contract` | Bridges non-retained activity requests to retained MQTT truth and, optionally, HA discovery. |
| `home-theatre-activity-controller` | Owns latest-request-wins activity state and aggregates target evidence. |
| `home-activity-lighting-controller` | Applies activity styles to room lights and holds them while the activity is active. |

Pure TypeScript policy modules live in `lib/`; thin Node-RED runtime and editor adapters live in `nodes/`.

Importable example flows for the Node-RED editor live in [`examples/`](https://github.com/avantics-hq/node-red-home-automation/tree/main/examples) (**Import → Examples**). Executable, deployment-neutral contract examples live in [`contract-examples/`](https://github.com/avantics-hq/node-red-home-automation/tree/main/contract-examples) and exercise the same reducers as the runtime adapters.

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
npm install /path/to/avantics-node-red-home-automation-3.0.0.tgz
```

Add the installed nodes from the **home automation** section of the Node-RED palette, then configure the room, device hosts, MQTT topics, source mappings, and timing limits for your deployment.

### Upgrading from 2.x

Version 3.0 changes some behaviour. Check these after upgrading:

- **Wall switches go through the switch lighting policy node.** The motion lighting policy no longer handles them,
  and ignores switch messages, so rewire any wall switch that feeds a motion node. The room lighting controller now
  keeps a light that a person set after the room went vacant, instead of the motion node.
- **The motion node's `delay` message takes seconds,** the same unit as its "Vacancy seconds" setting; it took
  minutes before. A redeploy with a changed vacancy delay or lux cutoff now takes effect.
- **Settings are checked when you deploy.** An emptied or unusable setting shows "invalid configuration", and the
  node's log says which setting is wrong. A setting your flow saved before it existed still takes its default.
- **No node assumes a room.** An empty area is allowed. A node that publishes needs one where it names something:
  the theatre state contract for its default base topic (`home/<area>/theatre`), and a room lighting controller for
  the topics it publishes. A theatre state contract added from now on doesn't need one for Home Assistant
  discovery: its entity IDs and suggested area come from its display name. One saved before needs an area for
  discovery, as before. A room lighting controller with no area still controls its lights, but publishes no state
  or discovery.
- **MQTT state publishing and Home Assistant discovery are opt-in** on the room lighting controller and the theatre
  state contract. New nodes start with them off. Nodes in a flow saved before 3.0 keep publishing until you untick
  the setting. Switching discovery off removes the entities from Home Assistant.
- **Discovery** goes under the **Discovery prefix** setting (`homeassistant` by default, as in Home Assistant) on
  both nodes, and every entry names this package and its version as its origin. Topics and IDs use the area in
  lowercase, with each run of spaces or other characters (anything but letters, digits, `_` and `-`) as `_`:
  "Living Room" publishes under `home/living_room/…`, and "living-room" is unchanged.
  Names shown in Home Assistant keep the area as you typed it.
- **Entity names.** A room lighting controller or theatre state contract you add from now on names its Home
  Assistant device, unique IDs and discovery topics after its Node-RED node ID (`nrha_<node id>…`), so renaming its
  area or display name updates the same entities. Nodes in flows saved before this keep naming them after the area,
  exactly as before, so nothing changes for them in Home Assistant. Either way, the entity ID Home Assistant first
  gives an entity comes from the area, with `-` as `_`.
  Importing a node in the editor, including Import > Replace (which keeps the node's ID), sets it up as a new node,
  so an older node brought in that way switches to node-based IDs at its next start: its area-named entities are
  removed and new ones created with the same entity IDs, keeping their history but not changes made to them in Home
  Assistant (name, area, icon).
- **Occupancy fusion can publish too**, off unless you switch it on: its occupancy as retained `ON`/`OFF` on
  `home/<area>/occupancy/state`, with availability, and an occupancy binary sensor in Home Assistant. These go on its
  new second output, so wire that to an MQTT out node; the first output still feeds the motion policy.
- **The motion lighting policy can publish too**, off unless you switch it on: whether this node's motion lighting
  is enabled and its vacancy delay in seconds (`home/<area>/motion/enabled/state` and `…/delay/state`), which it also
  takes from their `/set` topics, and a switch and a vacancy delay number in Home Assistant. These go on its new
  second output; the shared global enable is not published.
- **Topics no longer published are cleared.** Once the flows have started, and again at its startup message, a node
  clears any retained topic it published before and no longer does, for example after an area, base topic,
  discovery prefix or target change. It remembers what it published in its node context, which lasts across deploys;
  it lasts across a Node-RED restart only if your default context store is persistent.
- **Removing entities:** deleting a node clears its Home Assistant entities and retained state, but only when you
  deploy with "Modified nodes" or "Modified flows". On a full deploy (the deploy button's default), Node-RED stops the
  MQTT out node at the same moment, so the clearing never reaches the broker. Disabling a node or its flow keeps its
  entities, so they come back unchanged when you enable it again. To remove a node's entities after a full deploy,
  or to remove the entities of a flow you copied to another Node-RED (the copy's nodes have new IDs, so new
  entities), delete the device in Home Assistant: Settings → Devices & services → Devices, open the device, then
  Delete. Home Assistant then clears its retained discovery entry itself.
- **Availability:** each publishing node sends a retained `online` once the flows have started (and again at its
  startup message) and `offline` when it stops, on `home/<area>/lighting/availability` (room) or
  `<base>/availability` (theatre), and its Home Assistant entities follow it. These get through when the node is
  deployed on its own ("Modified nodes" or "Modified flows"), while the MQTT connection stays up. On a full deploy, a
  restart or a shutdown, Node-RED stops the MQTT out node at the same moment and reconnects to the broker afterwards,
  so set the MQTT broker node's **Birth message** to `online`, and its **Close message** and **Will message** (which
  covers crashes) to `offline`, all retained, on the same topic; with several publishing nodes, the broker can cover
  one of them. The theatre's readiness (`unknown`, `available`, `degraded`
  or `unavailable`), which used `<base>/availability` before, is now on `<base>/readiness`.

The whole-theatre MQTT contract uses non-retained requests at
`home/<area>/theatre/request`; every request supplies a unique `requestId` and an
explicit configured activity. Controller output is retained under `desired`,
`current`, `phase`, `transition` (when the latest transition started and finished, and which
targets it left degraded), `failure`, `readiness`, `metrics`, `slo`, and `health/<target>`. Metrics expose transition latency and outcome counts plus
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
the current timestamp. Across all controllers, an observation time more than one
second ahead of Node-RED's clock is treated as observed on receipt and traced as
`clock-skew`, so one device with a wrong clock cannot hold back later reports.

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

`home-activity-lighting-controller` does this itself: while a profile is active
it overrides that profile's lights under its configured owner (default
`activity`), and when a new profile drops a light, including an off profile
with no targets, it releases it. Give each activity-lighting node that feeds the
same room controller its own Owner; with a shared name, one node's release
hands back lights the other still holds. A flow that sets its own `owner` must
set it on every lighting message from the node, releases included, or leave it
to the node's Owner setting.

Release overridden targets (default: all; with `owner`, only that owner's
lights). Released lights that are on are restyled as a refresh would:

```js
msg.lighting = {kind: "release", targets: ["wall", "lamp"], owner: "theatre"};
```

A held (`overridden`) light changes only for an intent with an `owner` (its own,
or a newer owner who takes it over), a person (`manual: true`, an external
command on the command topic, or a change seen at the light), or a release.
Other intents, such as motion ON or OFF and owner-less values, leave it alone
and are traced as `ignored held-by`; their other targets are still handled.
The switch policy marks presses with `person: true`. Owner-less
intents, with or without values, reach a held light only with `manual: true` or
`person: true`; a flow acting for a person, such as a dashboard, sets one.
Switching a light off by its owner or a person returns it to `in-control`. With
**Publish state over MQTT** on (new nodes start with it off; nodes saved before
the setting existed keep it on), on startup and whenever a target's state
changes, the controller sends a retained message on its command output:

```js
{topic: "home/<area>/lighting/<target>/control", payload: {state: "overridden", owner: "theatre"}, retain: true}
```

Flows that filter that output by topic must pass the `/control` topics through.
It also publishes the circadian state on `home/<area>/circadian/state`, and
acts on ON or OFF sent to `home/<area>/circadian/set`, which is where the Home
Assistant circadian switch sends them: wire an MQTT in node subscribed to that
topic into the room controller. In the same way it publishes and acts on sleep
(`home/<area>/sleep/state` and `/set`, ON or OFF) and the wake and bed times
(`home/<area>/wake-time/state` and `/set`, likewise `bed-time`, as `HH:MM:SS`);
subscribing to `home/<area>/+/set` covers all four. A time set from Home
Assistant lasts until the node is deployed with a different setting for it.
With discovery on, Home Assistant also gets a sleep switch, wake and bed time
entities (under the device's configuration), and a diagnostic sensor per light
showing its control state, with the owner as an attribute.

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
adjustment becomes the new baseline instead of being corrected. A request still pending when Node-RED restarts is reported as
`volume_failed` with reason `restart`, not replayed.

## Contract examples

Build and run all seven public contracts:

```sh
npm run examples
```

| Example | Boundary demonstrated |
|---|---|
| [`occupancy-fusion.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/occupancy-fusion.mjs) | Motion establishes occupancy; optional presence can hold it. |
| [`motion-lighting.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/motion-lighting.mjs) | Occupancy and illuminance produce semantic lighting intent. |
| [`switch-gestures.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/switch-gestures.mjs) | Wall actions produce toggle or explicit manual-brightness intent. |
| [`room-lighting.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/room-lighting.mjs) | The room owner converts semantic intent into a transport command. |
| [`source-readiness.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/source-readiness.mjs) | Fresh application evidence confirms source readiness. |
| [`volume-ownership.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/volume-ownership.mjs) | Bounded relative requests accumulate and release ownership after fresh confirmation. |
| [`theatre-activity.mjs`](https://github.com/avantics-hq/node-red-home-automation/blob/main/contract-examples/theatre-activity.mjs) | Coordinated activity waits for fresh target-owner evidence. |

Each example uses synthetic identifiers and configuration, asserts its central invariant, and prints the complete input/output contract as JSON.

## Configuration and security

The repository contains no home-network addresses, deployment coordinates, or live credentials. Device hosts and room coordinates are required configuration where applicable.

The display controller stores its Bravia PSK as a Node-RED credential. Keep credentials in Node-RED's encrypted credential store rather than flow fields or repository files.

Report suspected vulnerabilities privately using the process in
[`SECURITY.md`](https://github.com/avantics-hq/node-red-home-automation/blob/main/SECURITY.md), not through a public issue.

## Development

```sh
npm ci
npm test
npm run examples
```

The strict TypeScript build, compiled test suite, executable contract examples, dependency audit, public-content scan, and secret scan run in CI. See [CONTRIBUTING.md](https://github.com/avantics-hq/node-red-home-automation/blob/main/CONTRIBUTING.md) for local checks and the optional pre-commit setup.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](https://github.com/avantics-hq/node-red-home-automation/blob/main/CONTRIBUTING.md) and the
[Code of Conduct](https://github.com/avantics-hq/node-red-home-automation/blob/main/CODE_OF_CONDUCT.md).

## Inspiration and thanks

- [Node-RED](https://nodered.org): the platform these nodes run on.
- [Home Assistant](https://www.home-assistant.io): the nodes publish state and
  discovery to it as a read-only view.
- [Zigbee2MQTT](https://www.zigbee2mqtt.io): the light transport the room
  controller and the examples are designed around.
- [Adaptive Lighting](https://github.com/basnijholt/adaptive-lighting) by
  basnijholt: the inspiration for circadian lighting in Node-RED.

BRAVIA is a trademark of Sony Group Corporation. Node-RED, Home Assistant,
Zigbee2MQTT and the other names here are trademarks of their respective owners.
This project is not affiliated with or endorsed by any of them.

## License

[MIT](https://github.com/avantics-hq/node-red-home-automation/blob/main/LICENSE)
