/**
 * DXCC resolution from AD1C's Big CTY file (cty.csv), held in memory.
 *
 * cty.csv: one entity per line, ten comma-separated fields, the last ending in `;`:
 *
 *   prefix,name,adif,continent,cq,itu,lat,lon(WEST-POSITIVE),utcOffset,aliases;
 *
 * Aliases are space-separated prefixes, or `=CALL` for an exact callsign, each with
 * optional overrides: (cq) [itu] <lat/lon> {continent} ~utc~. Records whose primary
 * prefix starts with `*` are regions of another entity (Sicily, African Italy) that
 * share its ADIF number; their aliases attach to the parent with their own overrides.
 *
 * A snapshot ships in packages/core/data/cty.csv so a fresh install resolves at once;
 * the engine refreshes it weekly into the data directory.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normaliseCallsign } from "../ham/callsign.ts";

export const CTY_CSV_URL = "https://www.country-files.com/bigcty/cty.csv";

export interface DxccEntity {
  adif: number;
  name: string;
  prefix: string;
  continent: string;
  cqZone: number;
  ituZone: number;
  lat: number;
  lon: number;
  utcOffset: number;
}

export interface DxccMatch {
  adif: number;
  name: string;
  continent: string;
  cqZone: number;
  ituZone: number;
  lat: number;
  lon: number;
  /** What matched: an exact callsign or a prefix. */
  via: "exact" | "prefix";
  matched: string;
}

interface Entry {
  adif: number;
  continent: string;
  cqZone: number;
  ituZone: number;
  lat: number;
  lon: number;
}

export interface CtyData {
  entities: Map<number, DxccEntity>;
  prefixes: Map<string, Entry>;
  exact: Map<string, Entry>;
  maxPrefixLen: number;
  problems: string[];
}

function parseAlias(raw: string, base: Entry): { call: string; exact: boolean; entry: Entry } | null {
  let s = raw.trim();
  if (!s) return null;
  const e: Entry = { ...base };
  const cq = /\((\d+)\)/.exec(s);
  if (cq) e.cqZone = Number(cq[1]);
  const itu = /\[(\d+)\]/.exec(s);
  if (itu) e.ituZone = Number(itu[1]);
  const cont = /\{([A-Za-z]{2})\}/.exec(s);
  if (cont) e.continent = cont[1]!.toUpperCase();
  const ll = /<([-\d.]+)\/([-\d.]+)>/.exec(s);
  if (ll) {
    const lat = Number(ll[1]);
    const lon = Number(ll[2]);
    if (Number.isFinite(lat)) e.lat = lat;
    if (Number.isFinite(lon)) e.lon = -lon;
  }
  s = s
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/~[^~]*~/g, "")
    .trim();
  const exact = s.startsWith("=");
  if (exact) s = s.slice(1);
  s = s.trim().toUpperCase();
  return s ? { call: s, exact, entry: e } : null;
}

export function parseCtyCsv(text: string): CtyData {
  const entities = new Map<number, DxccEntity>();
  const prefixes = new Map<string, Entry>();
  const exact = new Map<string, Entry>();
  const problems: string[] = [];
  let maxPrefixLen = 0;

  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const t = line.trim();
    if (!t) continue;
    const f = t.replace(/;\s*$/, "").split(",");
    if (f.length !== 10) {
      problems.push(`line ${i + 1}: expected 10 fields, got ${f.length}`);
      continue;
    }
    const [prefix, name, adifS, cont, cqS, ituS, latS, lonS, utcS, aliases] = f as [string, ...string[]];
    const adif = Number(adifS);
    if (!Number.isInteger(adif) || adif <= 0) {
      problems.push(`line ${i + 1}: bad ADIF number ${adifS}`);
      continue;
    }
    const base: Entry = {
      adif,
      continent: cont!.trim().toUpperCase(),
      cqZone: Number(cqS),
      ituZone: Number(ituS),
      lat: Number(latS),
      lon: -Number(lonS),
    };
    const region = prefix.startsWith("*");
    if (!region && !entities.has(adif)) {
      entities.set(adif, {
        adif,
        name: name!.trim(),
        prefix: prefix.trim(),
        continent: base.continent,
        cqZone: base.cqZone,
        ituZone: base.ituZone,
        lat: base.lat,
        lon: base.lon,
        utcOffset: -Number(utcS),
      });
    }
    for (const raw of (aliases ?? "").split(/\s+/)) {
      const a = parseAlias(raw, base);
      if (!a) continue;
      if (a.exact) exact.set(a.call, a.entry);
      else {
        prefixes.set(a.call, a.entry);
        maxPrefixLen = Math.max(maxPrefixLen, a.call.length);
      }
    }
  }
  return { entities, prefixes, exact, maxPrefixLen, problems };
}

/** Suffixes that say how, not where. */
const MODIFIERS = new Set(["P", "M", "QRP", "QRPP", "A", "LH", "LGT", "J", "B", "N", "E", "R", "T", "AE", "AG", "KT", "FF", "YOTA"]);

export class DxccResolver {
  constructor(readonly data: CtyData) {}

  entity(adif: number | null | undefined): DxccEntity | null {
    return adif ? (this.data.entities.get(adif) ?? null) : null;
  }

  /** Every current entity, sorted by name. */
  allEntities(): DxccEntity[] {
    return [...this.data.entities.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private longestPrefix(s: string): { entry: Entry; matched: string } | null {
    for (let n = Math.min(s.length, this.data.maxPrefixLen); n >= 1; n--) {
      const p = s.slice(0, n);
      const e = this.data.prefixes.get(p);
      if (e) return { entry: e, matched: p };
    }
    return null;
  }

  resolve(callsign: string): DxccMatch | null {
    const call = normaliseCallsign(callsign);
    if (!call || !/\d/.test(call)) return null;

    const hit = (e: Entry, via: DxccMatch["via"], matched: string): DxccMatch => ({
      adif: e.adif,
      name: this.data.entities.get(e.adif)?.name ?? `Entity ${e.adif}`,
      continent: e.continent,
      cqZone: e.cqZone,
      ituZone: e.ituZone,
      lat: e.lat,
      lon: e.lon,
      via,
      matched,
    });

    // 1. Whole-call exceptions, as written and without trailing modifiers.
    const parts = call.split("/").filter(Boolean);
    if (parts.length > 1 && (parts.at(-1) === "MM" || parts.at(-1) === "AM")) return null;
    const exactHit = this.data.exact.get(call);
    if (exactHit) return hit(exactHit, "exact", call);
    const trimmed = [...parts];
    while (trimmed.length > 1 && MODIFIERS.has(trimmed.at(-1)!)) trimmed.pop();
    const trimmedCall = trimmed.join("/");
    const exactTrim = this.data.exact.get(trimmedCall);
    if (exactTrim) return hit(exactTrim, "exact", trimmedCall);

    // 2. Decide which part names the entity.
    let subject: string;
    if (trimmed.length === 1) {
      subject = trimmed[0]!;
    } else {
      const last = trimmed.at(-1)!;
      const longest = trimmed.reduce((a, b) => (b.length > a.length ? b : a));
      if (/^\d$/.test(last)) {
        // W1ABC/4: same country, new call area.
        const base = trimmed.slice(0, -1).reduce((a, b) => (b.length > a.length ? b : a));
        subject = base.replace(/\d+/, last);
      } else {
        // PJ4/K1ABC or K1ABC/VE3: the shorter part is the location.
        const others = trimmed.filter((p) => p !== longest);
        subject = others.reduce((a, b) => (b.length <= a.length ? b : a));
        if (subject.length > longest.length) subject = longest;
      }
    }

    // 3. KG4: Guantanamo only for KG4 + exactly two letters.
    if (/^KG4[A-Z]{2}$/.test(subject)) {
      const g = this.data.entities.get(105);
      if (g) return hit({ adif: 105, continent: g.continent, cqZone: g.cqZone, ituZone: g.ituZone, lat: g.lat, lon: g.lon }, "prefix", "KG4");
    } else if (subject.startsWith("KG4")) {
      const us = this.longestPrefix("K");
      if (us) return hit(us.entry, "prefix", "K");
    }

    const p = this.longestPrefix(subject);
    return p ? hit(p.entry, "prefix", p.matched) : null;
  }
}

function bundledPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [resolve(here, "../../data/cty.csv"), resolve(here, "../data/cty.csv"), resolve(process.cwd(), "packages/core/data/cty.csv")]) {
    if (existsSync(/*turbopackIgnore: true*/ c)) return c;
  }
  return resolve(here, "../../data/cty.csv");
}

let cached: { path: string; resolver: DxccResolver } | null = null;

/**
 * The process-wide resolver. Prefers a refreshed copy at $ZEROBEAT_DATA/cty.csv,
 * falling back to the bundled snapshot.
 */
export function getDxcc(): DxccResolver {
  const dataDir = process.env.ZEROBEAT_DATA;
  const refreshed = dataDir ? resolve(dataDir, "cty.csv") : null;
  const path = refreshed && existsSync(/*turbopackIgnore: true*/ refreshed) ? refreshed : (process.env.ZEROBEAT_CTY ?? bundledPath());
  if (cached && cached.path === path) return cached.resolver;
  const data = parseCtyCsv(readFileSync(/*turbopackIgnore: true*/ path, "utf8"));
  cached = { path, resolver: new DxccResolver(data) };
  return cached.resolver;
}

/** Drop the cached resolver so the next call re-reads (after a refresh). */
export function reloadDxcc(): void {
  cached = null;
}
