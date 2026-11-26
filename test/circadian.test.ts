"use strict";

import assert from "node:assert/strict";
import test from "node:test";
import {scheduledLighting, type CircadianLighting} from "../lib/circadian";
import {alreadyStyled, lightCommand} from "../lib/z2m-light";
import {DEFAULT_BED_TIME, DEFAULT_WAKE_TIME, clockMinutes, resolveSchedule, scheduleLevel} from "../lib/circadian-schedule";
import {styleAtLevel, type LightLevels} from "../lib/light-styling";
import {type RoomConfig} from "../lib/room-controller";
import {publishRoom} from "../lib/room-publishing";

const levels: LightLevels = {sleepBrightnessPct: 1, maxBrightnessPct: 100, sleepColorTempKelvin: 2200, maxColorTempKelvin: 6500};
const clock = (hours: number, minutes = 0) => new Date(2026, 10, 23, hours, minutes);

test("schedule: clock times, defaults and validation", () => {
  assert.equal(clockMinutes("07:30"), 450);
  assert.equal(clockMinutes(" 23:59 "), 1439);
  assert.equal(clockMinutes("24:00"), null);
  assert.equal(clockMinutes("7:30"), null);
  assert.equal(clockMinutes(730), null);
  assert.deepEqual(resolveSchedule(), {wakeTime: DEFAULT_WAKE_TIME, bedTime: DEFAULT_BED_TIME});
  assert.deepEqual(resolveSchedule("", "01:00"), {wakeTime: "07:00", bedTime: "01:00"});
  assert.throws(() => resolveSchedule("7am", "23:00"), /HH:MM/);
  assert.throws(() => resolveSchedule("07:00", "07:00"), /differ/);
  assert.equal(scheduleLevel(clock(13), "07:00", "23:00"), 1);
  assert.equal(scheduleLevel(clock(3), "07:00", "23:00"), 0);
});

test("styling: level 0 is the sleep settings, level 1 the daytime ones, colour even in mireds", () => {
  // The style is in percent and kelvin; a Zigbee2MQTT light gets 1-254 and mireds.
  const device = (level: number, settings = levels) => lightCommand("ON", styleAtLevel(level, settings), 0);
  assert.deepEqual([styleAtLevel(0, levels).brightnessPct, Math.round(styleAtLevel(0, levels).colorTempKelvin)], [levels.sleepBrightnessPct, 2200]);
  assert.deepEqual([device(0).brightness, device(0).color_temp], [3, Math.round(1_000_000 / 2200)]);
  assert.deepEqual([device(1).brightness, device(1).color_temp], [254, Math.round(1_000_000 / 6500)]);
  assert.equal(device(0.5).color_temp, Math.round((1_000_000 / 2200 + 1_000_000 / 6500) / 2));
  // Brightness stays on the 1-254 scale.
  assert.equal(device(0, {...levels, sleepBrightnessPct: 0}).brightness, 1);
  assert.equal(device(1, {...levels, maxBrightnessPct: 150}).brightness, 254);
});

test("refresh rule: only a light that reports the exact style is skipped", () => {
  // 128 and 300 mireds on a Zigbee2MQTT light.
  const style = {brightnessPct: 128 * 100 / 254, colorTempKelvin: 1_000_000 / 300};
  assert.equal(alreadyStyled(style, {on: true, brightness: 128, color_temp: 300}), true);
  assert.equal(alreadyStyled(style, {on: true, brightness: "128", color_temp: "300"}), true);
  assert.equal(alreadyStyled(style, {on: true, brightness: 127, color_temp: 300}), false);
  assert.equal(alreadyStyled(style, {on: true, brightness: 128, color_temp: null}), false);
  assert.equal(alreadyStyled(style, {on: false, brightness: 128, color_temp: 300}), false);
  assert.equal(alreadyStyled(style, undefined), false);
});

test("scheduled lighting holds the sleep settings in sleep mode", () => {
  const lighting = scheduledLighting({wakeTime: "07:00", bedTime: "23:00"}, levels);
  assert.deepEqual(lighting.styleAt(clock(13), false), styleAtLevel(1, levels));
  assert.deepEqual(lighting.styleAt(clock(13), true), styleAtLevel(0, levels));
});

test("the room controller uses whatever circadian lighting it is given", () => {
  // A different curve is a different implementation, not an edit to the controller.
  const fixed: CircadianLighting = {
    styleAt: () => ({brightnessPct: 77 * 100 / 254, colorTempKelvin: 1_000_000 / 333}),
    withSchedule() { return fixed; }
  };
  const config: RoomConfig = {
    area: "room", displayName: "Room", initialSleep: false,
    targets: [{id: "main", stateTopic: "room/light/main", commandTopic: "room/light/main/set"}],
    refreshTransitionSeconds: 60, initialTransitionSeconds: 1, lighting: fixed
  };
  const result = publishRoom(undefined, {lighting: {kind: "intent", targets: ["main"], state: "ON", source: "motion"}}, config, clock(3));
  const command = result.outputs.find((entry) => entry.lighting_command)?.payload as Record<string, unknown>;
  assert.equal(command.brightness, 77);
  assert.equal(command.color_temp, 333);
});
