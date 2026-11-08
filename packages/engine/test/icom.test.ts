import { describe, expect, it } from "vitest";

import { bcdToFreq, bcdToLevel, CivParser, frame, freqToBcd, levelToBcd, poPercent, swrFromLevel, type CivFrame } from "../src/rig/civ.ts";
import type { IcomIo, Playback, SerialLink } from "../src/rig/icom-io.ts";
import { IcomRadio } from "../src/rig/icom.ts";

describe("CI-V encoding", () => {
  it("frequencies are 5 bytes of little-endian BCD", () => {
    expect([...freqToBcd(14_074_000)]).toEqual([0x00, 0x40, 0x07, 0x14, 0x00]);
    expect(bcdToFreq(freqToBcd(7_047_500))).toBe(7_047_500);
    expect(bcdToFreq(freqToBcd(144_174_000))).toBe(144_174_000);
  });

  it("levels are 2 bytes of big-endian BCD", () => {
    expect([...levelToBcd(255)]).toEqual([0x02, 0x55]);
    expect(bcdToLevel(Buffer.from([0x01, 0x43]))).toBe(143);
  });

  it("meters follow the reference guide's calibration points", () => {
    expect(poPercent(143)).toBeCloseTo(50);
    expect(poPercent(213)).toBeCloseTo(100);
    expect(swrFromLevel(48)).toBeCloseTo(1.5);
    expect(swrFromLevel(120)).toBeCloseTo(3);
  });

  it("parser splits frames across chunks and drops collisions", () => {
    const p = new CivParser();
    const a = frame(0xe0, 0xb6, 0xfb);
    const b = frame(0xe0, 0xb6, 0x03, freqToBcd(14_074_000));
    const jam = Buffer.from([0xfe, 0xfe, 0xfc, 0xfc, 0xfd]);
    const all = Buffer.concat([a, jam, b]);
    const got = [...p.push(all.subarray(0, 9)), ...p.push(all.subarray(9))];
    expect(got.map((f) => f.cmd)).toEqual([0xfb, 0x03]);
    expect(bcdToFreq(got[1]!.data)).toBe(14_074_000);
  });
});

/** An IC-7300MK2 on the end of a fake USB cable, with CI-V USB echo back switched on. */
function simulatedRadio(opts: { dataMod?: number; silent?: boolean } = {}) {
  const rig = { freq: 14_074_000, mode: 1, data: 0, power: 77, ptt: false, dataMod: opts.dataMod ?? 1, pttLog: [] as boolean[], tuned: [] as number[] };
  let onData: ((b: Buffer) => void) | null = null;
  const parser = new CivParser();
  const reply = (f: CivFrame, ...body: (number | Buffer | number[])[]) => setTimeout(() => onData?.(frame(0xe0, 0xb6, f.cmd, ...body)), 2);
  const ok = () => setTimeout(() => onData?.(frame(0xe0, 0xb6, 0xfb)), 2);
  const handle = (f: CivFrame) => {
    if (opts.silent || f.to !== 0xb6) return;
    const d = [...f.data];
    switch (f.cmd) {
      case 0x19:
        return reply(f, [0x00, 0xb6]);
      case 0x03:
        return reply(f, freqToBcd(rig.freq));
      case 0x05:
        rig.freq = bcdToFreq(f.data.subarray(0, 5));
        rig.tuned.push(rig.freq);
        return ok();
      case 0x26:
        rig.mode = d[1]!;
        rig.data = d[2]!;
        return ok();
      case 0x1a:
        if (d[0] === 0x05 && d[1] === 0x00 && d[2] === 0x85) return reply(f, [0x05, 0x00, 0x85, rig.dataMod]);
        return ok();
      case 0x14:
        if (d.length === 1) return reply(f, [0x0a], levelToBcd(rig.power));
        rig.power = bcdToLevel(f.data.subarray(1, 3));
        return ok();
      case 0x1c:
        if (d[0] === 0x00) {
          rig.ptt = d[1] === 1;
          rig.pttLog.push(rig.ptt);
        }
        return ok();
      case 0x15:
        if (d[0] === 0x02) return reply(f, [0x02], levelToBcd(120));
        if (d[0] === 0x11) return reply(f, [0x11], levelToBcd(rig.ptt ? 213 : 0));
        if (d[0] === 0x12) return reply(f, [0x12], levelToBcd(rig.ptt ? 48 : 0));
        return;
    }
  };
  const played: Int16Array[] = [];
  let captureOn = false;
  const io: IcomIo = {
    async openSerial(): Promise<SerialLink> {
      return {
        write: async (b) => {
          onData?.(b); // echo back
          for (const f of parser.push(b)) handle(f);
        },
        onData: (fn) => (onData = fn),
        onClose: () => {},
        close: () => (onData = null),
      };
    },
    startCapture(_dev, _rate, onSamples) {
      captureOn = true;
      const t = setInterval(() => onSamples(new Float32Array(480)), 20);
      return { stop: () => ((captureOn = false), clearInterval(t)) };
    },
    openPlayback(): Playback {
      let total = 0;
      return {
        write: async (s) => {
          played.push(s);
          total += s.length;
        },
        finish: () => new Promise((r) => setTimeout(r, (total / 24_000) * 1000)),
        kill: () => {},
      };
    },
  };
  return { rig, io, played, capturing: () => captureOn };
}

function radio(io: IcomIo, warn: string[] = []) {
  return new IcomRadio({ serialPath: "/dev/ttyACM0", baud: 115200, civAddress: 0xb6, audioDevice: "plughw:CARD=CODEC,DEV=0", ratedWatts: 100, defaultFreqHz: 14_074_000, log: (l, m) => l === "warn" && warn.push(m), io });
}

describe("IcomRadio against a simulated IC-7300MK2", () => {
  it("connects: identifies the radio, reads the dial, sets USB-D, starts audio", async () => {
    const sim = simulatedRadio();
    const r = radio(sim.io);
    const audio: number[] = [];
    r.on("audio", (s) => audio.push(s.length));
    await r.connect();
    expect(r.info.model).toBe("IC-7300MK2");
    expect(r.slice).toMatchObject({ freqHz: 14_074_000, mode: "USB-D" });
    expect(sim.rig).toMatchObject({ mode: 1, data: 1 });
    expect(r.transmit.rfpower).toBe(30);
    await new Promise((res) => setTimeout(res, 60));
    expect(audio.length).toBeGreaterThan(0);
    await r.close();
    expect(sim.capturing()).toBe(false);
  });

  it("tunes and sets power", async () => {
    const sim = simulatedRadio();
    const r = radio(sim.io);
    await r.connect();
    await r.tune(7_074_000);
    await r.setRfPower(50);
    expect(sim.rig.freq).toBe(7_074_000);
    expect(sim.rig.power).toBe(128);
    expect(r.slice!.freqHz).toBe(7_074_000);
    await r.close();
  });

  it("warns when the radio takes data audio from somewhere other than USB", async () => {
    const warn: string[] = [];
    const r = radio(simulatedRadio({ dataMod: 0 }).io, warn);
    await r.connect();
    expect(warn.join()).toMatch(/DATA MOD input is MIC/);
    await r.close();
  });

  it("explains a radio that does not answer", async () => {
    await expect(radio(simulatedRadio({ silent: true }).io).connect()).rejects.toThrow(/no answer from CI-V address B6h/);
  });

  it("transmits: keys, plays the audio on time, reads power and SWR, unkeys", async () => {
    const sim = simulatedRadio();
    const r = radio(sim.io);
    await r.connect();
    const samples = new Float32Array(24_000 * 0.6).fill(0.5);
    const startAt = Date.now() + 150;
    const rep = await r.transmitAudio({ samples, startAt, lateLimitMs: 300 });
    expect(rep.ok).toBe(true);
    expect(rep.startedLateMs).toBeLessThan(50);
    expect(rep.peakFwdW).toBeCloseTo(100);
    expect(rep.peakSwr).toBeCloseTo(1.5);
    // Connect unkeys first, in case another program left the radio keyed.
    expect(sim.rig.pttLog).toEqual([false, true, false]);
    // Audio the transmission is already late for is skipped, to stay aligned to the slot.
    const played = sim.played.reduce((a, s) => a + s.length, 0);
    expect(played).toBe(samples.length - Math.max(0, Math.floor((rep.startedLateMs / 1000) * 24_000)));
    expect(played).toBeGreaterThan(samples.length - 24_000 * 0.05);
    expect(r.isKeyed).toBe(false);
    await r.close();
  });

  it("refuses to start a transmission it is already too late for", async () => {
    const sim = simulatedRadio();
    const r = radio(sim.io);
    await r.connect();
    const rep = await r.transmitAudio({ samples: new Float32Array(2400), startAt: Date.now() - 1000, lateLimitMs: 300 });
    expect(rep.ok).toBe(false);
    expect(rep.detail).toMatch(/too late/);
    expect(sim.rig.pttLog).toEqual([false]);
    await r.close();
  });
});
