"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {
  transitionOccupancy,
  type OccupancyConfig,
  type OccupancyOutput
} from "../lib/occupancy-fusion";

const pirOnly: OccupancyConfig = {presenceMode: "ignore"};
const pirAndPresence: OccupancyConfig = {presenceMode: "hold"};

function occupancy(result: ReturnType<typeof transitionOccupancy>): OccupancyOutput["payload"][] {
  return result.outputs.map((message) => message.payload);
}

test("PIR-only occupancy follows motion edges", () => {
  const active = transitionOccupancy(undefined, {source: "motion", payload: {motion: true}}, pirOnly);
  assert.deepEqual(occupancy(active), [{
    kind: "occupancy",
    occupied: true,
    trigger: "motion",
    reason: "motion-active",
    sources: {motion: true, presence: null}
  }]);

  const inactive = transitionOccupancy(active.state, {source: "motion", payload: {motion: false}}, pirOnly);
  assert.equal(occupancy(inactive)[0]!.occupied, false);
  assert.equal(occupancy(inactive)[0]!.reason, "all-sources-inactive");
});

test("presence holds motion-established occupancy but cannot establish it", () => {
  const presence = transitionOccupancy(undefined, {source: "presence", payload: {presence: true}}, pirAndPresence);
  assert.equal(occupancy(presence).length, 0);
  assert.equal(presence.state.occupied, false);

  const motionOn = transitionOccupancy(presence.state, {source: "motion", payload: {motion: true}}, pirAndPresence);
  const motionOff = transitionOccupancy(motionOn.state, {source: "motion", payload: {motion: false}}, pirAndPresence);
  assert.equal(occupancy(motionOff).length, 0);
  assert.equal(motionOff.state.occupied, true);

  const presenceOff = transitionOccupancy(motionOff.state, {source: "presence", payload: {presence: false}}, pirAndPresence);
  assert.equal(occupancy(presenceOff)[0]!.occupied, false);
});

test("a new PIR edge retriggers while presence holds occupancy", () => {
  let result = transitionOccupancy(undefined, {source: "motion", payload: true}, pirAndPresence);
  result = transitionOccupancy(result.state, {source: "presence", payload: true}, pirAndPresence);
  result = transitionOccupancy(result.state, {source: "motion", payload: false}, pirAndPresence);
  result = transitionOccupancy(result.state, {source: "motion", payload: true}, pirAndPresence);

  assert.equal(occupancy(result).length, 1);
  assert.equal(occupancy(result)[0]!.trigger, "motion");
});

test("unknown and unavailable sensor states do not clear occupancy", () => {
  const active = transitionOccupancy(undefined, {source: "motion", payload: "on"}, pirOnly);
  const unknown = transitionOccupancy(active.state, {source: "motion", payload: "unavailable"}, pirOnly);

  assert.equal(unknown.state.occupied, true);
  assert.equal(occupancy(unknown).length, 0);
  assert.equal(unknown.traces[0]!.reason, "unknown-state");
});
