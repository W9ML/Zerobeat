/**
 * ICOM's network protocol (the radio's built-in RS-BA1 v2 server), as used by the
 * IC-7300MK2, IC-705, IC-9700, IC-7610 and IC-905. ICOM does not publish it; this follows
 * what two independent open-source clients agree on, wfview (packettypes.h,
 * icomudp*.cpp; GPL-3.0) and kappanhang. The code is written fresh; the packet layouts
 * and the credential scrambling table below are theirs, byte for byte, because the radio
 * accepts nothing else.
 *
 * Three UDP streams, each with the same session handshake and keep-alives:
 *   control (50001)  login, token, radio capabilities, opening the other two
 *   CI-V    (50002)  CI-V frames, wrapped
 *   audio   (50003)  16-bit mono PCM both ways, little-endian
 * The radio tells us its CI-V and audio ports in a status packet; we tell it ours.
 *
 * Every packet starts with a 16-byte header: length (u32 LE), type (u16 LE), sequence
 * (u16 LE), our session id, the radio's session id. Type 3/4/6 are "are you there", "I am
 * here", "are you ready"; type 7 is a ping (answered with reply = 1); type 1 is a
 * retransmit request; type 5 is disconnect. Packets the radio may ask to have resent are
 * "tracked": numbered from one counter per stream and kept for a while.
 *
 * The protocol is not encrypted (the password is only scrambled), so it belongs on the
 * LAN. Do not forward these ports from the internet.
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

import { Decimator2, lowpassTaps } from "../dsp/dsp.ts";
import type { Capture, IcomIo, Playback, SerialLink } from "./icom-io.ts";

const PING_MS = 500;
const IDLE_MS = 100;
const STALE_MS = 15_000;
const TOKEN_RENEW_MS = 60_000;
const LAN_RATE = 48_000;
const CODEC_LPCM16_MONO = 0x04;
export const TX_BUFFER_MS = 150;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The scrambling ICOM applies to the username and password (16 bytes, zero-padded). */
const SCRAMBLE: number[] = [
  0x47, 0x5d, 0x4c, 0x42, 0x66, 0x20, 0x23, 0x46, 0x4e, 0x57, 0x45, 0x3d, 0x67, 0x76, 0x60, 0x41, 0x62, 0x39, 0x59, 0x2d, 0x68, 0x7e, 0x7c, 0x65, 0x7d, 0x49, 0x29, 0x72, 0x73, 0x78, 0x21, 0x6e, 0x5a, 0x5e, 0x4a, 0x3e, 0x71, 0x2c, 0x2a, 0x54, 0x3c, 0x3a, 0x63, 0x4f, 0x43, 0x75, 0x27, 0x79,
  0x5b, 0x35, 0x70, 0x48, 0x6b, 0x56, 0x6f, 0x34, 0x32, 0x6c, 0x30, 0x61, 0x6d, 0x7b, 0x2f, 0x4b, 0x64, 0x38, 0x2b, 0x2e, 0x50, 0x40, 0x3f, 0x55, 0x33, 0x37, 0x25, 0x77, 0x24, 0x26, 0x74, 0x6a, 0x28, 0x53, 0x4d, 0x69, 0x22, 0x5c, 0x44, 0x31, 0x36, 0x58, 0x3b, 0x7a, 0x51, 0x5f, 0x52,
];

export function scramble(s: string): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < s.length && i < 16; i++) {
    let p = s.charCodeAt(i) + i;
    if (p > 126) p = 32 + (p % 127);
    out[i] = SCRAMBLE[p - 32] ?? 0;
  }
  return out;
}

export function header(len: number, type: number, seq: number, mine: Buffer, theirs: Buffer): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(len, 0);
  b.writeUInt16LE(type, 4);
  b.writeUInt16LE(seq & 0xffff, 6);
  mine.copy(b, 8);
  theirs.copy(b, 12);
  return b;
}

export interface RadioCaps {
  guid: Buffer;
  useMac: boolean;
  mac: Buffer;
  name: string;
  audioName: string;
  civ: number;
}

function cstr(b: Buffer, at: number, len: number): string {
  const s = b.subarray(at, at + len);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? s.length : end).toString("latin1");
}

/** Capabilities: a 0x42-byte header then one 0x66-byte entry per radio. */
export function parseCaps(b: Buffer): RadioCaps[] {
  const out: RadioCaps[] = [];
  for (let at = 0x42; at + 0x66 <= b.length; at += 0x66) {
    const e = b.subarray(at, at + 0x66);
    out.push({
      guid: Buffer.from(e.subarray(0, 16)),
      useMac: e.readUInt16LE(0x07) === 0x8010,
      mac: Buffer.from(e.subarray(0x0a, 0x10)),
      name: cstr(e, 0x10, 32),
      audioName: cstr(e, 0x30, 32),
      civ: e[0x52]!,
    });
  }
  return out;
}

export function isCaps(b: Buffer): boolean {
  return b.length > 0x42 && (b.length - 0x42) % 0x66 === 0 && b.readUInt16LE(4) !== 0x01;
}

/** 48 kHz → 24 kHz is the receiver's own decimator; 24 → 48 is zero-stuff and filter. */
export class Upsampler2 {
  private readonly taps = lowpassTaps(31, 0.23);
  private readonly hist = new Float32Array(31);
  private pos = 0;
  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length * 2);
    const n = this.taps.length;
    for (let i = 0; i < out.length; i++) {
      this.hist[this.pos] = i % 2 === 0 ? x[i >> 1]! * 2 : 0;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += this.taps[k]! * this.hist[(this.pos - k + n) % n]!;
      out[i] = acc;
      this.pos = (this.pos + 1) % n;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// One UDP stream
// ---------------------------------------------------------------------------

type StreamEvents = { packet: [Buffer]; dead: [string] };

export class LanStream extends EventEmitter<StreamEvents> {
  readonly sock: dgram.Socket;
  mine = Buffer.alloc(4);
  theirs = Buffer.alloc(4);
  private seq = 0;
  private pingSeq = 0;
  private sent = new Map<number, Buffer>();
  private lastTracked = 0;
  private lastHeard = Date.now();
  private timers: NodeJS.Timeout[] = [];
  private waiters: { match: (b: Buffer) => boolean; resolve: (b: Buffer) => void }[] = [];
  closed = false;

  constructor(
    readonly name: string,
    readonly host: string,
    public port: number,
  ) {
    super();
    this.sock = dgram.createSocket("udp4");
    this.sock.on("message", (b) => this.onMessage(b));
    this.sock.on("error", (e) => this.emit("dead", `${name}: ${e.message}`));
  }

  bind(): Promise<number> {
    this.bound = true;
    return new Promise((resolve, reject) => {
      this.sock.once("error", reject);
      this.sock.bind(0, () => {
        this.sock.off("error", reject);
        resolve(this.sock.address().port);
      });
    });
  }

  /** Session ids the way the radio's own software makes them: from our address and port. */
  private makeId(localIp: string, localPort: number): void {
    const [, , c, d] = localIp.split(".").map(Number) as [number, number, number, number];
    this.mine.writeUInt32LE((((c & 0xff) << 24) | ((d & 0xff) << 16) | (localPort & 0xffff)) >>> 0, 0);
  }

  send(b: Buffer): void {
    if (this.closed) return;
    this.sock.send(b, this.port, this.host);
  }

  sendTracked(b: Buffer): void {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    b.writeUInt16LE(seq, 6);
    this.sent.set(seq, b);
    if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!);
    this.lastTracked = Date.now();
    this.send(b);
  }

  control(type: number, seq = 0, tracked = false): void {
    const b = header(0x10, type, seq, this.mine, this.theirs);
    if (tracked) this.sendTracked(b);
    else this.send(b);
  }

  /** Resolves with the first packet that matches, or rejects after `ms`. */
  expect(match: (b: Buffer) => boolean, ms: number, what: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (b: Buffer) => (clearTimeout(t), resolve(b)) };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.name}: ${what}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  /** "Are you there" until "I am here", then "are you ready" until "I am ready". */
  async open(timeoutMs = 4_000): Promise<void> {
    const local = await this.bindIfNeeded();
    const localIp = await localAddressFor(this.host);
    this.makeId(localIp, local);
    const here = this.expect((b) => b.length === 0x10 && b.readUInt16LE(4) === 0x04, timeoutMs, `no answer from ${this.host}:${this.port} (is the radio on, and its Network Control enabled?)`);
    this.control(0x03);
    const ayt = setInterval(() => this.control(0x03), 500);
    try {
      const r = await here;
      this.theirs = Buffer.from(r.subarray(8, 12));
    } finally {
      clearInterval(ayt);
    }
    const ready = this.expect((b) => b.length === 0x10 && b.readUInt16LE(4) === 0x06, timeoutMs, "radio did not get ready");
    this.control(0x06, 1);
    await ready;
    this.seq = 1;
  }

  private bound = false;
  private async bindIfNeeded(): Promise<number> {
    return this.bound ? this.sock.address().port : this.bind();
  }

  keepAlive(idle: boolean): void {
    this.timers.push(
      setInterval(() => {
        const b = header(0x15, 0x07, this.pingSeq, this.mine, this.theirs);
        b[0x10] = 0x00;
        b.writeUInt32LE((Date.now() % 86_400_000) >>> 0, 0x11);
        this.send(b);
      }, PING_MS),
    );
    if (idle) {
      this.timers.push(
        setInterval(() => {
          if (Date.now() - this.lastTracked >= IDLE_MS) this.control(0x00, 0, true);
        }, IDLE_MS),
      );
    }
    this.timers.push(
      setInterval(() => {
        if (Date.now() - this.lastHeard > STALE_MS) this.emit("dead", `${this.name}: nothing from the radio for ${STALE_MS / 1000} s`);
      }, 1_000),
    );
  }

  private onMessage(b: Buffer): void {
    if (b.length < 0x10) return;
    this.lastHeard = Date.now();
    const type = b.readUInt16LE(4);
    // Retransmit requests: one packet, or ranges.
    if (type === 0x01 && b.length === 0x10) return this.resend(b.readUInt16LE(6));
    if (type === 0x01 && b.length === 0x18) {
      for (let at = 0x10; at + 4 <= b.length; at += 4) {
        let s = b.readUInt16LE(at);
        const e = b.readUInt16LE(at + 2);
        for (let n = 0; n < 50; n++) {
          this.resend(s);
          if (s === e) break;
          s = (s + 1) & 0xffff;
        }
      }
      return;
    }
    if (type === 0x07 && b.length === 0x15) {
      if (b[0x10] === 0x00) {
        const r = header(0x15, 0x07, b.readUInt16LE(6), this.mine, this.theirs);
        r[0x10] = 0x01;
        b.copy(r, 0x11, 0x11, 0x15);
        this.send(r);
      } else if (b.readUInt16LE(6) === this.pingSeq) {
        this.pingSeq = (this.pingSeq + 1) & 0xffff;
      }
      return;
    }
    for (const w of this.waiters) {
      if (w.match(b)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(b);
        return;
      }
    }
    this.emit("packet", b);
  }

  private resend(seq: number): void {
    const p = this.sent.get(seq);
    if (p) this.send(p);
    else this.control(0x00, seq); // we no longer have it: an idle with that number
  }

  close(): void {
    if (this.closed) return;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try {
      this.control(0x05);
      this.control(0x05);
    } catch {
      /* socket gone */
    }
    this.closed = true;
    setTimeout(() => {
      try {
        this.sock.close();
      } catch {
        /* closed */
      }
    }, 50);
  }
}

async function localAddressFor(host: string): Promise<string> {
  // The address the OS would use to reach the radio.
  const s = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => s.connect(9, host, (e?: Error) => (e ? reject(e) : resolve())));
    return s.address().address;
  } catch {
    return "127.0.0.1";
  } finally {
    s.close();
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface IcomLanOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  log: (level: "info" | "warn", msg: string) => void;
}

export class IcomLanSession extends EventEmitter<{ closed: [Error | null] }> {
  radio: RadioCaps | null = null;
  private control: LanStream | null = null;
  private civ: LanStream | null = null;
  private audio: LanStream | null = null;
  private innerSeq = 0;
  private tokReq = Buffer.alloc(2);
  private token = Buffer.alloc(4);
  private tokenTimer: NodeJS.Timeout | null = null;
  private civSeq = 0;
  private audioSeq = 0;
  private closed = false;
  private civListeners: ((b: Buffer) => void)[] = [];
  private closeListeners: ((e: Error | null) => void)[] = [];
  private captureFn: ((s: Float32Array) => void) | null = null;
  private decimator = new Decimator2();

  constructor(private readonly opts: IcomLanOptions) {
    super();
  }

  async connect(): Promise<void> {
    const host = isIPv4(this.opts.host) ? this.opts.host : (await lookup(this.opts.host, { family: 4 })).address;
    try {
      const control = new LanStream("control", host, this.opts.port);
      this.control = control;
      control.on("dead", (why) => void this.close(new Error(why)));
      await control.open();

      // Login.
      this.tokReq = Buffer.from([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
      const login = this.inner(0x80, 0x00);
      scramble(this.opts.username).copy(login, 0x40);
      scramble(this.opts.password).copy(login, 0x50);
      Buffer.from("Zerobeat", "latin1").copy(login, 0x60);
      const loginReply = control.expect((b) => b.length === 0x60 && b.readUInt16LE(4) !== 0x01, 4_000, "no reply to login");
      control.sendTracked(login);
      const lr = await loginReply;
      if (lr.readUInt32LE(0x30) === 0xfeffffff) throw new Error("the radio refused the username or password (Menu → Set → Network → Network User1)");
      this.token = Buffer.from(lr.subarray(0x1c, 0x20));
      control.keepAlive(true);

      // Confirm the token; the radio then describes itself.
      const caps = control.expect(isCaps, 5_000, "the radio did not send its capabilities");
      this.sendToken(0x02);
      this.radio = parseCaps(await caps)[0] ?? null;
      if (!this.radio) throw new Error("the radio reported no transceiver");
      this.tokenTimer = setInterval(() => this.sendToken(0x05), TOKEN_RENEW_MS);

      // Open CI-V and audio: tell the radio our ports, it answers with its own.
      const civ = new LanStream("civ", host, 0);
      const audio = new LanStream("audio", host, 0);
      this.civ = civ;
      this.audio = audio;
      const civLocal = await civ.bind();
      const audioLocal = await audio.bind();
      const status = control.expect((b) => b.length === 0x50 && b.readUInt16LE(4) !== 0x01, 5_000, "the radio did not open the CI-V and audio streams");
      control.sendTracked(this.connInfo(civLocal, audioLocal));
      const st = await status;
      if (st.readUInt32LE(0x30) === 0xffffffff) throw new Error("the radio refused the connection (another program may hold it; wait a minute or restart the radio)");
      civ.port = st.readUInt16BE(0x42) || this.opts.port + 1;
      audio.port = st.readUInt16BE(0x46) || this.opts.port + 2;

      for (const s of [civ, audio]) s.on("dead", (why) => void this.close(new Error(why)));
      await civ.open();
      civ.keepAlive(true);
      civ.on("packet", (b) => this.onCiv(b));
      this.openCiv(true);
      await audio.open();
      audio.keepAlive(false);
      audio.on("packet", (b) => this.onAudio(b));
      control.on("packet", (b) => this.onControl(b));
      this.opts.log("info", `ICOM network session to ${this.radio.name} at ${this.opts.host}`);
    } catch (e) {
      this.close(null, true);
      throw e;
    }
  }

  /** A control-stream request with the common inner header filled in. */
  private inner(len: number, requestType: number): Buffer {
    const b = header(len, 0x00, 0, this.control!.mine, this.control!.theirs);
    b.writeUInt32BE(len - 0x10, 0x10);
    b[0x14] = 0x01;
    b[0x15] = requestType;
    b.writeUInt16BE(this.innerSeq++ & 0xffff, 0x16);
    this.tokReq.copy(b, 0x1a);
    return b;
  }

  private sendToken(type: number): void {
    if (!this.control || this.closed) return;
    const b = this.inner(0x40, type);
    this.token.copy(b, 0x1c);
    b.writeUInt16BE(0x0798, 0x24);
    this.control.sendTracked(b);
  }

  private connInfo(civPort: number, audioPort: number): Buffer {
    const r = this.radio!;
    const b = this.inner(0x90, 0x03);
    this.token.copy(b, 0x1c);
    if (r.useMac) {
      b.writeUInt16LE(0x8010, 0x27);
      r.mac.copy(b, 0x2a);
    } else r.guid.copy(b, 0x20);
    Buffer.from(r.name.slice(0, 31), "latin1").copy(b, 0x40);
    scramble(this.opts.username).copy(b, 0x60);
    b[0x70] = 1; // receive audio
    b[0x71] = 1; // transmit audio
    b[0x72] = CODEC_LPCM16_MONO;
    b[0x73] = CODEC_LPCM16_MONO;
    b.writeUInt32BE(LAN_RATE, 0x74);
    b.writeUInt32BE(LAN_RATE, 0x78);
    b.writeUInt32BE(civPort, 0x7c);
    b.writeUInt32BE(audioPort, 0x80);
    b.writeUInt32BE(TX_BUFFER_MS, 0x84);
    b[0x88] = 1;
    return b;
  }

  private onControl(b: Buffer): void {
    if (b.length === 0x50 && b.readUInt32LE(0x30) === 0 && b[0x40] === 0x01) void this.close(new Error("the radio ended the session"));
    if (b.length === 0x40 && b[0x14] === 0x02 && b[0x15] === 0x05 && b.readUInt32LE(0x30) === 0xffffffff) {
      this.opts.log("warn", "the radio rejected the token renewal");
    }
  }

  // ---- CI-V
  private openCiv(open: boolean): void {
    if (!this.civ) return;
    const b = header(0x16, 0x00, 0, this.civ.mine, this.civ.theirs);
    b[0x10] = 0xc0;
    b[0x11] = 0x01;
    b.writeUInt16BE(this.civSeq++ & 0xffff, 0x13);
    b[0x15] = open ? 0x04 : 0x00;
    this.civ.sendTracked(b);
  }

  private civStarted = false;
  private onCiv(b: Buffer): void {
    if (b.length <= 0x15 || b.readUInt16LE(4) === 0x01 || b[0x10] !== 0xc1) return;
    const n = b.readUInt16LE(0x11);
    if (n + 0x15 !== b.length) return;
    this.civStarted = true;
    const data = Buffer.from(b.subarray(0x15));
    for (const f of this.civListeners) f(data);
  }

  sendCiv(d: Buffer): void {
    if (!this.civ || this.closed) throw new Error("the network session is closed");
    const b = header(0x15 + d.length, 0x00, 0, this.civ.mine, this.civ.theirs);
    b[0x10] = 0xc1;
    b.writeUInt16LE(d.length, 0x11);
    b.writeUInt16BE(this.civSeq++ & 0xffff, 0x13);
    d.copy(b, 0x15);
    // Until the radio starts answering, keep asking it to open the CI-V stream.
    if (!this.civStarted) this.openCiv(true);
    this.civ.sendTracked(b);
  }

  // ---- audio
  private onAudio(b: Buffer): void {
    if (b.length < 0x20 || b.readUInt16LE(4) === 0x01 || !this.captureFn) return;
    const pcm = b.subarray(0x18);
    const n = pcm.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
    const s = this.decimator.process(f);
    if (s.length) this.captureFn(s);
  }

  /** Send 48 kHz 16-bit samples as the radio's TX audio packets. */
  sendAudio(pcm: Buffer): void {
    if (!this.audio || this.closed) return;
    for (let at = 0; at < pcm.length; at += 1364) {
      const part = pcm.subarray(at, Math.min(pcm.length, at + 1364));
      const b = header(0x18 + part.length, 0x00, 0, this.audio.mine, this.audio.theirs);
      b.writeUInt16LE(0x0080, 0x10);
      b.writeUInt16BE(this.audioSeq++ & 0xffff, 0x12);
      b.writeUInt16BE(part.length, 0x16);
      part.copy(b, 0x18);
      this.audio.sendTracked(b);
    }
  }

  // ---- the driver's view
  io(): IcomIo & { outputLatencyMs: number; close: () => void } {
    return {
      outputLatencyMs: TX_BUFFER_MS,
      openSerial: async (): Promise<SerialLink> => ({
        write: async (b) => this.sendCiv(b),
        onData: (fn) => this.civListeners.push(fn),
        onClose: (fn) => this.closeListeners.push(fn),
        close: () => void this.close(null),
      }),
      startCapture: (_device, _rate, onSamples): Capture => {
        this.captureFn = onSamples;
        return { stop: () => (this.captureFn = null) };
      },
      openPlayback: (): Playback => new LanPlayback(this),
      close: () => void this.close(null),
    };
  }

  async close(reason: Error | null = null, quiet = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    try {
      if (this.civ && !this.civ.closed && this.civ.theirs.readUInt32LE(0)) this.openCiv(false);
      if (this.control && this.radio) {
        const b = this.inner(0x40, 0x01); // de-auth
        this.token.copy(b, 0x1c);
        this.control.sendTracked(b);
      }
    } catch {
      /* best effort */
    }
    // Give the radio a moment to ask for anything it missed, then hang up.
    await new Promise((r) => setTimeout(r, quiet ? 0 : 200));
    for (const s of [this.civ, this.audio, this.control]) s?.close();
    this.captureFn = null;
    if (!quiet) {
      if (reason) this.opts.log("warn", `ICOM network session closed: ${reason.message}`);
      for (const f of this.closeListeners) f(reason);
      this.emit("closed", reason);
    }
  }
}

/** Paces TX audio into 20 ms frames at 48 kHz, a little ahead of real time. */
class LanPlayback implements Playback {
  private queue: Buffer[] = [];
  private queued = 0;
  private up = new Upsampler2();
  private timer: NodeJS.Timeout | null = null;
  private started = 0;
  private sentBytes = 0;
  private done: (() => void) | null = null;
  private killed = false;
  private static FRAME = (LAN_RATE / 50) * 2; // 20 ms of 16-bit mono

  constructor(private readonly s: IcomLanSession) {}

  async write(samples: Int16Array): Promise<void> {
    if (this.killed) throw new Error("playback is closed");
    const f = new Float32Array(samples.length);
    for (let i = 0; i < f.length; i++) f[i] = samples[i]! / 32768;
    const up = this.up.process(f);
    const b = Buffer.alloc(up.length * 2);
    for (let i = 0; i < up.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(up[i]! * 32767))), i * 2);
    this.queue.push(b);
    this.queued += b.length;
    if (!this.timer) {
      this.started = Date.now();
      this.timer = setInterval(() => this.pump(), 5);
      this.pump();
    }
  }

  private pump(): void {
    // Keep 60 ms ahead of real time; the radio's own buffer absorbs the rest.
    const due = ((Date.now() - this.started + 60) / 1000) * LAN_RATE * 2;
    while (this.sentBytes + LanPlayback.FRAME <= due + LanPlayback.FRAME && this.queued > 0) {
      const frame = this.take(LanPlayback.FRAME);
      this.s.sendAudio(frame);
      this.sentBytes += frame.length;
    }
    if (this.queued === 0 && this.done) {
      const d = this.done;
      this.done = null;
      this.stop();
      // Resolve once the radio has played what it holds.
      setTimeout(d, TX_BUFFER_MS + Math.max(0, (this.sentBytes / (LAN_RATE * 2)) * 1000 - (Date.now() - this.started)));
    }
  }

  private take(n: number): Buffer {
    const out = Buffer.alloc(Math.min(n, this.queued));
    let at = 0;
    while (at < out.length) {
      const head = this.queue[0]!;
      const k = Math.min(head.length, out.length - at);
      head.copy(out, at, 0, k);
      at += k;
      if (k === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(k);
    }
    this.queued -= out.length;
    return out;
  }

  finish(): Promise<void> {
    if (this.killed || (!this.timer && this.queued === 0)) return Promise.resolve();
    return new Promise((resolve) => {
      this.done = resolve;
      this.pump();
    });
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kill(): void {
    this.killed = true;
    this.queue = [];
    this.queued = 0;
    this.stop();
    const d = this.done;
    this.done = null;
    d?.();
  }
}
