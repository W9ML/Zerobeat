/** The callbook photo for a callsign, fetched and cached by this server (QRZ hosts only). */
import { looksLikeCallsign, normaliseCallsign } from "@zerobeat/core/ham/callsign";

import { authorize, problem } from "@/lib/server/auth";
import { lookupPhoto } from "@/lib/server/lookup";

export async function GET(req: Request, ctx: { params: Promise<{ call: string }> }) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const call = normaliseCallsign(decodeURIComponent((await ctx.params).call));
  if (!looksLikeCallsign(call)) return problem(400, "not a callsign");
  const p = await lookupPhoto(call, who.kind === "user" ? who.id : null);
  if (!p) return problem(404, "no photo");
  return new Response(Buffer.from(p.body), {
    headers: { "content-type": p.type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" },
  });
}
