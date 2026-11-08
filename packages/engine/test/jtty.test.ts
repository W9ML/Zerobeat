import { describe, expect, it } from "vitest";

import { decodeFrame, decodeLadder, encodeTones, withCrc, crc12, type Correlation } from "../src/digital/jtty/fec.ts";
import { classSectionAtom, compileMacro, controlAtom, frameBits, grid4Atom, locAtom, numAtom, numTimeAtom, packAtom, packText, renderAtoms, sectionIndexOf, standardCall, text5Atom, unpackFrame, zoneLocAtom, callAtom, type Atom } from "../src/digital/jtty/source.ts";

const hex34 = (a: Atom, eom: boolean) => {
  const b = frameBits(packAtom(a)!, eom);
  let v = 0n;
  for (const x of b) v = v * 2n + BigInt(x);
  return "0x" + v.toString(16).toUpperCase().padStart(9, "0");
};

describe("JTTY source encoding: the spec's golden vectors", () => {
  it.each([
    ["CQ K1ABC CQ", callAtom(0, "K1ABC"), true, "0x026F78D41"],
    ["EXCH_NUM full SERIAL 123, more", numAtom(1, 0, 123), false, "0x20007B008"],
    ["EXCH_NUM full SERIAL 123, EOM", numAtom(1, 0, 123), true, "0x20007B009"],
    ["EXCH_LOC full STATE CA", locAtom(1, 0, "CA"), true, "0x2001BA019"],
    ["ZONE_LOC3 05 NWT", zoneLocAtom(5, "NWT"), true, "0x00B790D29"],
    ["CLASS_SECTION 1D EMA", classSectionAtom(1, "D", sectionIndexOf("EMA")), true, "0x082C58029"],
    ["EXCH_NUM_TIME full 156 1749", numTimeAtom(1, 156, 17 * 60 + 49), true, "0x204E42D39"],
    ["CONTROL AGN?", controlAtom(0), true, "0x000000049"],
    ["GRID4 field-only FN42", grid4Atom(0, "FN42"), true, "0x04A198049"],
    ["TEXT5 HELLO", text5Atom("HELLO"), true, "0x11395558D"],
  ])("%s", (_name, atom, eom, want) => {
    expect(hex34(atom as Atom, eom as boolean)).toBe(want);
    const back = unpackFrame(frameBits(packAtom(atom as Atom)!, eom as boolean));
    expect(back?.atom).toEqual(atom);
  });

  it("knows which calls fit a call atom", () => {
    for (const c of ["K1ABC", "W9ML", "KA1ABC", "JA6DEF", "WB9XYZ", "K7RU", "AA5AU"]) expect(standardCall(c)).toBe(true);
    for (const c of ["PJ4/KA1ABC", "N6QEK/KL7", "Q1ABC", "ABCDEF", "1A", "K1ABCD"]) expect(standardCall(c)).toBe(false);
  });

  it("rejects invalid words", () => {
    const zero = new Array(34).fill(0);
    expect(unpackFrame(zero)).toBeNull();
    const reserved = frameBits(packAtom(text5Atom("HELLO"))!, true);
    reserved[32] = 1;
    expect(unpackFrame(reserved)).toBeNull();
  });
});

describe("JTTY automatic packing: the design doc's frame counts", () => {
  it.each([
    ["CQ K1ABC CQ", 1],
    ["CQ KA1ABC CQ", 1],
    ["WB9XYZ", 1],
    ["WB9XYZ TU CQ KA1ABC CQ", 2],
    ["WB9XYZ 599 123", 2],
    ["599 123", 1],
    ["599 MA", 1],
    ["599 FN42", 1],
    ["1D EMA", 1],
    ["599 001", 2],
    ["599 05", 2],
    ["599 BRUCE", 2],
    ["TU NOW JA6DEF 599 123", 2],
  ])("%s takes %i frame(s)", (text, frames) => {
    const p = packText(text as string)!;
    expect(p.atoms.length).toBe(frames);
    expect(renderAtoms(p.atoms)).toBe(text);
  });

  it("RTTY Roundup respells serials and packs them as one frame", () => {
    expect(packText("599 001", "rtty-roundup")!.atoms.length).toBe(1);
    expect(packText("K1ABC 599 001", "rtty-roundup")!.atoms.length).toBe(2);
    const p = packText("599 05", "rtty-roundup")!;
    expect(p.text).toBe("599 005");
    expect(p.atoms.length).toBe(1);
  });

  it("round-trips WSJT-X's test messages exactly, after normalization", () => {
    const msgs = ["CQ PJ4/KA1ABC CQ", "VP2/KF2GHI", "WB9XYZ GEORGE MA", "NOW IS THE TIME FOR ALL GOOD MEN TO COME TO THE AID OF THEIR PARTY.", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ +-./?!\"#$%,&*()_'=[]{}<>|:;", "WB9XYZ KA1ABC -09", "cq dx ka1abc"];
    for (const m of msgs) {
      const p = packText(m);
      if (!p) continue; // over 16 frames
      expect(renderAtoms(p.atoms)).toBe(p.text);
    }
    expect(packText("cq dx ka1abc")!.text).toBe("CQ DX KA1ABC");
  });

  it("compiles the shipped function keys to native atoms", () => {
    const ctx = { myCall: "K1ABC", hisCall: "W9XYZ", queueCall: "W7UVW", exchange: "107", profile: "unknown" as const };
    const want: [string, string, number][] = [
      ["CQ %M CQ", "CQ K1ABC CQ", 1],
      ["%H %E", "W9XYZ 599 107", 2],
      ["%H TU CQ %M CQ", "W9XYZ TU CQ K1ABC CQ", 2],
      ["%M", "K1ABC", 1],
      ["%H", "W9XYZ", 1],
      ["TU NOW %Q %E", "TU NOW W7UVW 599 107", 2],
      ["%H AGN?", "W9XYZ AGN?", 1],
      ["%E", "599 107", 1],
    ];
    for (const [t, text, frames] of want) {
      const r = compileMacro(t, ctx);
      expect("error" in r ? r.error : r.text).toBe(text);
      if (!("error" in r)) expect(r.atoms.length).toBe(frames);
    }
    expect(compileMacro("%H %E", { ...ctx, hisCall: "PJ4/KA1ABC" })).toHaveProperty("error");
  });
});

describe("JTTY FEC", () => {
  const corr = (tones: number[], amp: number, noise: number, seed = 1): Correlation => {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const re = new Float64Array(46 * 4);
    const im = new Float64Array(46 * 4);
    for (let t = 0; t < 46; t++) for (let k = 0; k < 4; k++) {
      re[t * 4 + k] = rnd() * noise + (k === tones[t] ? amp : 0);
      im[t * 4 + k] = rnd() * noise;
    }
    return { re, im };
  };
  const payload = frameBits(packAtom(text5Atom("HELLO"))!, true);

  it("appends a CRC that checks to zero", () => {
    expect(crc12(withCrc(payload), 46)).toBe(0);
  });

  it("decodes a clean frame and a noisy one, coherently and not", () => {
    const tones = encodeTones(payload);
    expect(tones.length).toBe(46);
    expect(decodeFrame(corr(tones, 1, 0), 1)).toEqual(payload);
    expect(decodeFrame(corr(tones, 1, 0.6, 3), 1)).toEqual(payload);
    expect(decodeLadder(corr(tones, 1, 0.9, 5))?.payload).toEqual(payload);
  });

  it("does not invent text from noise", () => {
    let false_ = 0;
    for (let seed = 1; seed <= 30; seed++) if (decodeLadder(corr(new Array(46).fill(0), 0, 1, seed))) false_++;
    expect(false_).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { JttyAssembler, JttyReceiver, atomsToTones, tonesToWaveform, type JttyFrame } from "../src/digital/jtty/modem.ts";

function receive(x: Float32Array, rxHz = 1500): { frames: JttyFrame[]; messages: Map<number, string> } {
  const frames: JttyFrame[] = [];
  const asm = new JttyAssembler();
  const messages = new Map<number, string>();
  const rx = new JttyReceiver((f) => {
    frames.push(f);
    const m = asm.add(f);
    messages.set(m.id, m.text);
  });
  rx.rxHz = rxHz;
  for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, Math.min(x.length, i + 480)), 0);
  rx.push(new Float32Array(12_000 * 3), 0);
  return { frames, messages };
}

function noise(n: number, amp: number, seed = 11): Float32Array {
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

describe("JTTY assembler", () => {
  it("keeps one transmission on one line when frames are lost, marking the gap", () => {
    const asm = new JttyAssembler();
    const FRAME = 59 * 384;
    const frame = (k: number, text: string, eom = false): JttyFrame =>
      ({ at: 1_000_000 + k * FRAME, atMs: 1_000 + k * 1888, freqHz: 1337, snr: -12, atom: text5Atom(text), text, eom, coherent: 1 }) as JttyFrame;
    const ids = new Set<number>();
    let last = "";
    for (const [k, s] of [[0, "CHRIS"], [1, " NICE"], [3, " TO SE"], [4, "E YOU"], [9, " JR1NH"]] as const) {
      const m = asm.add(frame(k, s));
      ids.add(m.id);
      last = m.text;
    }
    expect(ids.size).toBe(1);
    expect(last.split("…")).toHaveLength(3);
    // Too long a silence is another transmission.
    expect(asm.add(frame(30, "CQ")).id).not.toBe([...ids][0]);
  });
});

describe("JTTY modem", () => {
  it("decodes WSJT-X's own sample recording (260807_134110.wav) exactly", () => {
    const buf = readFileSync(new URL("./fixtures/jtty_260807_134110.wav", import.meta.url));
    const at = buf.indexOf("data") + 8;
    const x = new Float32Array((buf.length - at) >> 1);
    for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(at + 2 * i) / 32768;
    const { frames, messages } = receive(x);
    expect([...messages.values()]).toEqual(["RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!"]);
    expect(frames).toHaveLength(10);
    for (const f of frames) expect(Math.abs(f.freqHz - 1507)).toBeLessThan(3);
    expect(frames.at(-1)!.eom).toBe(true);
  }, 30_000);

  it("hears its own transmission: two messages, back to back, with noise", () => {
    const a = packText("CQ K1ABC CQ")!.atoms;
    const b = packText("WB9XYZ 599 107 GL")!.atoms;
    const wa = tonesToWaveform(atomsToTones(a), 1200, 12_000);
    const wb = tonesToWaveform(atomsToTones(b), 1830, 12_000);
    const x = noise(12_000 * 14, 0.5);
    const add = (w: Float32Array, at: number, amp: number) => w.forEach((v, i) => (x[at + i]! += v * amp));
    add(wa, 6_000, 0.12); // about -12 dB in 2.5 kHz, near JTTY's limit
    add(wb, 30_000, 0.12);
    const { messages } = receive(x, 1200);
    expect([...messages.values()].sort()).toEqual(["CQ K1ABC CQ", "WB9XYZ 599 107 GL"]);
  }, 30_000);

  it("finds nothing in 30 s of noise", () => {
    const { frames } = receive(noise(12_000 * 30, 0.3, 77));
    expect(frames).toEqual([]);
  }, 60_000);

  it("transmits 1.888 s per frame at the requested rate", () => {
    const w = tonesToWaveform(atomsToTones(packText("CQ K1ABC CQ")!.atoms), 1500, 24_000);
    expect(w.length).toBe(59 * 768);
  });
});

import { Receiver } from "../src/digital/receiver.ts";
import type { Decoder } from "../src/digital/decoder.ts";
import { modeForDial } from "../src/digital/timing.ts";
import { KeyboardDesk, type KeyLine } from "../src/operate/keyboard.ts";

describe("JTTY on the station", () => {
  it("hears a message sent as radio audio at 24 kHz, through the receiver and the desk", () => {
    const rx = new Receiver({} as Decoder, () => {});
    rx.setSlotted(false);
    const desk = new KeyboardDesk();
    const lines: KeyLine[] = [];
    desk.on("line", (l) => lines.push(l));
    rx.on("audio", (x, at) => desk.feed(x, at));
    desk.start("JTTY");
    desk.setContext({ hisCall: "W9XYZ", exchange: "" });
    const c = desk.compose({ fkey: 2 }, "K1ABC"); // "%H %E" → W9XYZ 599 001
    if ("error" in c) throw new Error(c.error);
    expect(c.text).toBe("W9XYZ 599 001");
    const w = desk.waveform(c, 1400);
    const x = new Float32Array(24_000 * 10);
    let s = 5;
    for (let i = 0; i < x.length; i++) x[i] = (((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1) * 0.05;
    for (let i = 0; i < w.length; i++) x[24_000 + i]! += w[i]! * 0.3;
    const t0 = Date.UTC(2026, 9, 20, 12, 0, 0);
    for (let i = 0; i < x.length; i += 256) rx.feed(x.subarray(i, i + 256), t0 + ((i + 256) / 24_000) * 1000);
    const last = lines.at(-1)!;
    expect(last.text).toBe("W9XYZ 599 001");
    expect(last.complete).toBe(true);
    expect(Math.abs(last.freqHz - 1400)).toBeLessThan(3);
    expect(Math.abs(last.startMs - (t0 + 1000))).toBeLessThan(60);
  }, 30_000);

  it("keeps JTTY when it shares a dial frequency with FT4", () => {
    expect(modeForDial(10_140_000)).toBe("FT4");
    expect(modeForDial(10_140_000, "JTTY")).toBe("JTTY");
    expect(modeForDial(14_090_000)).toBe("JTTY");
    expect(modeForDial(14_074_000, "JTTY")).toBe("FT8");
  });

  it("refuses text JTTY cannot carry, and fills function keys from the context", () => {
    const desk = new KeyboardDesk();
    desk.start("JTTY");
    expect(desk.compose({ text: "   " }, "K1ABC")).toEqual({ error: "nothing to send" });
    expect(desk.compose({ text: "X".repeat(100) }, "K1ABC")).toHaveProperty("error");
    expect(desk.compose({ fkey: 5 }, "K1ABC")).toHaveProperty("error"); // no his call yet
    desk.setContext({ hisCall: "w9xyz", queueCall: "", exchange: "", serial: 42 });
    expect(desk.compose({ text: "%h tu" }, "K1ABC")).toMatchObject({ text: "W9XYZ TU" });
    expect(desk.compose({ fkey: 8 }, "K1ABC")).toMatchObject({ text: "599 042" });
  });
});

describe("JTTY strong and weak signals together", () => {
  // A +13 dB CQ with a -7 dB reply 60 Hz up, starting 400 ms later: their tones overlap.
  const mix = (subtraction: boolean) => {
    const ws = tonesToWaveform(atomsToTones(packText("CQ K1ABC CQ")!.atoms), 1500, 12_000);
    const ww = tonesToWaveform(atomsToTones(packText("W9XYZ 599 107")!.atoms), 1560, 12_000);
    const x = noise(12_000 * 10, 0.5, 3);
    ws.forEach((v, i) => (x[12_000 + i]! += v * 2.0));
    ww.forEach((v, i) => (x[16_800 + i]! += v * 0.2));
    const frames: JttyFrame[] = [];
    const asm = new JttyAssembler();
    const messages = new Map<number, { text: string; snr: number }>();
    const rx = new JttyReceiver((f) => {
      frames.push(f);
      const m = asm.add(f);
      messages.set(m.id, { text: m.text, snr: m.snr });
    });
    rx.subtraction = subtraction;
    for (let i = 0; i < x.length; i += 480) rx.push(x.subarray(i, i + 480), 0);
    rx.push(new Float32Array(36_000), 0);
    return [...messages.values()];
  };

  it("finds the weak one under the strong one by subtracting it, as WSJT-X does", () => {
    const got = mix(true);
    expect(got.map((m) => m.text).sort()).toEqual(["CQ K1ABC CQ", "W9XYZ 599 107"]);
    const weak = got.find((m) => m.text === "W9XYZ 599 107")!;
    expect(Math.abs(weak.snr - -7)).toBeLessThanOrEqual(2); // WSJT-X's SNR in 2500 Hz
  }, 30_000);

  it("without subtraction loses the part sent under the strong one", () => {
    // Only the frame after the CQ ends gets through: "599 107", the call is gone.
    expect(mix(false).map((m) => m.text).sort()).toEqual(["599 107", "CQ K1ABC CQ"]);
  }, 30_000);

  it("reports SNR in 2500 Hz like WSJT-X", () => {
    const w = tonesToWaveform(atomsToTones(packText("CQ K1ABC CQ")!.atoms), 1200, 12_000);
    const x = noise(12_000 * 6, 0.5, 9);
    w.forEach((v, i) => (x[6_000 + i]! += v * 0.12)); // -11.6 dB
    const { frames } = receive(x, 1200);
    expect(frames).toHaveLength(1);
    expect(Math.abs(frames[0]!.snr - -11.6)).toBeLessThanOrEqual(2);
  }, 30_000);
});
