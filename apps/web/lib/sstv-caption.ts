/**
 * What is drawn over an SSTV picture before it goes out: up to three lines of text, each at
 * the top, middle or bottom, in a size and colour, on a dark band or outlined; and the
 * corner where another picture (theirs, as a reply) is set in. Built as SVG and as
 * numbers both the page and the server use, so the preview is what goes out.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const MAX_LINES = 3;
export const MAX_CHARS = 40;

export type LinePos = "top" | "middle" | "bottom";
export type LineSize = "s" | "m" | "l";

export interface TextLine {
  text: string;
  pos: LinePos;
  size: LineSize;
  /** #rrggbb */
  color: string;
  /** A dark band behind the line; otherwise the letters are outlined. */
  band: boolean;
}

export type Corner = "tl" | "tr" | "bl" | "br";

/** Band height as a share of the picture's height, per size. */
const BAND: Record<LineSize, number> = { s: 0.1, m: 0.14, l: 0.19 };

/** Fill-ins a line can use, from the contact being made. */
export interface TokenContext {
  mycall: string;
  call?: string;
  rst?: string;
  name?: string;
  grid?: string;
  mode?: string;
  now?: number;
}

export const TOKENS = ["{mycall}", "{call}", "{rst}", "{name}", "{grid}", "{date}", "{time}", "{mode}"] as const;

export function expandTokens(text: string, c: TokenContext): string {
  const d = new Date(c.now ?? Date.now());
  const map: Record<string, string> = {
    mycall: c.mycall,
    call: c.call ?? "",
    rst: c.rst ?? "",
    name: c.name ?? "",
    grid: c.grid ?? "",
    mode: c.mode ?? "",
    date: d.toISOString().slice(0, 10),
    time: `${d.toISOString().slice(11, 16).replace(":", "")}Z`,
  };
  return text
    .replace(/\{(\w+)\}/g, (all, k: string) => (k.toLowerCase() in map ? map[k.toLowerCase()]! : all))
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A line as the server accepts it: known positions and sizes, a real colour, short text. */
export function cleanLine(l: Partial<TextLine>): TextLine | null {
  const text = String(l.text ?? "").trim().toUpperCase().slice(0, MAX_CHARS);
  if (!text) return null;
  const pos: LinePos = l.pos === "top" || l.pos === "middle" ? l.pos : "bottom";
  const size: LineSize = l.size === "s" || l.size === "l" ? l.size : "m";
  const color = /^#[0-9a-fA-F]{6}$/.test(String(l.color)) ? String(l.color) : "#ffffff";
  return { text, pos, size, color, band: l.band !== false };
}

/** The text over a picture W×H pixels, as SVG (null: no text). Lines at one position stack. */
export function overlaySvg(lines: TextLine[], W: number, H: number): string | null {
  const shown = lines.slice(0, MAX_LINES).filter((l) => l.text.trim());
  if (!shown.length) return null;
  const parts: string[] = [];
  const stackHeight = (pos: LinePos) => shown.filter((l) => l.pos === pos).reduce((n, l) => n + Math.round(H * BAND[l.size]), 0);
  const cursor: Record<LinePos, number> = { top: 0, middle: Math.round((H - stackHeight("middle")) / 2), bottom: H - stackHeight("bottom") };
  for (const l of shown) {
    const t = l.text.trim().toUpperCase().slice(0, MAX_CHARS);
    const band = Math.round(H * BAND[l.size]);
    const y0 = cursor[l.pos];
    cursor[l.pos] += band;
    // Bold sans capitals run about 0.68 em wide; leave 3 % margins.
    const size = Math.min(band * 0.72, (W * 0.94) / (0.68 * t.length));
    const y = y0 + (band + size * 0.7) / 2;
    if (l.band) parts.push(`<rect x="0" y="${y0}" width="${W}" height="${band}" fill="black" fill-opacity="0.55"/>`);
    const outline = l.band ? "" : ` stroke="black" stroke-width="${(size * 0.12).toFixed(1)}" paint-order="stroke" stroke-linejoin="round"`;
    parts.push(
      `<text x="${(W / 2).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size.toFixed(1)}" fill="${l.color}"${outline}>${esc(t)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
}

/** Where a set-in picture goes: a 40 %-wide box with a white border, 3 % in from the corner. */
export function insetBox(corner: Corner, W: number, H: number): { left: number; top: number; width: number; height: number; border: number } {
  const width = Math.round(W * 0.4);
  const height = Math.round((width * H) / W);
  const m = Math.round(W * 0.03);
  const left = corner === "tl" || corner === "bl" ? m : W - width - m;
  const top = corner === "tl" || corner === "tr" ? m : H - height - m;
  return { left, top, width, height, border: Math.max(2, Math.round(W * 0.008)) };
}

/** The one line along the bottom, as before (kept for anything still calling it). */
export function captionSvg(text: string, W: number, H: number): string | null {
  const l = cleanLine({ text, pos: "bottom", size: "m", color: "#ffffff", band: true });
  return l ? overlaySvg([l], W, H) : null;
}

/** Ready-made layouts: lines with fill-ins. */
export const TEMPLATES: { id: string; label: string; lines: TextLine[] }[] = [
  {
    id: "cq",
    label: "CQ",
    lines: [
      { text: "CQ CQ DE {mycall}", pos: "bottom", size: "m", color: "#ffffff", band: true },
      { text: "{grid}", pos: "top", size: "s", color: "#ffd84d", band: false },
    ],
  },
  {
    id: "reply",
    label: "Reply",
    lines: [
      { text: "{call} DE {mycall}", pos: "top", size: "m", color: "#ffffff", band: true },
      { text: "UR {rst} {name}", pos: "bottom", size: "m", color: "#ffd84d", band: true },
    ],
  },
  {
    id: "73",
    label: "73",
    lines: [
      { text: "TNX {call} 73", pos: "middle", size: "l", color: "#ffffff", band: false },
      { text: "DE {mycall} {date}", pos: "bottom", size: "s", color: "#ffffff", band: true },
    ],
  },
];
