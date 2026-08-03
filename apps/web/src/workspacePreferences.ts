export type UpdateDetailLevel = "summary" | "detailed" | "attention";
export type UpdateIntervalSeconds = 60 | 300 | 900;

export interface UpdatePreferences {
  intervalSeconds: UpdateIntervalSeconds;
  detailLevel: UpdateDetailLevel;
}

const GLOBAL_KEY = "norns:update-preferences";
const PROJECT_KEY_PREFIX = "norns:update-preferences:project:";

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  intervalSeconds: 300,
  detailLevel: "summary",
};

export const UPDATE_INTERVAL_OPTIONS: ReadonlyArray<{
  value: UpdateIntervalSeconds;
  label: string;
}> = [
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 900, label: "Every 15 minutes" },
];

export const UPDATE_DETAIL_OPTIONS: ReadonlyArray<{
  value: UpdateDetailLevel;
  label: string;
}> = [
  { value: "summary", label: "Progress summary" },
  { value: "detailed", label: "Detailed progress, costs, and completions" },
  { value: "attention", label: "Only blockers and decisions" },
];

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parsePreferences(raw: string | null): UpdatePreferences | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UpdatePreferences>;
    if (
      ![60, 300, 900].includes(value.intervalSeconds ?? 0) ||
      !["summary", "detailed", "attention"].includes(value.detailLevel ?? "")
    ) {
      return null;
    }
    return value as UpdatePreferences;
  } catch {
    return null;
  }
}

export function loadGlobalUpdatePreferences(): UpdatePreferences {
  return parsePreferences(storage()?.getItem(GLOBAL_KEY) ?? null) ?? DEFAULT_UPDATE_PREFERENCES;
}

export function saveGlobalUpdatePreferences(preferences: UpdatePreferences): void {
  try {
    storage()?.setItem(GLOBAL_KEY, JSON.stringify(preferences));
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
  }
}

export function loadProjectUpdatePreferences(projectId: string): UpdatePreferences | null {
  return parsePreferences(storage()?.getItem(`${PROJECT_KEY_PREFIX}${projectId}`) ?? null);
}

export function saveProjectUpdatePreferences(
  projectId: string,
  preferences: UpdatePreferences | null,
): void {
  const key = `${PROJECT_KEY_PREFIX}${projectId}`;
  try {
    if (preferences) storage()?.setItem(key, JSON.stringify(preferences));
    else storage()?.removeItem(key);
  } catch {
    // Best effort; the active workspace still receives the new in-memory value.
  }
}

export function resolveUpdatePreferences(projectId: string): UpdatePreferences {
  return loadProjectUpdatePreferences(projectId) ?? loadGlobalUpdatePreferences();
}
