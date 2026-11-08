/** An admin chooses whose logbook and settings to look at (read-only), or goes back to their own. */
import { z } from "zod";

import { authorize, isSecure, json, problem, readJson } from "@/lib/server/auth";
import { VIEW_COOKIE } from "@/lib/server/scope";

const Body = z.object({ userId: z.string().max(64).nullable() });

export async function POST(req: Request) {
  const who = authorize(req, "ADMIN");
  if (who instanceof Response) return who;
  const b = Body.safeParse(await readJson(req));
  if (!b.success) return problem(400, "send { userId } or { userId: null }");
  const res = json({ ok: true });
  const secure = isSecure(req) ? "; Secure" : "";
  const viewing = b.data.userId && b.data.userId !== (who.kind === "user" ? who.id : "") ? b.data.userId : null;
  res.headers.append("set-cookie", viewing ? `${VIEW_COOKIE}=${encodeURIComponent(viewing)}; Path=/; HttpOnly; SameSite=Lax${secure}` : `${VIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  return res;
}
