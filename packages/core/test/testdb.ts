import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";

export function testDb() {
  const dir = mkdtempSync(join(tmpdir(), "ds-test-"));
  const h = openDb({ path: join(dir, "t.db") });
  runMigrations(h.db);
  return h;
}
