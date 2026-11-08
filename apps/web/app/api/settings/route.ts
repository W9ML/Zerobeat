import { isPersonal } from "@zerobeat/core/settings/registry";
import { SettingsError } from "@zerobeat/core/settings/store";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { settingsStore } from "@/lib/server/ctx";
import { engineReload } from "@/lib/server/engine";

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response || who.kind !== "user") return who instanceof Response ? who : problem(403, "sign in first");
  const admin = who.role === "ADMIN";
  return json({ settings: settingsStore().describe(who.id).filter((v) => admin || isPersonal(v.key)) });
}

export async function PATCH(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  if (who.kind !== "user") return problem(403, "sign in first");
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return problem(400, "send a JSON object of settings");
  // Your own settings are yours to change; the shack's need an admin.
  const shack = Object.keys(body).filter((k) => !isPersonal(k));
  if (shack.length && who.role !== "ADMIN") return problem(403, `only an admin can change the shack's settings (${shack.join(", ")})`);
  try {
    const changed = settingsStore().write(body, who.id);
    engineReload();
    return json({ ok: true, changed });
  } catch (e) {
    if (e instanceof SettingsError) return problem(400, e.message, { issues: e.issues });
    throw e;
  }
}
