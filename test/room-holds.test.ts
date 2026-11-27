"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {addOwner, heldOff, legacyHold, newHold, releaseOwner, savedHolds, setOwnerSpec} from "../lib/room-holds";

const before = {control: "in-control" as const, on: true};

test("owners stack: a newer one goes on top, and the same owner again stays where it is", () => {
  const hold = newHold("film", before);
  assert.equal(addOwner(hold, "film"), "top");
  assert.equal(addOwner(hold, "reading"), "pushed");
  assert.equal(addOwner(hold, "film"), "beneath");
  assert.deepEqual(hold.owners.map(({owner}) => owner), ["film", "reading"]);
  setOwnerSpec(hold, "reading", {state: "OFF"});
  assert.equal(heldOff(hold), true);
  setOwnerSpec(hold, "film", {state: "ON", brightnessPct: 12, extra: {effect: "okay"}});
  assert.equal(heldOff(hold), true, "the owner on top decides");
});

test("releasing the top hands the light to the owner beneath, with its last request", () => {
  const hold = newHold("film", before);
  addOwner(hold, "reading");
  setOwnerSpec(hold, "film", {state: "ON", brightnessPct: 12});
  assert.deepEqual(releaseOwner(hold, "reading"), {kind: "next", owner: "film", spec: {state: "ON", brightnessPct: 12}});
  assert.deepEqual(releaseOwner(hold, "film"), {kind: "restore", before});
});

test("releasing an owner beneath drops it; an unknown owner changes nothing; no owner lets go of all", () => {
  const hold = newHold("film", before);
  addOwner(hold, "reading");
  assert.deepEqual(releaseOwner(hold, "bath"), {kind: "none"});
  assert.deepEqual(releaseOwner(hold, "film"), {kind: "dropped"});
  assert.deepEqual(hold.owners.map(({owner}) => owner), ["reading"]);
  addOwner(hold, "film");
  assert.deepEqual(releaseOwner(hold, null), {kind: "restore", before});
});

test("saved holds load for overridden lights only, and a 6.0.0 hold knows nothing of before", () => {
  const saved = JSON.parse(JSON.stringify({lamp: newHold("film", before), wall: newHold("film", before), bad: {owners: []}}));
  assert.deepEqual(Object.keys(savedHolds(saved, (target) => target !== "wall")), ["lamp"]);
  assert.deepEqual(savedHolds(undefined, () => true), {});
  assert.deepEqual(releaseOwner(legacyHold("film"), "film"), {kind: "restore", before: null});
});
