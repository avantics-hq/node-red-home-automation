import {transitionAvr} from "../dist/lib/avr-controller.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "volume-ownership";

export function run() {
  const configuration = {
    area: "media-room",
    sources: {streamer: "MEDIA"},
    retryMs: 1000,
    maxAttempts: 2,
    // In dB; the receiver's 80 is 0 dB.
    minVolumeDb: -70,
    maxVolumeDb: -35
  };
  const inputs = [
    {kind: "observed", line: "PWON\rZMON\rSIMEDIA\rMV30\r"},
    {kind: "volume", requestId: "volume-1", mode: "relative", valueDb: 1},
    {kind: "volume", requestId: "volume-2", mode: "relative", valueDb: 1},
    {kind: "observed", line: "MV32"},
    {kind: "observed", line: "MV28"}
  ];

  let result = transitionAvr(undefined, {avr: inputs[0]}, configuration, "2026-01-01T12:00:00.000Z");
  const commands = [];
  for (const [index, input] of inputs.slice(1).entries()) {
    result = transitionAvr(
      result.state,
      {avr: input},
      configuration,
      `2026-01-01T12:00:0${index + 1}.000Z`
    );
    commands.push(...result.commands.map(({payload, avrCommand}) => ({payload, operation: avrCommand.operation})));
  }

  assert.deepEqual(commands, [
    {payload: "MV31\r", operation: "volume"},
    {payload: "MV32\r", operation: "volume"}
  ]);
  assert.equal(result.state.observed.volume, -52);
  assert.equal(result.state.volumeRequest, null);
  assert.deepEqual(result.state.volumeMetrics, {
    intents: 2,
    commands: 2,
    bounded: 0,
    confirmations: 1,
    externalChanges: 1,
    failures: 0
  });

  return {
    configuration,
    inputs,
    commands,
    outputs: [{observedVolume: result.state.observed.volume, metrics: result.state.volumeMetrics}],
    invariant: "Relative requests accumulate, confirmation releases ownership, and later external adjustment becomes the new baseline."
  };
}

runWhenMain(import.meta.url, name, run);
