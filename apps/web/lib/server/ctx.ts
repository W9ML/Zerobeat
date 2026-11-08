/**
 * Server-side context for the web tier: the shared database, settings and state,
 * opened once per process. Imported only from server components and route handlers.
 */
import "server-only";

import { getDb } from "@zerobeat/core/db/client";
import { openSettings, type SettingsStore } from "@zerobeat/core/settings/store";
import { EngineState } from "@zerobeat/core/state/engine-state";

let settings: SettingsStore | null = null;
let state: EngineState | null = null;

export function db() {
  return getDb();
}

export function settingsStore(): SettingsStore {
  settings ??= openSettings(getDb());
  return settings;
}

export function engineState(): EngineState {
  state ??= new EngineState(getDb());
  return state;
}

export const VERSION = process.env.ZEROBEAT_VERSION ?? "2.0.0";
