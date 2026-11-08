import { describe, expect, it } from "vitest";

import { captionSvg, cleanLine, expandTokens, insetBox, overlaySvg } from "./sstv-caption.ts";

describe("SSTV text", () => {
  it("fills in the contact's call, report, name and the time", () => {
    const t = Date.UTC(2026, 10, 6, 14, 5);
    expect(expandTokens("{call} de {mycall} ur {rst} {name}", { mycall: "W9ML", call: "K1ABC", rst: "595", name: "Joe", now: t })).toBe("K1ABC de W9ML ur 595 Joe");
    expect(expandTokens("{date} {time}", { mycall: "W9ML", now: t })).toBe("2026-11-06 1405Z");
    // Nothing to fill in: the gap closes; an unknown {word} stays.
    expect(expandTokens("UR {rst} {name} {foo}", { mycall: "W9ML", rst: "595" })).toBe("UR 595 {foo}");
  });

  it("keeps only what the server accepts", () => {
    expect(cleanLine({ text: "  cq de w9ml ", pos: "side" as never, size: "xl" as never, color: "red" })).toEqual({ text: "CQ DE W9ML", pos: "bottom", size: "m", color: "#ffffff", band: true });
    expect(cleanLine({ text: "   " })).toBeNull();
    expect(cleanLine({ text: "x".repeat(80) })!.text).toHaveLength(40);
  });

  it("stacks lines at one position and draws each in its colour", () => {
    const svg = overlaySvg(
      [
        { text: "ONE", pos: "bottom", size: "m", color: "#ff0000", band: true },
        { text: "TWO", pos: "bottom", size: "s", color: "#00ff00", band: false },
      ],
      320,
      256,
    )!;
    const ys = [...svg.matchAll(/<rect x="0" y="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ys).toEqual([256 - 36 - 26]); // only the banded line has a rect, above the small one
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#00ff00" stroke="black"');
    expect(overlaySvg([], 320, 256)).toBeNull();
    expect(captionSvg("W9ML", 320, 256)).toContain(">W9ML<");
  });

  it("sets a picture into a corner inside the frame", () => {
    for (const c of ["tl", "tr", "bl", "br"] as const) {
      const b = insetBox(c, 320, 256);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
      expect(b.left + b.width).toBeLessThanOrEqual(320);
      expect(b.top + b.height).toBeLessThanOrEqual(256);
    }
    expect(insetBox("br", 320, 256)).toMatchObject({ width: 128, height: 102, left: 320 - 128 - 10 });
  });
});
