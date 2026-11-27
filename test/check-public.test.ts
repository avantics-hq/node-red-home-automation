"use strict";

import assert from "node:assert/strict";
import {resolve} from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";

type ScanText = (file: string, text: string) => string[];

async function scanner(): Promise<ScanText> {
  const module = await import(pathToFileURL(resolve(__dirname, "../../scripts/check-public.mjs")).href) as {scanText: ScanText};
  return module.scanText;
}

const ruleOf = (finding: string) => finding.replace(/^[^:]+:\d+: /, "");

// One private detail per line; every line must be caught, by the named rule.
// A "|" breaks each sample in this source so the repository scan does not
// flag the fixture itself; it is removed before scanning.
const positives: Array<[string, string]> = ([
  ["fd12:|3456:789a:1::1", "private IPv6 address"],
  ["fe80:|:1ff:fe23:4567:890a", "private IPv6 address"],
  ["host: kitchen-hub.lo|cal", "local network hostname"],
  ["http://nas.la|n:8080/", "local network hostname"],
  ["mac 3c:22:fb:01:|ab:cd", "MAC address"],
  ["mac 3C-22-FB-01-|AB-CD", "MAC address"],
  ["contact jane.doe@gm|ail.com", "email address"],
  ["ieee 0x00158d00|01a2b3c4", "Zigbee IEEE address"],
  ["entity light.|living_room", "Home Assistant entity identifier"],
  ["entity sensor.|hall_motion_occupancy", "Home Assistant entity identifier"],
  ["entity media_player.|tv", "Home Assistant entity identifier"],
  ["topic zigbee2|mqtt/Living Room Lamp/set", "Zigbee2MQTT device topic"],
  ["{\"latitude\": 51.507|351}", "high-precision location coordinate"],
  ["{\"longitude\": -0.127|758}", "high-precision location coordinate"],
  ["addr 100.64.|12.34", "carrier-grade NAT address"],
  ["addr 100.127.|255.1", "carrier-grade NAT address"],
  ["topic zigbee2|mqtt/&lt;study_blind/set", "Zigbee2MQTT device topic"]
] as Array<[string, string]>).map(([line, rule]) => [line.replace("|", ""), rule]);

// Look alike but name nothing private.
const negatives = [
  "docs at example.com and noreply@example.com",
  "commit by 4588308+someone@users.noreply.github.com",
  "dev-build@node-red-home-automation.invalid and tester@screen.test",
  "files package-lock.json and home-automation.git",
  "code select.payload and cover.observedAt",
  "service remote.send_command and light.turn_on",
  "host localhost and http://localhost:1880",
  "topic zigbee2mqtt/bridge/state and zigbee2mqtt/<device>",
  "page <code>zigbee2mqtt/&lt;device&gt;/set</code> and zigbee2mqtt/&lt;your cover&gt;/availability",
  "public 100.63.0.1 and 100.128.0.1",
  "time 12:34:56 and version 1.2.3.4.5.6",
  "latitude: 51.5074 (four decimals)",
  "fe80 alone, fd is a word"
];

test("the public scan catches each kind of private detail", async () => {
  const scanText = await scanner();
  for (const [line, rule] of positives) {
    const findings = scanText("sample.md", line).map(ruleOf);
    assert.ok(findings.includes(rule), `${JSON.stringify(line)} -> ${JSON.stringify(findings)}`);
  }
  // The review's sample: one finding per line, at that line.
  const text = positives.map(([line]) => line).join("\n");
  const lines = new Set(scanText("sample.md", text).map((finding) => Number(finding.split(":")[1])));
  assert.equal(lines.size, positives.length);
});

test("the public scan leaves documentation look-alikes alone", async () => {
  const scanText = await scanner();
  for (const line of negatives) {
    assert.deepEqual(scanText("sample.md", line), [], line);
  }
});

test("Pages may name device brands, but no room", async () => {
  const scanText = await scanner();
  const pageLabel = "deployment-specific room name in Pages";
  for (const file of ["docs/guide.html", "docs-src/pages/guide.html"]) {
    for (const line of ["Wire the shelly cover node", "a Shelly relay in detached mode", "Shelly Plus 2PM", "Denon receiver", "type home-shelly-cover", "Wire the shelly switch node", "type home-shelly-switch"]) {
      assert.deepEqual(scanText(file, line), [], `${file}: ${line}`);
    }
    for (const line of ["the Kitchen blind", "Hallway lights", "the lounge receiver"]) {
      assert.deepEqual(scanText(file, line).map(ruleOf), [pageLabel], `${file}: ${line}`);
    }
  }
  // Pages rules apply to the site only.
  assert.deepEqual(scanText("README.md", "A Shelly Gen2 or later device"), []);
});
