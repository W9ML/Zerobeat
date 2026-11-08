/**
 * Writes the logo as static files: favicon SVG, PNG app icons, and a social/preview card.
 * The geometry comes from components/logo.tsx so there is one source of truth.
 *   npx tsx scripts/gen-icons.ts
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";

import { markGeometry } from "../apps/web/components/logo.tsx";

function svg({ tile = true, maskable = false, small = false }: { tile?: boolean; maskable?: boolean; small?: boolean } = {}): string {
  const { ring, wave } = markGeometry();
  // At favicon sizes thin lines vanish: thicken the wave and the ring.
  const waveW = small ? 3.6 : 2.6;
  const ringW = small ? 6.5 : 5;
  // Maskable icons are cropped to a circle by the OS: shrink the art into the safe zone.
  const inner = maskable ? `transform="translate(6.4 6.4) scale(0.8)"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2029"/><stop offset="1" stop-color="#0c0f14"/></linearGradient>
<linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a5c"/><stop offset="1" stop-color="#ef5a22"/></linearGradient>
</defs>
${tile ? (maskable ? `<rect width="64" height="64" fill="url(#t)"/>` : `<rect width="64" height="64" rx="14" fill="url(#t)"/><rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#fff" stroke-opacity="0.06"/>`) : ""}
<g ${inner}>
<path d="${wave}" fill="none" stroke="#6b7487" stroke-width="${waveW}" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${ring.cx}" cy="${ring.cy}" r="${ring.r}" fill="none" stroke="url(#h)" stroke-width="${ringW}"/>
</g>
</svg>`;
}

const out = "apps/web/public";
writeFileSync(`${out}/icon.svg`, svg());
writeFileSync(`${out}/favicon.svg`, svg({ small: true }));
const png = (s: string, size: number, file: string) => sharp(Buffer.from(s), { density: 72 * (size / 64) * 2 }).resize(size, size).png().toFile(`${out}/${file}`);
await png(svg({ small: true }), 32, "favicon-32.png");
await png(svg(), 180, "apple-touch-icon.png");
await png(svg(), 192, "icon-192.png");
await png(svg(), 512, "icon-512.png");
await png(svg({ maskable: true }), 512, "icon-maskable-512.png");

// Preview card: mark + wordmark, for link unfurls and the README.
const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0a0c10"/>
<g transform="translate(140 175) scale(4.375)">${svg().replace(/<\/?svg[^>]*>/g, "")}</g>
<text x="470" y="318" font-family="Inter, Segoe UI, DejaVu Sans, Arial, sans-serif" font-size="104" letter-spacing="-3"><tspan fill="#8f98ab" font-weight="500">Zero</tspan><tspan fill="#e8eaef" font-weight="700">beat</tspan></text>
<text x="474" y="388" font-family="Inter, Segoe UI, DejaVu Sans, Arial, sans-serif" font-size="34" fill="#616a7d">Your rig · every digital mode · any browser</text>
</svg>`;
await sharp(Buffer.from(card)).png().toFile(`${out}/card.png`);
console.log("icons written");
