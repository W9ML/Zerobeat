/**
 * SQLite connection shared by the web app and the engine (two processes, one file).
 *
 * WAL mode lets the engine write decodes while the web tier reads the log; the busy
 * timeout makes a brief lock a wait rather than an error. Foreign keys are on, which
 * SQLite does not do by default.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  path?: string;
  readonly?: boolean;
}

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ZEROBEAT_DB ?? "./data/zerobeat.db");
}

export function openDb(opts: OpenDbOptions = {}): { db: Db; sqlite: Database.Database } {
  const path = opts.path ?? dbPath();
  if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { readonly: opts.readonly ?? false, timeout: 5_000 });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

let shared: { db: Db; sqlite: Database.Database } | null = null;

/** Process-wide connection. Lazily opened; call `closeDb()` on shutdown. */
export function getDb(): Db {
  if (!shared) shared = openDb();
  return shared.db;
}

export function getSqlite(): Database.Database {
  if (!shared) shared = openDb();
  return shared.sqlite;
}

export function closeDb(): void {
  shared?.sqlite.close();
  shared = null;
}

export { schema };
