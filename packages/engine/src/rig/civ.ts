/**
 * ICOM CI-V framing and data formats (IC-7300MK2 CI-V Reference Guide).
 *
 *   FE FE <to> <from> <cmd> [sub] [data…] FD      OK reply: FE FE E0 <rig> FB FD
 *                                                  NG reply: FE FE E0 <rig> FA FD
 *
 * Frequencies are 5 bytes of BCD, least significant pair first. Levels and meters are
 * 2 bytes of BCD, most significant first ("02 55" = 255). FC is a collision jam.
 */

export const PREAMBLE = 0xfe;
export const EOM = 0xfd;
export const OK = 0xfb;
export const NG = 0xfa;
export const JAM = 0xfc;
export const CONTROLLER = 0xe0;

export interface CivFrame {
  to: number;
  from: number;
  cmd: number;
  /** Everything after the command byte, sub-command included. */
  data: Buffer;
}

export function frame(to: number, from: number, cmd: number, ...body: (number | Buffer | number[])[]): Buffer {
  const parts: number[] = [PREAMBLE, PREAMBLE, to, from, cmd];
  for (const b of body) {
    if (typeof b === "number") parts.push(b);
    else for (const x of b) parts.push(x);
  }
  parts.push(EOM);
  return Buffer.from(parts);
}

/** Splits a byte stream into frames; keeps any partial frame for the next chunk. */
export class CivParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): CivFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: CivFrame[] = [];
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([PREAMBLE, PREAMBLE]));
      if (start < 0) {
        // Keep a lone trailing FE: it may be the first half of a preamble.
        this.buf = this.buf.length && this.buf[this.buf.length - 1] === PREAMBLE ? this.buf.subarray(this.buf.length - 1) : Buffer.alloc(0);
        return out;
      }
      const end = this.buf.indexOf(EOM, start + 2);
      if (end < 0) {
        this.buf = this.buf.subarray(start);
        if (this.buf.length > 1024) this.buf = Buffer.alloc(0); // garbage, not a frame
        return out;
      }
      // Skip extra preamble bytes (some radios send three or more).
      let i = start;
      while (i < end && this.buf[i] === PREAMBLE) i++;
      const body = this.buf.subarray(i, end);
      this.buf = this.buf.subarray(end + 1);
      if (body.length < 3 || body.includes(JAM)) continue;
      out.push({ to: body[0]!, from: body[1]!, cmd: body[2]!, data: Buffer.from(body.subarray(3)) });
    }
  }
}

/** 5-byte little-endian BCD, as in commands 00, 03 and 05. */
export function freqToBcd(hz: number): Buffer {
  let n = Math.round(hz);
  if (n < 0 || n >= 10_000_000_000) throw new RangeError(`frequency ${hz} out of range`);
  const out = Buffer.alloc(5);
  for (let i = 0; i < 5; i++) {
    const lo = n % 10;
    n = Math.floor(n / 10);
    const hi = n % 10;
    n = Math.floor(n / 10);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

export function bcdToFreq(b: Buffer): number {
  let hz = 0;
  for (let i = b.length - 1; i >= 0; i--) hz = hz * 100 + ((b[i]! >> 4) & 0xf) * 10 + (b[i]! & 0xf);
  return hz;
}

/** 0–9999 as 2 bytes of big-endian BCD ("02 55" for 255). */
export function levelToBcd(v: number): Buffer {
  const n = Math.max(0, Math.min(9999, Math.round(v)));
  const d = String(n).padStart(4, "0");
  return Buffer.from([(Number(d[0]) << 4) | Number(d[1]), (Number(d[2]) << 4) | Number(d[3])]);
}

export function bcdToLevel(b: Buffer): number {
  let v = 0;
  for (const x of b) v = v * 100 + ((x >> 4) & 0xf) * 10 + (x & 0xf);
  return v;
}

/** Po meter (15 11): 0 = 0 %, 143 = 50 %, 213 = 100 % of rated power. */
export function poPercent(level: number): number {
  if (level <= 143) return (level / 143) * 50;
  return 50 + ((level - 143) / (213 - 143)) * 50;
}

/** SWR meter (15 12): 0 = 1.0, 48 = 1.5, 80 = 2.0, 120 = 3.0, extrapolated beyond. */
export function swrFromLevel(level: number): number {
  const pts: [number, number][] = [
    [0, 1],
    [48, 1.5],
    [80, 2],
    [120, 3],
  ];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (level <= x1) return y0 + ((level - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 3 + (level - 120) / 40;
}

/** S-meter (15 02): 0 = S0, 120 = S9 (-73 dBm), 241 = S9+60 dB. */
export function smeterDbm(level: number): number {
  if (level <= 120) return -127 + (level / 120) * 54;
  return -73 + ((level - 120) / 121) * 60;
}

/** CI-V addresses of radios this driver knows, for naming what answered. */
export const ICOM_MODELS: Record<number, string> = {
  0xb6: "IC-7300MK2",
  0x94: "IC-7300",
  0xa4: "IC-705",
  0xa2: "IC-9700",
  0x98: "IC-7610",
  0xa6: "IC-7760",
  0xac: "IC-905",
};

/** Operating modes for command 26 (and 01/04). */
export const CIV_MODE = { LSB: 0x00, USB: 0x01, AM: 0x02, CW: 0x03, RTTY: 0x04, FM: 0x05, CWR: 0x07, RTTYR: 0x08 } as const;
export const CIV_MODE_NAME: Record<number, string> = { 0: "LSB", 1: "USB", 2: "AM", 3: "CW", 4: "RTTY", 5: "FM", 7: "CW-R", 8: "RTTY-R" };
