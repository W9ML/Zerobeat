/**
 * FlexRadio SmartSDR wire formats. Pure functions only; everything here is unit-tested.
 *
 * TCP 4992 command channel (line based):
 *   radio → V<version>, then H<handle>; usable at the H line
 *   us    → C<seq>|<command>
 *   radio → R<seq>|<hexStatus>|<message>          0 = OK
 *   radio → S<handle>|<object…> [id] [flags…] k=v… unsolicited status, PARTIAL (merge)
 *   radio → M<code>|<text>
 *
 * VITA-49 UDP (to the port registered with `client udpport`): 28-byte header; stream id
 * at offset 4, packet class at offset 14. Timestamps are dummies on receive.
 *   0x03e3 DAX audio: big-endian float32 stereo pairs, 24 kHz
 *   0x8002 meters:    repeating uint16 id, int16 value
 *   0x8003 panadapter, 0x8004 waterfall (ignored)
 *
 * DAX TX ("reduced bandwidth"): class 0x0123, mono int16 big-endian at 24 kHz, sent to
 * the radio's UDP 4991. byte0 0x18, byte1 0xd0|counter, size in words = payload/4 + 7,
 * OUI 0x001c2d, info class 0x534c, all timestamp words zero. Mirroring the RX format is
 * silently discarded by the radio.
 */

export const FLEX_TCP_PORT = 4992;
export const FLEX_VITA_PORT = 4991;
export const DAX_RATE = 24_000;
export const VITA_HEADER = 28;
export const CLASS_DAX_AUDIO = 0x03e3;
export const CLASS_DAX_REDUCED = 0x0123;
export const CLASS_METER = 0x8002;
export const TX_FRAMES_PER_PACKET = 128;

export type FlexLine =
  | { kind: "version"; version: string }
  | { kind: "handle"; handle: string }
  | { kind: "reply"; seq: number; status: number; message: string }
  | { kind: "status"; handle: string; body: string }
  | { kind: "message"; code: string; text: string }
  | { kind: "unknown"; line: string };

export function parseLine(line: string): FlexLine {
  const t = line.replace(/\r$/, "");
  switch (t[0]) {
    case "V":
      return { kind: "version", version: t.slice(1) };
    case "H":
      return { kind: "handle", handle: t.slice(1).toUpperCase() };
    case "R": {
      const a = t.indexOf("|");
      if (a === -1) return { kind: "unknown", line: t };
      const b = t.indexOf("|", a + 1);
      const status = parseInt(b === -1 ? t.slice(a + 1) : t.slice(a + 1, b), 16);
      return { kind: "reply", seq: Number(t.slice(1, a)), status: Number.isFinite(status) ? status : -1, message: b === -1 ? "" : t.slice(b + 1) };
    }
    case "S": {
      const a = t.indexOf("|");
      if (a === -1) return { kind: "unknown", line: t };
      return { kind: "status", handle: t.slice(1, a).toUpperCase(), body: t.slice(a + 1) };
    }
    case "M": {
      const a = t.indexOf("|");
      return { kind: "message", code: t.slice(1, a === -1 ? undefined : a), text: a === -1 ? "" : t.slice(a + 1) };
    }
    default:
      return { kind: "unknown", line: t };
  }
}

export interface StatusBody {
  /** Object path: `slice`, `transmit`, `interlock`, `display pan`, `client`. */
  object: string;
  /** Identifier as written: `0`, `0x40000000`. */
  id: string | null;
  flags: string[];
  fields: Record<string, string>;
}

/**
 * Leading words without `=` name the object up to the first identifier; bare words after
 * the identifier are flags (`client 0x74C8037A connected client_id=…`).
 */
export function parseStatusBody(body: string): StatusBody {
  const tokens = body.split(/\s+/).filter(Boolean);
  const path: string[] = [];
  const flags: string[] = [];
  let id: string | null = null;
  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.includes("=")) break;
    if (id === null && /^(?:0x[0-9A-Fa-f]+|\d+)$/.test(tok)) id = tok;
    else if (id === null) path.push(tok);
    else flags.push(tok);
  }
  const fields: Record<string, string> = {};
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const eq = tok.indexOf("=");
    if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return { object: path.join(" "), id, flags, fields };
}

/** `info` reply: comma-separated k=v with quoted values that may contain commas. */
export function parseInfoReply(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) out[m[1]!] = m[3] !== undefined ? m[3] : (m[2] ?? "");
  return out;
}

/** Discovery broadcast: take the longest printable run, split k=v. */
export function parseDiscovery(buf: Buffer): Record<string, string> | null {
  const runs = buf.toString("latin1").match(/[\x20-\x7e]{40,}/g);
  if (!runs) return null;
  const body = runs.reduce((a, b) => (b.length > a.length ? b : a));
  const out: Record<string, string> = {};
  for (const tok of body.trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out.model ? out : null;
}

export interface MeterDef {
  id: number;
  src: string;
  num: number;
  name: string;
  unit: string;
}

/** `meter list` reply: `#<id>.src=TX-#<id>.num=4#<id>.nam=PATEMP#<id>.unit=degC#…` */
export function parseMeterList(message: string): MeterDef[] {
  const byId = new Map<number, Partial<MeterDef> & { id: number }>();
  for (const part of message.split("#")) {
    const m = /^(\d+)\.(\w+)=(.*)$/.exec(part.trim());
    if (!m) continue;
    const id = Number(m[1]);
    const e = byId.get(id) ?? { id };
    const v = m[3]!;
    if (m[2] === "src") e.src = v;
    else if (m[2] === "num") e.num = Number(v);
    else if (m[2] === "nam") e.name = v;
    else if (m[2] === "unit") e.unit = v;
    byId.set(id, e);
  }
  return [...byId.values()]
    .filter((e): e is MeterDef => typeof e.src === "string" && typeof e.name === "string")
    .map((e) => ({ id: e.id, src: e.src, num: e.num ?? 0, name: e.name, unit: e.unit ?? "" }));
}

/** Scale a raw int16 meter value by its unit, per the SmartSDR API. */
export function scaleMeter(raw: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case "dbm":
    case "dbfs":
    case "swr":
      return raw / 128;
    case "volts":
    case "amps":
      return raw / 256;
    case "degc":
    case "degf":
      return raw / 64;
    default:
      return raw;
  }
}

export interface VitaPacket {
  /** The header's 4-bit packet count, per stream, modulo 16. */
  count: number;
  streamId: number;
  packetClass: number;
  payload: Buffer;
}

export function parseVita(buf: Buffer): VitaPacket | null {
  if (buf.length < VITA_HEADER) return null;
  return { count: buf.readUInt8(1) & 0x0f, streamId: buf.readUInt32BE(4), packetClass: buf.readUInt16BE(14), payload: buf.subarray(VITA_HEADER) };
}

/** DAX RX payload: big-endian float32 stereo pairs. Returns the left channel. */
export function daxAudioToMono(payload: Buffer): Float32Array {
  const frames = Math.floor(payload.length / 8);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = payload.readFloatBE(i * 8);
  return out;
}

/** Reduced-bandwidth DAX payload: big-endian int16 mono. */
export function daxReducedToMono(payload: Buffer): Float32Array {
  const n = Math.floor(payload.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = payload.readInt16BE(i * 2) / 32768;
  return out;
}

/** Meter payload: repeating (uint16 id, int16 value). */
export function parseMeterPayload(payload: Buffer): { id: number; raw: number }[] {
  const out: { id: number; raw: number }[] = [];
  for (let i = 0; i + 4 <= payload.length; i += 4) out.push({ id: payload.readUInt16BE(i), raw: payload.readInt16BE(i + 2) });
  return out;
}

/** One reduced-bandwidth DAX TX packet: mono int16 BE, `samples.length` frames. */
export function buildDaxTxPacket(streamId: number, counter: number, samples: Float32Array): Buffer {
  const payloadBytes = samples.length * 2;
  const buf = Buffer.alloc(VITA_HEADER + payloadBytes);
  buf.writeUInt8(0x18, 0);
  buf.writeUInt8(0xd0 | (counter & 0x0f), 1);
  buf.writeUInt16BE(payloadBytes / 4 + 7, 2);
  buf.writeUInt32BE(streamId >>> 0, 4);
  buf.writeUInt32BE(0x001c2d, 8);
  buf.writeUInt16BE(0x534c, 12);
  buf.writeUInt16BE(CLASS_DAX_REDUCED, 14);
  // 16..27: integer and fractional timestamps, zero.
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16BE(Math.round(v * 32767), VITA_HEADER + i * 2);
  }
  return buf;
}

export function mhzString(hz: number): string {
  return (hz / 1_000_000).toFixed(6);
}

/** SmartSDR mode names the engine uses. */
export type SliceMode = "DIGU" | "DIGL" | "USB" | "LSB" | "CW" | "AM" | "FM" | "RTTY" | "SAM" | "NFM" | "DFM";
