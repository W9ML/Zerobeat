/** Maidenhead locators, great-circle distance and bearing. */

export const GRID_RE = /^[A-R]{2}\d{2}(?:[A-X]{2}(?:\d{2})?)?$/i;

/** RR73 has the shape of a grid; FT8 reserves it as a sign-off, so it is never a locator here. */
export function isGrid(s: string | null | undefined): s is string {
  return !!s && GRID_RE.test(s) && s.toUpperCase() !== "RR73";
}

/** Centre of the locator, in degrees. Null for anything malformed. */
export function gridToLatLon(grid: string): { lat: number; lon: number } | null {
  if (!isGrid(grid)) return null;
  const g = grid.toUpperCase();
  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;
  let lonSize = 2;
  let latSize = 1;
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24);
    lonSize = 2 / 24;
    latSize = 1 / 24;
  }
  if (g.length >= 8) {
    lon += Number(g[6]) * (lonSize / 10);
    lat += Number(g[7]) * (latSize / 10);
    lonSize /= 10;
    latSize /= 10;
  }
  return { lat: lat + latSize / 2, lon: lon + lonSize / 2 };
}

export function latLonToGrid(lat: number, lon: number, precision: 4 | 6 | 8 = 6): string {
  let adjLon = lon + 180;
  let adjLat = lat + 90;
  const A = "ABCDEFGHIJKLMNOPQR";
  const a = "abcdefghijklmnopqrstuvwx";
  let g = A[Math.floor(adjLon / 20)]! + A[Math.floor(adjLat / 10)]!;
  adjLon %= 20;
  adjLat %= 10;
  g += Math.floor(adjLon / 2).toString() + Math.floor(adjLat).toString();
  if (precision === 4) return g;
  adjLon %= 2;
  adjLat %= 1;
  g += a[Math.floor(adjLon / (2 / 24))]! + a[Math.floor(adjLat / (1 / 24))]!;
  if (precision === 6) return g;
  adjLon %= 2 / 24;
  adjLat %= 1 / 24;
  g += Math.floor(adjLon / (2 / 240)).toString() + Math.floor(adjLat / (1 / 240)).toString();
  return g;
}

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great-circle bearing from a to b, degrees 0–360. */
export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function gridDistanceKm(a: string, b: string): number | null {
  const pa = gridToLatLon(a);
  const pb = gridToLatLon(b);
  return pa && pb ? distanceKm(pa, pb) : null;
}
