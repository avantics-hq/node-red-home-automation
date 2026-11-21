import {transitionSource} from "../dist/lib/source-capability-controller.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "source-readiness";

export function run() {
  const configuration = {
    sources: {
      streamer: {
        activation: "command",
        deactivation: "command",
        confirmation: "application"
      }
    },
    pollMs: 1000,
    confirmationTimeoutMs: 5000,
    maxAttempts: 2
  };
  const intent = {
    kind: "intent",
    requestId: "watch-1",
    generation: 1,
    sourceId: "streamer",
    action: "activate"
  };
  let result = transitionSource(undefined, {sourceCapability: intent}, configuration, "2026-01-01T12:00:00.000Z");
  const commands = [...result.commands];
  result = transitionSource(result.state, {sourceCapability: {
    kind: "command_result",
    generation: 1,
    sourceId: "streamer",
    ok: true
  }}, configuration, "2026-01-01T12:00:00.100Z");
  result = transitionSource(result.state, {sourceCapability: {
    kind: "observed",
    generation: 1,
    sourceId: "streamer",
    status: "active",
    observedAt: "2026-01-01T12:00:00.200Z",
    application: "player.example",
    playback: "paused"
  }}, configuration, "2026-01-01T12:00:00.200Z");
  const evidence = result.events.at(-1).theatre;

  assert.equal(result.state.phase, "ready");
  assert.equal(evidence.details.readiness.required, "application");
  assert.equal(evidence.details.readiness.satisfied, true);
  assert.equal(evidence.details.readiness.playback, "paused");

  return {
    configuration,
    inputs: [intent, {kind: "command_result", ok: true}, {
      kind: "observed",
      status: "active",
      application: "player.example",
      playback: "paused"
    }],
    commands,
    outputs: [evidence],
    invariant: "A successful command is not ready until fresh application evidence arrives."
  };
}

runWhenMain(import.meta.url, name, run);
