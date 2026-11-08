import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";

import { bcdToFreq, bcdToLevel, CivParser, frame, freqToBcd, levelToBcd, type CivFrame } from "../src/rig/civ.ts";
import { header, IcomLanSession, parseCaps, scramble, Upsampler2 } from "../src/rig/icom-lan.ts";
import { IcomRadio } from "../src/rig/icom.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ICOM LAN helpers", () => {
  it("scrambles credentials the way the radio expects", () => {
    // From the table: "a" (97) at position 0 → 0x38, "b" (98+1) → 0x2e, "c" (99+2) → 0x40.
    expect(scramble("abc").subarray(0, 4)).toEqual(Buffer.from([0x38, 0x2e, 0x40, 0x00]));
    expect(scramble("x".repeat(20)).length).toBe(16);
  });

  it("upsamples 24 kHz to 48 kHz without changing the tone", () => {
    const up = new Upsampler2();
    const x = new Float32Array(2400).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / 24_000) * 0.5);
    const y = up.process(x);
    expect(y.length).toBe(4800);
    // Compare with the ideal 48 kHz tone after the filter's delay settles.
    let peak = 0;
    for (let i = 400; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]!));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
  });
});

/**
 * An IC-7300MK2's network server, from the protocol as wfview and kappanhang describe it:
 * control, CI-V and audio streams, each with the are-you-there handshake and pings.
 */
async function simulatedLanRadio(opts: { user?: string; pass?: string; dataMod?: number } = {}) {
  const user = opts.user ?? "w9ml";
  const pass = opts.pass ?? "secret123";
  const rig = { freq: 14_074_000, power: 77, ptt: false, pttLog: [] as boolean[], dataMod: opts.dataMod ?? 5, txBytes: 0, loggedIn: false, convo: { rxRate: 0, txCodec: 0 } };
  const radioId = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const sockets: dgram.Socket[] = [];
  const timers: NodeJS.Timeout[] = [];

  async function stream(onPacket: (b: Buffer, reply: (x: Buffer) => void, peer: { id: Buffer; addr: string; port: number }) => void) {
    const s = dgram.createSocket("udp4");
    sockets.push(s);
    const peer = { id: Buffer.alloc(4), addr: "", port: 0 };
    const reply = (x: Buffer) => s.send(x, peer.port, peer.addr);
    s.on("message", (b, r) => {
      peer.addr = r.address;
      peer.port = r.port;
      const type = b.readUInt16LE(4);
      if (b.length === 0x10 && type === 0x03) {
        peer.id = Buffer.from(b.subarray(8, 12));
        return reply(header(0x10, 0x04, 0, radioId, peer.id));
      }
      if (b.length === 0x10 && type === 0x06) return reply(header(0x10, 0x06, 1, radioId, peer.id));
      if (b.length === 0x15 && type === 0x07) {
        if (b[0x10] === 0) {
          const p = header(0x15, 0x07, b.readUInt16LE(6), radioId, peer.id);
          p[0x10] = 1;
          reply(p);
        }
        return;
      }
      if (b.length === 0x10) return; // idle, disconnect
      onPacket(b, reply, peer);
    });
    await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
    return { s, port: s.address().port, peer, reply };
  }

  // CI-V answers, as the radio would give them.
  const civParser = new CivParser();
  const answer = (f: CivFrame): Buffer | null => {
    const d = [...f.data];
    const ok = frame(0xe0, 0xb6, 0xfb);
    const data = (...body: (number | number[] | Buffer)[]) => frame(0xe0, 0xb6, f.cmd, ...body);
    switch (f.cmd) {
      case 0x19:
        return data([0x00, 0xb6]);
      case 0x03:
        return data(freqToBcd(rig.freq));
      case 0x05:
        rig.freq = bcdToFreq(f.data.subarray(0, 5));
        return ok;
      case 0x26:
        return ok;
      case 0x1a:
        return d[0] === 0x05 && d[2] === 0x85 ? data([0x05, 0x00, 0x85, rig.dataMod]) : ok;
      case 0x14:
        if (d.length === 1) return data([0x0a], levelToBcd(rig.power));
        rig.power = bcdToLevel(f.data.subarray(1, 3));
        return ok;
      case 0x1c:
        if (d[0] === 0) {
          rig.ptt = d[1] === 1;
          rig.pttLog.push(rig.ptt);
        }
        return ok;
      case 0x15:
        if (d[0] === 0x02) return data([0x02], levelToBcd(120));
        if (d[0] === 0x11) return data([0x11], levelToBcd(rig.ptt ? 213 : 0));
        if (d[0] === 0x12) return data([0x12], levelToBcd(rig.ptt ? 48 : 0));
        return null;
    }
    return null;
  };

  let civSeq = 0;
  const civ = await stream((b, reply, peer) => {
    if (b[0x10] !== 0xc1) return; // open/close
    for (const f of civParser.push(b.subarray(0x15))) {
      const a = answer(f);
      if (!a) continue;
      const p = header(0x15 + a.length, 0, civSeq, radioId, peer.id);
      p[0x10] = 0xc1;
      p.writeUInt16LE(a.length, 0x11);
      p.writeUInt16BE(civSeq++, 0x13);
      a.copy(p, 0x15);
      reply(p);
    }
  });

  let audioSeq = 0;
  const audio = await stream((b) => {
    if (b.readUInt16LE(0x10) === 0x0080) rig.txBytes += b.readUInt16BE(0x16);
  });
  // Receive audio: 20 ms of a 1 kHz tone at 48 kHz every 20 ms, in the radio's two-packet split.
  let phase = 0;
  let audioStart = 0;
  let framesSent = 0;
  timers.push(
    setInterval(() => {
      if (!audio.peer.port) return;
      if (!audioStart) audioStart = Date.now();
      // Paced by the clock, not the timer: Windows stretches a 20 ms interval.
      while (framesSent < Math.floor((Date.now() - audioStart) / 20)) {
      framesSent++;
      const pcm = Buffer.alloc(1920);
      for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin(((phase++ % 48) / 48) * 2 * Math.PI) * 8000), i * 2);
      for (const part of [pcm.subarray(0, 1364), pcm.subarray(1364)]) {
        const p = header(0x18 + part.length, 0, audioSeq++, radioId, audio.peer.id);
        p.writeUInt16LE(0x8197, 0x10);
        p.writeUInt16BE(part.length, 0x16);
        part.copy(p, 0x18);
        audio.reply(p);
      }
      }
    }, 10),
  );

  const control = await stream((b, reply, peer) => {
    if (b.length === 0x80) {
      const r = header(0x60, 0, 0, radioId, peer.id);
      b.copy(r, 0x1a, 0x1a, 0x1c); // echo token request
      Buffer.from([0xde, 0xad, 0xbe, 0xef]).copy(r, 0x1c);
      const good = b.subarray(0x40, 0x50).equals(scramble(user)) && b.subarray(0x50, 0x60).equals(scramble(pass));
      if (!good) r.writeUInt32LE(0xfeffffff, 0x30);
      else rig.loggedIn = true;
      return reply(r);
    }
    if (b.length === 0x40 && b[0x15] === 0x02) {
      const caps = header(0x42 + 0x66, 0, 0, radioId, peer.id);
      caps.writeUInt16LE(1, 0x40);
      const e = 0x42;
      Buffer.from("0123456789abcdef").copy(caps, e);
      Buffer.from("IC-7300MK2").copy(caps, e + 0x10);
      Buffer.from("ICOM_VAUDIO").copy(caps, e + 0x30);
      caps[e + 0x52] = 0xb6;
      return reply(caps);
    }
    if (b.length === 0x90) {
      rig.convo = { rxRate: b.readUInt32BE(0x74), txCodec: b[0x73]! };
      const st = header(0x50, 0, 0, radioId, peer.id);
      st.writeUInt16BE(civ.port, 0x42);
      st.writeUInt16BE(audio.port, 0x46);
      return reply(st);
    }
  });

  return {
    rig,
    port: control.port,
    close: () => {
      for (const t of timers) clearInterval(t);
      for (const s of sockets) s.close();
    },
  };
}

const opened: { close: () => void }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.close();
});

describe("ICOM over the network, against a simulated IC-7300MK2", () => {
  it("parses the capabilities packet", () => {
    const b = Buffer.alloc(0x42 + 0x66);
    Buffer.from("IC-7300MK2").copy(b, 0x42 + 0x10);
    b[0x42 + 0x52] = 0xb6;
    expect(parseCaps(b)[0]).toMatchObject({ name: "IC-7300MK2", civ: 0xb6, useMac: false });
  });

  it("logs in, opens CI-V and audio, and runs the radio", async () => {
    const sim = await simulatedLanRadio();
    opened.push(sim);
    const warn: string[] = [];
    const log = (l: "info" | "warn", m: string) => l === "warn" && warn.push(m);
    const session = new IcomLanSession({ host: "127.0.0.1", port: sim.port, username: "w9ml", password: "secret123", log });
    await session.connect();
    expect(session.radio).toMatchObject({ name: "IC-7300MK2", civ: 0xb6 });
    expect(sim.rig.convo).toEqual({ rxRate: 48_000, txCodec: 0x04 });

    const r = new IcomRadio({ serialPath: "127.0.0.1 (LAN)", baud: 0, civAddress: 0xb6, audioDevice: "", ratedWatts: 100, defaultFreqHz: 14_074_000, log, io: session.io(), dataModSource: 0x05, modelName: session.radio!.name });
    let rx = 0;
    r.on("audio", (s) => (rx += s.length));
    await r.connect();
    expect(r.info.model).toBe("IC-7300MK2");
    expect(r.slice?.freqHz).toBe(14_074_000);
    await r.tune(7_074_000);
    expect(sim.rig.freq).toBe(7_074_000);

    // Received audio arrives decimated to 24 kHz.
    rx = 0;
    await wait(500);
    expect(rx).toBeGreaterThan(24_000 * 0.35);
    expect(rx).toBeLessThan(24_000 * 0.65);

    const samples = new Float32Array(24_000 * 0.4).fill(0.3);
    const rep = await r.transmitAudio({ samples, startAt: Date.now() + 250, lateLimitMs: 300 });
    expect(rep.ok).toBe(true);
    // Connect unkeys first, in case another program left the radio keyed.
    expect(sim.rig.pttLog).toEqual([false, true, false]);
    expect(rep.peakFwdW).toBeCloseTo(100);
    // Sent at 48 kHz, 16-bit: twice the samples, two bytes each.
    expect(sim.rig.txBytes).toBeGreaterThan(samples.length * 2 * 2 * 0.9);
    expect(warn).toEqual([]);
    await r.close();
  }, 15_000);

  it("says plainly when the password is wrong", async () => {
    const sim = await simulatedLanRadio();
    opened.push(sim);
    const session = new IcomLanSession({ host: "127.0.0.1", port: sim.port, username: "w9ml", password: "nope", log: () => {} });
    await expect(session.connect()).rejects.toThrow(/refused the username or password/);
  });

  it("warns when DATA MOD is not LAN", async () => {
    const sim = await simulatedLanRadio({ dataMod: 1 });
    opened.push(sim);
    const warn: string[] = [];
    const log = (l: "info" | "warn", m: string) => l === "warn" && warn.push(m);
    const session = new IcomLanSession({ host: "127.0.0.1", port: sim.port, username: "w9ml", password: "secret123", log });
    await session.connect();
    const r = new IcomRadio({ serialPath: "lan", baud: 0, civAddress: 0xb6, audioDevice: "", ratedWatts: 100, defaultFreqHz: 14_074_000, log, io: session.io(), dataModSource: 0x05 });
    await r.connect();
    expect(warn.join()).toMatch(/DATA MOD input is USB, not LAN/);
    await r.close();
  }, 15_000);
});
