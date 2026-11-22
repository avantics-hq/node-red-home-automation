import {transitionMotion} from "../dist/lib/motion-policy.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "motion-lighting";

export function run() {
  const configuration = {
    onTargets: ["ceiling", "worktop"],
    offTargets: ["ceiling", "worktop", "accent"],
    defaultIlluminanceCutoff: 120,
    defaultDelaySeconds: 45,
    switchWindowMs: 500,
    switchFreshnessMs: 60_000
  };
  const inputs = [
    {source: "illuminance", payload: 35},
    {source: "occupancy", payload: {occupied: true, trigger: "motion"}}
  ];
  let result = transitionMotion(undefined, inputs[0], configuration, true, 1000);
  result = transitionMotion(result.state, inputs[1], configuration, result.globalEnabled, 2000);
  const outputs = result.effects
    .filter(({kind}) => kind === "send")
    .map(({message}) => message);

  assert.deepEqual(outputs, [{
    lighting: {
      kind: "intent",
      targets: ["ceiling", "worktop"],
      state: "ON",
      source: "motion"
    }
  }]);

  return {
    configuration,
    inputs,
    outputs,
    invariant: "The policy emits semantic lighting intent only when occupancy is enabled and dark enough."
  };
}

runWhenMain(import.meta.url, name, run);
