/**
 * The World Radio League logbooks for a key: the one being typed on the settings page
 * (not saved yet), or the stored one. The key goes from the browser to this server and
 * on to WRL only; it is not stored here.
 */
import { wrlLogbooks } from "@zerobeat/core/integrations/wrl";

import { authorize, json, problem, readJson } from "@/lib/server/auth";
import { settingsStore } from "@/lib/server/ctx";

export async function POST(req: Request) {
  // Your own World Radio League account.
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const b = await readJson<{ key?: string }>(req);
  const typed = typeof b?.key === "string" ? b.key.trim() : "";
  if (typed && (typed.length > 200 || /\s/.test(typed))) return problem(400, "that does not look like an API key");
  const key = typed || (who.kind === "user" ? settingsStore().snapshot(who.id)["wrl.apiKey"] : "");
  if (!key) return problem(400, "enter the World Radio League API key first");
  const r = await wrlLogbooks(key);
  if (!r.ok) return problem(400, r.error);
  return json({ logbooks: r.logbooks, defaultId: r.defaultId });
}
