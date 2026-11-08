import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WSPR_POWERS,
  WsprHashTable,
  decodeWspr,
  normalizeWsprPower,
  packWspr,
  unpackWspr,
  wsprHash,
  wsprTones,
  wsprWaveform,
} from "../src/digital/wspr/index.ts";
import { hashlittle } from "../src/digital/wspr/codec.ts";
import { convEncode, deinterleave, fano, fanoMetricTable, interleave } from "../src/digital/wspr/fec.ts";
import { fftMixed } from "../src/digital/wspr/fft.ts";

/** mulberry32: a decent PRNG (a plain LCG's Box-Muller pairs are correlated enough to fake WSPR sync). */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
}

/** 120 s of unit-variance white noise at 12 kHz (6 kHz bandwidth). */
function noise(seed: number): Float64Array {
  const u = rng(seed);
  const x = new Float64Array(120 * 12000);
  for (let i = 0; i < x.length; i++) x[i] = Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return x;
}

/** Add a WSPR transmission at snrDb in 2500 Hz (wspr_wav.f90's scaling), starting at t0 s. */
function addSignal(x: Float64Array, message: string, f0: number, snrDb: number, t0 = 1): void {
  const w = wsprWaveform(wsprTones(message), f0, 12000);
  const a = Math.sqrt((2 * 2500) / 6000) * 10 ** (0.05 * snrDb);
  const k0 = Math.round(t0 * 12000);
  for (let i = 0; i < w.length && k0 + i < x.length; i++) x[k0 + i] = x[k0 + i]! + a * w[i]!;
}

const toAudio = (x: Float64Array) => Float32Array.from(x, (v) => v * 0.01);

describe("WSPR source coding", () => {
  it("hashes callsigns exactly as wsprd (lookup3 hashlittle, 15 bits)", () => {
    // Bob Jenkins' published test vectors for hashlittle
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hashlittle(enc(""), 0)).toBe(0xdeadbeef);
    expect(hashlittle(enc(""), 0xdeadbeef)).toBe(0xbd5b7dde);
    expect(hashlittle(enc("Four score and seven years ago"), 0)).toBe(0x17770551);
    expect(hashlittle(enc("Four score and seven years ago"), 1)).toBe(0xcd628161);
    // hashtable.txt written by WSJT-X's wsprd.exe after decoding 150426_0918.wav
    const table: Array<[string, number]> = [
      ["ND6P", 2711], ["W3BI", 4023], ["W5BIT", 4642], ["NM7J", 5785], ["KI7CI", 6857],
      ["W3HH", 8822], ["G8VDQ", 12775], ["WD4LHT", 15534], ["DJ6OL", 23865],
    ];
    for (const [call, h] of table) expect(wsprHash(call)).toBe(h);
  });

  it("rounds power to the legal levels as WSJT-X does", () => {
    expect(WSPR_POWERS.map(normalizeWsprPower)).toEqual(WSPR_POWERS);
    expect([1, 2, 4, 5, 6, 8, 9, 36, 61, -3].map(normalizeWsprPower)).toEqual([0, 3, 3, 7, 7, 7, 10, 37, 60, 0]);
    expect(unpackWspr(packWspr("K1ABC FN42 36"))!.dbm).toBe(37);
  });

  it("round-trips type 1 messages", () => {
    for (const m of ["K1ABC FN42 37", "W9ML EN61 30", "G4JNT IO90 0", "VK2XYZ QF56 60", "K1A FN42 10", "2E0ABC IO91 23"]) {
      const u = unpackWspr(packWspr(m))!;
      expect(u.message).toBe(m);
      expect(u.type).toBe(1);
      const [call, grid, dbm] = m.split(" ");
      expect([u.callsign, u.grid, u.dbm]).toEqual([call, grid, Number(dbm)]);
    }
    expect(unpackWspr(packWspr("k1abc fn42 37"))!.message).toBe("K1ABC FN42 37");
  });

  it("round-trips type 2 messages (prefixes, letter and two-digit suffixes)", () => {
    for (const m of ["PJ4/K1ABC 37", "F/G4XYZ 10", "VP2/W9ML 33", "K1ABC/P 7", "W9ML/7 20", "W9ML/12 0", "W9ML/99 47"]) {
      const u = unpackWspr(packWspr(m))!;
      expect(u.message).toBe(m);
      expect(u.type).toBe(2);
      expect(u.grid).toBeNull();
      expect(u.callsign).toBe(m.split(" ")[0]);
    }
  });

  it("round-trips type 3 messages through the hash table", () => {
    const table = new WsprHashTable();
    // Unknown hash: wsprd prints <...>
    let u = unpackWspr(packWspr("<PJ4/K1ABC> FK52UD 37"), table)!;
    expect(u).toMatchObject({ message: "<...> FK52UD 37", type: 3, callsign: null, grid: "FK52UD", dbm: 37 });
    // Hearing the type 2 message teaches the table the call...
    expect(unpackWspr(packWspr("PJ4/K1ABC 37"), table)!.type).toBe(2);
    u = unpackWspr(packWspr("<PJ4/K1ABC> FK52UD 37"), table)!;
    expect(u).toMatchObject({ message: "<PJ4/K1ABC> FK52UD 37", callsign: "PJ4/K1ABC", grid: "FK52UD" });
    // ...as does a type 1 message, with its locator.
    unpackWspr(packWspr("K1ABC FN42 37"), table);
    expect(unpackWspr(packWspr("<K1ABC> FN42AB 10"), table)!.message).toBe("<K1ABC> FN42AB 10");
    expect(table.grid(wsprHash("K1ABC"))).toBe("FN42");
    // entries() / from() persist it, like wsprd's hashtable.txt
    const again = WsprHashTable.from(table.entries());
    expect(again.call(wsprHash("PJ4/K1ABC"))).toBe("PJ4/K1ABC");
  });

  it("refuses what WSPR cannot send", () => {
    for (const m of ["", "K1ABC", "K1ABC FN42", "K1ABC ZZ42 37", "TOOLONGCALL FN42 37", "K1ABC FN42 X", "<K1ABC> FN42 37", "A/B/C 37"]) {
      expect(() => packWspr(m), m).toThrow();
    }
  });
});

describe("WSPR channel coding", () => {
  it("encodes channel tones as WSJT-X (golden vectors, checked by decoding with WSJT-X's wsprd.exe)", () => {
    expect(Buffer.from(packWspr("K1ABC FN42 37")).toString("hex")).toBe("f70c238b0d194000000000");
    expect(wsprTones("K1ABC FN42 37").join("")).toBe(
      "330020001020131222100323133220200032012322002232110233210221321222033030301210212032132003323032203020201023021112330231212221332000010320132222202332323320031222",
    );
    expect(wsprTones("PJ4/K1ABC 33").join("")).toBe(
      "310022001022111220120321111022200230030320022212130033030001323222013012321010012032112201303230223020021023001110310031230023332000010120112220222132323100031022",
    );
    expect(wsprTones("<PJ4/K1ABC> FK52UD 37").join("")).toBe(
      "332022223002133202300303131220222012032300200010310013210203103000211010103230210010130021123032201202221203021310130211012201112222032122310020000310101100011202",
    );
  });

  it("interleaves by bit reversal and back", () => {
    const x = Uint8Array.from({ length: 162 }, (_, i) => i);
    const y = interleave(x.slice());
    expect(y[0]).toBe(0);
    expect(y[128]).toBe(1); // index 1 bit-reversed is 128
    expect([...deinterleave(y)]).toEqual([...x]);
  });

  it("Fano-decodes clean and noisy soft symbols, and gives up on noise", () => {
    const data = packWspr("W9ML EN61 30");
    const code = convEncode(data).subarray(0, 162);
    const mt = fanoMetricTable();
    const clean = Uint8Array.from(code, (b) => (b ? 255 : 0));
    let r = fano(clean, 81, mt);
    expect(r.ok).toBe(true);
    expect([...r.data]).toEqual([...data.subarray(0, 10)]);
    // Soft symbols at about Es/No 2 dB, rms 50 as wsprd normalises them
    const u = rng(5);
    const gauss = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    const soft = Uint8Array.from(code, (b) => Math.max(0, Math.min(255, Math.trunc(128 + (b ? 32 : -32) + 38 * gauss()))));
    r = fano(soft, 81, mt);
    expect(r.ok).toBe(true);
    expect(unpackWspr(r.data)!.message).toBe("W9ML EN61 30");
    const junk = Uint8Array.from({ length: 162 }, () => Math.trunc(128 + 50 * gauss()) & 255);
    expect(fano(junk, 81, mt, 60, 200).ok).toBe(false);
  });

  it("has a mixed-radix FFT that matches the DFT", () => {
    for (const n of [12, 45, 360, 720]) {
      const u = rng(n);
      const re = Float64Array.from({ length: n }, () => u() - 0.5);
      const im = Float64Array.from({ length: n }, () => u() - 0.5);
      const [r0, i0] = [re.slice(), im.slice()];
      fftMixed(re, im);
      for (const k of [0, 1, n >> 1, n - 1]) {
        let sr = 0;
        let si = 0;
        for (let j = 0; j < n; j++) {
          const a = (-2 * Math.PI * ((k * j) % n)) / n;
          sr += r0[j]! * Math.cos(a) - i0[j]! * Math.sin(a);
          si += r0[j]! * Math.sin(a) + i0[j]! * Math.cos(a);
        }
        expect(Math.abs(sr - re[k]!) + Math.abs(si - im[k]!)).toBeLessThan(1e-9);
      }
    }
  });

  it("makes a phase-continuous waveform of the right length at any rate", () => {
    const tones = wsprTones("K1ABC FN42 37");
    expect(wsprWaveform(tones, 1500).length).toBe(162 * 8192);
    expect(wsprWaveform(tones, 1500, 48000).length).toBe(162 * 32768);
    const w = wsprWaveform(tones, 1500);
    let maxStep = 0;
    for (let i = 1; i < w.length; i++) maxStep = Math.max(maxStep, Math.abs(w[i]! - w[i - 1]!));
    expect(maxStep).toBeLessThan((2 * Math.PI * 1503) / 12000 + 1e-3); // no phase jumps
  });
});

describe("WSPR decoder (wsprd port)", () => {
  it("decodes WSJT-X's sample recording 150426_0918.wav exactly as wsprd does", () => {
    const buf = readFileSync(new URL("./fixtures/wspr/150426_0918.wav", import.meta.url));
    const at = buf.indexOf("data") + 8;
    const x = new Float32Array((buf.length - at) >> 1);
    for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(at + 2 * i) / 32768;
    const t = performance.now();
    const d = decodeWspr(x, { dialHz: 14_095_600 });
    const ms = performance.now() - t;
    // wsprd.exe (WSJT-X 3.3.0-beta2) -f 14.0956 150426_0918.wav prints:
    //   0918  -9  1.1  14.097046  0  ND6P DM04 30
    //   0918 -15  0.1  14.097060  0  W5BIT EL09 17
    //   0918 -23  2.2  14.097065  0  G8VDQ IO91 37
    //   0918  -6  0.6  14.097089  0  WD4LHT EL89 30
    //   0918  -1 -0.8  14.097103  0  NM7J DM26 30
    //   0918 -21  0.5  14.097117  0  KI7CI DM09 37
    //   0918 -18 -1.9  14.097130  0  DJ6OL JO52 37
    //   0918 -11  0.8  14.097187  0  W3HH EL89 30
    //   0918 -25  0.7  14.097194  0  W3BI FN20 30
    const want: Array<[number, number, number, string]> = [
      [-9, 1.13, 14.097046, "ND6P DM04 30"],
      [-15, 0.07, 14.09706, "W5BIT EL09 17"],
      [-23, 2.16, 14.097065, "G8VDQ IO91 37"],
      [-6, 0.62, 14.097089, "WD4LHT EL89 30"],
      [-1, -0.79, 14.097103, "NM7J DM26 30"],
      [-21, 0.54, 14.097117, "KI7CI DM09 37"],
      [-18, -1.94, 14.09713, "DJ6OL JO52 37"],
      [-11, 0.83, 14.097187, "W3HH EL89 30"],
      [-25, 0.75, 14.097194, "W3BI FN20 30"],
    ];
    expect(d.map((e) => [e.snrDb, e.dtSec, Math.round(e.freqHz) / 1e6, e.message])).toEqual(want);
    expect(d.every((e) => e.driftHz === 0 && e.type === 1)).toBe(true);
    // G8VDQ only comes out in the block-detection pass, 4.6 Hz from the stronger W5BIT,
    // after W5BIT has been subtracted; wsprd's ALL_WSPR.TXT shows 8080 Fano cycles per bit.
    const g8 = d.find((e) => e.callsign === "G8VDQ")!;
    expect(g8.pass).toBe(3);
    expect(Math.floor(g8.cycles / 81)).toBe(8080);
    console.log(`WSPR sample decode: ${d.length} decodes in ${ms.toFixed(0)} ms`);
    // A speed budget for a desktop; skipped on a busy station (deploy/build.sh sets this).
    if (!process.env.ZEROBEAT_SKIP_SPEED) expect(ms).toBeLessThan(6000);
  }, 60_000);

  it("single-pass mode matches wsprd -s", () => {
    const buf = readFileSync(new URL("./fixtures/wspr/150426_0918.wav", import.meta.url));
    const at = buf.indexOf("data") + 8;
    const x = new Float32Array((buf.length - at) >> 1);
    for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(at + 2 * i) / 32768;
    const d = decodeWspr(x, { passes: 1 });
    expect(d.map((e) => e.callsign)).toEqual(["ND6P", "W5BIT", "WD4LHT", "NM7J", "KI7CI", "DJ6OL", "W3HH"]);
  }, 60_000);

  it("hears its own -24 dB transmission in noise", () => {
    const x = noise(11);
    addSignal(x, "W9ML EN61 30", 1523.4, -24, 1.0);
    const d = decodeWspr(toAudio(x), { dialHz: 14_095_600 });
    expect(d).toHaveLength(1);
    const e = d[0]!;
    expect(e).toMatchObject({ message: "W9ML EN61 30", type: 1, callsign: "W9ML", grid: "EN61", dbm: 30, driftHz: 0 });
    expect(Math.abs(e.freqHz - (14_095_600 + 1523.4))).toBeLessThan(0.3);
    expect(Math.abs(e.dtSec)).toBeLessThan(0.1);
    expect(Math.abs(e.snrDb + 24)).toBeLessThanOrEqual(2);
  }, 60_000);

  it("decodes several stations at once, all three message types, and names the hashed call", () => {
    const x = noise(23);
    addSignal(x, "K1ABC FN42 37", 1420, -20, 1.0);
    addSignal(x, "PJ4/K1ABC 33", 1460, -12, 1.5); // strongest, so decoded before its type 3
    addSignal(x, "<PJ4/K1ABC> FK52UD 37", 1500, -22, 0.5);
    addSignal(x, "G4XYZ/P 10", 1540, -21, 1.0);
    addSignal(x, "W9ML/12 7", 1580, -23, 2.0);
    addSignal(x, "VK2XYZ QF56 23", 1605, -25, 1.2);
    // Two signals 3 Hz apart: the weaker one needs the stronger one subtracted first.
    addSignal(x, "N0ABC EM19 20", 1395, -12, 1.0);
    addSignal(x, "KB0ZZZ DN70 3", 1398, -21, 1.3);
    const table = new WsprHashTable();
    const d = decodeWspr(toAudio(x), { hashTable: table });
    expect(d.map((e) => e.message)).toEqual([
      "N0ABC EM19 20",
      "KB0ZZZ DN70 3",
      "K1ABC FN42 37",
      "PJ4/K1ABC 33",
      "<PJ4/K1ABC> FK52UD 37",
      "G4XYZ/P 10",
      "W9ML/12 7",
      "VK2XYZ QF56 23",
    ]);
    const t3 = d.find((e) => e.type === 3)!;
    expect(t3).toMatchObject({ callsign: "PJ4/K1ABC", grid: "FK52UD", dbm: 37 });
    expect(d.find((e) => e.callsign === "KB0ZZZ")!.pass).toBeGreaterThan(1);
    expect(table.call(wsprHash("K1ABC"))).toBe("K1ABC");
    for (const e of d) expect(Math.abs(e.freqHz - Math.round(e.freqHz))).toBeLessThan(0.3);
  }, 60_000);

  it("finds nothing in 2 minutes of noise", () => {
    for (const seed of [101, 202, 303]) {
      expect(decodeWspr(toAudio(noise(seed)), { wideband: true })).toEqual([]);
    }
  }, 60_000);
});
