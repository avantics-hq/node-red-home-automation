"use strict";

// What device adapters share about MQTT messages: a publication for an
// MQTT out node, and a payload as an MQTT in node hands it over.

export interface MqttPublication {
  topic: string;
  payload: string;
}

// An MQTT in node may hand over a parsed object, a string or a Buffer;
// JSON text is parsed, anything else is returned as it is.
export function parsedPayload(payload: unknown): unknown {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
