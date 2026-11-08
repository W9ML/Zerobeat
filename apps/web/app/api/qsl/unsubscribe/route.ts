/** RFC 8058 one-click unsubscribe (mail clients POST here), and the page's button. */
import { optOut, verifyUnsubscribe } from "@zerobeat/core/qsl/queue";

import { db } from "@/lib/server/ctx";

export async function POST(req: Request) {
  const u = new URL(req.url);
  const call = u.searchParams.get("call");
  const t = u.searchParams.get("t");
  if (!call || !t || !verifyUnsubscribe(call, t)) return new Response("invalid link", { status: 400 });
  optOut(db(), call, "unsubscribe");
  // The page's button sends confirm=1: show the person the result. A mail client's
  // one-click POST gets a plain 200.
  const form = await req.formData().catch(() => null);
  if (form?.get("confirm") === "1") {
    const to = new URL(`/qsl/unsubscribe?call=${encodeURIComponent(call)}&t=${encodeURIComponent(t)}&done=1`, u);
    return new Response(null, { status: 303, headers: { location: to.pathname + to.search } });
  }
  return new Response("unsubscribed", { status: 200 });
}
