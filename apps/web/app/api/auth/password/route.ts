/** Change your own password. Signs out your other sessions. */
import { eq } from "drizzle-orm";

import { hashPassword, passwordProblem, verifyPassword } from "@zerobeat/core/auth/password";
import { destroyUserSessions, SESSION_COOKIE } from "@zerobeat/core/auth/sessions";
import { users } from "@zerobeat/core/db/schema";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";

export async function POST(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "sign in to change your password");
  const b = await readJson<{ current?: string; next?: string }>(req);
  if (!b?.current || !b.next) return problem(400, "enter your current and new password");
  const d = db();
  const row = d.select({ hash: users.passwordHash }).from(users).where(eq(users.id, who.id)).get();
  if (!row || !(await verifyPassword(String(b.current).slice(0, 256), row.hash))) return problem(400, "your current password is not right", { issues: { current: "not right" } });
  const issue = passwordProblem(String(b.next));
  if (issue) return problem(400, issue, { issues: { next: issue } });
  d.update(users)
    .set({ passwordHash: await hashPassword(String(b.next)) })
    .where(eq(users.id, who.id))
    .run();
  const token = req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  destroyUserSessions(d, who.id, token);
  return json({ ok: true });
}
