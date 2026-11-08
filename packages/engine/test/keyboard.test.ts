import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { KeyLine } from "../src/digital/keyboard/common.ts";
import { cwText, cwTokens, cwWaveform, CwReceiver, MORSE } from "../src/digital/keyboard/cw.ts";
import { pskBits, PskReceiver, pskWaveform, VARICODE } from "../src/digital/keyboard/psk31.ts";
import { RttyReceiver, rttyText, rttyWaveform, toBaudot } from "../src/digital/keyboard/rtty.ts";
import { KeyboardDesk } from "../src/operate/keyboard.ts";
import { buildWaveform } from "../src/digital/waveform.ts";

function noise(n: number, amp: number, seed = 3): Float32Array {
  let s = seed;
  let spare: number | null = null;
  const g = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u = ((s = (s * 1103515245 + 12345) & 0x7fffffff) + 1) / 0x80000000;
    const v = ((s = (s * 1103515245 + 12345) & 0x7fffffff) + 1) / 0x80000000;
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return new Float32Array(n).map(() => g() * amp);
}

/** Noise of 0.3 rms with signals added; SNR in 2500 Hz of a sine of amplitude a is 10·log10(a²/2 / 0.0375). */
function band(seconds: number, sigs: { w: Float32Array; at: number; amp: number }[], seed = 3): Float32Array {
  const x = noise(12_000 * seconds, 0.3, seed);
  for (const s of sigs) s.w.forEach((v, i) => (x[s.at + i]! += v * s.amp));
  return x;
}

function run(rx: { rxHz: number; push(x: Float32Array, at: number): void }, x: Float32Array, rxHz: number): KeyLine[] {
  rx.rxHz = rxHz;
  for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, i + 480), i / 12);
  return [];
}

function listen<R extends { rxHz: number; push(x: Float32Array, at: number): void }>(make: (on: (l: KeyLine) => void) => R, x: Float32Array, rxHz: number) {
  const lines = new Map<string, KeyLine>();
  run(make((l) => lines.set(l.id, l)), x, rxHz);
  const all = [...lines.values()];
  return { rx: all.filter((l) => l.atRx).map((l) => l.text).join(" | "), band: all.filter((l) => !l.atRx), all };
}

describe("RTTY", () => {
  it("encodes Baudot with fldigi's US figures and unshift-on-space", () => {
    expect(toBaudot("RY")).toEqual([10, 21]);
    // FIGS before the digits; after the space, FIGS again (the receiver unshifted).
    expect(toBaudot("5NN 599 MA")).toEqual([27, 16, 31, 12, 12, 4, 27, 16, 24, 24, 4, 28, 3]);
    expect(rttyText("cq de w9ml/7 599 #1")).toBe("CQ DE W9ML/7 599 #1");
    expect(rttyText("café ~")).toBe("CAF ");
  });

  it("decodes a signal at -3 dB in 2500 Hz exactly, and two more across the band", () => {
    const msg = "CQ CQ TEST DE W9ML W9ML K 599 123 5NN TU";
    const r = listen(
      (on) => new RttyReceiver(on),
      band(16, [
        { w: rttyWaveform(msg, 1500, 12_000), at: 30_000, amp: 0.2 },
        { w: rttyWaveform("CQ CQ DE K1ABC K1ABC K", 900, 12_000), at: 36_000, amp: 0.3 },
        { w: rttyWaveform("W9XYZ 599 MA MA TU", 2105, 12_000), at: 40_000, amp: 0.25 },
      ]),
      1500,
    );
    expect(r.rx).toContain(msg);
    expect(r.band.map((l) => l.text).filter((t) => t.length > 4).sort()).toEqual(["CQ CQ DE K1ABC K1ABC K", "W9XYZ 599 MA MA TU"]);
  }, 30_000);

  it("prints nothing from two minutes of noise", () => {
    expect(listen((on) => new RttyReceiver(on), noise(12_000 * 120, 0.3, 9), 1500).all).toEqual([]);
  }, 60_000);

  it("prints nothing from FT4 and FT8 signals (14.080 is FT4's frequency too)", () => {
    const sigs: { w: Float32Array; at: number; amp: number }[] = [];
    for (let c = 0; c < 8; c++) {
      sigs.push({ w: buildWaveform("CQ K1ABC FN42", "FT4", 880, 12_000), at: Math.round(c * 7.5 * 12_000) + 6000, amp: 0.4 });
      sigs.push({ w: buildWaveform("W9ML K1ABC -12", "FT4", 1040, 12_000), at: Math.round(c * 7.5 * 12_000) + 6000, amp: 0.6 });
      if (c % 2 === 0) sigs.push({ w: buildWaveform("CQ DX W1AW FN31", "FT8", 2100, 12_000), at: c * 7.5 * 12_000 + 6000, amp: 0.5 });
    }
    const r = listen((on) => new RttyReceiver(on), band(62, sigs, 11), 900);
    expect(r.all.map((l) => l.text)).toEqual([]);
  }, 60_000);
});

describe("RTTY on the air", () => {
  // 75 s of 14.080 MHz on 2026-10-20: FT4 signals all over the passband, no RTTY.
  it("opens no band channels on a band full of FT4", () => {
    const b = readFileSync(new URL("./fixtures/ft4-band-14080.wav", import.meta.url));
    const x = new Float32Array((b.length - 44) >> 1);
    for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
    const r = listen((on) => new RttyReceiver(on), x, 900);
    expect(r.band.map((l) => l.text)).toEqual([]);
  }, 60_000);
});

describe("PSK31", () => {
  it("carries G3PLX's varicode (from fldigi): short codes for common letters, no 00 inside", () => {
    expect(VARICODE).toHaveLength(128);
    expect(new Set(VARICODE).size).toBe(128);
    expect(VARICODE.every((c) => c.startsWith("1") && c.endsWith("1") && !c.includes("00"))).toBe(true);
    expect([VARICODE[32], VARICODE[101], VARICODE[116], VARICODE[65], VARICODE[13], VARICODE[10]]).toEqual(["1", "11", "101", "1111101", "11111", "11101"]);
    expect(pskBits("e").slice(32, 39).join("")).toBe(VARICODE[13] + "00"); // the CR of the opening CR LF
  });

  it("decodes at -9 dB, follows a signal 8 Hz off, and finds others across the band", () => {
    const msg = "CQ CQ de W9ML W9ML pse k - Name: Mike, QTH Hebron IN (EN61) 73!";
    const r = listen(
      (on) => new PskReceiver(on),
      band(30, [
        { w: pskWaveform(msg, 1508, 12_000), at: 30_000, amp: 0.15 },
        { w: pskWaveform("CQ CQ DE K1ABC K1ABC K", 900, 12_000), at: 36_000, amp: 0.3 },
      ]),
      1500,
    );
    expect(r.rx).toContain(msg);
    expect(r.band.map((l) => l.text)).toContain("CQ CQ DE K1ABC K1ABC K");
  }, 30_000);

  it("prints nothing from two minutes of noise", () => {
    expect(listen((on) => new PskReceiver(on), noise(12_000 * 120, 0.3, 9), 1500).all).toEqual([]);
  }, 60_000);
});

describe("CW", () => {
  it("knows Morse, prosigns included", () => {
    expect(MORSE.K).toBe("-.-");
    expect(cwTokens("CQ de w9ml <SK>")).toEqual(["C", "Q", " ", "D", "E", " ", "W", "9", "M", "L", " ", "<SK>"]);
    expect(cwText("5nn  TU ~")).toBe("5NN TU");
  });

  it("times dits, dahs and gaps by PARIS", () => {
    // "E" at 20 WPM: 2 dits lead, 1 dit, 2 dits tail = 5 dits of 60 ms.
    expect(cwWaveform("E", 700, 12_000, 20).length).toBe(Math.round(5 * 0.06 * 12_000));
  });

  it.each([12, 25])("decodes %i WPM at -6 dB exactly", (wpm) => {
    const msg = "CQ CQ DE W9ML W9ML K <BT> 5NN 123 TU 73 <SK>";
    const r = listen((on) => new CwReceiver(on), band(75, [{ w: cwWaveform(msg, 700, 12_000, wpm), at: 30_000, amp: 0.14 }]), 700);
    expect(r.rx.replace(/ \| /g, " ").trim()).toContain("CQ DE W9ML W9ML K = 5NN 123 TU 73 <SK>");
  }, 30_000);

  it("copies several signals at once without phantom channels on their sidebands", () => {
    const r = listen(
      (on) => new CwReceiver(on),
      band(16, [
        { w: cwWaveform("CQ TEST K1ABC K1ABC", 520, 12_000, 28), at: 36_000, amp: 0.3 },
        { w: cwWaveform("W9XYZ 5NN MA", 1340, 12_000, 18), at: 40_000, amp: 0.25 },
        { w: cwWaveform("RX FREQ CW 73", 712, 12_000, 22), at: 30_000, amp: 0.3 },
      ], 5),
      700,
    );
    expect(r.rx.trim()).toBe("RX FREQ CW 73");
    expect(r.band).toHaveLength(2);
    expect(r.band.map((l) => l.text).join(" ")).toMatch(/TEST K1ABC K1ABC.*9XYZ 5NN MA/);
  }, 30_000);

  it("prints nothing from two minutes of noise", () => {
    expect(listen((on) => new CwReceiver(on), noise(12_000 * 120, 0.3, 9), 700).all).toEqual([]);
  }, 60_000);
});

describe("the keyboard desk", () => {
  it("fills each mode's function keys: the serial in a contest that wants one, nothing on a ragchew", () => {
    const d = new KeyboardDesk({ serial: 7, serialOn: true });
    d.setContext({ hisCall: "w9xyz" });
    d.start("RTTY");
    expect(d.compose({ fkey: 2 }, "K1ABC")).toEqual({ text: "W9XYZ 599 007 007" });
    d.start("CW");
    expect(d.compose({ fkey: 2 }, "K1ABC")).toEqual({ text: "W9XYZ 5NN 007" });
    // No contest: the report alone, no stray serial.
    d.setContext({ serialOn: false });
    expect(d.compose({ fkey: 2 }, "K1ABC")).toEqual({ text: "W9XYZ 5NN" });
    d.start("RTTY");
    expect(d.compose({ fkey: 2 }, "K1ABC")).toEqual({ text: "W9XYZ 599" });
    d.start("PSK31");
    expect(d.compose({ fkey: 1 }, "K1ABC")).toEqual({ text: "CQ CQ CQ de K1ABC K1ABC K1ABC pse k" });
    expect(d.compose({ text: "%h de %m" }, "K1ABC")).toEqual({ text: "W9XYZ de K1ABC" });
    d.setContext({ hisCall: "" });
    expect(d.compose({ fkey: 5 }, "K1ABC")).toEqual({ error: "set their call first (%H)" });
    d.start("JTTY");
    expect(d.compose({ fkey: 1 }, "K1ABC")).toMatchObject({ text: "CQ K1ABC CQ" });
  });

  it("sends CW at the speed set", () => {
    const d = new KeyboardDesk({ wpm: 30 });
    d.start("CW");
    const c = d.compose({ text: "E" }, "K1ABC") as { text: string };
    expect(d.waveform(c, 700).length).toBe(Math.round(5 * 0.04 * 24_000));
  });

  it("only listens in the mode it is in", () => {
    const d = new KeyboardDesk();
    const lines: KeyLine[] = [];
    d.on("line", (l) => lines.push(l));
    d.start("RTTY");
    const x = band(10, [{ w: rttyWaveform("PSK OR RTTY TEST TEST", 1500, 12_000), at: 30_000, amp: 0.3 }]);
    for (let i = 0; i < x.length; i += 480) d.feed(x.subarray(i, i + 480), i / 12);
    expect(lines.some((l) => l.text.includes("PSK OR RTTY TEST TEST"))).toBe(true);
    d.start("CW");
    lines.length = 0;
    for (let i = 0; i < x.length; i += 480) d.feed(x.subarray(i, i + 480), i / 12);
    expect(lines.filter((l) => l.text.includes("RTTY TEST"))).toEqual([]);
  }, 30_000);
});

describe("editable function keys", () => {
  it("keeps the operator's keys per mode, checks JTTY ones compile, and resets to the defaults", () => {
    const k = new KeyboardDesk();
    const defaults = [...k.defaultFkeys("RTTY")];
    const mine = ["CQ TEST %M %M", "%H 599 %X", "TU %M TEST", "%M", "%H", "%H 599 %X %X", "AGN", "%X"];
    expect(k.setFkeys("RTTY", mine)).toBeNull();
    expect(k.fkeys("RTTY")).toEqual(mine);
    expect(k.fkeys("CW")).toEqual(k.defaultFkeys("CW"));
    expect(k.setFkeys("RTTY", mine.slice(0, 7))).toMatch(/eight/);
    // JTTY keys must pack into frames.
    const bad = ["%Z%Z%Z " + "X".repeat(110), "%H %E", "", "", "", "", "", ""];
    expect(k.setFkeys("JTTY", bad)).toMatch(/^F1:/);
    expect(k.setFkeys("RTTY", null)).toBeNull();
    expect(k.fkeys("RTTY")).toEqual(defaults);
  });
});
