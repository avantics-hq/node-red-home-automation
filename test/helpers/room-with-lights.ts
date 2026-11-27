"use strict";

// The room controller with a Zigbee2MQTT light adapter for each light, behind
// the call the room's tests used before 6.0: targets with their Zigbee2MQTT
// topics, reports and other people's commands as the room once took them
// (tagged observed and command-observed), and each light command as the
// adapter publishes it, in the room's old output shape. So the room's
// behaviour is checked end to end, through the adapters, as it was. The
// adapters' state rides along on the room's, as `lights`.
import {isLightReading, type LightRoomMessage} from "../../lib/light-contract";
import type {RoomConfig, RoomMessage, RoomOutput, RoomState} from "../../lib/room-controller";
import {publishRoom as publishRoomOnly, type RoomPublishingConfig} from "../../lib/room-publishing";
import {parseZ2mTargetTopics, transitionZ2mLight, type Z2mLightConfig, type Z2mLightState} from "../../lib/z2m-light-adapter";

export interface TopicTarget {
  id: string;
  stateTopic: string;
  commandTopic: string;
  onOffOnly?: boolean;
}

export type TopicRoomConfig = Omit<RoomConfig, "targets"> & {targets: TopicTarget[]};

export type WithLights = RoomState & {lights?: Record<string, Partial<Z2mLightState>>};

export interface CommandOutput extends RoomOutput {
  lighting_command?: {area: string; target: string; source: string};
}

function adaptersFor(config: TopicRoomConfig): Record<string, Z2mLightConfig> {
  return Object.fromEntries(config.targets.map((target) => {
    const topics = parseZ2mTargetTopics(target.stateTopic, target.commandTopic);
    if (!topics) throw new Error(`test target ${target.id}: topics must be <base>/<name> and <base>/<name>/set`);
    return [target.id, {target: target.id, ...topics, group: false}];
  }));
}

export function publishRoom(
  saved: Partial<WithLights> | undefined,
  msg: RoomMessage & {lighting?: RoomMessage["lighting"] & {retained?: boolean}},
  config: TopicRoomConfig & RoomPublishingConfig,
  now?: Date | string | number
) {
  const adapters = adaptersFor(config);
  const roomConfig = {...config, targets: config.targets.map(({id, onOffOnly}) => ({id, ...(onOffOnly ? {onOffOnly} : {})}))};
  const lights: Record<string, Partial<Z2mLightState> | undefined> = {...(saved?.lights ?? {})};
  let room: Partial<RoomState> | undefined = saved;
  const outputs: CommandOutput[] = [];
  const traces: ReturnType<typeof publishRoomOnly>["traces"] = [];
  let last: ReturnType<typeof publishRoomOnly> | undefined;
  const controlChanged = new Set<string>();
  const queue: Array<{room: RoomMessage} | {light: string; msg: Record<string, unknown>}> = [];

  // Where an old-style message goes: a report or someone's command to the
  // light's adapter, by its topic; anything else to the room.
  const kind = msg.lighting?.kind;
  if (kind === "observed" || kind === "command-observed") {
    const field = kind === "observed" ? "stateTopic" : "commandTopic";
    const target = config.targets.find((entry) => (msg.lighting?.target ? entry.id === msg.lighting.target : entry[field] === msg.topic));
    if (target) {
      queue.push({light: target.id, msg: {topic: kind === "observed" ? target.stateTopic : target.commandTopic, payload: msg.payload,
        retain: msg.retain === true || msg.lighting?.retained === true}});
    }
  } else {
    queue.push({room: msg});
  }
  while (queue.length) {
    const next = queue.shift()!;
    if ("room" in next) {
      const result = publishRoomOnly(room, next.room, roomConfig, now);
      room = result.state;
      last = result;
      traces.push(...result.traces);
      for (const id of result.controlChanged) controlChanged.add(id);
      const controls = result.outputs.filter(({topic}) => topic.endsWith("/control"));
      outputs.push(...result.outputs.filter(({topic}) => !topic.endsWith("/control")));
      // The old room sent no reading requests; the adapters' are tested on their own.
      for (const command of result.commands as LightRoomMessage[]) {
        if (command.kind !== "command") continue;
        const adapter = transitionZ2mLight(lights[command.target], {light: command}, adapters[command.target]!, now);
        lights[command.target] = adapter.state;
        for (const publication of adapter.publications) {
          outputs.push({...publication, lighting_command: {area: config.area, target: command.target, source: command.source}});
        }
        for (const reading of adapter.readings) queue.push({room: {light: reading}});
      }
      outputs.push(...controls);
    } else {
      const adapter = transitionZ2mLight(lights[next.light], next.msg, adapters[next.light]!, now);
      lights[next.light] = adapter.state;
      for (const reading of adapter.readings) if (isLightReading(reading)) queue.push({room: {light: reading}});
    }
  }
  if (!last) {
    // Nothing reached the room (a retained or unreadable message): as it was.
    last = publishRoomOnly(room, {}, roomConfig, now);
    room = last.state;
  }
  const state = Object.assign(last.state, {lights: lights as Record<string, Partial<Z2mLightState>>}) as WithLights;
  return {
    ...last,
    state,
    outputs,
    traces,
    controlChanged: roomConfig.targets.map(({id}) => id).filter((id) => controlChanged.has(id))
  };
}
