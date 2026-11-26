// Written by scripts/build-docs.mjs.
window.DOCS_SEARCH = [
 {
  "title": "Introduction",
  "description": "State-aware controllers for Node-RED. Clear wiring, observed results, and manual control that stays yours.",
  "url": "index.html",
  "text": "State-aware controllers for Node-RED. Clear wiring, observed results, and manual control that stays yours."
 },
 {
  "title": "Introduction",
  "section": "Automation that checks the result.",
  "description": "Build lighting, cover and home-theatre flows that know the difference between a command being sent and a devic",
  "url": "index.html#overview",
  "text": "Build lighting, cover and home-theatre flows that know the difference between a command being sent and a device doing what you asked. Each controller tracks the wanted and observed state, preserves a person’s manual changes, and retries only a bounded number of times. Your request Motion, switch or activity → Controller One command owner → Device MQTT or local API Device observations return to the controller. Only fresh evidence confirms the requested result."
 },
 {
  "title": "Introduction",
  "section": "Get the package",
  "description": "In Node-RED, choose Manage palette → Install and search for @avantics/node-red-home-automation . Or run this f",
  "url": "index.html#install",
  "text": "In Node-RED, choose Manage palette → Install and search for @avantics/node-red-home-automation . Or run this from your Node-RED user directory, then restart Node-RED: Terminal npm install @avantics/node-red-home-automation Find the nodes in the home automation palette category. Import a wiring example from Import → Examples . Check before updating This package is under active development. Pin the version you use, read the release notes and check your flows after an update."
 },
 {
  "title": "Introduction",
  "section": "Choose what you want to control",
  "description": "01 / LIGHTING Start with one room Combine motion and wall switches without taking control away from the person",
  "url": "index.html#choose",
  "text": "01 / LIGHTING Start with one room Combine motion and wall switches without taking control away from the person. Room lighting in the README ↗ 02 / COVERS Wire a blind or curtain Connect a cover, set a position or preset, and confirm the motor has stopped. Follow the cover guide → 03 / HOME THEATRE Coordinate an activity Bring display, receiver, source and lighting together from one request. Read the theatre documentation → 04 / REFERENCE Look up a node Find its messages, output ports and exact configuration defaults. Explore the cover controller →"
 },
 {
  "title": "Introduction",
  "section": "A few ideas carry through every flow",
  "description": "One command owner Policies ask for an outcome. A controller owns the device commands, so two parts of your flo",
  "url": "index.html#core-ideas",
  "text": "One command owner Policies ask for an outcome. A controller owns the device commands, so two parts of your flow do not fight over the same target. Requests describe the result Send “open”, a position, or a lighting intent. The device path translates the controller’s commands into its protocol. Evidence before completion Sending a command is not success. The controller waits for fresh observations; retries and failure paths have limits. Recovery stays bounded Retries, timers, traces and failure paths remain finite, and a restart re-reads the devices rather than replaying commands. Manual control stays yours A person’s change becomes ownership evidence, not something to correct immediately. The cover guide shows how automatic requests respect it. Home Assistant is the panel, not the device path. It can display state and send requests over MQTT. Controllers command and observe the devices directly, not through Home Assistant."
 },
 {
  "title": "Introduction",
  "section": "Follow the project",
  "description": "See what is complete, next and planned on the public roadmap . Run the contract examples to explore the messag",
  "url": "index.html#project",
  "text": "See what is complete, next and planned on the public roadmap . Run the contract examples to explore the messages without a device. Sources: README and package metadata."
 },
 {
  "title": "Wire a cover",
  "description": "Connect a blind, shutter or curtain through a relay cover adapter. Then add presets, manual control and a group without losing sight of what the motor actually did.",
  "url": "guide-covers.html",
  "text": "Connect a blind, shutter or curtain through a relay cover adapter. Then add presets, manual control and a group without losing sight of what the motor actually did."
 },
 {
  "title": "Wire a cover",
  "section": "Before you wire it",
  "description": "This guide connects a calibrated relay-module cover over its own MQTT API. You need the device’s MQTT topic pr",
  "url": "guide-covers.html#before",
  "text": "This guide connects a calibrated relay-module cover over its own MQTT API. You need the device’s MQTT topic prefix and a broker connection in Node-RED. Use a compatible generation-2-or-later relay device in cover mode , calibrated on the device first. Enable MQTT and MQTT Control on the device. Keep RPC status notifications enabled so changes are reported. Generic status updates can provide additional full reports. The controller’s positions are 0 = closed and 100 = open . For a motor with no reliable position, use open, close and stop only instead; this position-adapter guide is not that device path."
 },
 {
  "title": "Wire a cover",
  "section": "Wire the command and observation loop",
  "description": "The adapter translates messages. The controller decides whether a move is complete. Keep both directions conne",
  "url": "guide-covers.html#wiring",
  "text": "The adapter translates messages. The controller decides whether a move is complete. Keep both directions connected. MQTT in <prefix>/# → Relay cover adapter Device reports ↔ neutral messages ⇄ Cover controller Requests and confirmation Adapter output 1 → MQTT out → device MQTT out Same broker · leave its topic empty Reports: MQTT in → adapter → controller. Commands: controller output 1 → adapter → MQTT out. The table below names every port. Four connections From Connect to Why MQTT in Relay adapter input Subscribe to <prefix>/# ; use auto-detect output. Controller output 1 Relay adapter input Pass neutral device commands unchanged. Relay adapter output 1 MQTT out Same broker; leave the MQTT out topic empty. Relay adapter output 2 Controller input Feed back observations, availability and command results. Set the adapter’s topic prefix. Use the prefix configured on your device. Set Cover ID to 0 , or 1 for a device’s second cover. Choose a position cover. On the controller, leave Cover as “Takes a position (0 to 100)”. Set Invert positions only if the device reports 0 as open. Request a reading at startup. Send msg.cover = {kind: \"startup\"} after deploy. The controller reads the cover rather than trusting old state. Watch state and results. Connect controller output 2 to a Debug node. Output 3 reports whether it is moving; output 4 is for optional MQTT publications, not device commands. A position echo is not a stopped motor. A move confirms from a stopped report at the target, or a position that stays the same for the settle time. Set Settle time to at least the interval between motor travel reports."
 },
 {
  "title": "Wire a cover",
  "section": "Request a position or preset",
  "description": "Use an Inject node or another policy to send a number, \"open\" , \"close\" , \"stop\" , or a named preset to the co",
  "url": "guide-covers.html#presets",
  "text": "Use an Inject node or another policy to send a number, \"open\" , \"close\" , \"stop\" , or a named preset to the controller. Inject → cover controller · request a position msg.payload = 60; return msg; The default Presets setting is {\"partial\":60} . To use it: Inject → cover controller · use a named preset msg.payload = \"partial\"; return msg; A still cover already at its target is confirmed without sending another move."
 },
 {
  "title": "Wire a cover",
  "section": "Leave a person’s move alone",
  "description": "Mark requests from schedules or automatic policies with respectManual . They wait while the cover is held by a",
  "url": "guide-covers.html#manual",
  "text": "Mark requests from schedules or automatic policies with respectManual . They wait while the cover is held by a person’s move. Automatic request msg.payload = \"partial\"; msg.respectManual = true; return msg; A new request without that flag takes control back. For a wall button that should stop a moving cover, set stopIfMoving : Button request · stop if moving, otherwise open msg.payload = \"open\"; msg.stopIfMoving = true; return msg; Pause motion lighting, not the user’s enable switch. Controller output 3 can feed the motion policy’s pause input: set msg.source = \"pause\" and a distinct msg.owner . Keep the boolean payload. Never use the area-enabled input for this."
 },
 {
  "title": "Wire a cover",
  "section": "Move several covers as one",
  "description": "Add a cover group . Its default members are [\"left\",\"right\"] . Output 1 is the group result; each following ou",
  "url": "guide-covers.html#groups",
  "text": "Add a cover group . Its default members are [\"left\",\"right\"] . Output 1 is the group result; each following output is a request for the labelled member. Connect the group’s left and right outputs to their respective cover controllers. Connect each controller’s output 2 back to the group input. Send the request to the group. It assigns each member its own request identity. The group reports ready only when every member confirms. If some fail, it reports partial or none-confirmed with individual member details. A silent member becomes no-answer at the answer deadline (default 120 seconds ). Each member keeps its own device connection. A group has no Home Assistant entity; Home Assistant can group the individual cover entities itself."
 },
 {
  "title": "Wire a cover",
  "section": "Check the result",
  "description": "Read the outcome What you see What it means Moving, then ready Fresh reports confirm the cover has stopped at ",
  "url": "guide-covers.html#check",
  "text": "Read the outcome What you see What it means Moving, then ready Fresh reports confirm the cover has stopped at its target. not-calibrated / position-unknown The device cannot provide a usable position. Calibrate it or restore its position knowledge; do not invent a reading. unavailable The device is offline. No device command is sent; it is read again when it returns. For output messages, optional Home Assistant discovery and timing defaults, open the cover controller reference . Sources: README Covers; cover-controller, cover-group and relay-adapter editor help."
 },
 {
  "title": "Cover controller",
  "description": "Message shapes, output ports and settings for one blind, shutter or curtain. Position-aware confirmation without fighting manual moves.",
  "url": "node-cover-controller.html",
  "text": "Message shapes, output ports and settings for one blind, shutter or curtain. Position-aware confirmation without fighting manual moves."
 },
 {
  "title": "Cover controller",
  "section": "One motor. One command owner.",
  "description": "Controls a blind, shutter or curtain in position mode or open-close mode. It confirms moves from cover reports",
  "url": "node-cover-controller.html#summary",
  "text": "Controls a blind, shutter or curtain in position mode or open-close mode. It confirms moves from cover reports, retries within its limits, and leaves a person’s move where they put it. Looking for wiring? Follow Wire a cover for the MQTT adapter connections and a working message path."
 },
 {
  "title": "Cover controller",
  "section": "Inputs",
  "description": "Requests and device observations share the same input. A position cover uses 0 for closed and 100 for open. In",
  "url": "node-cover-controller.html#inputs",
  "text": "Requests and device observations share the same input. A position cover uses 0 for closed and 100 for open. Input properties Property Type Meaning msg.payload string / number \"open\" , \"close\" , \"stop\" , a position from 0 to 100, or a preset name. An already satisfied, still target needs no command. msg.stopIfMoving boolean With true , stop if moving (including an unconfirmed move); otherwise carry out the request. msg.respectManual boolean With true , wait while a person’s move holds the cover. A request without this takes control back. msg.cover object Observation, availability, startup, command result, or a full cover request. See message shapes below. Device observation · msg.cover { kind: \"observed\", position: 60, motion: \"stopped\", observedAt: \"2026-01-01T12:00:00.000Z\" } Motion is opening , closing or stopped . Optional battery and charging fields are kept as reported facts, not acted on. Other msg.cover shapes kind Other fields Use availability online Offline requests are answered unavailable without a command. The cover is re-read when it returns. startup None Read the cover again after deploy. command_result generation, ok Result from the device path; not a substitute for observed completion. set_position requestId, generation, position Full position request with its identity."
 },
 {
  "title": "Cover controller",
  "section": "Outputs",
  "description": "The port order is fixed. Device commands and optional MQTT publications have different jobs. Four output ports",
  "url": "node-cover-controller.html#outputs",
  "text": "The port order is fixed. Device commands and optional MQTT publications have different jobs. Four output ports Port Message Connect to 1 · Device commands msg.cover_command = {operation, position, requestId, generation, attempt} Position mode: set_position, stop, observe. Device adapter. For example, the relay adapter input. 2 · State and results msg.theatre = {kind: \"target_state\", target: \"cover\", status, details} Debug, a cover group, or another result consumer. Contains positions and failure or manual-override details. 3 · Moving msg.payload true / false; msg.topic = \"moving\" . Sent on changes. Policies that need to react to cover motion. 4 · MQTT publications Retained state and optional discovery, when publishing is on. MQTT out; not the device-command path. Completion needs a stopped target. A stopped motion report confirms the target, or it must remain at the same position for the settle time. A command echo alone does not prove that travel is finished."
 },
 {
  "title": "Cover controller",
  "section": "Settings",
  "description": "Defaults below are from the editor definition. Timing values are in milliseconds , not seconds. Mode-specific ",
  "url": "node-cover-controller.html#settings",
  "text": "Defaults below are from the editor definition. Timing values are in milliseconds , not seconds. Mode-specific settings are identified in their descriptions. Editor settings and exact defaults Setting / property Default Meaning Name name · string Empty Display label; a new palette node starts unnamed. Area area · string Empty Required when publishing state or discovery. Cover coverType · enum position A position cover, or open-close for open, close and stop only. Presets presets · JSON object {\"partial\":60} Position mode. Names begin with a lowercase letter; use letters, digits, _ or -. Do not name one open, close or stop. Positions: 0–100. Position tolerance positionTolerance · number 2 Position mode. Allowed difference from the target in position points. Invert positions invert · boolean false Position mode. Enable if the device reports 0 as open. Travel timeout travelTimeoutMs · milliseconds 90000 Position mode. Time limit for travel. Poll interval pollMs · milliseconds 5000 Position mode. Interval between reads. Settle time settleMs · milliseconds 5000 Position mode. Stable-position interval for confirmation; use at least the interval between motor travel reports. Full travel time travelMs · milliseconds 30000 Open-close mode. Full-duration travel used when judging a reported move by time. Travel margin marginMs · milliseconds 10000 Open-close mode. Travel-time margin. Maximum attempts maxAttempts · number 2 Bound on command attempts. Name in topics topicName · string Empty Required when publishing. Give each cover in an area its own name. Publish state over MQTT publishState · boolean false Enables retained state on output 4. Home Assistant discovery discovery · boolean false Requires Publish state. Announces a cover entity. Discovery prefix discoveryPrefix · string homeassistant Nonempty prefix without MQTT wildcards. New nodes use node-based Home Assistant identifiers ( idScheme = \"node\" ). That internal marker is set when a node is added from the palette; it is not an editor setting."
 },
 {
  "title": "Cover controller",
  "section": "Optional MQTT and Home Assistant",
  "description": "Publishing and discovery are off by default. When publishing is on, set both Area and Name in topics . The bas",
  "url": "node-cover-controller.html#publishing",
  "text": "Publishing and discovery are off by default. When publishing is on, set both Area and Name in topics . The base topic is home/<area>/cover/<name> . Published state and incoming requests Topic suffix Direction Payload /state Output 4 · retained open, closed, opening, closing or stopped, once reported. /position Output 4 · retained Reported position, for a position cover. /availability Output 4 · retained online or offline. /set MQTT in → controller OPEN, CLOSE or STOP. /position/set MQTT in → controller Requested position. Subscribe to home/<area>/cover/<name>/+ and …/position/set and feed the MQTT in messages to the controller. These are requests to the controller, never direct commands through Home Assistant. Do not retain command or request messages."
 },
 {
  "title": "Cover controller",
  "section": "Open, close and stop only",
  "description": "For a motor without a reliable position, set Cover to “Open, close and stop only”. Positions and presets are i",
  "url": "node-cover-controller.html#open-close",
  "text": "For a motor without a reliable position, set Cover to “Open, close and stop only”. Positions and presets are ignored. Commands on output 1 become open , close , stop or observe . Report msg.cover = {kind: \"observed\", motion, state, observedAt} . A reported end state ( open or closed ) confirms the move. Otherwise, a move in the requested direction that stops after the full travel time is explicitly judged by travel time . Stopping early or moving the other way is treated as a person’s move. If the motor reports nothing, the result stays unconfirmed and fails with no-reports after the retry limit. Source: cover-controller editor defaults and help; README Covers. Relay-adapter wiring is sourced separately in the guide."
 },
 {
  "title": "Home theatre",
  "description": "Activity orchestration across display, receiver, source, lighting and backlighting, with observed completion.",
  "url": "home-theatre.html",
  "text": "A reusable controller contract for coordinating target owners from explicit activity requests and fresh observations."
 },
 {
  "title": "Home theatre",
  "section": "Composed target owners",
  "description": "The activity layer emits semantic intent. Each target controller retains its own safe sequencing, transport an",
  "url": "home-theatre.html#targets",
  "text": "The activity layer emits semantic intent. Each target controller retains its own safe sequencing, transport and confirmation policy. Display Mode and power intent Receiver Power, source and bounded volume ownership Media source Capability and readiness Room lighting Ownership-preserving style Backlighting Observed power state"
 },
 {
  "title": "Home theatre",
  "section": "Activity lifecycle",
  "description": "Every request receives a monotonic generation. Delayed work from older generations cannot mutate current state",
  "url": "home-theatre.html#lifecycle",
  "text": "Every request receives a monotonic generation. Delayed work from older generations cannot mutate current state. Requested Validate identity and activity. Preparing Refresh target evidence. Transitioning Dispatch semantic target intent. Confirming Require fresh mandatory evidence. Terminal Report ready, waiting or failed."
 },
 {
  "title": "Home theatre",
  "section": "Behavioral guarantees",
  "description": "Stale work is inert Timers, command results and observations carry generation identity and cannot complete a n",
  "url": "home-theatre.html#guarantees",
  "text": "Stale work is inert Timers, command results and observations carry generation identity and cannot complete a newer request. Readiness is honest Mandatory targets require fresh observations. Unsupported or unobservable capabilities remain explicit. Manual control is preserved Unsolicited target changes become ownership evidence rather than a reason to fight the user. Volume control has one owner Absolute and relative requests share receiver bounds, observed confirmation and an explicit release point for later manual adjustment. Recovery is bounded Restart refreshes observations without blindly replaying state-changing commands. Failure is actionable Retries, fallback use, target availability and transition latency remain visible through one state contract. Policies stay transport-neutral Activity profiles name semantic outcomes; adapters own protocol-specific operations."
 },
 {
  "title": "Home theatre",
  "section": "Public contract",
  "description": "Node-RED adapters bridge the pure reducer to MQTT and Home Assistant without moving policy into flow wiring. P",
  "url": "home-theatre.html#contract",
  "text": "Node-RED adapters bridge the pure reducer to MQTT and Home Assistant without moving policy into flow wiring. Public contract Surface Contract Invariant Request Unique request ID, configured activity and timestamp Retained requests are inert Desired state Activity and generation One current request identity Target evidence Status, observation time, classification and failure Older evidence cannot overwrite newer evidence Outcome Current activity, phase, availability and failure Ready requires all mandatory targets Operations Latency, retries, fallbacks, outcomes and objective status Expected waiting does not become a false failure"
 },
 {
  "title": "Home theatre",
  "section": "Source-level proof",
  "description": "The package test suite covers successful activities, optional degradation, mandatory failure, restart, superse",
  "url": "home-theatre.html#proof",
  "text": "The package test suite covers successful activities, optional degradation, mandatory failure, restart, supersession, stale results, manual ownership, recovery and rolling operational objectives. Privacy boundary This reference describes generalized code behavior only. It intentionally omits device models, room names, addresses, entity identifiers, flow exports, activity history and operational records."
 },
 {
  "title": "Contract examples",
  "description": "Executable, transport-neutral examples of state, intent and evidence across component boundaries.",
  "url": "contract-examples.html",
  "text": "Seven deterministic examples call the same pure reducers used by the Node-RED adapters. Synthetic configuration keeps transport ownership visible."
 },
 {
  "title": "Contract examples",
  "section": "Contract examples",
  "description": "Each example declares configuration, applies deterministic inputs, asserts one consumer-visible invariant and ",
  "url": "contract-examples.html#examples",
  "text": "Each example declares configuration, applies deterministic inputs, asserts one consumer-visible invariant and returns its commands or outputs as JSON. Occupancy fusion Sensor policy Motion establishes occupancy. Optional presence can hold it after motion clears, but cannot establish it alone. Contract presence:on → no output motion:on → occupied:true motion:off → held presence:off → occupied:false Open executable example → Occupancy to lighting intent Motion policy Dark, enabled occupancy produces semantic intent; it does not publish a device command. Contract { occupied: true, trigger: \"motion\" } → { kind: \"intent\", state: \"ON\", targets: [\"ceiling\", \"worktop\"] } Open executable example → Explicit manual brightness Switch policy A classified double action becomes one full-brightness intent with manual ownership. Contract { action: \"double\" } → { state: \"ON\", manual: true, values: { brightnessPct: 100 } } Open executable example → Room lighting boundary Command owner The room controller converts semantic lighting intent into the sole transport command and records its policy source. Contract { kind: \"intent\", state: \"ON\", source: \"motion\" } → { topic: \"demo/lighting/ceiling/set\", lighting_command: { source: \"motion\" } } Open executable example → Media-source evidence Readiness policy Command success enters confirmation. Fresh active-application evidence is what satisfies application readiness. Contract activate → command_result:ok → confirming observed:{ active, application, paused } → ready Open executable example → Bounded receiver volume Command ownership Rapid relative requests accumulate against one target. Fresh confirmation releases ownership so later external adjustment becomes the baseline. Contract relative:+1 → MV31 relative:+1 → MV32 observed MV32 → ready · released observed MV28 → −52 dB, the external baseline Open executable example → Theatre activity Coordination One activity request fans out semantic target intents and reaches ready only from fresh mandatory evidence. Contract movie_night request → display · receiver · source · lighting · backlighting → fresh target evidence → { phase: \"ready\", availability: \"available\" } Open executable example →"
 },
 {
  "title": "Contract examples",
  "section": "Run the contracts",
  "description": "The aggregate command compiles the package, executes all seven examples and fails if an asserted invariant cha",
  "url": "contract-examples.html#run",
  "text": "The aggregate command compiles the package, executes all seven examples and fails if an asserted invariant changes. Terminal npm ci npm run examples"
 },
 {
  "title": "Contract examples",
  "section": "What the examples preserve",
  "description": "Policy before transport Sensor and user events become semantic outcomes before a target owner selects a protoc",
  "url": "contract-examples.html#preserve",
  "text": "Policy before transport Sensor and user events become semantic outcomes before a target owner selects a protocol. Evidence before ready Command acceptance never substitutes for a fresh observation of the required state. Finite state Timers, retries, generations and traces remain bounded and stale work stays inert. Privacy boundary Every identifier, topic, profile, timestamp and coordinate in these examples is synthetic. The examples contain no device inventory, addresses, credentials, entity identifiers, flow exports or operational records."
 },
 {
  "title": "Roadmap",
  "description": "The public progress record: released components and the milestone roadmap.",
  "url": "roadmap.html",
  "text": "What is complete, next and planned. Milestone badges report delivery progress; release badges show what the package includes."
 },
 {
  "title": "Roadmap",
  "section": "Component roadmap",
  "description": "Milestone badges report delivery progress, independently of the release badges in the portfolio below. Candida",
  "url": "roadmap.html#milestones",
  "text": "Milestone badges report delivery progress, independently of the release badges in the portfolio below. Candidate components keep transport, policy, observed state and recovery explicit before joining the package. Milestone complete Contract examples Transport-neutral examples cover room lighting, occupancy, switch gestures, source readiness, volume ownership and coordinated activities. Milestone complete Volume ownership Absolute and relative requests share one bounded command owner, confirm from fresh evidence and preserve external adjustments. Milestone complete Switch-state observability Wall-input reducers preserve restart baselines, distinguish retained replay, refresh duplicate evidence and expose freshness or explicit unavailability. Milestone complete Home Assistant integration Home Assistant is an optional view and control panel: each node can publish its state and announce entities, and Home Assistant controls send MQTT messages that the nodes act on, never commands to devices. Entities report availability, keep stable identifiers through renames, and are cleaned up when their node is removed. Rooms expose circadian and sleep switches and wake and bed times; occupancy, motion, receiver volume and covers have their own entities. Milestone complete Blind and cover control Covers have their own nodes. A cover controller owns one blind, shutter or curtain motor: positions and named presets, open/close-only motors judged honestly from what they report, a moving signal other policies can react to, and a person's move left where they put it. A cover group moves several covers as one and says which confirmed. Each cover can also appear in Home Assistant as a cover entity, whose controls come back to the cover node as requests. Next Device-agnostic core Separate decision logic from devices. Policies and controllers speak a neutral vocabulary of targets, intents and observations; a translation layer maps them to specific protocols, vendors and dashboards. Each part stays usable on its own, defaults name no rooms or devices, and powered devices are modelled from observed power. Planned Device adapters Small device nodes that connect the controllers to real devices over MQTT, so a relay module in cover mode or a Zigbee2MQTT cover wires straight in without function nodes. Each adapter knows one kind of device, and the controllers stay device-neutral. Planned Adaptive covers A policy that decides when covers move, from window contacts, a schedule, an enable switch and readings such as sun or temperature, and asks the cover nodes to move them. A person's move is respected, restarts and repeated messages are handled, and a cover never closes onto an open window. Planned Scenes with restore A scene temporarily owns a set of targets, such as lights or motion enablement, and records their observed state. Ending it, by request, a safety timer or a configured trigger, restores every target. Overlapping scenes stack: the newest owns shared targets and hands them back to the one beneath. Queued Grouped audio Model membership, synchronization and partial failure without hiding which players are unavailable. Planned Water irrigation Run garden zones from schedules and soil or rain evidence, one valve owner per zone. Each run is bounded, confirmed from the valve's observed state, and skipped or cut short when rain or moisture says it isn't needed. A person's manual run takes over until it ends. Planned Heating and climate Hold each room at a scheduled temperature from observed temperature and valve state. A person's manual change wins until the next schedule step, and an open window pauses heating instead of fighting it. Planned Humidity-driven ventilation Run extractor fans in bathrooms and kitchens from a rise in humidity and stop them once it falls back, with a bounded run time, a manual boost and a short overrun. Planned Water leak protection Close a main water valve when a leak sensor trips and confirm it closed from the valve's observed state. The alarm stays latched until a person clears it, and an unconfirmed close is reported, never assumed. Planned Energy-aware scheduling Run deferrable loads, such as a dishwasher, water heating or vehicle charging, in the cheapest or greenest window from tariff or solar data, finishing before a deadline the user sets."
 },
 {
  "title": "Roadmap",
  "section": "Component portfolio",
  "description": "Portfolio badges show whether a capability is released in the package. Roadmap badges show delivery state. Com",
  "url": "roadmap.html#components",
  "text": "Portfolio badges show whether a capability is released in the package. Roadmap badges show delivery state. Components share explicit ownership, semantic commands, observed completion and bounded recovery. Released Home-theatre orchestration Capability milestone A latest-request-wins activity controller coordinates display, receiver, source, lighting and backlighting target owners without embedding transport-specific commands. Fresh observations gate completion Stale generations are inert Recovery and manual ownership are explicit Read the capability reference → Released Media-player readiness Source policy Gate source completion on fresh availability, active-device, application or playback evidence without moving transport logic into orchestration. Configurable readiness depth Application and playback evidence Honest waiting and unavailable outcomes Released Volume ownership Receiver policy One AVR controller coordinates bounded absolute and relative volume requests without fighting later physical adjustments. Rapid relative input accumulates Configured half-step safety bounds Fresh observation confirms and releases ownership Released Contract examples Consumer reference Run deterministic, transport-neutral examples for occupancy, lighting, switch gestures, source readiness, volume ownership and coordinated activities. Real reducer execution Synthetic configuration Asserted consumer-visible invariants Explore the executable contracts → Released Room lighting control Lighting policies One room controller owns adaptive output while independent switch, motion, schedule and activity policies emit semantic intent. Circadian brightness and colour temperature Per-target manual ownership Reducer-owned duplicate and retained-state handling Restart baseline, freshness and availability evidence Independent switch gestures and occupancy policy Released Occupancy fusion Sensor policy Combine motion triggers with optional presence hold while preserving unknown sensor states and preventing one source from clearing another. Released Metrics, traces and objectives Operational evidence Bounded traces and rolling outcome evaluation expose transition latency, retries, fallbacks, target availability and actionable failure."
 },
 {
  "title": "Roadmap",
  "section": "Public boundary",
  "description": "Pages and repository documentation describe source code and generalized behavior only. Credentials, addresses,",
  "url": "roadmap.html#boundary",
  "text": "Pages and repository documentation describe source code and generalized behavior only. Credentials, addresses, coordinates, entity identifiers, flow exports, installation inventory and operational records remain outside this repository."
 }
];
