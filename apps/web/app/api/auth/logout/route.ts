import { destroySession, SESSION_COOKIE } from "@zerobeat/core/auth/sessions";

import { db } from "@/lib/server/ctx";

export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  destroySession(db(), token ? decodeURIComponent(token) : null);
  return new Response(null, {
    status: 303,
    headers: { location: "/login", "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}
