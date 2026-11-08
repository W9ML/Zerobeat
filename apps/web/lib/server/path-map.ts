/**
 * A map of the path to another station, as SVG, made to be read at card size: land,
 * country borders and US state lines, the great-circle path as the curve it is, both
 * ends labeled with their callsigns, and the night side of the Earth shaded so the grey
 * line between the two stations shows. The view is the path's extent with a margin,
 * corrected for latitude so places keep their shape; a path over most of the world
 * shows the whole world.
 *
 * Map data: Natural Earth 1:110m land and countries (world-atlas) and US Census states
 * (us-atlas); both public domain.
 */
import "server-only";

import type { FeatureCollection, MultiLineString, MultiPolygon, Polygon } from "geojson";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countriesTopo from "world-atlas/countries-110m.json";
import landTopo from "world-atlas/land-110m.json";
import statesTopo from "us-atlas/states-10m.json";

import { qrzUrl } from "../qrz";

const RAD = Math.PI / 180;
export const MAP_W = 640;
export const MAP_H = 400;

type Ring = [number, number][];

let cache: { land: Ring[]; borders: Ring[]; states: Ring[] } | null = null;
function data() {
  if (cache) return cache;
  const lt = landTopo as unknown as Topology<{ land: GeometryCollection }>;
  const fc = feature(lt, lt.objects.land) as unknown as FeatureCollection<Polygon | MultiPolygon>;
  const land: Ring[] = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) land.push(ring as Ring);
  }
  // Borders between countries only (not coastlines): the mesh of shared arcs.
  const ct = countriesTopo as unknown as Topology<{ countries: GeometryCollection }>;
  const borders = (mesh(ct, ct.objects.countries, (a, b) => a !== b) as unknown as MultiLineString).coordinates as Ring[];
  const st = statesTopo as unknown as Topology<{ states: GeometryCollection }>;
  const states = (mesh(st, st.objects.states, (a, b) => a !== b) as unknown as MultiLineString).coordinates as Ring[];
  cache = { land, borders, states };
  return cache;
}

/** Points along the great circle, longitudes unwrapped so the line is continuous. */
function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }, n = 96): [number, number][] {
  const la1 = a.lat * RAD;
  const lo1 = a.lon * RAD;
  const la2 = b.lat * RAD;
  const lo2 = b.lon * RAD;
  const c = Math.acos(Math.max(-1, Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(lo2 - lo1))));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    let lat: number;
    let lon: number;
    if (c < 1e-6) {
      lat = a.lat;
      lon = a.lon;
    } else {
      const A = Math.sin((1 - f) * c) / Math.sin(c);
      const B = Math.sin(f * c) / Math.sin(c);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      lat = Math.atan2(z, Math.hypot(x, y)) / RAD;
      lon = Math.atan2(y, x) / RAD;
    }
    const prev = pts.at(-1);
    if (prev) {
      while (lon - prev[1] > 180) lon -= 360;
      while (lon - prev[1] < -180) lon += 360;
    }
    pts.push([lat, lon]);
  }
  return pts;
}

/** Where the sun is overhead now: latitude (declination) and longitude, degrees (NOAA's approximation). */
export function subsolar(now: number): { lat: number; lon: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (now - start) / 86_400_000;
  const g = (2 * Math.PI * doy) / 365; // fractional year, radians
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)); // minutes
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return { lat: decl / RAD, lon: -((utcMin + eqt) / 4 - 180) };
}

export interface PathMapInput {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  fromLabel?: string;
  toLabel?: string;
  now?: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export { qrzUrl };

export function pathMapSvg({ from, to, fromLabel = "", toLabel = "", now = Date.now() }: PathMapInput): string {
  const pts = greatCircle(from, to);
  const lons = pts.map((q) => q[1]);
  const lats = pts.map((q) => q[0]);
  let latMin = Math.min(...lats);
  let latMax = Math.max(...lats);
  let lonMin = Math.min(...lons);
  let lonMax = Math.max(...lons);
  // A margin, and enough area around a short path that the borders say where it is.
  const padLat = Math.max(3, (latMax - latMin) * 0.25);
  latMin = Math.max(-80, latMin - padLat);
  latMax = Math.min(84, latMax + padLat);
  const lat0 = (latMin + latMax) / 2;
  // Longitude degrees shrink toward the poles: scale them so places keep their shape.
  const kx = Math.max(0.35, Math.cos(lat0 * RAD));
  const padLon = Math.max(4, (lonMax - lonMin) * 0.2);
  lonMin -= padLon;
  lonMax += padLon;
  // At least about 1,400 km across, so a contact next door still shows a region.
  let w = Math.max((lonMax - lonMin) * kx, 13);
  let h = latMax - latMin;
  const aspect = MAP_W / MAP_H;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const world = w / kx > 300;
  const lon0 = (lonMin + lonMax) / 2;
  const scale = world ? MAP_W / 360 : MAP_W / w;
  const xk = world ? 1 : kx;
  const latC = world ? 0 : Math.max(-90 + h / 2, Math.min(90 - h / 2, lat0));
  const X = (lon: number) => (lon - lon0) * xk * scale + MAP_W / 2;
  const Y = (lat: number) => (latC - lat) * scale + MAP_H / 2;
  const f = (v: number) => v.toFixed(1);

  const { land, borders, states } = data();
  const path = (rings: Ring[], close: boolean) => {
    let d = "";
    for (const ring of rings) {
      let part = "";
      let prev: number | null = null;
      for (const [lon, lat] of ring) {
        const jump = prev !== null && Math.abs(lon - prev) > 180;
        part += `${part && !jump ? "L" : "M"}${f(X(lon))},${f(Y(lat))}`;
        prev = lon;
      }
      d += part + (close ? "Z" : "");
    }
    return d;
  };
  // Drawn three times, a world apart, so the view can be centred anywhere.
  const world3 = (d: string, attrs: string) => {
    const dx = 360 * xk * scale;
    return `<g ${attrs}><path d="${d}" transform="translate(${f(-dx)} 0)"/><path d="${d}"/><path d="${d}" transform="translate(${f(dx)} 0)"/></g>`;
  };

  // The night side: beyond the terminator, toward the pole the sun is not lighting.
  const sun = subsolar(now);
  const dec = Math.abs(sun.lat) < 0.2 ? (sun.lat < 0 ? -0.2 : 0.2) : sun.lat;
  const night: Ring = [];
  for (let lon = lon0 - 540; lon <= lon0 + 540; lon += 2) night.push([lon, Math.atan(-Math.cos((lon - sun.lon) * RAD) / Math.tan(dec * RAD)) / RAD]);
  const pole = dec > 0 ? -90 : 90;
  const nightD = `M${f(X(night[0]![0]))},${f(Y(pole))}` + night.map(([lo, la]) => `L${f(X(lo))},${f(Y(la))}`).join("") + `L${f(X(night.at(-1)![0]))},${f(Y(pole))}Z`;

  const line = pts.map(([lat, lon], i) => `${i ? "L" : "M"}${f(X(lon))},${f(Y(lat))}`).join("");
  const a = pts[0]!;
  const b = pts.at(-1)!;
  const ax = X(a[1]);
  const ay = Y(a[0]);
  const bx = X(b[1]);
  const by = Y(b[0]);
  // Each label beside its dot, on the side away from the other end, kept in the frame.
  const label = (x: number, y: number, text: string, awayX: number, color: string) => {
    if (!text) return "";
    const right = x >= awayX;
    const anchor = right ? (x > MAP_W - 130 ? "end" : "start") : x < 130 ? "start" : "end";
    const tx = anchor === "start" ? x + 11 : x - 11;
    const ty = Math.max(20, Math.min(MAP_H - 10, y + 6));
    // Each callsign opens its QRZ.com page (when the map is shown inline, not as an <img>).
    return `<a href="${esc(qrzUrl(text))}" target="_blank" rel="noopener noreferrer"><title>${esc(text)} on QRZ.com</title><text x="${f(tx)}" y="${f(ty)}" text-anchor="${anchor}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="23" font-weight="700" fill="${color}" stroke="#0b0f15" stroke-width="5" stroke-linejoin="round" paint-order="stroke">${esc(text)}</text></a>`;
  };
  const showStates = !world && lonMax > -130 && lonMin < -60 && latMax > 22 && latMin < 52;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}" role="img" aria-label="Path from ${esc(fromLabel)} to ${esc(toLabel)}">
<rect width="${MAP_W}" height="${MAP_H}" fill="#0e1622"/>
${world3(path(land, true), `fill="#2b3648"`)}
${showStates ? world3(path(states, false), `fill="none" stroke="#4d5b72" stroke-width="0.8"`) : ""}
${world3(path(borders, false), `fill="none" stroke="#6b7c96" stroke-width="1.2"`)}
<path d="${nightD}" fill="#000610" fill-opacity="0.5"/>
<path d="${line}" stroke="#f2662f" stroke-opacity="0.3" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="${line}" stroke="#ff7a45" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<circle cx="${f(ax)}" cy="${f(ay)}" r="6" fill="#0b0f15" stroke="#ff7a45" stroke-width="2.5"/>
<circle cx="${f(bx)}" cy="${f(by)}" r="7" fill="#3ecf8e" stroke="#0b0f15" stroke-width="2.5"/>
${label(ax, ay, fromLabel, bx, "#ffb08a")}
${label(bx, by, toLabel, ax, "#8ff0c2")}
</svg>`;
}
