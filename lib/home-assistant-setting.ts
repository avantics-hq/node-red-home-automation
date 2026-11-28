"use strict";

// The one publishing setting a node has, Publish in the editor: off ("Don't
// publish"), state ("MQTT state": its state and availability as retained
// MQTT topics, plain MQTT) or discovery ("MQTT state and Home Assistant
// discovery": its entities announced to Home Assistant too, which read that
// state). It replaced two on/off settings, publishState and discovery, which
// stay in a node's saved flow: a node saved before reads as they said.
// Decided by the person on 2026-11-28.

import {optionalBooleanSetting, optionalChoiceSetting} from "./settings";

export const HOME_ASSISTANT_CHOICES = ["off", "state", "discovery"] as const;
export type HomeAssistantChoice = typeof HOME_ASSISTANT_CHOICES[number];

// The choice, or for a node saved before it, its two old settings: off/off
// is off, on/off state only, on/on state and discovery (discovery needs the
// state). `unsetMeans` is what an old setting not set at all meant for this
// node: on for the room's publishing, so a saved flow behaves the same.
export function homeAssistantSetting(
  config: {homeAssistant?: unknown; publishState?: unknown; discovery?: unknown},
  unsetMeans: {publishState: boolean; discovery: boolean}
): HomeAssistantChoice {
  const choice = optionalChoiceSetting(config.homeAssistant, "Home Assistant", HOME_ASSISTANT_CHOICES);
  if (choice) return choice;
  const state = optionalBooleanSetting(config.publishState, "publish state") ?? unsetMeans.publishState;
  const discovery = optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? unsetMeans.discovery;
  return !state ? "off" : discovery ? "discovery" : "state";
}

// The choice as a node's publishing reads it, and whether it needs an area:
// with the choice set, unless off; for a node saved before it, whenever
// either old setting was on, even discovery alone, which published nothing:
// as each node checked it before the choice.
export function publishingChoice(
  config: {homeAssistant?: unknown; publishState?: unknown; discovery?: unknown},
  unsetMeans: {publishState: boolean; discovery: boolean}
): {choice: HomeAssistantChoice; publishState: boolean; discovery: boolean; needsArea: boolean} {
  const choice = homeAssistantSetting(config, unsetMeans);
  const saved = config.homeAssistant === undefined || config.homeAssistant === null;
  const needsArea = choice !== "off" || (saved &&
    ((optionalBooleanSetting(config.publishState, "publish state") ?? unsetMeans.publishState) ||
      (optionalBooleanSetting(config.discovery, "Home Assistant discovery") ?? unsetMeans.discovery)));
  return {choice, publishState: choice !== "off", discovery: choice === "discovery", needsArea};
}
