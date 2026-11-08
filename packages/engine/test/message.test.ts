import { describe, expect, it } from "vitest";
import { encodeFT8, decodeFT8, HashCallBook } from "@e04/ft8ts";
import { parseMessage, standardMessages, formatReport, isCallToken, isStandardCall } from "../src/digital/message.ts";

describe("message grammar", () => {
  it("parses CQ forms", () => {
    expect(parseMessage("CQ W9ML EN61")[0]).toMatchObject({ kind: "cq", from: "W9ML", grid: "EN61", modifier: null });
    expect(parseMessage("CQ POTA N7XAK DN40")[0]).toMatchObject({ kind: "cq", from: "N7XAK", modifier: "POTA" });
    expect(parseMessage("CQ 9 K9XYZ EN61")[0]).toMatchObject({ kind: "cq", from: "K9XYZ", modifier: "9" });
    expect(parseMessage("CQ DX JA1XYZ")[0]).toMatchObject({ kind: "cq", from: "JA1XYZ", modifier: "DX", grid: null });
    expect(parseMessage("CQ PJ4/K1ABC")[0]).toMatchObject({ kind: "cq", from: "PJ4/K1ABC", nonstandard: true });
  });
  it("parses directed payloads, RR73 before grid", () => {
    const p = (m: string) => (parseMessage(m)[0] as any).payload;
    expect(p("W9ML K1ABC FN42")).toEqual({ kind: "grid", grid: "FN42" });
    expect(p("W9ML K1ABC -08")).toEqual({ kind: "report", db: -8 });
    expect(p("W9ML K1ABC R+05")).toEqual({ kind: "rreport", db: 5 });
    expect(p("W9ML K1ABC RR73")).toEqual({ kind: "rr73" });
    expect(p("W9ML K1ABC RRR")).toEqual({ kind: "rrr" });
    expect(p("W9ML K1ABC 73")).toEqual({ kind: "73" });
    expect(p("W9ML K1ABC R FN42")).toEqual({ kind: "rgrid", grid: "FN42" });
    expect(p("W9ML PJ4/K1ABC")).toEqual({ kind: "none" });
    expect(parseMessage("<W9ML> PJ4/K1ABC RR73")[0]).toMatchObject({ kind: "directed", to: "W9ML", from: "PJ4/K1ABC" });
  });
  it("splits fox/hound compounds", () => {
    const m = parseMessage("K1ABC RR73; W9ML <KH1/KH7Z> -12");
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ to: "K1ABC", from: "KH1/KH7Z", payload: { kind: "rr73" } });
    expect(m[1]).toMatchObject({ to: "W9ML", from: "KH1/KH7Z", payload: { kind: "report", db: -12 } });
  });
  it("classifies tokens", () => {
    expect(isCallToken("9")).toBe(false);
    expect(isCallToken("RR73")).toBe(false);
    expect(isCallToken("EN61")).toBe(false);
    expect(isCallToken("W9ML")).toBe(true);
    expect(isStandardCall("W9ML")).toBe(true);
    expect(isStandardCall("K1ABC/P")).toBe(true);
    expect(isStandardCall("PJ4/K1ABC")).toBe(false);
    expect(formatReport(-8)).toBe("-08");
    expect(formatReport(0)).toBe("+00");
    expect(formatReport(-60)).toBe("-50");
  });
  it("produces templates that survive encode/decode, including compound calls", () => {
    const book = new HashCallBook();
    book.save("W9ML");
    book.save("PJ4/K1ABC");
    const check = (msg: string) => {
      const audio = encodeFT8(msg, { sampleRate: 12000, baseFrequency: 1200 });
      const buf = new Float32Array(15 * 12000);
      buf.set(audio, 6000);
      const d = decodeFT8(buf, { sampleRate: 12000, depth: 1, hashCallBook: book });
      return d[0]?.msg ?? "";
    };
    const std = standardMessages("W9ML", "JA1XYZ", "EN61", -10);
    expect(check(std.tx1)).toBe("JA1XYZ W9ML EN61");
    expect(check(std.tx3)).toBe("JA1XYZ W9ML R-10");
    const cmp = standardMessages("W9ML", "PJ4/K1ABC", "EN61", -10);
    expect(check(cmp.tx1)).toBe("PJ4/K1ABC <W9ML>");
    expect(check(cmp.tx2)).toBe("<PJ4/K1ABC> W9ML -10");
    expect(check(cmp.tx4)).toBe("PJ4/K1ABC <W9ML> RR73");
  }, 30000);
});

import { buildWaveform } from "../src/digital/waveform.ts";
describe("waveform", () => {
  it("has the right length at 24 kHz", () => {
    expect(buildWaveform("CQ W9ML EN61", "FT8", 1500).length).toBe(79 * 3840);
    expect(buildWaveform("CQ W9ML EN61", "FT4", 1500).length).toBeGreaterThanOrEqual(105 * 1152);
    expect(() => buildWaveform("CQ W9ML EN61", "FT8", 3500)).toThrow();
  });
});
