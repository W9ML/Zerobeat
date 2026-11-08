/**
 * QSL card rendering: the operator's artwork with a contact table composited on top.
 * The table is SVG rendered by sharp/librsvg, so the host needs fontconfig and a font
 * (fonts-dejavu-core on Debian).
 */
import { existsSync } from "node:fs";
import sharp from "sharp";

import { displayMode } from "../ham/modes.ts";
import type { Qso, Station } from "../db/schema.ts";
import type { SettingsSnapshot } from "../settings/registry.ts";
import { utcDate, utcTime } from "../util/time.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface CardOptions {
  imagePath: string;
  width?: number;
  settings: Pick<SettingsSnapshot, "qsl.card.tableX" | "qsl.card.tableY" | "qsl.card.tableWidth" | "qsl.card.textColor" | "qsl.card.backgroundColor">;
}

function tableSvg(w: number, h: number, q: Qso, station: Pick<Station, "callsign">, o: CardOptions["settings"]): string {
  const cols: [string, string][] = [
    ["To", q.callsign],
    ["Date", utcDate(q.startTime)],
    ["UTC", utcTime(q.startTime, false)],
    ["Band", q.band.toLowerCase()],
    ["MHz", (q.freqHz / 1e6).toFixed(3)],
    ["Mode", displayMode(q.mode, q.submode)],
    ["Report", q.rstSent ?? "—"],
  ];
  const x0 = Math.round(w * o["qsl.card.tableX"]);
  const y0 = Math.round(h * o["qsl.card.tableY"]);
  const tw = Math.round(w * o["qsl.card.tableWidth"]);
  const colW = tw / cols.length;
  const fs = Math.max(12, Math.round(Math.min(colW / 6.5, h * 0.04)));
  const rowH = Math.round(fs * 1.7);
  const th = rowH * 2 + 4;
  const color = o["qsl.card.textColor"];
  const bg = o["qsl.card.backgroundColor"];
  const cells = cols
    .map(([k, v], i) => {
      const cx = x0 + colW * i + colW / 2;
      return (
        `<text x="${cx}" y="${y0 + rowH * 0.7}" font-size="${Math.round(fs * 0.7)}" text-anchor="middle" fill="${color}" opacity="0.75">${esc(k)}</text>` +
        `<text x="${cx}" y="${y0 + rowH * 1.7}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="${color}">${esc(v)}</text>` +
        (i > 0 ? `<line x1="${x0 + colW * i}" y1="${y0 + 6}" x2="${x0 + colW * i}" y2="${y0 + th - 6}" stroke="${color}" stroke-opacity="0.25"/>` : "")
      );
    })
    .join("");
  const footer = `${station.callsign} confirms the contact above. 73!`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif">
<rect x="${x0}" y="${y0}" width="${tw}" height="${th}" rx="${Math.round(fs * 0.4)}" fill="${bg}"/>
${cells}
<text x="${x0 + tw / 2}" y="${Math.min(h - 8, y0 + th + fs * 1.1)}" font-size="${Math.round(fs * 0.65)}" text-anchor="middle" fill="${color}" opacity="0.85">${esc(footer)}</text>
</svg>`;
}

export async function renderCard(q: Qso, station: Pick<Station, "callsign">, opts: CardOptions): Promise<Buffer> {
  const width = opts.width ?? 1600;
  let base: sharp.Sharp;
  if (existsSync(opts.imagePath)) {
    base = sharp(opts.imagePath).rotate().resize({ width, withoutEnlargement: false });
  } else {
    // No artwork yet: a plain card so previews still work.
    base = sharp({ create: { width, height: Math.round(width / 1.5), channels: 3, background: "#1d2733" } });
  }
  const meta = await base.png().toBuffer({ resolveWithObject: true });
  const w = meta.info.width;
  const h = meta.info.height;
  const svg = Buffer.from(tableSvg(w, h, q, station, opts.settings));
  return sharp(meta.data).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}
