/**
 * Waterfall colour maps. Each is a list of [position 0–1, r, g, b] stops. The noise floor
 * sits low in the scale (dark blue on Classic), signals climb through the bright colours.
 */
/** Two themes: SmartSDR-like Classic, and Viridis, which reads the same to red-green colorblind eyes. */
export type PaletteId = "classic" | "viridis";

type Stop = [number, number, number, number];

export const PALETTES: Record<PaletteId, { label: string; stops: Stop[] }> = {
  // A radio's own waterfall (colours measured off SmartSDR): noise as shades of blue,
  // signals through teal and green to yellow, the strongest orange and red, no white.
  // Positions are set for the default floor -14 dB and range 55 dB.
  classic: {
    label: "Classic",
    stops: [
      [0, 0, 0, 70],
      [0.145, 0, 0, 120],
      [0.273, 0, 4, 185],
      [0.364, 4, 14, 225],
      [0.436, 10, 70, 190],
      [0.491, 14, 125, 115],
      [0.564, 45, 195, 58],
      [0.655, 70, 215, 48],
      [0.745, 140, 232, 36],
      [0.836, 236, 244, 15],
      [0.909, 230, 150, 22],
      [1, 210, 32, 16],
    ],
  },
  viridis: {
    label: "Viridis (colorblind-safe)",
    stops: [
      [0, 68, 1, 84],
      [0.25, 59, 82, 139],
      [0.5, 33, 145, 140],
      [0.75, 94, 201, 98],
      [1, 253, 231, 37],
    ],
  },
};

/** 256 RGBA entries. */
export function paletteBytes(id: PaletteId): Uint8Array {
  const stops = PALETTES[id].stops;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const [t0, r0, g0, b0] = stops[k]!;
    const [t1, r1, g1, b1] = stops[k + 1]!;
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    out[i * 4] = r0 + (r1 - r0) * f;
    out[i * 4 + 1] = g0 + (g1 - g0) * f;
    out[i * 4 + 2] = b0 + (b1 - b0) * f;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** CSS colour at position t, for the spectrum trace. */
export function paletteCss(id: PaletteId, t: number, alpha = 1): string {
  const b = paletteBytes(id);
  const i = Math.round(Math.min(1, Math.max(0, t)) * 255) * 4;
  return `rgba(${b[i]}, ${b[i + 1]}, ${b[i + 2]}, ${alpha})`;
}
