/**
 * Mixed-radix complex FFT (radix 4, 2, 3 and a generic odd radix) for the WSPR decoder.
 *
 * wsprd (WSJT-X lib/wsprd/wsprd.c, readwavfile) downsamples the 2-minute recording with
 * FFTW: one 1,474,560-point real FFT (46080 x 32) at 12 kHz, then a 46,080-point inverse
 * FFT of the band 1500 +/- 187.5 Hz, which yields complex baseband at 375 Hz. Neither size
 * is a power of two (both are 2^n * 45), so the radix-2 `fft` in dsp/dsp.ts cannot do it.
 * This is a plain Stockham autosort FFT: every stage reads one buffer and writes the
 * other, so no bit-reversal pass is needed and any factorisation works. Twiddles come from
 * one cached table per size (W_N^k, k < N), which keeps the trigonometry out of the loops.
 *
 * Unnormalised in both directions, like FFTW: forward is sum x[n] e^(-2 pi i k n / N),
 * inverse uses e^(+2 pi i k n / N).
 */

interface Plan {
  radices: number[];
  cos: Float64Array;
  sin: Float64Array;
}

const plans = new Map<number, Plan>();

function factorise(n: number): number[] {
  const out: number[] = [];
  let m = n;
  while (m % 4 === 0) {
    out.push(4);
    m /= 4;
  }
  for (const p of [2, 3, 5]) {
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  }
  for (let p = 7; m > 1; p += 2) {
    while (m % p === 0) {
      out.push(p);
      m /= p;
    }
  }
  return out;
}

function plan(n: number): Plan {
  let p = plans.get(n);
  if (!p) {
    const cos = new Float64Array(n);
    const sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      cos[k] = Math.cos(a);
      sin[k] = Math.sin(a);
    }
    p = { radices: factorise(n), cos, sin };
    // The 1.47 M-point table is 23 MB; only a few sizes are ever used, but don't hoard.
    if (plans.size > 8) plans.clear();
    plans.set(n, p);
  }
  return p;
}

/**
 * In-place complex FFT of any length (re/im are overwritten with the transform).
 * `inverse` flips the exponent sign; neither direction scales.
 */
export function fftMixed(re: Float64Array, im: Float64Array, inverse = false): void {
  const N = re.length;
  if (N <= 1) return;
  const { radices, cos, sin } = plan(N);
  const sg = inverse ? 1 : -1; // sign of the exponent
  let xr: Float64Array = re;
  let xi: Float64Array = im;
  let yr: Float64Array = new Float64Array(N);
  let yi: Float64Array = new Float64Array(N);
  let n = N;
  let s = 1;
  for (const r of radices) {
    // Stockham DIF stage: inputs x[q + s(p + k m)], outputs y[q + s(r p + j)] times W_n^(j p).
    // N/n is always s, so W_n^(j p) is entry j p s of the size-N table.
    const m = n / r;
    if (r === 4) {
      for (let p = 0; p < m; p++) {
        const t1 = p * s;
        const w1r = cos[t1]!, w1i = sg * sin[t1]!;
        const w2r = cos[2 * t1]!, w2i = sg * sin[2 * t1]!;
        const w3r = cos[3 * t1]!, w3i = sg * sin[3 * t1]!;
        const sm = s * m;
        for (let q = 0; q < s; q++) {
          const i0 = q + s * p;
          const i1 = i0 + sm;
          const i2 = i1 + sm;
          const i3 = i2 + sm;
          const a0r = xr[i0]!, a0i = xi[i0]!;
          const a1r = xr[i1]!, a1i = xi[i1]!;
          const a2r = xr[i2]!, a2i = xi[i2]!;
          const a3r = xr[i3]!, a3i = xi[i3]!;
          const t0r = a0r + a2r, t0i = a0i + a2i;
          const u1r = a0r - a2r, u1i = a0i - a2i;
          const t2r = a1r + a3r, t2i = a1i + a3i;
          // (a1 - a3) * (sg i)
          const dr = a1r - a3r, di = a1i - a3i;
          const t3r = -sg * di, t3i = sg * dr;
          const o = q + s * 4 * p;
          yr[o] = t0r + t2r;
          yi[o] = t0i + t2i;
          const b1r = u1r + t3r, b1i = u1i + t3i;
          yr[o + s] = b1r * w1r - b1i * w1i;
          yi[o + s] = b1r * w1i + b1i * w1r;
          const b2r = t0r - t2r, b2i = t0i - t2i;
          yr[o + 2 * s] = b2r * w2r - b2i * w2i;
          yi[o + 2 * s] = b2r * w2i + b2i * w2r;
          const b3r = u1r - t3r, b3i = u1i - t3i;
          yr[o + 3 * s] = b3r * w3r - b3i * w3i;
          yi[o + 3 * s] = b3r * w3i + b3i * w3r;
        }
      }
    } else if (r === 2) {
      for (let p = 0; p < m; p++) {
        const wr = cos[p * s]!, wi = sg * sin[p * s]!;
        for (let q = 0; q < s; q++) {
          const i0 = q + s * p;
          const i1 = i0 + s * m;
          const a0r = xr[i0]!, a0i = xi[i0]!;
          const a1r = xr[i1]!, a1i = xi[i1]!;
          const o = q + s * 2 * p;
          yr[o] = a0r + a1r;
          yi[o] = a0i + a1i;
          const dr = a0r - a1r, di = a0i - a1i;
          yr[o + s] = dr * wr - di * wi;
          yi[o + s] = dr * wi + di * wr;
        }
      }
    } else if (r === 3) {
      const h = sg * (Math.sqrt(3) / 2);
      for (let p = 0; p < m; p++) {
        const t1 = p * s;
        const w1r = cos[t1]!, w1i = sg * sin[t1]!;
        const w2r = cos[2 * t1]!, w2i = sg * sin[2 * t1]!;
        for (let q = 0; q < s; q++) {
          const i0 = q + s * p;
          const i1 = i0 + s * m;
          const i2 = i1 + s * m;
          const a0r = xr[i0]!, a0i = xi[i0]!;
          const a1r = xr[i1]!, a1i = xi[i1]!;
          const a2r = xr[i2]!, a2i = xi[i2]!;
          const sr = a1r + a2r, si = a1i + a2i;
          const cr = a0r - 0.5 * sr, ci = a0i - 0.5 * si;
          // (a1 - a2) * (h i)
          const dr = -h * (a1i - a2i), di = h * (a1r - a2r);
          const o = q + s * 3 * p;
          yr[o] = a0r + sr;
          yi[o] = a0i + si;
          const b1r = cr + dr, b1i = ci + di;
          yr[o + s] = b1r * w1r - b1i * w1i;
          yi[o + s] = b1r * w1i + b1i * w1r;
          const b2r = cr - dr, b2i = ci - di;
          yr[o + 2 * s] = b2r * w2r - b2i * w2i;
          yi[o + 2 * s] = b2r * w2i + b2i * w2r;
        }
      }
    } else {
      // Generic odd radix (5 for WSPR's sizes): a direct r-point DFT per butterfly.
      const er = new Float64Array(r);
      const ei = new Float64Array(r);
      for (let k = 0; k < r; k++) {
        er[k] = Math.cos((2 * Math.PI * k) / r);
        ei[k] = sg * Math.sin((2 * Math.PI * k) / r);
      }
      const ar = new Float64Array(r);
      const ai = new Float64Array(r);
      for (let p = 0; p < m; p++) {
        for (let q = 0; q < s; q++) {
          for (let k = 0; k < r; k++) {
            ar[k] = xr[q + s * (p + k * m)]!;
            ai[k] = xi[q + s * (p + k * m)]!;
          }
          for (let j = 0; j < r; j++) {
            let br = 0;
            let bi = 0;
            for (let k = 0, e = 0; k < r; k++, e = (e + j) % r) {
              br += ar[k]! * er[e]! - ai[k]! * ei[e]!;
              bi += ar[k]! * ei[e]! + ai[k]! * er[e]!;
            }
            const t = j * p * s;
            const wr = cos[t]!, wi = sg * sin[t]!;
            const o = q + s * (r * p + j);
            yr[o] = br * wr - bi * wi;
            yi[o] = br * wi + bi * wr;
          }
        }
      }
    }
    [xr, yr] = [yr, xr];
    [xi, yi] = [yi, xi];
    n = m;
    s *= r;
  }
  if (xr !== re) {
    re.set(xr);
    im.set(xi);
  }
}
