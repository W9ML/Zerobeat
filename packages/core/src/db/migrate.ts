/**
 * Apply pending Drizzle migrations. Run at install/upgrade time (`npm run db:migrate`)
 * and by the engine on start, so a fresh database is created without a separate step.
 */
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Db } from "./client.ts";

export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db -> packages/core/drizzle (works from source and from the bundled engine, which
  // sets ZEROBEAT_MIGRATIONS explicitly).
  return process.env.ZEROBEAT_MIGRATIONS ?? resolve(here, "../../drizzle");
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

