import {
  normaliseActivityProfiles,
  transitionTheatre
} from "../dist/lib/theatre-activity-controller.js";
import {assert, runWhenMain} from "./_shared.mjs";

export const name = "theatre-activity";

export function run() {
  const activityProfiles = normaliseActivityProfiles({
    movie_night: {
      display: {mode: "projection"},
      avr: {power: "on", input: "media"},
      source: {action: "activate", sourceId: "streamer", readiness: "required"},
      lighting: {profile: "dim"},
      backlighting: {power: "off"}
    }
  });
  const configuration = {area: "demo_room", freshnessMs: 30000, activityProfiles};
  const intent = {
    kind: "intent",
    requestId: "movie-night-1",
    generation: 1,
    activity: "movie_night"
  };
  let result = transitionTheatre(undefined, {theatre: intent}, configuration, "2026-01-01T20:00:00.000Z");
  const targetIntents = [...result.commands];
  const targets = ["display", "avr", "source", "lighting", "backlighting"];

  for (const [index, target] of targets.entries()) {
    const observedAt = `2026-01-01T20:00:0${index + 1}.000Z`;
    result = transitionTheatre(result.state, {theatre: {
      kind: "target_state",
      target,
      generation: 1,
      status: "ready",
      observedAt
    }}, configuration, observedAt);
  }

  assert.equal(targetIntents.length, 5);
  assert.deepEqual(targetIntents.map(({target}) => target), targets);
  assert.equal(result.state.phase, "ready");
  assert.equal(result.state.currentActivity, "movie_night");
  assert.equal(result.state.availability, "available");

  return {
    configuration: {activities: Object.keys(activityProfiles), freshnessMs: configuration.freshnessMs},
    inputs: [intent, {kind: "target_state", targets, status: "ready"}],
    outputs: {
      targetIntents,
      state: {
        currentActivity: result.state.currentActivity,
        phase: result.state.phase,
        availability: result.state.availability
      }
    },
    invariant: "The activity becomes ready only after fresh evidence from every mandatory target owner."
  };
}

runWhenMain(import.meta.url, name, run);
