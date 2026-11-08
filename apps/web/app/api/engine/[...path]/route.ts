/**
 * The browser's door to the engine. Each action has a minimum role; the engine itself
 * only trusts this process's bearer token.
 */
import type { Role } from "@zerobeat/core/db/schema";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { engine, EngineDown, wsTicket, wsUrlHint } from "@/lib/server/engine";
import { requestScope } from "@/lib/server/scope";

const POST_ROLES: Record<string, Role> = {
  auto: "OPERATOR",
  call: "OPERATOR",
  halt: "OPERATOR",
  "cq-slot": "OPERATOR",
  "hunt-slot": "OPERATOR",
  udp: "OPERATOR",
  hound: "OPERATOR",
  contest: "OPERATOR",
  "spots/tune": "OPERATOR",
  "sstv/halt": "OPERATOR",
  "js8/send": "OPERATOR",
  "js8/hb": "OPERATOR",
  "js8/halt": "OPERATOR",
  "js8/inbox/delete": "OPERATOR",
  "js8/log": "OPERATOR",
  "keyboard/send": "OPERATOR",
  "keyboard/halt": "OPERATOR",
  "keyboard/context": "OPERATOR",
  "keyboard/clear": "OPERATOR",
  "keyboard/fkeys": "OPERATOR",
  "keyboard/log": "OPERATOR",
  skip: "OPERATOR",
  rearm: "OPERATOR",
  tune: "OPERATOR",
  "band-freq": "OPERATOR",
  "tx-offset": "OPERATOR",
  power: "OPERATOR",
  atu: "OPERATOR",
  control: "OPERATOR",
  // Engaging FT-0 (stop everything) is for anyone signed in; releasing it is checked
  // below for OPERATOR.
  ft0: "VIEWER",
  "jobs/run": "OPERATOR",
  "tx-allow": "OPERATOR",
  "heard/refresh": "OPERATOR",
  "push/test": "VIEWER",
  // Each user's own accounts: their digest, uploads, LoTW certificate, test buttons.
  "digest/test": "VIEWER",
  "uploads/resume": "OPERATOR",
  "lotw/cert": "OPERATOR",
  test: "VIEWER",
  // Asking for the radio while someone else is using it, and answering.
  "radio/request": "OPERATOR",
  "radio/answer": "OPERATOR",
};
const GET_ROLES: Record<string, Role> = { status: "VIEWER", recent: "VIEWER", services: "VIEWER", ticket: "VIEWER", health: "VIEWER", heard: "VIEWER", runs: "VIEWER", "push/key": "VIEWER", keyboard: "VIEWER", spots: "VIEWER", sstv: "VIEWER", wspr: "VIEWER", js8: "VIEWER", "contest/sheet": "VIEWER", "contest/check": "VIEWER" };

async function forward(req: Request, method: "GET" | "POST" | "DELETE", path: string, userId?: string) {
  try {
    const body = method === "POST" ? ((await readJson(req)) ?? {}) : undefined;
    const r = await engine(method, `/${path}`, body, path === "lotw/cert" ? 30_000 : 15_000, userId);
    return json(r.data, r.status);
  } catch (e) {
    if (e instanceof EngineDown) return problem(503, e.message);
    throw e;
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  const role = GET_ROLES[path];
  if (!role) return problem(404, "not found");
  const who = authorize(req, role);
  if (who instanceof Response) return who;
  if (path === "ticket") return json({ ticket: wsTicket(who.email), url: wsUrlHint() });
  // The engine answers for the signed-in user, or for the user an admin is viewing (for=).
  const u = new URL(req.url);
  u.searchParams.delete("for");
  const scope = requestScope(req, who);
  if (scope.readOnly) u.searchParams.set("for", scope.userId);
  return forward(req, "GET", path + u.search, who.kind === "user" ? who.id : undefined);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  const role = POST_ROLES[path];
  if (!role) return problem(404, "not found");
  const who = authorize(req, role);
  if (who instanceof Response) return who;
  if (path === "push/test") {
    if (who.kind !== "user") return problem(403, "sign in first");
    const r = await engine("POST", "/push/test", { userId: who.id }).catch((e) => e as Error);
    if (r instanceof Error) return problem(503, r.message);
    return json(r.data, r.status);
  }
  const userId = who.kind === "user" ? who.id : undefined;
  if (path === "ft0" || path === "auto" || path === "tx-allow" || path === "control") {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (path === "ft0" && body.engage !== true) {
      const op = authorize(req, "OPERATOR");
      if (op instanceof Response) return op;
    }
    const r = await engine("POST", `/${path}`, { ...body, by: who.email }, 15_000, userId).catch((e) => e as Error);
    if (r instanceof Error) return problem(503, r.message);
    return json(r.data, r.status);
  }
  return forward(req, "POST", path, userId);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const path = (await ctx.params).path.join("/");
  if (path !== "lotw/cert") return problem(404, "not found");
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  // Your own certificate.
  return forward(req, "DELETE", path, who.kind === "user" ? who.id : undefined);
}
