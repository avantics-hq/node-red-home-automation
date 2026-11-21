import {transitionOccupancy} from "../dist/lib/occupancy-fusion.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "occupancy-fusion";

export function run() {
  const configuration = {presenceMode: "hold"};
  const inputs = [
    {source: "presence", payload: {presence: true}},
    {source: "motion", payload: {motion: true}},
    {source: "motion", payload: {motion: false}},
    {source: "presence", payload: {presence: false}}
  ];
  let state;
  const outputs = [];

  for (const input of inputs) {
    const result = transitionOccupancy(state, input, configuration);
    state = result.state;
    outputs.push(...result.outputs.map(({payload}) => payload));
  }

  assert.deepEqual(outputs.map(({occupied}) => occupied), [true, false]);
  assert.equal(outputs[0].trigger, "motion");
  assert.equal(outputs[1].reason, "all-sources-inactive");

  return {
    configuration,
    inputs,
    outputs,
    invariant: "Presence can hold motion-established occupancy but cannot establish it."
  };
}

runWhenMain(import.meta.url, name, run);
