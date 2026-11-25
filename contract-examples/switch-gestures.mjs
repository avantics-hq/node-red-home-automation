import {transitionSwitchPolicy} from "../dist/lib/switch-policy.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "switch-gestures";

export function run() {
  const configuration = {targets: ["ceiling"], switchWindowMs: 500, switchFreshnessMs: 60_000};
  const input = {source: "switch-action", payload: {action: "double"}};
  const result = transitionSwitchPolicy(undefined, input, configuration, 1000);
  const outputs = result.effects
    .filter(({kind}) => kind === "send")
    .map(({message}) => message);

  assert.deepEqual(outputs, [{
    lighting: {
      kind: "intent",
      targets: ["ceiling"],
      state: "ON",
      source: "wall",
      person: true,
      manual: true,
      values: {brightnessPct: 100}
    }
  }]);

  return {
    configuration,
    inputs: [input],
    outputs,
    invariant: "A double action requests explicit full brightness and manual ownership."
  };
}

runWhenMain(import.meta.url, name, run);
