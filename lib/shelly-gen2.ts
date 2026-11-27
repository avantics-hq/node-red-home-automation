"use strict";

// What the Shelly Gen2+ adapters share: one component's topics on the
// device's MQTT API, and what a message on them says about its status.
//
// From Shelly's Gen2 API documentation (Mqtt and Notifications):
// - MQTT control commands are text on <prefix>/command/<component>; a
//   "status_update" there makes the device publish the component's full
//   status on <prefix>/status/<component>;
// - changes arrive as NotifyStatus frames on <prefix>/events/rpc, holding
//   only what changed, to be laid over the last full status; a key that has
//   gone is sent as null;
// - <prefix>/online is true once connected, and false (the broker's last
//   will) when it drops.

import {isObject, parsedPayload} from "./mqtt-message";

export function shellyTopics(topicPrefix: string, component: string) {
  return {
    command: `${topicPrefix}/command/${component}`,
    status: `${topicPrefix}/status/${component}`,
    events: `${topicPrefix}/events/rpc`,
    online: `${topicPrefix}/online`,
    component
  };
}

export type ShellyTopics = ReturnType<typeof shellyTopics>;

// A device message as the component's status:
// - "status": a full status (a status_update's answer, or NotifyFullStatus);
// - "change": the last status with a NotifyStatus change laid over it;
// - "online": the device connecting or dropping;
// - "other": a frame for another component, or another message.
// Keys in `keepNull` mean something when null (an unknown position, say),
// so a null there is kept rather than taken as gone.
export type ShellyMessage =
  | {kind: "status"; status: Record<string, unknown>}
  | {kind: "change"; status: Record<string, unknown>; change: Record<string, unknown>}
  | {kind: "online"; online: boolean}
  | {kind: "other"};

export function readShellyMessage(
  msg: {topic?: unknown; payload?: unknown},
  topics: ShellyTopics,
  last: Record<string, unknown> | null,
  keepNull: readonly string[] = []
): ShellyMessage {
  if (msg.topic === topics.status) {
    const status = parsedPayload(msg.payload);
    if (!isObject(status)) throw new Error(`${topics.status} must carry the ${topics.component} status object`);
    return {kind: "status", status: {...status}};
  }
  if (msg.topic === topics.events) {
    const received = parsedPayload(msg.payload);
    const full = isObject(received) && received.method === "NotifyFullStatus";
    const change = isObject(received) && (received.method === "NotifyStatus" || full) && isObject(received.params)
      ? received.params[topics.component] : undefined;
    if (!isObject(change)) return {kind: "other"};
    const status: Record<string, unknown> = full ? {} : {...last};
    for (const [key, value] of Object.entries(change)) {
      if (value === null && !keepNull.includes(key)) delete status[key];
      else status[key] = value;
    }
    return full ? {kind: "status", status} : {kind: "change", status, change};
  }
  if (msg.topic === topics.online) {
    const online = parsedPayload(msg.payload);
    if (online !== true && online !== false) throw new Error(`${topics.online} must be true or false`);
    return {kind: "online", online};
  }
  return {kind: "other"};
}
