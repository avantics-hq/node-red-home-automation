"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  POWER_ON,
  POWER_STANDBY,
  QUERY_COMMAND,
  ZONE_ON,
  formatVolumeCommand,
  parseAvrLine,
  parseSourceCodes,
  roundVolume,
  selectSource
} from "../lib/denon-protocol";

test("commands end in a carriage return", () => {
  assert.equal(QUERY_COMMAND, "PW?\rZM?\rSI?\rMV?\r");
  assert.equal(POWER_ON, "PWON\r");
  assert.equal(POWER_STANDBY, "PWSTANDBY\r");
  assert.equal(ZONE_ON, "ZMON\r");
  assert.equal(selectSource("SAT/CBL"), "SISAT/CBL\r");
});

test("volume uses half steps both ways", () => {
  assert.equal(roundVolume(31.3), 31.5);
  for (const volume of [0, 5, 31, 31.5, 98]) {
    const command = formatVolumeCommand(volume).trim();
    assert.equal(parseAvrLine(command, {})?.value, volume, command);
  }
  assert.throws(() => formatVolumeCommand(99), /half-step/);
});

test("status lines map to fields, and unknown lines to nothing", () => {
  const sources = {shield: "SAT/CBL"};
  assert.deepEqual(parseAvrLine("PWOFF", sources), {field: "power", value: "standby", line: "PWOFF"});
  assert.deepEqual(parseAvrLine("ZMOFF", sources), {field: "mainZone", value: "off", line: "ZMOFF"});
  assert.deepEqual(parseAvrLine("SIGAME", sources), {field: "source", value: null, sourceCode: "GAME", line: "SIGAME"});
  assert.equal(parseAvrLine("MSSTEREO", sources), null);
});

test("source codes must be valid and unique", () => {
  assert.deepEqual(parseSourceCodes({shield: "SAT/CBL", game: "GAME"}), {shield: "SAT/CBL", game: "GAME"});
  assert.deepEqual(parseSourceCodes(undefined), {});
  assert.throws(() => parseSourceCodes({shield: "sat"}), /Denon source codes/);
  assert.throws(() => parseSourceCodes({a: "GAME", b: "GAME"}), /unique/);
});
