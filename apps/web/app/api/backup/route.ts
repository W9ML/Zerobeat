/**
 * Download a consistent snapshot of the database (SQLite online backup), or one of the
 * nightly backups. Restore is deliberately not a web action: stop the services and copy
 * the file into place (see docs/operations.md).
 */
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { getSqlite } from "@zerobeat/core/db/client";

import { authorize, json, problem } from "@/lib/server/auth";
import { dataDir } from "@/lib/server/paths";

export async function GET(req: Request) {
  const who = authorize(req, "ADMIN");
  if (who instanceof Response) return who;
  const u = new URL(req.url);
  const dir = join(dataDir(), "backups");
  if (u.searchParams.get("list")) {
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".db"))
          .sort()
          .reverse()
          .map((f) => ({ name: f, bytes: statSync(join(dir, f)).size }))
      : [];
    return json({ files });
  }
  const name = u.searchParams.get("file");
  let path: string;
  let cleanup: (() => void) | null = null;
  if (name) {
    if (!/^zerobeat-\d{4}-\d{2}-\d{2}\.db$/.test(name)) return problem(400, "bad file name");
    path = join(dir, name);
    if (!existsSync(path)) return problem(404, "no such backup");
  } else {
    const tmp = mkdtempSync(join(tmpdir(), "ds-backup-"));
    path = join(tmp, "snapshot.db");
    await getSqlite().backup(path);
    cleanup = () => rmSync(tmp, { recursive: true, force: true });
  }
  const stream = createReadStream(path);
  if (cleanup) stream.on("close", cleanup);
  const filename = name ?? `zerobeat-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}.db`;
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "content-type": "application/vnd.sqlite3", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" },
  });
}
