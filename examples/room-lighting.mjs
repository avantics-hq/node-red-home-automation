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
    initialSleep: false,
    latitude: 0,
    longitude: 0,
    sleepBrightnessPct: 5,
    maxBrightnessPct: 100,
    minBrightnessPct: 10,
    sleepColorTempKelvin: 1800,
    minColorTempKelvin: 2200,
    maxColorTempKelvin: 5000,
    refreshTransitionSeconds: 30,
    initialTransitionSeconds: 1
  };
  const input = {
    lighting: {
      kind: "intent",
      targets: ["ceiling"],
      state: "ON",
      source: "motion"
    }
  };
  const result = transitionRoom(undefined, input, configuration, "2026-03-20T10:00:00Z");
  const outputs = result.outputs.map(({topic, payload, retain, lighting_command}) => ({
    topic,
    payload,
    retain,
    lighting_command
  }));

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].topic, "demo/lighting/ceiling/set");
  assert.equal(outputs[0].payload.state, "ON");
  assert.equal(outputs[0].lighting_command.source, "motion");

  return {
    configuration: {
      area: configuration.area,
      targets: configuration.targets.map(({id}) => id),
      solarCoordinates: "deployment-supplied"
    },
    inputs: [input],
    outputs,
    invariant: "The room controller is the only transport command owner and records the policy source."
  };
}

runWhenMain(import.meta.url, name, run);
