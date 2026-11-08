/** SSTV pictures the station received or sent, from data/sstv (and current.png, the one arriving). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { authorize, problem } from "@/lib/server/auth";
import { dataDir } from "@/lib/server/paths";

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const { file } = await ctx.params;
  if (!/^[\w.-]+\.png$/.test(file) || file.includes("..")) return problem(400, "bad picture name");
  try {
    const png = await readFile(join(dataDir(), "sstv", file));
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": file === "current.png" ? "no-store" : "private, max-age=86400" } });
  } catch {
    return problem(404, "no such picture");
  }
}
