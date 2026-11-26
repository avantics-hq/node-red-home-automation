"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {DisplayTransport} from "../lib/transports/display-transport";

interface RequestRecord {
  url: string;
  method: string;
  psk: string | null;
  body?: Record<string, unknown>;
}

type FakeHandler = (request: Request) => Promise<Response> | Response;

// Device responses without a socket: requests and responses still go through
// Node's real Request/Response serialisation.
function fakeFetch(handler: FakeHandler): typeof globalThis.fetch {
  return async (input, init) => handler(new Request(input, init));
}

function transport(fetch: typeof globalThis.fetch): DisplayTransport {
  return new DisplayTransport({
    tvHost: "tv.test:8080",
    tvPsk: "test-secret",
    screenHost: "screen.test",
    projectorMeterHost: "meter.test",
    timeoutMs: 1000,
    fetch
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});
}

test("direct transport queries and commands the Bravia and both Shelly devices", async () => {
  const requests: RequestRecord[] = [];
  const display = transport(fakeFetch(async (request) => {
    const url = new URL(request.url);
    const record: RequestRecord = {
      url: `${url.pathname}${url.search}`,
      method: request.method,
      psk: request.headers.get("x-auth-psk")
    };
    if (request.method === "POST") record.body = await request.json() as Record<string, unknown>;
    requests.push(record);
    if (record.url === "/sony/system") {
      return json(record.body?.method === "getPowerStatus"
        ? {result: [{status: "active"}], id: 50}
        : {result: [0], id: 55});
    }
    if (record.url === "/rpc/Cover.GetStatus?id=0") return json({state: "stopped", current_pos: 82});
    if (record.url === "/rpc/Cover.GoToPosition") return json(null);
    if (record.url === "/rpc/Switch.GetStatus?id=1") return json({apower: 2.1});
    return json({}, 404);
  }));

  const base = {generation: 7};
  const tv = await display.execute({...base, device: "tv", operation: "query_power"});
  const screen = await display.execute({...base, device: "screen", operation: "query_position"});
  const projector = await display.execute({...base, device: "projector", operation: "query_power"});
  const tvSet = await display.execute({...base, device: "tv", operation: "set_power", power: "standby"});
  const screenSet = await display.execute({...base, device: "screen", operation: "set_position", position: 82});

  assert.ok(tv);
  assert.ok(screen);
  assert.ok(projector);
  assert.ok(tv.display?.kind === "observed");
  assert.ok(screen.display?.kind === "observed");
  assert.ok(projector.display?.kind === "observed");
  assert.equal(tv.display.power, "on");
  assert.equal(screen.display.position, 82);
  assert.equal(projector.display.watts, 2.1);
  assert.equal(tvSet, null);
  assert.equal(screenSet, null);
  assert.equal(requests.filter((entry) => entry.url === "/sony/system").every((entry) => entry.psk === "test-secret"), true);
  assert.equal(requests.filter((entry) => entry.url !== "/sony/system").every((entry) => entry.psk === null), true);
  assert.deepEqual(
    requests.find((entry) => entry.url === "/rpc/Cover.GoToPosition")?.body,
    {id: 0, pos: 82}
  );
  assert.equal(JSON.stringify([tv, screen, projector]).includes("test-secret"), false);
});

test("transport failures are classified without leaking credentials or response bodies", async () => {
  const display = transport(fakeFetch(() => new Response("sensitive device detail", {status: 500})));
  const result = await display.execute({device: "tv", operation: "query_power", generation: 1});
  assert.ok(result);
  assert.deepEqual(result.display, {
    kind: "transport_failed",
    device: "tv",
    operation: "query_power",
    generation: 1,
    reason: "http_500"
  });
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  assert.equal(JSON.stringify(result).includes("sensitive"), false);
});

test("unusable Shelly replies are transport failures, never position 0 or NaN", async () => {
  const replies: Record<string, unknown> = {cover: {current_pos: null, state: "stopped"}, power: {}};
  const display = transport(fakeFetch(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("Cover.GetStatus")) return json(replies.cover);
    if (url.pathname.endsWith("Switch.GetStatus")) return json(replies.power);
    return json({}, 404);
  }));
  const base = {generation: 7};
  const screen = await display.execute({...base, device: "screen", operation: "query_position"});
  const projector = await display.execute({...base, device: "projector", operation: "query_power"});
  assert.deepEqual(screen?.display, {kind: "transport_failed", device: "screen", operation: "query_position", generation: 7, reason: "invalid_screen_position"});
  assert.deepEqual(projector?.display, {kind: "transport_failed", device: "projector", operation: "query_power", generation: 7, reason: "invalid_projector_power"});

  replies.cover = {current_pos: 101};
  const outOfRange = await display.execute({...base, device: "screen", operation: "query_position"});
  assert.equal(outOfRange?.display?.kind, "transport_failed");
});
