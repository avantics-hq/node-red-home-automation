import {scheduledLighting} from "../dist/lib/circadian.js";
import {resolveSchedule} from "../dist/lib/circadian-schedule.js";
import {transitionRoom} from "../dist/lib/room-controller.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "room-lighting";

export function run() {
  const configuration = {
    area: "demo_room",
    displayName: "Demo Room",
    targets: [{
      id: "ceiling",
      stateTopic: "demo/lighting/ceiling/state",
      commandTopic: "demo/lighting/ceiling/set"
    }],
    initialTransitionSeconds: 1
  };
  const schedule = resolveSchedule("07:00", "23:00");
  const now = "2026-03-20T10:00:00Z";
  // A circadian lighting policy sends the room how lights should look now; the
  // room uses it for lights it controls.
  const values = scheduledLighting(schedule, {
    sleepBrightnessPct: 5,
    maxBrightnessPct: 100,
    sleepColorTempKelvin: 1800,
    maxColorTempKelvin: 5000
  }).styleAt(new Date(now), false);
  const style = {
    lighting: {kind: "style", source: "circadian", values, transitionSeconds: 30, until: "2026-03-20T10:03:00Z"}
  };
  const input = {
    lighting: {
      kind: "intent",
      targets: ["ceiling"],
      state: "ON",
      source: "motion"
    }
  };
  const styled = transitionRoom(undefined, style, configuration, now);
  assert.equal(styled.outputs.length, 0);
  const result = transitionRoom(styled.state, input, configuration, now);
  const outputs = result.outputs.map(({topic, payload, retain, lighting_command}) => ({
    topic,
    payload,
    retain,
    lighting_command
  }));

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].topic, "demo/lighting/ceiling/set");
  assert.equal(outputs[0].payload.state, "ON");
  assert.equal(typeof outputs[0].payload.brightness, "number");
  assert.equal(outputs[0].lighting_command.source, "motion");

  return {
    configuration: {
      area: configuration.area,
      targets: configuration.targets.map(({id}) => id),
      schedule
    },
    inputs: [style, input],
    outputs,
    invariant: "The room controller is the only transport command owner and records the policy source; a style only shapes how its lights look."
  };
}

runWhenMain(import.meta.url, name, run);
