"use strict";

// The theatre's activities as configured: which targets an activity drives,
// what each target should do, and the checks on that configuration.

export const TARGETS = ["display", "avr", "source", "lighting", "backlighting"] as const;

export const REQUIRED_TARGETS = ["display", "avr", "backlighting"] as const;

export const OPTIONAL_TARGETS = ["lighting"] as const;

export type TheatreTarget = typeof TARGETS[number];

const PROFILE_NAME = /^[a-z][a-z0-9_-]*$/;

const SOURCE_ACTIONS: Record<string, true> = {activate: true, deactivate: true};

const SOURCE_READINESS: Record<string, true> = {required: true, optional: true};

const BACKLIGHTING_POWER: Record<ActivityBacklightingProfile["power"], true> = {
  on: true,
  off: true
};

export interface ActivitySourceProfile extends Record<string, unknown> {
  action: "activate" | "deactivate";
  readiness: "required" | "optional";
  sourceId?: string | null;
}

export interface ActivityLightingProfile extends Record<string, unknown> {
  profile: string;
}

export interface ActivityBacklightingProfile extends Record<string, unknown> {
  power: "on" | "off";
}

export type ActivityProfile = Record<TheatreTarget, Record<string, unknown>> & {
  source: ActivitySourceProfile;
  lighting: ActivityLightingProfile;
  backlighting: ActivityBacklightingProfile;
};

export type ActivityProfiles = Record<string, ActivityProfile>;

export function normaliseActivityProfiles(value: unknown): ActivityProfiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("activityProfiles must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("activityProfiles must not be empty");

  const profiles: ActivityProfiles = {};
  for (const [name, profileValue] of entries) {
    if (!PROFILE_NAME.test(name)) throw new Error(`invalid activity profile name: ${name}`);
    if (!profileValue || typeof profileValue !== "object" || Array.isArray(profileValue)) {
      throw new Error(`activity profile ${name} must be an object`);
    }
    const profile = profileValue as Record<string, unknown>;
    const targets = {} as Record<TheatreTarget, Record<string, unknown>>;
    for (const target of TARGETS) {
      const desired = profile[target];
      if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
        throw new Error(`activity profile ${name} must define ${target}`);
      }
      targets[target] = {...desired as Record<string, unknown>};
    }
    const source = targets.source;
    if (!Object.hasOwn(SOURCE_ACTIONS, source.action as PropertyKey)) {
      throw new Error(`activity profile ${name} has an invalid source action`);
    }
    if (!Object.hasOwn(SOURCE_READINESS, source.readiness as PropertyKey)) {
      throw new Error(`activity profile ${name} has invalid source readiness`);
    }
    if (source.action === "activate" &&
      (typeof source.sourceId !== "string" || !source.sourceId)) {
      throw new Error(`activity profile ${name} must define sourceId`);
    }
    const lighting = targets.lighting;
    if (typeof lighting.profile !== "string" || !PROFILE_NAME.test(lighting.profile)) {
      throw new Error(`activity profile ${name} has invalid lighting profile`);
    }
    const backlighting = targets.backlighting;
    if (!Object.hasOwn(BACKLIGHTING_POWER, backlighting.power as PropertyKey)) {
      throw new Error(`activity profile ${name} has invalid backlighting power`);
    }
    profiles[name] = targets as ActivityProfile;
  }
  return profiles;
}

// Whether an observation shows every value a profile expects.
export function matchesExpected(expected: unknown, observed: unknown): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    return Object.is(expected, observed);
  }
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    matchesExpected(value, (observed as Record<string, unknown>)[key]));
}
