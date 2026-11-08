/**
 * Send a picture by SSTV: an uploaded image or one of "My pictures", cropped to the mode's
 * size, with another picture (theirs, as a reply) set into a corner if asked, and up to
 * three lines of text over it; the raw pixels go to the engine, which keys the radio.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import sharp from "sharp";

import { modeById } from "@zerobeat/core/sstv/modes";

import { authorize, json, problem } from "@/lib/server/auth";
import { cleanLine, insetBox, overlaySvg, type Corner, type TextLine } from "@/lib/sstv-caption";
import { engine, EngineDown } from "@/lib/server/engine";
import { dataDir, isLibraryId, sstvLibraryDir } from "@/lib/server/paths";
import { ownScope } from "@/lib/server/scope";

const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];

/** Lines from the form: JSON of up to three lines, or the old single "text" field. */
function linesFrom(form: FormData): TextLine[] {
  const raw = form.get("lines");
  if (typeof raw === "string" && raw) {
    try {
      const arr = JSON.parse(raw) as Partial<TextLine>[];
      if (Array.isArray(arr)) return arr.slice(0, 3).map(cleanLine).filter((l): l is TextLine => !!l);
    } catch {
      /* fall through to the single line */
    }
  }
  const one = cleanLine({ text: String(form.get("text") ?? ""), pos: "bottom", size: "m", color: "#ffffff", band: true });
  return one ? [one] : [];
}

export async function POST(req: Request) {
  const who = authorize(req, "OPERATOR");
  if (who instanceof Response) return who;
  const form = await req.formData().catch(() => null);
  if (!form) return problem(400, "send the picture as a form");
  const mode = modeById(String(form.get("mode") ?? ""));
  if (!mode) return problem(400, "choose an SSTV mode");
  const userId = ownScope(who).userId;

  // The picture: an upload (saved to My pictures if asked), or one of My pictures.
  let source: Buffer;
  const file = form.get("image");
  const libraryId = String(form.get("libraryId") ?? "");
  if (file instanceof File) {
    if (file.size > 20 * 1024 * 1024) return problem(413, "the picture is over 20 MB");
    source = Buffer.from(await file.arrayBuffer());
    if (form.get("save") === "1") {
      try {
        const jpg = await sharp(source).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        const dir = sstvLibraryDir(userId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.jpg`), jpg);
      } catch {
        /* not saved; the send goes on */
      }
    }
  } else if (isLibraryId(libraryId)) {
    try {
      source = await readFile(join(sstvLibraryDir(userId), `${libraryId}.jpg`));
    } catch {
      return problem(404, "that picture is not in My pictures any more");
    }
  } else return problem(400, "choose a picture");

  // A received picture set into a corner (a reply with theirs in it).
  let inset: { png: Buffer; corner: Corner } | null = null;
  const insetFile = String(form.get("insetFile") ?? "");
  const corner = String(form.get("insetCorner") ?? "br") as Corner;
  if (insetFile) {
    if (!/^[\w.-]+\.png$/.test(insetFile) || insetFile.includes("..") || insetFile === "current.png") return problem(400, "bad picture name");
    try {
      inset = { png: await readFile(join(dataDir(), "sstv", insetFile)), corner: CORNERS.includes(corner) ? corner : "br" };
    } catch {
      return problem(404, "that received picture is not there any more");
    }
  }

  const W = mode.width;
  const H = mode.height;
  const svg = overlaySvg(linesFrom(form), W, H);
  let rgb: Buffer;
  try {
    const layers: sharp.OverlayOptions[] = [];
    if (inset) {
      const b = insetBox(inset.corner, W, H);
      const inner = await sharp(inset.png)
        .resize(b.width - 2 * b.border, b.height - 2 * b.border, { fit: "cover" })
        .extend({ top: b.border, bottom: b.border, left: b.border, right: b.border, background: "#ffffff" })
        .png()
        .toBuffer();
      layers.push({ input: inner, left: b.left, top: b.top });
    }
    if (svg) layers.push({ input: Buffer.from(svg) });
    let img = sharp(await sharp(source).rotate().resize(W, H, { fit: "cover" }).png().toBuffer());
    if (layers.length) img = sharp(await img.composite(layers).png().toBuffer());
    rgb = await img.removeAlpha().raw().toBuffer();
  } catch {
    return problem(400, "that file is not a picture this server can read");
  }
  if (rgb.length !== W * H * 3) return problem(500, "the picture did not come out the right size");
  try {
    const r = await engine("POST", "/sstv/send", { mode: mode.id, rgb: rgb.toString("base64") }, 30_000, userId);
    return json(r.data, r.status);
  } catch (e) {
    if (e instanceof EngineDown) return problem(503, e.message);
    throw e;
  }
}
