import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { pathMapSvg, qrzUrl } = await import("./server/path-map");

describe("path map", () => {
  it("links each callsign on the map to its QRZ.com page", () => {
    const svg = pathMapSvg({ from: { lat: 41.3, lon: -87.2 }, to: { lat: 46.1, lon: -122.9 }, fromLabel: "W1XYZ", toLabel: "PJ4/K1ABC", now: Date.UTC(2026, 10, 8, 1) });
    expect(svg).toContain(`<a href="https://www.qrz.com/db/W1XYZ" target="_blank" rel="noopener noreferrer">`);
    expect(svg).toContain(`<a href="https://www.qrz.com/db/PJ4/K1ABC" target="_blank"`);
    expect(svg).toContain("<title>PJ4/K1ABC on QRZ.com</title>");
    expect(qrzUrl(" n2rjr ")).toBe("https://www.qrz.com/db/N2RJR");
  });
  it("draws no link without a callsign", () => {
    expect(pathMapSvg({ from: { lat: 41.3, lon: -87.2 }, to: { lat: 46.1, lon: -122.9 } })).not.toContain("<a ");
  });
});
