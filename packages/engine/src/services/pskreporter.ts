/**
 * PSKReporter spotting over IPFIX/UDP, per https://pskreporter.info/pskdev.html.
 *
 * Enterprise 30351 field ids used:
 *   receiverCallsign 2, receiverLocator 4, decodingSoftware 8, antennaInformation 9
 *   senderCallsign 1, frequency 5 (uint32 Hz), sNR 6 (int8), mode 10, senderLocator 3,
 *   informationSource 11 (uint8, 1 = automatic)
 *   flowStartSeconds is IANA element 150 (uint32, no enterprise bit)
 *
 * The receiver record goes in an Options Template (set id 3, scope field count 0); the
 * sender records in a Template (set id 2). Datagrams at most every 5 minutes; spots are
 * de-duplicated per callsign and band within an interval.
 */
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";

const HOST = "report.pskreporter.info";
const PORT = 4739;
const ENT = 30351;
const RX_TEMPLATE = 0x9992;
const TX_TEMPLATE = 0x9993;
const VAR = 0xffff;

function fieldSpec(id: number, len: number, enterprise = true): Buffer {
  const b = Buffer.alloc(enterprise ? 8 : 4);
  b.writeUInt16BE(enterprise ? 0x8000 | id : id, 0);
  b.writeUInt16BE(len, 2);
  if (enterprise) b.writeUInt32BE(ENT, 4);
  return b;
}

function pad4(b: Buffer): Buffer {
  const r = b.length % 4;
  return r ? Buffer.concat([b, Buffer.alloc(4 - r)]) : b;
}

function set(id: number, body: Buffer): Buffer {
  const padded = pad4(Buffer.concat([Buffer.alloc(4), body]));
  padded.writeUInt16BE(id, 0);
  padded.writeUInt16BE(padded.length, 2);
  return padded;
}

function varStr(s: string): Buffer {
  const v = Buffer.from(s.slice(0, 254), "utf8");
  return Buffer.concat([Buffer.from([v.length]), v]);
}

export function receiverTemplate(): Buffer {
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16BE(RX_TEMPLATE, 0);
  hdr.writeUInt16BE(4, 2); // field count
  hdr.writeUInt16BE(0, 4); // scope field count
  return set(3, Buffer.concat([hdr, fieldSpec(2, VAR), fieldSpec(4, VAR), fieldSpec(8, VAR), fieldSpec(9, VAR)]));
}

export function senderTemplate(): Buffer {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(TX_TEMPLATE, 0);
  hdr.writeUInt16BE(7, 2);
  return set(
    2,
    Buffer.concat([hdr, fieldSpec(1, VAR), fieldSpec(5, 4), fieldSpec(6, 1), fieldSpec(10, VAR), fieldSpec(3, VAR), fieldSpec(11, 1), fieldSpec(150, 4, false)]),
  );
}

export interface Spot {
  callsign: string;
  freqHz: number;
  snr: number;
  mode: string;
  grid: string | null;
  at: number;
}

export function buildDatagram(opts: { callsign: string; grid: string; software: string; antenna: string; spots: Spot[]; seq: number; domain: number; now: number }): Buffer {
  const rx = set(RX_TEMPLATE, Buffer.concat([varStr(opts.callsign), varStr(opts.grid), varStr(opts.software), varStr(opts.antenna)]));
  const records = opts.spots.map((s) => {
    const f = Buffer.alloc(4);
    f.writeUInt32BE(s.freqHz >>> 0, 0);
    const snr = Buffer.alloc(1);
    snr.writeInt8(Math.max(-128, Math.min(127, Math.round(s.snr))), 0);
    const t = Buffer.alloc(4);
    t.writeUInt32BE(Math.floor(s.at / 1000), 0);
    return Buffer.concat([varStr(s.callsign), f, snr, varStr(s.mode), varStr(s.grid ?? ""), Buffer.from([1]), t]);
  });
  const tx = set(TX_TEMPLATE, Buffer.concat(records));
  const body = Buffer.concat([receiverTemplate(), senderTemplate(), rx, tx]);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt16BE(10, 0);
  hdr.writeUInt16BE(16 + body.length, 2);
  hdr.writeUInt32BE(Math.floor(opts.now / 1000), 4);
  hdr.writeUInt32BE(opts.seq >>> 0, 8);
  hdr.writeUInt32BE(opts.domain >>> 0, 12);
  return Buffer.concat([hdr, body]);
}

export class PskReporter {
  private pending = new Map<string, Spot>();
  private seq = 0;
  private readonly domain = randomBytes(4).readUInt32BE(0);
  private lastSent = 0;
  sentSpots = 0;

  constructor(private readonly log: (m: string) => void) {}

  add(s: Spot, band: string): void {
    const key = `${s.callsign}|${band}`;
    const prev = this.pending.get(key);
    if (!prev || s.snr > prev.snr) this.pending.set(key, s);
  }

  /** Send if 5 minutes have passed. Returns the number of spots sent. */
  async flush(station: { callsign: string; grid: string; antenna: string }, now = Date.now(), force = false): Promise<number> {
    if (!force && now - this.lastSent < 5 * 60_000) return 0;
    if (this.pending.size === 0) return 0;
    const all = [...this.pending.values()];
    this.pending.clear();
    this.lastSent = now;
    const sock = dgram.createSocket("udp4");
    try {
      for (let i = 0; i < all.length; i += 40) {
        const pkt = buildDatagram({ ...station, software: "Zerobeat", spots: all.slice(i, i + 40), seq: this.seq++, domain: this.domain, now });
        await new Promise<void>((res, rej) => sock.send(pkt, PORT, HOST, (e) => (e ? rej(e) : res())));
      }
      this.sentSpots += all.length;
      return all.length;
    } catch (e) {
      this.log(`PSKReporter send failed: ${(e as Error).message}`);
      return 0;
    } finally {
      sock.close();
    }
  }
}
