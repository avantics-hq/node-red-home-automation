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
- **Recoverable automation:** adopt one fresh, uniquely matching physical activity after lost state; otherwise report the activity as unknown and leave the devices alone until the next request.

![Architecture diagram. Inputs (wall switches, motion and presence sensors, illuminance, and theatre requests over MQTT) feed two groups of nodes. Room lighting: occupancy-fusion, motion-lighting-policy and switch-lighting-policy feed room-lighting-controller, which sends set commands to the lights (for example Zigbee2MQTT) and reads back their observed state. Theatre activities: theatre-state-contract passes activity intents to theatre-activity-controller and publishes retained theatre state and Home Assistant discovery; your flow routes each theatreCommand by target to the theatre equipment controllers (AVR, display mode, source capability, backlighting), which command the devices, or to activity-lighting-controller, which holds room lights; both report target state back to the activity controller.](https://avantics-hq.github.io/node-red-home-automation/images/architecture.svg)

Each controller keeps the desired and the observed state, sends semantic
commands, and reports done only when fresh observations confirm them.

## Included nodes

The nodes come in four groups. Each group has an importable example flow
(**Import → Examples** in the Node-RED editor).

### Room lighting

Motion, presence, illuminance and wall switches drive one room's lights, with
circadian styling and manual ownership. Wire occupancy fusion into the motion
policy, wall switches into the switch policy, and both policies into the room
controller. The room controller keeps a light a person set after the room went
vacant, so motion doesn't switch it straight off. Without a Node-RED context
store, a motion node that restarts or is redeployed doesn't know whether the
room is occupied, so it counts the room as vacant from then: someone sitting
still in a lit room has the motion-lit lights switched off after the vacancy
delay unless motion is seen. After a restart the room has also forgotten which
lights a person set, so it doesn't keep those either. Circadian
levels follow the room controller's wake and bed times (default 07:00 and
23:00): they rise over the hour after waking, stay bright and cool through the
day, and wind down to the sleep settings over the three hours before bed. Times
are the Node-RED host's local time.
Example: [`Room lighting.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Room%20lighting.json).

Wire the room controller's commands to MQTT out unchanged, and observe commands
and state as they are wired. The controller watches each light's command topic
to tell its own commands from other people's, so a function that rewrites them
on the way makes them look like someone else's. To stop that becoming a loop, a
bare ON or OFF that arrives within 5 seconds of one of its own commands with that
power, before that command has come back on the topic, is taken as that command,
and the controller restyles a light after someone else's bare ON at most once
every 5 seconds. A person's bare ON or OFF in that moment is taken as the
controller's own, which changes nothing, as the light is already being set that
way; other rewrites can still be misread.

| Node | Purpose |
|---|---|
| `home-occupancy-fusion` | Combines PIR motion with optional presence sensing. |
| `home-motion-lighting-policy` | Converts occupancy and illuminance into lighting intent. A `delay` message (in seconds) or `illuminance-cut-off` message overrides its settings until they are changed and redeployed. |
| `home-switch-lighting-policy` | Converts raw edges or pre-classified button actions into lighting intent while exposing input freshness and availability. |
| `home-room-lighting-controller` | Owns the room's light commands, adaptive styling, manual and held lights, and lighting state. |
| `home-shelly-switch` | Connects one switch channel of a Shelly Gen2+ relay as the device is set up: a detached wall switch's presses to the switch policy, or the relay as the light. |

A Shelly Gen2 or later relay behind a wall switch wires straight in through the
Shelly switch adapter, with no function nodes: an MQTT in node on the device's
`<prefix>/#` feeds it, and its first output goes to an MQTT out node. It reads
the device's own configuration for its channel (with `Shelly.GetConfig`, the
reply addressed under the device's prefix so the same MQTT in node receives it)
at startup and whenever the device comes online, and shows what it found. In
detached mode, where the relay stays on to power smart bulbs, the switch's
presses go to the switch policy: a toggle switch's on/off as edges, with the
device's status as the baseline, and a push button's single, double or long
presses as actions (the switch policy acts on single and double; long is passed
on for later use). The relay is never commanded, and a relay that reports off
is flagged, as the bulbs have lost power. In any other mode the relay is the
light: the node reports its state and takes on and off. Its **Mode** setting
overrides what was read, and decides when the configuration can't be read.
Example: [`Shelly switch.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Shelly%20switch.json).

One house schedule can set the wake and bed times for many rooms. It is a
configuration node, like an MQTT broker: choose it as a room controller's
**Schedule** and the room follows it, hearing of every change without wires.
Those rooms then have no wake and bed time entities of their own in Home
Assistant. Rooms that need their own times (a child's room, say) choose none.
Deleting the house schedule in the editor returns its rooms to their own times.
The optional house schedule MQTT node publishes the schedule's times and Home
Assistant time entities, and takes changes from them.
Example: [`House schedule.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/House%20schedule.json).

| Node | Purpose |
|---|---|
| `home-house-schedule` | A configuration node: one wake and bed time for every room that uses it. |
| `home-house-schedule-mqtt` | Publishes a house schedule for Home Assistant and changes it from Home Assistant. |

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

The display controller reads the projector's power from any meter or adapter:
send `msg.display = {kind: "observed", device: "projector", power: "on"}`
(`"on"`, `"standby"` or `"transitioning"`), or `watts` from a meter. Its
built-in Shelly meter is optional. Without one, it asks for a reading on output
3 whenever it needs one; wire that to your meter, unless the meter reports on
its own at least once per query timeout. A device that doesn't report fails
the request with reason `no-reading`. The node's help has the details.

For projector mode it opens the screen to its **Screen viewing position**, or,
left empty (the default for a new node), by the screen's own open command,
confirmed when the screen reports itself fully open. A node saved with a
position keeps it.

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


### Covers

One cover controller owns one position cover: a blind, shutter or curtain motor
that takes and reports a position from 0 (closed) to 100 (open). Send it
`"open"`, `"close"`, `"stop"`, a position, or the name of a preset such as
`partial`. It confirms a move from what the cover reports, retries a bounded
number of times, and leaves a cover a person moved where they put it. A move is
confirmed only once the cover has stopped at the target, from a `stopped`
motion report or the same position for the settle time (with or without
another report), so a transport that echoes the requested position at once
doesn't end the move early. Set the settle time to at least how often the
motor reports while it travels: otherwise an echo can be confirmed before the
first travel report arrives. An
automatic target, such as a position computed from the weather, sets
`msg.respectManual = true` so it waits while a person's move holds; a target
the cover is already at is confirmed without a command. A button can send
`msg.stopIfMoving = true` with `"open"` or `"close"` to stop the cover if it is
moving and do the request otherwise. The cover's availability report
(`{kind: "availability", online}`) keeps requests from going to an offline
device: they are answered `unavailable`, and the cover is read again when it is
back. A motor with no reliable position can be set to *open, close and
stop only*: it confirms a move from a reported end state, or from a move that
ran for its full travel time, and says when it could only judge by travel time
or could not confirm at all. Its third output says whether the cover is
moving, so other policies can react. To pause motion lighting while a blind
moves, send it to the motion policy's pause input
(`msg.source = "pause"`, `msg.payload` true or false, `msg.owner` naming the
cover), as the example does; a pause lasts at most the motion policy's
**Maximum pause** unless sent again; never its enable (`area-enabled`), which is the
user's own switch. Device commands come out in a neutral
shape (`set_position`, `stop` or `observe`); the example flow wires them to and
from a Zigbee2MQTT cover through the Zigbee2MQTT cover adapter (below). Battery
and charging status are kept as reported facts and never acted on.

Switched on, a cover node publishes its state (and position) under
`home/<area>/cover/<name>/`, named by its **Name in topics** (no default: give
each cover in a room its own), and announces a Home Assistant cover entity of that name. Its open,
close and stop (and, for a position cover, set position) come back to the cover node on its own set topics
as requests like any other, carried out and confirmed as above; nothing
commands the device through Home Assistant. A cover group has no entity of its
own: Home Assistant can group the covers' entities itself.

A cover group moves several covers as one, such as the left and right of a
curtain: it sends each member the request on that member's own output, labelled
from its Members setting, and reports ready only when every member confirms,
or, if only some do, which did what.

A Shelly Gen2 or later device in cover mode wires straight to a cover
controller through the Shelly cover adapter, with no function nodes: an MQTT in
node subscribed to the device's `<prefix>/#` feeds the adapter, the
controller's device commands go to it too, and its two outputs go to an MQTT
out node and back to the controller. It speaks the device's own MQTT API, never
Home Assistant: it sends `pos,<0-100>`, `stop`, and `status_update` (for a fresh
reading) on `<prefix>/command/cover:<id>` (the device's MQTT Control, on by
default), and turns the device's status and
change notifications into position and motion readings, and its online topic
into availability. A cover that isn't calibrated, or has lost its position,
fails the command in hand with the reason rather than reporting a position.
Example: [`Shelly cover.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Shelly%20cover.json).

A Zigbee2MQTT cover wires the same way through the Zigbee2MQTT cover adapter:
set its base topic (`zigbee2mqtt` by default) and the device's friendly name,
feed it from MQTT in nodes on `<base>/<friendly name>` and its `/availability`,
and wire it between the cover controller and an MQTT out node. It sends
`{"position": n}` and `{"state": "OPEN" | "CLOSE" | "STOP"}` on the device's
`/set`, and asks for a fresh reading on its `/get`. Each state report becomes a
position reading, with motion from `motor_state` or `moving` where the device
reports one; a cover that reports none is confirmed by the controller's settle
time. A cover with no position (set the controller to open, close and stop
only) reports its end state once its motion says it has stopped.
Example: [`Cover control.json`](https://github.com/avantics-hq/node-red-home-automation/blob/main/examples/Cover%20control.json).

| Node | Purpose |
|---|---|
| `home-cover-controller` | Owns one cover's moves (a position cover, or open, close and stop only), confirmed from what it reports, with presets, manual ownership and a moving signal. |
| `home-cover-group` | Moves several covers as one, with an honest result when only some confirm. |
| `home-shelly-cover` | Connects a Shelly Gen2+ cover to a cover controller over the device's own MQTT API. |
| `home-z2m-cover` | Connects a Zigbee2MQTT cover to a cover controller over Zigbee2MQTT's MQTT messages. |

## Requirements

- Node.js 24 or newer
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
npm install /path/to/avantics-node-red-home-automation-5.0.0.tgz
```

Add the installed nodes from the **home automation** section of the Node-RED palette, then configure the room, device hosts, MQTT topics, source mappings, and timing limits for your deployment.

### 6.0.0

Check these after upgrading from 5.x:

- **Enable inputs take only `true` or `false`.** The motion policy's
  `area-enabled`, `global-enabled` and `pause`, and the room controller's
  `{kind: "circadian" | "sleep", enabled}`, no longer read strings such as
  `"ON"` or `"on"`. Any other value is refused: nothing changes, the node logs
  a warning once per input per deploy, and its status says what was refused.
  Before 6.0 the motion policy read "on" in any case as on and anything else as
  off, and the room read anything but `true` as off. Home Assistant's own `ON`
  and `OFF` on the `…/set` topics are unchanged: the nodes translate them.

### 5.0.0

Separates the decision logic from the devices it drives, adds a Shelly cover
adapter, and fixes theatre recovery and screen handling. Check these after
upgrading from 4.0:

- **Lighting values are in percent and kelvin.** Intents and activity lighting
  profiles take `brightnessPct` (0-100) and `colorTempKelvin` instead of
  Zigbee2MQTT's `brightness` (1-254) and `color_temp` (mireds), and the switch
  policy's double press now sends `{brightnessPct: 100}`. Your lights get the
  same commands. The old values still work in 5.x, with a warning in the log;
  change them before 6.0. For example, brightness 64 becomes brightnessPct 25,
  and color_temp 400 becomes colorTempKelvin 2500 (1,000,000 ÷ mireds). 0% is
  the dimmest level, not off: send state OFF to switch a light off.
- **Receiver volume is in dB** (a Denon's 80 is 0 dB). Send `valueDb` in volume
  requests. `value` on the receiver's 0-98 scale still works in 5.x, with a
  warning, and stops in 6.0. Saved volume bounds are converted when read; open
  and save the node to store them in dB. The published volume state and the
  Home Assistant volume number now show dB, as do the node's volume results and
  state messages, so update any automation or flow that sets or reads them with
  0-98 values. Without a context store, the old retained
  volume can sit outside Home Assistant's new dB range until the receiver
  first reports after a restart.
- **The display controller's settings are named by role:** TV host, TV
  pre-shared key, Screen controller host and Projector power meter host (saved
  as `projectorPowerMeterHost`). A flow saved before 5.0 keeps working; open and
  save the node to store the new name before 6.0, when `projectorMeterHost`
  stops being read. No warning is logged for this one.
- **The projector's power can come from any meter or adapter:** send
  `msg.display = {kind: "observed", device: "projector", power: "on" |
  "standby" | "transitioning"}`, or `watts`. The built-in power meter host is
  now optional. Without it, wire the new third output (projector power queries)
  to ask your meter for a reading. Leave output 3 unwired only if your meter
  reports on its own at least once every Query timeout, even when the power
  doesn't change: a meter that reports only on a change says nothing while the
  projector sits steady. Saved wiring on outputs 1 and 2 is kept. Power values
  are lower case only (`on`, `standby`, `transitioning`); a smart plug's own
  `ON` or `OFF` is rejected, so send its watts.
- **A display request fails rather than waiting** when a device hasn't reported
  within Query timeout × Maximum attempts (it's asked again once): the reason is
  `no-reading`, naming the device. Before, it waited in discovering. This
  applies with the built-in hosts too.
- **The screen opens by its own command when no viewing position is set.** A
  display node with no Screen viewing position (new nodes, and flows written
  without the key) opens the screen with the screen's own open command and
  confirms it fully open, rather than going to 82%. Nodes saved with a position
  keep it; a saved position must now be above 0 and at most 100, or empty, or
  the node won't deploy. Closing always uses the screen's own close command and runs to the
  end, which also restores a position the screen has lost. A screen with a
  viewing position but no known position is closed first, then sent to the
  position; one that has never been calibrated fails with
  `screen-not-calibrated`. The display's state events may report the screen's
  position as null when it reports only open or closed.
- **Theatre recovery now reaches the devices.** After the theatre recovers an
  activity, each device takes on the new request by reading itself, never by
  commanding: one that matches is ready, and its old manual override clears;
  one that doesn't reports a manual override once. Before, devices kept the old
  request, and a flow that recovered on every manual override could loop.
- **Backlighting's ready carries the time of its reading,** so a repeated
  request no longer counts as a fresh reading, and a silent device is reported
  stale and then not responding.
- **New node: Shelly cover**, which connects a Shelly Gen2+ cover to a cover
  controller over the device's own MQTT API (see "Covers").
- **For code that imports the package's files directly:** the display's device
  transport moved from `dist/lib/display-transport` to
  `dist/lib/transports/display-transport`. Only the nodes are a public
  interface.

### 4.0.3

Fixes the theatre state flapping on every scheduled refresh: with an activity
settled and ready, backlighting and room lighting reported themselves as
confirming while they re-read their devices, so the theatre published
`unknown` and back, and counted drift each time. A refresh of a ready target
now re-reads it without leaving ready, as the display, receiver and source
already did. A target that really changes on its own still counts as drift.

### 4.0.2

Fixes the display controller switching the TV off before the projector was
ready: with a source playing, there was sound but no picture while the screen
opened and the projector warmed up. Projector mode now starts the projector and
waits for its warm-up, opens the screen, then puts the TV in standby, so the
picture stays up and the TV stays on if the projector fails to start. A request
made while the projector is warming up or cooling down now waits for that to
finish, so the lamp is no longer left on or toggled mid-warm-up.

### 4.0.1

Fixes the cover controller ending a move too early when a transport echoes the
requested position as soon as the command is sent, before the motor moves: the
cover showed as stopped while it was still travelling, and the travel after it
was taken for a person's move. A move now confirms only once the cover has
stopped at the target, from a `stopped` motion report or the same position for
the settle time. Set the settle time to at least how often the motor reports
while it travels (see Covers).

### 4.0.0

Adds cover control, a house schedule, and Home Assistant entities for every
publishing node. Check these after upgrading from 3.0:

- **Breaking: theatre recovery never switches a running activity off.** After a
  restart or redeploy with unclear evidence, the activity is reported as unknown
  and the devices are left alone until the next request. The "Recovery Off
  activity" setting is gone, and a saved value is ignored. The metric
  `recoveriesSafeOff` is now `recoveriesUnknown` (in `<base>/metrics`, shown as
  attributes of the "Transition latency" sensor), and the event
  `recovery_safe_off` is now `recovery_unknown`. Update any dashboard, template
  or flow that uses the old names.
- **Breaking: the theatre's readiness moved topics.** It is now on
  `<base>/readiness`, and its Home Assistant sensor is "Readiness".
  `<base>/availability` now carries `online` or `offline` (see "Availability"
  below).
- **Breaking for areas that aren't identifiers:** a room or theatre contract whose
  area has spaces or other characters now publishes under the lowercase form,
  for example `home/living_room/…` instead of `home/Living Room/…` (see
  "Discovery" below).
- **Without a context store, a restart or redeploy is gentler:** a room leaves
  its lights alone until something names them, motion lighting starts its
  vacancy countdown, and a theatre device re-learns its activity from the
  theatre instead of being marked unresponsive. A [file context store](#recommended-setup-a-file-context-store) keeps state
  across restarts instead.
- **A Catch node fires once per input error,** not twice.
- **New nodes:** a cover controller for blinds, shutters and curtains, a cover
  group, a house schedule that sets many rooms' wake and bed times, and a house
  schedule MQTT node for Home Assistant (see "Covers" and "Room lighting").
- **New outputs, off until you switch publishing on:** occupancy fusion and the
  motion policy gain a second output, and the AVR controller a third, for their
  MQTT state and Home Assistant entities. Saved nodes are unchanged.
- **Home Assistant:** availability, entity names that survive area renames, the
  room's sleep switch and wake and bed times, receiver volume, and cleanup of a
  deleted node's entities, described under "Upgrading from 2.x" below.
- **Other flows can pause motion lighting** without changing the user's enable.

### 3.0.1

Fixes the room lighting controller looping on its own commands when something
between it and MQTT out rewrites them, for example a function that cuts a styled
ON down to `{"state":"ON"}`: it took each rewritten command for someone else's
and answered with another, without end. It now takes a bare ON or OFF that
arrives within 5 seconds of one of its own commands with that power, before that
command has come back on the topic, as that command, and restyles a light after
someone else's bare ON at most once every 5 seconds.
It also no longer marks a light manual when its own command is seen twice. Wire
its commands to MQTT out unchanged (see Room lighting).

### Upgrading from 2.x

Version 3.0 changed some behaviour, and later versions added to it. Check these after upgrading from 2.x, along with the notes above:

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
  discovery: its entity IDs then come from its display name. With an area, it suggests that area to Home Assistant,
  which creates it if no area of that name exists. One saved before needs an area for discovery, as before. A room
  lighting controller with no area still controls its lights only with state publishing and discovery both off;
  with either on (or unset, as on a room saved before 3.0), it reports an invalid configuration.
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
  Importing or pasting a node in the editor keeps its saved settings, including its ID scheme and publishing, so
  an older node restored from a backup keeps its area-named entities. Only a node added from the palette starts as
  new.
- **Occupancy fusion can publish too**, off unless you switch it on: its occupancy as retained `ON`/`OFF` on
  `home/<area>/occupancy/state`, with availability, and an occupancy binary sensor in Home Assistant. These go on its
  new second output, so wire that to an MQTT out node; the first output still feeds the motion policy.
- **The motion lighting policy can publish too**, off unless you switch it on: whether this node's motion lighting
  is enabled and its vacancy delay in seconds (`home/<area>/motion/enabled/state` and `…/delay/state`), which it also
  takes from their `/set` topics, and a switch and a vacancy delay number in Home Assistant. These go on its new
  second output; the shared global enable is not published.
- **The AVR controller can publish what the receiver reports**, off unless you switch it on: power, source and
  volume, retained under `home/<area>/receiver/`, with availability, and Home Assistant power and source sensors
  and a volume number (see "Receiver volume ownership"). These go on its new
  third output, apart from the receiver commands and the theatre's state.
- **Topics no longer published are cleared.** Once the flows have started, and again at its startup message, a node
  clears any retained topic it published before and no longer does, for example after an area, base topic,
  discovery prefix or target change. It remembers what it published in its node context, which lasts across
  deploys and restarts only with a context store configured (see "Recommended setup"). Without that record, an occupancy, motion, receiver or
  house schedule MQTT node named after itself (node-based IDs) that publishes state still clears its own Home Assistant
  entities it no longer publishes, such as after you switch discovery off; it never clears topics another node could
  publish. Other old topics, after an area, base topic, discovery prefix or target change, or after you switch
  publishing off entirely, are cleared only from the record. A node that never gets a startup message
  keeps clearing its old topics at every start, so to move an area from one older room node to another, send the old
  node a startup message, or delete it.
- **Send each publishing node a startup message once, a few seconds after deploy.** The example flows do this with an
  inject node set to fire once after 3 seconds: by then the MQTT broker node has usually connected, and a message
  sent before it connects is dropped, along with the discovery and state it carried.
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
  one of them. With discovery on, each publishing node also announces its Home Assistant entries once the flows have
  started, just before its `online`, and again at its startup message. The theatre's readiness (`unknown`,
  `available`, `degraded` or `unavailable`), which used `<base>/availability` before, is now on `<base>/readiness`.

## Theatre MQTT contract

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
request resumes automation. A target controller that starts with nothing
saved (a redeploy or restart without a context store) takes the activity's
wanted values from the activity controller's next refresh, which carries them
as the intent did, and only reads its device for it: it reports ready when
the device already matches, and a manual override (reason `adopted-mismatch`)
when it doesn't, sending no command until the next request.
Recovery adopts physical state only when fresh
display, AVR, source, and backlighting evidence matches exactly one configured
profile. With missing or ambiguous startup evidence the activity is unknown,
and nothing is commanded until the next request: a redeploy or restart, which
starts the controller with nothing saved unless a context store is configured,
never switches a running activity off. While it is unknown, the theatre's
phase shows `idle` (the controller isn't working on anything) and its current
activity `unknown` until the next request, even if something is playing.
(Earlier versions ran a configured Off activity here; that setting is gone,
and a saved value is ignored.)

## Recommended setup: a file context store

The nodes keep what they are doing in Node-RED's node context. By default
Node-RED keeps context in memory and deletes a node's context whenever the
node stops: on a full deploy, on a "Modified flows" deploy of its flow (which
restarts every node in that flow, changed or not), on a "Modified nodes"
deploy of the node itself, and on every restart. Configure the file context
store so it survives. In `settings.js` in your Node-RED user directory, set:

```js
contextStorage: {
    default: { module: "localfilesystem" }
},
```

then restart Node-RED. The file store writes changes to disk every 30 seconds
by default, so a change made just before Node-RED stops can still be lost.

Without a context store, after a node is redeployed or Node-RED restarts:

- **A room forgets which lights are held or manual:** every light an activity
  held, or a person set by hand, is back under the room's control, so the next
  refresh restyles an activity's lights and lights a person set.
- **Changes made at runtime go back to the node's settings:** for example motion
  lighting's enable, vacancy delay and lux cutoff, a room's circadian lighting,
  sleep, and wake and bed times, and the house schedule's times, set from Home
  Assistant or a message.
- **The theatre starts its counts again:** its counters and operational SLO
  samples restart, and the activity controller no longer knows the current
  activity. At its next startup recovery it works it out from what the devices
  report, and if no single activity matches, it switches to the recovery off
  activity.
- **Work in progress is not recovered:** a motion off-timer that was running,
  or a theatre device change still being confirmed. The node starts afresh
  and goes by what it next observes.
- **Old retained topics are not cleared:** a node can't remember what it
  published before, so after you change an area, base topic, discovery prefix
  or targets, the old retained topics and Home Assistant entities stay until
  you remove them yourself.

## Room light control

The room lighting controller gives each target one control state:

- `in-control`: circadian lighting may style and refresh the light (the default).
- `overridden`: another owner, such as an activity or a scene, holds the light;
  refresh and circadian changes leave it alone until it is released.
- `manual`: a person changed the light.

The control states live in the node's context. A room controller that starts
with nothing saved (its first deploy, or a redeploy or restart without a
context store) can't know which lights an activity held or a person set, so it
leaves every light as it is: the periodic refresh restyles a light again only
once an intent or release names it, someone switches it on with a bare ON, or
circadian lighting is switched on. A light that is on at that start and that
nothing names can keep its start-time style all day; to bring it back into step,
switch circadian lighting on (for example with the Home Assistant circadian
switch), or let motion or a wall switch name it.

Add `owner` to an intent to override the targets it switches on. With
`preserveManual: true`, manual lights are skipped:

```js
msg.lighting = {
  kind: "intent",
  targets: ["wall", "lamp"],
  state: "ON",
  source: "activity",
  owner: "theatre",
  values: {brightnessPct: 25, colorTempKelvin: 2500},
  preserveManual: true
};
```

An intent's `values` use the package's own units: `brightnessPct` (0-100) and
`colorTempKelvin`. The room controller converts them for the light (for a
Zigbee2MQTT light, to its 1-254 brightness and mireds); other fields, such as
`effect`, are passed on as they are. `brightnessPct: 0` is the dimmest the
light goes, not off: send `state: "OFF"` to switch it off. A value that isn't a
number (a numeric string such as `"50"` counts), or a colour temperature of 0
or less, is left out with a warning in the log. During 5.x, `brightness` and `color_temp`
in Zigbee2MQTT's own units are still accepted and passed on unchanged, and the
room controller logs a warning once per deploy; they stop working in 6.0.

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
  valueDb: 1
};
```

Volume is in dB: `valueDb` is the volume for `absolute`, or the change for
`relative`, and the bounds, results, published state and Home Assistant
number are in dB too. The controller converts for the receiver (for a Denon,
whose 0-98 has 80 at 0 dB, -80 to +18 dB in half steps). During 5.x, a request
with `value` in the receiver's own 0-98, and bounds saved before 5.0 as
**minVolume** and **maxVolume**, are still read, and the node logs a warning
once per deploy for such requests; they stop working in 6.0.

`mode` may be `absolute` or `relative`. The controller resolves relative input
from fresh observed volume, accumulates rapid requests against the pending
target, applies configured half-step bounds, retries through the existing
bounded transport path, and confirms completion from fresh receiver evidence.
Once confirmed, it releases the volume target; a later physical or external
adjustment becomes the new baseline instead of being corrected. A request still pending when Node-RED restarts is reported as
`volume_failed` with reason `restart`, not replayed.

With publishing and discovery on, Home Assistant gets a volume number. A
value set there arrives on `home/<area>/receiver/volume/set`; values arriving
within 0.3 seconds of each other are settled to the last, which becomes an
ordinary absolute request (`msg.avr = {kind: "volume", mode: "absolute", ...}`),
so it is bounded, sent and confirmed in the same way, and never sent to the
receiver directly. The number shows the confirmed volume. A theatre activity
owns the receiver's power and source, not its volume: a volume request made
while an activity is switching power or source waits until that is done, and
one made while the receiver is off (an activity's `off`, say) is rejected
with `receiver-not-ready`, as any request would be.

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

The display controller stores its TV pre-shared key as a Node-RED credential. Keep credentials in Node-RED's encrypted credential store rather than flow fields or repository files.

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
