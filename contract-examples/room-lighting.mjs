import {scheduledLighting} from "../dist/lib/circadian.js";
import {resolveSchedule} from "../dist/lib/circadian-schedule.js";
import {transitionCircadian} from "../dist/lib/circadian-policy.js";
import {transitionRoom} from "../dist/lib/room-controller.js";
import {normaliseZ2mLightConfig, transitionZ2mLight} from "../dist/lib/z2m-light-adapter.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "room-lighting";

export function run() {
  const configuration = {
    area: "demo_room",
    displayName: "Demo Room",
    targets: [{id: "ceiling"}],
    initialTransitionSeconds: 1
  };
  const schedule = resolveSchedule("07:00", "23:00");
  const now = "2026-03-20T10:00:00Z";
  // A circadian lighting policy sends the room how lights should look now; the
  // room uses it for lights it controls.
  const policy = {
    lighting: scheduledLighting(schedule, {
      sleepBrightnessPct: 5,
      maxBrightnessPct: 100,
      sleepColorTempKelvin: 1800,
      maxColorTempKelvin: 5000
    }),
    schedule,
    timesFrom: "own",
    initialSleep: false,
    transitionSeconds: 30,
    intervalSeconds: 60
  };
  const style = {lighting: transitionCircadian(undefined, {kind: "tick"}, policy, now).style};
  const input = {
    lighting: {
      kind: "intent",
      targets: ["ceiling"],
      state: "ON",
      source: "motion"
    }
  };
  assert.equal(style.lighting.until, "2026-03-20T10:03:00.000Z");
  const styled = transitionRoom(undefined, style, configuration, now);
  assert.equal(styled.commands.length, 0);
  const result = transitionRoom(styled.state, input, configuration, now);
  // The room's neutral command, for the light's adapter.
  assert.equal(result.commands.length, 1);
  const command = result.commands[0];
  assert.equal(command.kind, "command");
  assert.equal(command.target, "ceiling");
  assert.equal(command.state, "ON");
  assert.equal(command.source, "motion");
  // The Zigbee2MQTT light adapter turns it into the light's own message.
  const light = normaliseZ2mLightConfig({target: "ceiling", baseTopic: "demo", friendlyName: "ceiling"});
  const outputs = transitionZ2mLight(undefined, {light: command}, light, now).publications;
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].topic, "demo/ceiling/set");
  assert.equal(outputs[0].payload.state, "ON");
  assert.equal(typeof outputs[0].payload.brightness, "number");

  return {
    configuration: {
      area: configuration.area,
      targets: configuration.targets.map(({id}) => id),
      schedule
    },
    inputs: [style, input],
    commands: result.commands,
    outputs,
    invariant: "The room controller owns its lights' commands and records the policy source; a style only shapes how its lights look; each light's adapter speaks the device's own messages."
  };
}

runWhenMain(import.meta.url, name, run);
