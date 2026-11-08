/** One of "My pictures": the image, or delete it. */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { authorize, json, problem } from "@/lib/server/auth";
import { isLibraryId, sstvLibraryDir } from "@/lib/server/paths";
import { ownScope } from "@/lib/server/scope";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const { id } = await ctx.params;
  if (!isLibraryId(id)) return problem(400, "bad picture id");
  try {
    const jpg = await readFile(join(sstvLibraryDir(ownScope(who).userId), `${id}.jpg`));
    return new Response(new Uint8Array(jpg), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  } catch {
    return problem(404, "no such picture");
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const { id } = await ctx.params;
  if (!isLibraryId(id)) return problem(400, "bad picture id");
  await rm(join(sstvLibraryDir(ownScope(who).userId), `${id}.jpg`), { force: true });
  return json({ ok: true });
}
