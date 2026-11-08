/** "My pictures": each user's own pictures to send by SSTV. List them, or add one. */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import sharp from "sharp";

import { authorize, json, problem } from "@/lib/server/auth";
import { sstvLibraryDir } from "@/lib/server/paths";
import { ownScope } from "@/lib/server/scope";

const MAX_PICTURES = 60;

export async function GET(req: Request) {
  const who = authorize(req, "VIEWER");
  if (who instanceof Response) return who;
  const dir = sstvLibraryDir(ownScope(who).userId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const items = await Promise.all(
    names
      .filter((n) => n.endsWith(".jpg"))
      .map(async (n) => ({ id: n.slice(0, -4), at: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  return json({ items: items.sort((a, b) => b.at - a.at), max: MAX_PICTURES });
}

/** Add a picture (kept at most 1024 px, as JPEG). */
export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const form = await req.formData().catch(() => null);
  const file = form?.get("image");
  if (!(file instanceof File)) return problem(400, "choose a picture");
  if (file.size > 20 * 1024 * 1024) return problem(413, "the picture is over 20 MB");
  const dir = sstvLibraryDir(ownScope(who).userId);
  const have = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jpg")).length;
  if (have >= MAX_PICTURES) return problem(409, `My pictures holds ${MAX_PICTURES}; delete one first`);
  let jpg: Buffer;
  try {
    jpg = await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    return problem(400, "that file is not a picture this server can read");
  }
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jpg`), jpg);
  return json({ ok: true, id }, 201);
}
