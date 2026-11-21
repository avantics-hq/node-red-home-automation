"use strict";

import assert from "node:assert/strict";
import http, {
  type IncomingMessage,
  type RequestListener,
  type ServerResponse
} from "node:http";
import test from "node:test";
import type {AddressInfo} from "node:net";
import {DisplayTransport} from "../lib/display-transport";

interface RequestRecord {
  url: string | undefined;
  method: string | undefined;
  psk: string | string[] | undefined;
  body?: Record<string, unknown>;
}

async function withServer(
  handler: RequestListener,
  run: (host: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("direct transport queries and commands the Bravia and both Shelly devices", async () => {
  const requests: RequestRecord[] = [];
  await withServer(async (request, response) => {
    const record: RequestRecord = {
      url: request.url,
      method: request.method,
      psk: request.headers["x-auth-psk"]
    };
    if (request.method === "POST") record.body = await body(request);
    requests.push(record);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/sony/system") {
      response.end(JSON.stringify(record.body?.method === "getPowerStatus"
        ? {result: [{status: "active"}], id: 50}
        : {result: [0], id: 55}));
    } else if (request.url === "/rpc/Cover.GetStatus?id=0") {
      response.end(JSON.stringify({state: "stopped", current_pos: 82}));
    } else if (request.url === "/rpc/Cover.GoToPosition") {
      response.end("{}");
    } else if (request.url === "/rpc/Switch.GetStatus?id=1") {
      response.end(JSON.stringify({apower: 2.1}));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  }, async (host) => {
    const transport = new DisplayTransport({
      tvHost: host,
      tvPsk: "test-secret",
      screenHost: host,
      projectorMeterHost: host,
      timeoutMs: 1000
    });
    const base = {generation: 7};
    const tv = await transport.execute({...base, device: "tv", operation: "query_power"});
    const screen = await transport.execute({...base, device: "screen", operation: "query_position"});
    const projector = await transport.execute({...base, device: "projector", operation: "query_power"});
    const tvSet = await transport.execute({...base, device: "tv", operation: "set_power", power: "standby"});
    const screenSet = await transport.execute({...base, device: "screen", operation: "set_position", position: 82});

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
    assert.deepEqual(
      requests.find((entry) => entry.url === "/rpc/Cover.GoToPosition")?.body,
      {id: 0, pos: 82}
    );
    assert.equal(JSON.stringify([tv, screen, projector]).includes("test-secret"), false);
  });
});

test("transport failures are classified without leaking credentials or response bodies", async () => {
  await withServer((_request: IncomingMessage, response: ServerResponse) => {
    response.statusCode = 500;
    response.end("sensitive device detail");
  }, async (host) => {
    const transport = new DisplayTransport({
      tvHost: host,
      tvPsk: "test-secret",
      screenHost: host,
      projectorMeterHost: host,
      timeoutMs: 1000
    });
    const result = await transport.execute({device: "tv", operation: "query_power", generation: 1});
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
});
