/**
 * UDP feed for other station software: GridTracker, Log4OM, N1MM Logger+, JTAlert-style
 * tools, HRD and anything else that listens for WSJT-X.
 *
 * Two formats, chosen per destination:
 *   wsjtx  The WSJT-X network protocol (NetworkMessage.hpp, schema 2): Heartbeat, Status,
 *          Decode, QSO Logged, Logged ADIF and Close go out. Optionally, Reply ("call this
 *          station", what a GridTracker double-click sends) and Halt Tx come back in.
 *   adif   One plain ADIF record per datagram when a contact is logged, for loggers that
 *          take raw ADIF over UDP.
 *
 * Inbound control is off unless switched on, and even then only datagrams from the
 * addresses we send to are believed; anything else is dropped without a reply.
 * Encoding is QDataStream: big-endian, utf8 strings as a 32-bit length (0xffffffff for
 * null) then bytes, QTime as milliseconds since midnight, QDateTime as a Julian day
 * (qint64), milliseconds since midnight and a time spec byte (1 = UTC).
 */
import dgram from "node:dgram";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

export const MAGIC = 0xadbccbda;
export const SCHEMA = 2;
export const MAX_SCHEMA = 3;

export enum MsgType {
  Heartbeat = 0,
  Status = 1,
  Decode = 2,
  Clear = 3,
  Reply = 4,
  QsoLogged = 5,
  Close = 6,
  Replay = 7,
  HaltTx = 8,
  FreeText = 9,
  WsprDecode = 10,
  Location = 11,
  LoggedAdif = 12,
  HighlightCallsign = 13,
}

const NO_VALUE = 0xffffffff;
const JD_UNIX_EPOCH = 2_440_588;

class Writer {
  private parts: Buffer[] = [];
  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff);
    this.parts.push(b);
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
    return this;
  }
  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.round(v));
    this.parts.push(b);
    return this;
  }
  u64(v: number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(v))));
    this.parts.push(b);
    return this;
  }
  i64(v: number): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(Math.round(v)));
    this.parts.push(b);
    return this;
  }
  f64(v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    this.parts.push(b);
    return this;
  }
  utf8(s: string | null): this {
    if (s === null) return this.u32(NO_VALUE);
    const b = Buffer.from(s, "utf8");
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }
  qtime(epochMs: number): this {
    return this.u32(((epochMs % 86_400_000) + 86_400_000) % 86_400_000);
  }
  qdatetime(epochMs: number): this {
    return this.i64(Math.floor(epochMs / 86_400_000) + JD_UNIX_EPOCH)
      .qtime(epochMs)
      .u8(1);
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class Reader {
  private o = 0;
  constructor(private readonly b: Buffer) {}
  private need(n: number): void {
    if (this.o + n > this.b.length) throw new RangeError("short datagram");
  }
  u8(): number {
    this.need(1);
    return this.b.readUInt8(this.o++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    this.need(4);
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.b.readInt32BE(this.o);
    this.o += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.b.readDoubleBE(this.o);
    this.o += 8;
    return v;
  }
  utf8(): string | null {
    const n = this.u32();
    if (n === NO_VALUE) return null;
    if (n > 4096) throw new RangeError("string too long");
    this.need(n);
    const s = this.b.toString("utf8", this.o, this.o + n);
    this.o += n;
    return s;
  }
  get done(): boolean {
    return this.o >= this.b.length;
  }
}

function header(type: MsgType, id: string): Writer {
  return new Writer().u32(MAGIC).u32(SCHEMA).u32(type).utf8(id);
}

// ---------------------------------------------------------------------------
// Outbound messages
// ---------------------------------------------------------------------------

export function encodeHeartbeat(id: string, version: string, revision = ""): Buffer {
  return header(MsgType.Heartbeat, id).u32(MAX_SCHEMA).utf8(version).utf8(revision).build();
}

export interface StatusInfo {
  dialHz: number;
  mode: string;
  dxCall: string;
  report: string;
  txEnabled: boolean;
  transmitting: boolean;
  decoding: boolean;
  rxDf: number;
  txDf: number;
  deCall: string;
  deGrid: string;
  dxGrid: string;
  periodSec: number | null;
  configName: string;
  txMessage: string;
}

export function encodeStatus(id: string, s: StatusInfo): Buffer {
  return header(MsgType.Status, id)
    .u64(s.dialHz)
    .utf8(s.mode)
    .utf8(s.dxCall)
    .utf8(s.report)
    .utf8(s.mode)
    .bool(s.txEnabled)
    .bool(s.transmitting)
    .bool(s.decoding)
    .u32(s.rxDf)
    .u32(s.txDf)
    .utf8(s.deCall)
    .utf8(s.deGrid)
    .utf8(s.dxGrid)
    .bool(false) // Tx watchdog
    .utf8("") // sub-mode
    .bool(false) // fast mode
    .u8(0) // special operation: none
    .u32(NO_VALUE) // frequency tolerance: n/a
    .u32(s.periodSec ?? NO_VALUE)
    .utf8(s.configName)
    .utf8(s.txMessage)
    .build();
}

/** WSJT-X's one-character mode tags in Decode messages. */
export const MODE_CHAR: Record<string, string> = { FT8: "~", FT4: "+" };

export interface DecodeInfo {
  at: number; // window start, epoch ms
  snr: number;
  dt: number;
  dfHz: number;
  mode: string;
  text: string;
  lowConfidence: boolean;
}

export function encodeDecode(id: string, d: DecodeInfo, isNew = true): Buffer {
  return header(MsgType.Decode, id)
    .bool(isNew)
    .qtime(d.at)
    .i32(d.snr)
    .f64(d.dt)
    .u32(Math.max(0, Math.round(d.dfHz)))
    .utf8(MODE_CHAR[d.mode] ?? d.mode)
    .utf8(d.text)
    .bool(d.lowConfidence)
    .bool(false)
    .build();
}

export interface LoggedInfo {
  timeOn: number;
  timeOff: number;
  dxCall: string;
  dxGrid: string;
  freqHz: number;
  mode: string;
  rstSent: string;
  rstRcvd: string;
  txPower: string;
  comments: string;
  name: string;
  operator: string;
  myCall: string;
  myGrid: string;
  propMode: string;
}

export function encodeQsoLogged(id: string, q: LoggedInfo): Buffer {
  return header(MsgType.QsoLogged, id)
    .qdatetime(q.timeOff)
    .utf8(q.dxCall)
    .utf8(q.dxGrid)
    .u64(q.freqHz)
    .utf8(q.mode)
    .utf8(q.rstSent)
    .utf8(q.rstRcvd)
    .utf8(q.txPower)
    .utf8(q.comments)
    .utf8(q.name)
    .qdatetime(q.timeOn)
    .utf8(q.operator)
    .utf8(q.myCall)
    .utf8(q.myGrid)
    .utf8("") // exchange sent
    .utf8("") // exchange received
    .utf8(q.propMode)
    .build();
}

export function encodeLoggedAdif(id: string, adif: string): Buffer {
  return header(MsgType.LoggedAdif, id).utf8(adif).build();
}

export function encodeClose(id: string): Buffer {
  return header(MsgType.Close, id).build();
}

export function encodeClear(id: string): Buffer {
  return header(MsgType.Clear, id).build();
}

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

export type Inbound =
  | { type: MsgType.Reply; id: string; time: number; snr: number; dt: number; dfHz: number; mode: string; text: string; modifiers: number }
  | { type: MsgType.HaltTx; id: string; autoOnly: boolean }
  | { type: MsgType.Replay; id: string }
  | { type: MsgType.Heartbeat; id: string; maxSchema: number }
  | { type: "other"; id: string; msgType: number };

export function parseMessage(buf: Buffer): Inbound | null {
  try {
    const r = new Reader(buf);
    if (r.u32() !== MAGIC) return null;
    const schema = r.u32();
    if (schema < 1 || schema > MAX_SCHEMA) return null;
    const type = r.u32();
    const id = r.utf8() ?? "";
    switch (type) {
      case MsgType.Reply: {
        const time = r.u32();
        const snr = r.i32();
        const dt = r.f64();
        const dfHz = r.u32();
        const mode = r.utf8() ?? "";
        const text = r.utf8() ?? "";
        r.bool(); // low confidence
        const modifiers = r.done ? 0 : r.u8();
        return { type, id, time, snr, dt, dfHz, mode, text, modifiers };
      }
      case MsgType.HaltTx:
        return { type, id, autoOnly: r.done ? false : r.bool() };
      case MsgType.Replay:
        return { type, id };
      case MsgType.Heartbeat:
        return { type, id, maxSchema: r.done ? 2 : r.u32() };
      default:
        return { type: "other", id, msgType: type };
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export interface UdpTarget {
  host: string;
  port: number;
  format: "wsjtx" | "adif";
}

/**
 * "127.0.0.1:2237, 192.168.0.50:2333 adif, 239.255.0.1:2237". A bare host means port
 * 2237. A trailing word picks the format (wsjtx is the default).
 */
export function parseTargets(spec: string): { targets: UdpTarget[]; errors: string[] } {
  const targets: UdpTarget[] = [];
  const errors: string[] = [];
  for (const raw of spec.split(/[,;\n]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const m = /^([A-Za-z0-9.\-]+)(?::(\d{1,5}))?(?:\s+(wsjtx|wsjt-x|adif))?$/i.exec(item);
    if (!m) {
      errors.push(`"${item}" is not host:port`);
      continue;
    }
    const port = m[2] ? Number(m[2]) : 2237;
    if (port < 1 || port > 65535) {
      errors.push(`"${item}" has a bad port`);
      continue;
    }
    targets.push({ host: m[1]!.toLowerCase(), port, format: m[3]?.toLowerCase() === "adif" ? "adif" : "wsjtx" });
  }
  return { targets, errors };
}

function isMulticast(ip: string): boolean {
  const first = Number(ip.split(".")[0]);
  return isIPv4(ip) && first >= 224 && first <= 239;
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

export interface UdpFeedOptions {
  id: string;
  version: string;
  log: (level: "info" | "warn", msg: string) => void;
  onReply: (r: Extract<Inbound, { type: MsgType.Reply }>, from: string) => void;
  onHaltTx: (autoOnly: boolean, from: string) => void;
  onReplay: () => void;
}

export interface UdpFeedConfig {
  targets: string;
  /** The program name in every message header (WSJT-X's own is "WSJT-X"); default opts.id. */
  id?: string;
  /** The version the heartbeat reports while named WSJT-X; otherwise opts.version. */
  wsjtxVersion?: string;
  sendDecodes: boolean;
  acceptControl: boolean;
}

interface Resolved extends UdpTarget {
  ip: string;
}

export class UdpFeed {
  private sock: dgram.Socket | null = null;
  private resolved: Resolved[] = [];
  private cfgKey = "";
  private heartbeat: NodeJS.Timeout | null = null;
  private lastStatus = "";
  private cfg: UdpFeedConfig = { targets: "", sendDecodes: true, acceptControl: false };
  sent = 0;
  received = 0;

  constructor(private readonly opts: UdpFeedOptions) {}

  get active(): boolean {
    return this.resolved.length > 0;
  }

  /** The name every message carries. */
  get id(): string {
    return this.cfg.id || this.opts.id;
  }

  /** The version the heartbeat carries: a WSJT-X version while named WSJT-X. */
  get version(): string {
    return this.id === "WSJT-X" && this.cfg.wsjtxVersion ? this.cfg.wsjtxVersion : this.opts.version;
  }

  /** Apply settings. Rebinds only when the destinations change. */
  async configure(cfg: UdpFeedConfig): Promise<void> {
    this.cfg = cfg;
    const targetsKey = cfg.targets.trim();
    // A new name starts over too, so listeners see the new program from its first heartbeat.
    const key = targetsKey ? `${targetsKey}|${this.id}|${this.version}` : "";
    if (key === this.cfgKey && (this.sock || !key)) return;
    this.cfgKey = key;
    this.close(false);
    const { targets, errors } = parseTargets(targetsKey);
    for (const e of errors) this.opts.log("warn", `UDP feed: ${e}`);
    if (!targets.length) {
      if (!key) this.opts.log("info", "UDP feed off");
      return;
    }
    const resolved: Resolved[] = [];
    for (const t of targets) {
      try {
        const ip = isIPv4(t.host) ? t.host : (await lookup(t.host, { family: 4 })).address;
        resolved.push({ ...t, ip });
      } catch (e) {
        this.opts.log("warn", `UDP feed: cannot resolve ${t.host}: ${(e as Error).message}`);
      }
    }
    if (!resolved.length) return;
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", (e) => this.opts.log("warn", `UDP feed socket: ${e.message}`));
    sock.on("message", (msg, rinfo) => this.onMessage(msg, rinfo.address));
    await new Promise<void>((resolve) => sock.bind(0, "0.0.0.0", () => resolve()));
    if (resolved.some((t) => isMulticast(t.ip))) {
      try {
        sock.setMulticastTTL(1);
        sock.setMulticastLoopback(true);
      } catch {
        /* not fatal */
      }
    }
    this.sock = sock;
    this.resolved = resolved;
    this.opts.log("info", `UDP feed to ${resolved.map((t) => `${t.host}:${t.port}${t.format === "adif" ? " (ADIF)" : ""}`).join(", ")}`);
    this.sendWsjtx(encodeHeartbeat(this.id, this.version));
    this.heartbeat = setInterval(() => this.sendWsjtx(encodeHeartbeat(this.id, this.version)), 15_000);
    this.heartbeat.unref();
  }

  private sendTo(t: Resolved, buf: Buffer): void {
    if (!this.sock) return;
    this.sock.send(buf, t.port, t.ip, (err) => {
      if (err) this.opts.log("warn", `UDP feed to ${t.host}:${t.port}: ${err.message}`);
    });
    this.sent++;
  }

  private sendWsjtx(buf: Buffer): void {
    for (const t of this.resolved) if (t.format === "wsjtx") this.sendTo(t, buf);
  }

  status(s: StatusInfo): void {
    if (!this.sock) return;
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.sendWsjtx(encodeStatus(this.id, s));
  }

  decodes(list: DecodeInfo[], isNew = true): void {
    if (!this.sock || !this.cfg.sendDecodes) return;
    for (const d of list) this.sendWsjtx(encodeDecode(this.id, d, isNew));
  }

  logged(q: LoggedInfo, adif: string): void {
    if (!this.sock) return;
    this.sendWsjtx(encodeQsoLogged(this.id, q));
    this.sendWsjtx(encodeLoggedAdif(this.id, adif));
    const raw = Buffer.from(adif.trim() + "\n", "utf8");
    for (const t of this.resolved) if (t.format === "adif") this.sendTo(t, raw);
  }

  private onMessage(msg: Buffer, from: string): void {
    if (!this.cfg.acceptControl) return;
    // Believe only the programs we send to (or, for a multicast group, the LAN).
    const trusted = this.resolved.some((t) => t.format === "wsjtx" && (t.ip === from || (isMulticast(t.ip) && isPrivate(from))));
    if (!trusted) return;
    const m = parseMessage(msg);
    if (!m) return;
    this.received++;
    if (m.type === MsgType.Reply) this.opts.onReply(m, from);
    else if (m.type === MsgType.HaltTx) this.opts.onHaltTx(m.autoOnly, from);
    else if (m.type === MsgType.Replay) this.opts.onReplay();
  }

  close(sayGoodbye = true): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.sock) {
      if (sayGoodbye) this.sendWsjtx(encodeClose(this.id));
      const s = this.sock;
      this.sock = null;
      setTimeout(() => {
        try {
          s.close();
        } catch {
          /* closed */
        }
      }, sayGoodbye ? 100 : 0);
    }
    this.resolved = [];
    this.lastStatus = "";
  }
}
