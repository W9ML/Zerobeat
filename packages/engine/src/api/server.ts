/**
 * Engine API on 127.0.0.1 only.
 *
 *  HTTP  Control and status for the web tier. Every request carries
 *        `Authorization: Bearer $ENGINE_TOKEN`; the web tier has already checked the
 *        user's session and role.
 *  WS    /ws live feed for browsers (state, decodes, activity, binary waterfall rows).
 *        Requires `?ticket=` minted by the web tier: HMAC over expiry and user, valid
 *        60 s, so the socket is never open to anyone who merely reaches the port.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { SecretBox } from "@zerobeat/core/crypto/secrets";
import { qrzStatus } from "@zerobeat/core/integrations/qrz";
import { wrlStatus } from "@zerobeat/core/integrations/wrl";
import { readP12, LotwCertError } from "@zerobeat/core/integrations/lotw";
import { mailConfigured, sendMail } from "@zerobeat/core/mail";
import { getDb, getSqlite } from "@zerobeat/core/db/client";
import { stationForUser } from "@zerobeat/core/log/owners";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { distanceKm, gridToLatLon, isGrid } from "@zerobeat/core/ham/grid";
import type { SettingsStore } from "@zerobeat/core/settings/store";
import type { EngineState } from "@zerobeat/core/state/engine-state";
import type { Logger } from "@zerobeat/core/util/log";
import { UPLOAD_SERVICES, users, type UploadService } from "@zerobeat/core/db/schema";
import { eq } from "drizzle-orm";

import type { Station } from "../operate/station.ts";
import { AUTO_MODES } from "../operate/schedule.ts";
import type { Receiver } from "../digital/receiver.ts";
import { setBandPlan } from "../digital/timing.ts";
import type { Decode } from "../digital/receiver.ts";
import type { RadioSupervisor } from "../flex/supervisor.ts";
import type { Jobs } from "../services/jobs.ts";
import { serviceReady, type UploadRunner } from "../services/uploads.ts";
import { score, type LogQueries } from "../operate/worked.ts";
import { recentRuns } from "../operate/runs.ts";
import { heardSummary } from "../services/heardby.ts";
import type { Pusher } from "../services/push.ts";
import { Waterfall } from "../dsp/dsp.ts";
import type { SpotFeed } from "../services/spots.ts";
import type { HellChunk } from "../digital/keyboard/hell.ts";
import { isStationId, NeededLogs, parseCallBands } from "./needed.ts";

function ticketKey(token: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(token), Buffer.alloc(0), Buffer.from("zerobeat:ws-ticket") /* must match apps/web/lib/server/engine.ts */, 32));
}

/** `exp.user.sig` — the web tier mints these with the same function. */
export function mintTicket(token: string, user: string, now = Date.now()): string {
  const body = `${now + 60_000}.${Buffer.from(user).toString("base64url")}`;
  return `${body}.${createHmac("sha256", ticketKey(token)).update(body).digest("base64url")}`;
}

export function verifyTicket(token: string, ticket: string, now = Date.now()): string | null {
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(createHmac("sha256", ticketKey(token)).update(body).digest("base64url"));
  const got = Buffer.from(parts[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(parts[0]) < now) return null;
  return Buffer.from(parts[1]!, "base64url").toString();
}

export interface ApiDeps {
  token: string;
  port: number;
  settings: SettingsStore;
  state: EngineState;
  station: Station;
  receiver: Receiver;
  supervisor: RadioSupervisor;
  jobs: Jobs;
  uploads: UploadRunner;
  worked: LogQueries;
  pusher: Pusher;
  /** DX cluster and RBN spots. */
  spots?: SpotFeed;
  /** Called after settings are reloaded. */
  onReload?: () => Promise<void>;
  /** A contact was logged outside the engine (the web form, the API). */
  onQsoLogged?: (id: string) => void;
  log: Logger;
  version: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Requests that operate the radio (not stopping it, not settings). */
/** Hell columns for the page: base64 bytes, HELL_ROWS a column. */
const hellJson = (c: HellChunk) => ({ at: c.at, freqHz: c.freqHz, tx: c.tx, px: Buffer.from(c.px).toString("base64") });

const OPERATING = new Set(["/call", "/sstv/send", "/auto", "/cq-slot", "/hunt-slot", "/udp", "/hound", "/contest", "/spots/tune", "/js8/send", "/js8/hb", "/js8/log", "/keyboard/send", "/keyboard/log", "/tune", "/band-freq", "/tx-offset", "/power", "/atu", "/tx-allow", "/skip", "/rearm"]);

async function body(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function slimDecode(d: Decode, me: string | null, worth?: { points: number; reasons: string[] } | null, myGrid?: string | null) {
  const p = d.parsed[0];
  const grid = p?.kind === "cq" ? p.grid : p?.kind === "directed" && p.payload.kind === "grid" ? p.payload.grid : null;
  // Where the sender is: the country from the prefix, the distance when a grid was sent.
  const dx = d.sender && d.sender !== "<...>" ? getDxcc().resolve(d.sender) : null;
  const a = myGrid && isGrid(myGrid) ? gridToLatLon(myGrid) : null;
  const b = grid && isGrid(grid) ? gridToLatLon(grid) : null;
  const toMe = !!me && d.parsed.some((x) => x.kind === "directed" && x.to === me);
  const fromMe = !!me && d.sender === me;
  return {
    w: d.windowIndex,
    at: d.at,
    mode: d.mode,
    f: d.offsetHz,
    snr: d.snr,
    dt: d.dt,
    text: d.text,
    from: d.sender,
    kind: toMe ? "to-me" : fromMe ? "from-me" : p?.kind === "cq" ? "cq" : p?.kind === "directed" ? "qso" : "text",
    grid,
    country: dx?.name ?? null,
    km: a && b ? Math.round(distanceKm(a, b)) : null,
    mod: p?.kind === "cq" ? p.modifier : null,
    ap: d.ap,
    worth: worth ?? null,
  };
}

export function startApi(d: ApiDeps) {
  const clients = new Set<WebSocket>();
  // Whoever has the radio: decodes are marked and measured from their call and grid.
  const me = () => d.station.me()?.call ?? null;
  /** Whose personal data a request is about: ?for=, the signed-in user, else the operator. */
  const userFor = (req: IncomingMessage, url: URL): string | null => {
    const hdr = req.headers["x-zerobeat-user"];
    return url.searchParams.get("for") || (typeof hdr === "string" && hdr ? hdr : null) || d.station.holderId;
  };
  const myGrid = () => d.station.me()?.grid ?? null;
  // Needed tags are scored against the asker's own log, which need not be the operator's.
  const neededLogs = new NeededLogs(getDb());
  d.station.on("logged", () => neededLogs.invalidate());

  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1 && c.bufferedAmount < 2_000_000) c.send(s);
  };
  let stateTimer: NodeJS.Timeout | null = null;
  d.station.on("state", () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      broadcast({ t: "state", state: d.station.snapshot() });
    }, 200);
  });
  d.station.on("activity", (line) => broadcast({ t: "activity", line }));
  d.station.on("needed", (alert) => broadcast({ t: "needed", alert }));
  d.station.on("fault", (reason) => broadcast({ t: "fault", reason }));
  d.station.keys.on("line", (line) => broadcast({ t: "key", line }));
  d.station.keys.on("hell", (c) => broadcast({ t: "hell", chunk: hellJson(c) }));
  d.station.keys.on("hellSeen", (seen) => broadcast({ t: "hell-seen", seen }));
  d.spots?.on("spot", (spot) => broadcast({ t: "spot", spot }));
  d.station.keys.on("clear", () => broadcast({ t: "key-clear" }));
  d.station.sstv.on("picture", (picture) => broadcast({ t: "sstv-picture", picture }));
  d.station.wspr.on("spots", (spots, period) => broadcast({ t: "wspr", spots, period }));
  d.station.js8.on("message", (message) => broadcast({ t: "js8", message }));
  d.station.on("decodes", (w) => {
    const call = me();
    const grid = myGrid();
    const band = d.station.band;
    const idx = band ? d.worked.worked(band) : null;
    const decodes = w.decodes.map((x) => {
      const cq = x.parsed.find((p) => p.kind === "cq");
      const worth = idx && cq?.kind === "cq" && x.sender ? score({ callsign: x.sender, grid: cq.grid, snr: x.snr, park: null, potaCq: cq.modifier === "POTA" }, idx) : null;
      const slim = slimDecode(x, call, worth ? { points: worth.points, reasons: worth.reasons } : null, grid);
      const ck = band && x.sender && x.sender !== call && x.sender !== "<...>" ? d.station.contestCheck({ callsign: x.sender, band, mode: w.mode, grid: slim.grid }) : null;
      return ck ? { ...slim, contest: { dupe: ck.dupe, mult: ck.newMults.length > 0 } } : slim;
    });
    broadcast({ t: "window", index: w.index, mode: w.mode, start: w.start, decodeMs: w.decodeMs, skipped: w.skipped, ownTx: w.ownTx, decodes });
  });
  const sendRow = (type: 4 | 5, row: Uint8Array, at: number) => {
    // Frame type 4: [4, rows per second, when (float64 LE, engine ms), ...bins]; bins are dB
    // above the noise floor (see Waterfall). Type 5 is the same for our own transmit audio.
    // (Types 2 and 3 were the same without the time.)
    const frame = Buffer.alloc(row.length + 10);
    frame[0] = type;
    frame[1] = Waterfall.ROWS_PER_SEC;
    frame.writeDoubleLE(at, 2);
    frame.set(row, 10);
    for (const c of clients) if (c.readyState === 1 && c.bufferedAmount < 500_000) c.send(frame);
  };
  d.receiver.on("waterfall", (row, at) => sendRow(4, row, at));
  d.receiver.on("waterfall-tx", (row, at) => sendRow(5, row, at));

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    "GET /status": async () => d.station.snapshot(),
    "GET /health": async () => ({ ok: true, version: d.version, radio: d.supervisor.state }),
    "GET /recent": async () => {
      const call = me();
      return { decodes: d.station.recent.slice(-200).map((x) => slimDecode(x, call, null, myGrid())), activity: d.station.activity.slice(-100) };
    },
    "GET /heard": async (_req, url) => ({
      ...heardSummary(getDb(), Date.now() - Math.min(1440, Number(url.searchParams.get("minutes") ?? 60)) * 60_000),
      // when PSKReporter was last asked: it is only asked while the station has transmitted in the last 30 minutes
      lastQueryAt: d.state.get("heardLastQueryAt") ?? null,
    }),
    "POST /heard/refresh": async () => ({ detail: await d.jobs.heardByNow() }),
    // What this receiver hears per band: now (this UTC hour so far) against the last 30 days at this hour and the next.
    "GET /bands": async (_req, url) => {
      const mode = (url.searchParams.get("mode") ?? "FT8").toUpperCase();
      if (!/^[A-Z0-9]{2,6}$/.test(mode)) throw new HttpError(400, "mode must be like FT8");
      const now = Date.now(), h = new Date(now).getUTCHours(), mem = d.station.memory;
      const usual = mem.activityAt(h, mode, 30, now), next = mem.activityAt((h + 1) % 24, mode, 30, now), cur = mem.current(mode, now);
      const bands = [...new Set([...usual.keys(), ...next.keys(), ...cur.keys()])];
      return {
        mode,
        hour: h,
        days: 30,
        bands: bands.map((band) => {
          const c = cur.get(band);
          return {
            band,
            usual: usual.get(band)?.perWindow ?? null,
            samples: usual.get(band)?.samples ?? 0,
            next: next.get(band)?.perWindow ?? null,
            now: c ? { perWindow: Math.round((c.decodes / c.windows) * 10) / 10, windows: c.windows, stations: c.stations } : null,
          };
        }),
      };
    },
    "GET /needed": async (_req, url) => {
      const station = url.searchParams.get("station");
      if (!isStationId(station)) throw new HttpError(400, "station is required");
      const pairs = parseCallBands(url.searchParams.get("calls"));
      if (typeof pairs === "string") throw new HttpError(400, pairs);
      return neededLogs.needed(station, pairs);
    },
    "GET /runs": async (req, url) => {
      const uid = userFor(req, url);
      const sid = uid ? (stationForUser(getDb(), uid)?.id ?? "") : "";
      return { runs: recentRuns(getDb(), 0, Math.min(200, Number(url.searchParams.get("limit") ?? 50)), sid), active: d.station.runs.active };
    },
    "GET /push/key": async () => ({ publicKey: d.pusher.publicKey() }),
    "POST /push/test": async (req) => {
      const b = parse(z.object({ userId: z.string().max(64) }), await body(req));
      const n = await d.pusher.send("faults", { title: "Zerobeat test", body: "Notifications from your station reach this device.", url: "/operate", tag: "test" }, b.userId);
      return { ok: n > 0, detail: n ? `sent to ${n} device${n === 1 ? "" : "s"}` : "no devices with notifications on" };
    },
    "POST /digest/test": async (req, url) => ({ detail: await d.jobs.digest(true, userFor(req, url) ?? undefined) }),
    "POST /reload": async () => {
      const before = radioKey(d.settings);
      const powerBefore = d.settings.get("radio.rfPowerPct");
      d.settings.invalidate();
      const s = d.settings.snapshot();
      d.receiver.depth = Number(s["radio.decodeDepth"]);
      setBandPlan(s["radio.bandPlan"]);
      if (radioKey(d.settings) !== before && !d.station.ft0) await d.supervisor.restart();
      else if (d.station.radio && s["radio.rfPowerPct"] !== powerBefore) await d.station.radio.setRfPower(s["radio.rfPowerPct"]).catch(() => {});
      d.station.emit("state");
      await d.onReload?.();
      return { ok: true };
    },
    "POST /udp": async (req) => {
      const b = parse(z.object({ on: z.boolean() }), await body(req));
      const by = req.headers["x-zerobeat-user"];
      d.settings.write({ "udp.enabled": b.on }, typeof by === "string" ? by : null);
      d.settings.invalidate();
      await d.onReload?.();
      d.station.emit("state");
      return { ok: true };
    },
    "POST /qso-logged": async (req) => {
      const b = parse(z.object({ id: z.string().min(1).max(64) }), await body(req));
      d.station.invalidateContest();
      d.onQsoLogged?.(b.id);
      return { ok: true };
    },
    "POST /auto": async (req) => {
      const b = parse(z.object({ mode: z.enum(AUTO_MODES as [string, ...string[]]), by: z.string().max(100).default("operator") }), await body(req));
      const err = await d.station.setAuto(b.mode as never, b.by);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /call": async (req) => {
      const b = parse(
        z.object({ callsign: z.string().min(3).max(16), offsetHz: z.number().min(100).max(3100), windowIndex: z.number().int(), snr: z.number().min(-40).max(60), grid: z.string().max(8).nullable().default(null), text: z.string().max(80).optional() }),
        await body(req),
      );
      const reply = b.text ? (d.station.recent.find((x) => x.windowIndex === b.windowIndex && x.text === b.text && x.parsed.some((p) => p.kind === "directed" && p.to === me())) ?? null) : null;
      const err = d.station.callStation({ callsign: b.callsign.toUpperCase(), grid: b.grid, snr: b.snr, offsetHz: b.offsetHz, windowIndex: b.windowIndex, origin: "manual", replyTo: reply });
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "GET /spots": async () => ({ spots: d.spots?.spots.slice(-200) ?? [], status: d.spots?.status() ?? [] }),
    "POST /spots/tune": async (req) => {
      const b = parse(z.object({ freqHz: z.number().int().min(100_000).max(450_000_000), mode: z.string().max(10).nullable().default(null) }), await body(req));
      const err = await d.station.tuneToSpot(b.freqHz, b.mode);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    // Receive audio to a WAV in the data folder, for reporting a decoder problem. Not
    // proxied by the web tier: only reachable on this machine, with the engine token.
    "POST /debug/record": async (req) => {
      const b = parse(z.object({ seconds: z.number().int().min(1).max(300) }), await body(req));
      const rate = 12_000;
      const pcm = new Int16Array(rate * b.seconds);
      let n = 0;
      const take = (x: Float32Array) => {
        for (let i = 0; i < x.length && n < pcm.length; i++) pcm[n++] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
      };
      d.receiver.on("audio", take);
      await new Promise((r) => setTimeout(r, b.seconds * 1000 + 500));
      d.receiver.off("audio", take);
      const dir = path.join(path.resolve(process.env.ZEROBEAT_DATA ?? "./data"), "recordings");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rx-${new Date().toISOString().replace(/[:.]/g, "-")}-${d.station.dialHz}.wav`);
      const head = Buffer.alloc(44);
      head.write("RIFF", 0);
      head.writeUInt32LE(36 + n * 2, 4);
      head.write("WAVEfmt ", 8);
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(1, 22);
      head.writeUInt32LE(rate, 24);
      head.writeUInt32LE(rate * 2, 28);
      head.writeUInt16LE(2, 32);
      head.writeUInt16LE(16, 34);
      head.write("data", 36);
      head.writeUInt32LE(n * 2, 40);
      fs.writeFileSync(file, Buffer.concat([head, Buffer.from(pcm.buffer, 0, n * 2)]));
      return { ok: true, file, seconds: n / rate };
    },
    "GET /js8": async () => ({ messages: d.station.js8.messages.slice(-250) }),
    "POST /js8/send": async (req) => {
      const b = parse(z.object({ text: z.string().min(1).max(400) }), await body(req));
      const err = d.station.sendJs8(b.text);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /js8/hb": async () => {
      if (!d.station.js8On) throw new HttpError(409, "switch to JS8 first");
      const blocked = d.station.txBlocked(false);
      if (blocked) throw new HttpError(409, blocked);
      const err = d.station.js8.heartbeat();
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /js8/halt": async () => {
      d.station.haltJs8();
      return { ok: true };
    },
    "POST /js8/inbox/delete": async (req) => {
      const b = parse(z.object({ id: z.number().int() }), await body(req));
      d.station.js8.deleteStored(b.id);
      return { ok: true };
    },
    "POST /js8/log": async (req) => {
      const b = parse(z.object({ callsign: z.string().min(3).max(16), rstSent: z.string().max(8).default(""), rstRcvd: z.string().max(8).default(""), grid: z.string().max(8).nullable().default(null), notes: z.string().max(200).default("") }), await body(req));
      const r = d.station.logJs8(b);
      if ("error" in r) throw new HttpError(409, r.error);
      return { ok: true, id: r.id };
    },
    "GET /wspr": async () => ({ ...d.station.wspr.snapshot(), spots: d.station.wspr.spots.slice(-300) }),
    // ?before=<ms> pages back through the gallery; ?limit= (default 60, at most 200).
    "GET /sstv": async (_req, url) => {
      const before = Number(url.searchParams.get("before")) || Infinity;
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 60));
      return { ...d.station.sstv.snapshot(), ...d.station.sstv.page(before, limit) };
    },
    "POST /sstv/send": async (req) => {
      const b = parse(z.object({ mode: z.string().max(8), rgb: z.string().max(2_000_000) }), await body(req, 2_100_000));
      const err = d.station.sendSstv(b.mode, new Uint8Array(Buffer.from(b.rgb, "base64")));
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /sstv/halt": async () => {
      d.station.haltSstv();
      return { ok: true };
    },
    "GET /keyboard": async () => ({ lines: d.station.keys.lines.slice(-200) }),
    "POST /keyboard/send": async (req) => {
      const b = parse(z.object({ text: z.string().max(600).optional(), fkey: z.number().int().min(1).max(8).optional() }), await body(req));
      const err = d.station.sendKeyboard(b);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /keyboard/halt": async () => {
      d.station.haltKeyboard();
      return { ok: true };
    },
    "POST /keyboard/context": async (req) => {
      const b = parse(
        z.object({
          hisCall: z.string().max(16).optional(),
          queueCall: z.string().max(16).optional(),
          exchange: z.string().max(16).optional(),
          profile: z.enum(["unknown", "field-day", "rtty-roundup"]).optional(),
          serial: z.number().int().min(1).max(9999).optional(),
          wpm: z.number().int().min(5).max(50).optional(),
          hellSpeed: z.enum(["feld", "slow", "x5", "x9", "fsk105", "fsk245", "hell80"]).optional(),
          hellReverse: z.boolean().optional(),
        }),
        await body(req),
      );
      d.station.setKeyContext(b);
      return { ok: true };
    },
    "POST /keyboard/clear": async () => {
      d.station.keys.clear();
      return { ok: true };
    },
    "POST /keyboard/log": async (req) => {
      const b = parse(
        z.object({
          callsign: z.string().min(3).max(16),
          rstSent: z.string().max(8).default(""),
          rstRcvd: z.string().max(8).default(""),
          grid: z.string().max(8).nullable().default(null),
          exchSent: z.string().max(16).default(""),
          exchRcvd: z.string().max(16).default(""),
          startTime: z.number().int().nullable().default(null),
          notes: z.string().max(200).default(""),
          name: z.string().max(60).nullable().default(null),
          qth: z.string().max(80).nullable().default(null),
        }),
        await body(req),
      );
      const r = d.station.logKeyboard({ ...b, callsign: b.callsign.toUpperCase(), grid: b.grid ? b.grid.toUpperCase() : null });
      if ("error" in r) throw new HttpError(409, r.error);
      return { ok: true, id: r.id };
    },
    "POST /contest": async (req) => {
      const b = parse(
        z.object({
          id: z.enum(["none", "ww-digi", "arrl-digi", "field-day", "rtty-roundup"]).optional(),
          exchange: z.string().max(12).optional(),
          serial: z.number().int().min(1).max(9999).optional(),
          since: z.number().int().min(0).max(Date.now() + 86_400_000).optional(),
          fdPower: z.union([z.literal(1), z.literal(2), z.literal(5)]).optional(),
        }),
        await body(req),
      );
      d.station.setContest(b);
      return { ok: true };
    },
    "GET /contest/sheet": async () => d.station.contestSheet() ?? { id: "none", rows: [], multList: [], missing: [] },
    "GET /contest/check": async (_req, url) => {
      const call = (url.searchParams.get("call") ?? "").toUpperCase().slice(0, 16);
      if (!call) throw new HttpError(400, "give ?call=");
      return d.station.contestCheck({ callsign: call, band: url.searchParams.get("band"), grid: url.searchParams.get("grid"), exchange: url.searchParams.get("exchange") ?? undefined }) ?? { dupe: false, newMults: [], workedOn: [] };
    },
    "POST /keyboard/fkeys": async (req) => {
      const b = parse(z.object({ mode: z.enum(["JTTY", "RTTY", "PSK31", "CW", "HELL"]), keys: z.array(z.string().max(160)).length(8).nullable() }), await body(req));
      const err = d.station.setFkeys(b.mode, b.keys);
      if (err) throw new HttpError(400, err);
      return { ok: true };
    },
    "POST /hound": async (req) => {
      const b = parse(z.object({ on: z.boolean() }), await body(req));
      d.station.setHoundMode(b.on);
      return { ok: true };
    },
    "POST /cq-slot": async (req) => {
      const b = parse(z.object({ slot: z.union([z.literal(0), z.literal(1)]) }), await body(req));
      d.station.setCqSlot(b.slot);
      return { ok: true };
    },
    "POST /hunt-slot": async (req) => {
      const b = parse(z.object({ slot: z.union([z.literal(0), z.literal(1), z.null()]) }), await body(req));
      d.station.setHuntSlot(b.slot);
      return { ok: true };
    },
    "POST /halt": async () => {
      d.station.haltQso();
      await d.station.setAuto("off", "operator");
      return { ok: true };
    },
    "POST /skip": async () => {
      d.station.haltQso("skipped by operator");
      return { ok: true };
    },
    "POST /tx-allow": async (req) => {
      const b = parse(z.object({ allowed: z.boolean(), by: z.string().max(100).default("operator") }), await body(req));
      if (b.allowed && d.station.ft0) throw new HttpError(409, "FT-0 is engaged; release it first");
      d.settings.write({ "radio.allowTransmit": b.allowed }, null);
      if (!b.allowed) {
        await d.station.radio?.unkey().catch(() => {});
        d.station.haltQso("transmit turned off");
        await d.station.setAuto("off", "transmit turned off");
      }
      d.log.info(`transmit ${b.allowed ? "armed" : "disarmed"} by ${b.by}`);
      d.station.emit("state");
      return { ok: true, allowed: b.allowed };
    },
    "POST /rearm": async () => {
      d.station.guards.rearm();
      d.station.emit("state");
      return { ok: true };
    },
    "POST /tune": async (req) => {
      const b = parse(z.object({ hz: z.number().int().min(100_000).max(1_300_000_000).optional(), band: z.string().max(6).optional(), mode: z.enum(["FT8", "FT4", "FT2", "JTTY", "RTTY", "PSK31", "CW", "HELL", "SSTV", "WSPR", "JS8"]).optional() }), await body(req));
      if (b.band) {
        const err = await d.station.tuneBand(b.band.toUpperCase(), b.mode ?? d.station.opMode);
        if (err) throw new HttpError(400, err);
      } else if (b.hz) await d.station.tuneHz(b.hz);
      else throw new HttpError(400, "give hz or band");
      return { ok: true };
    },
    "POST /band-freq": async (req) => {
      const b = parse(z.object({ reset: z.boolean().optional() }), await body(req));
      const err = d.station.saveBandFreq(!!b.reset);
      if (err) throw new HttpError(400, err);
      return { ok: true };
    },
    // Ask for the radio: yours at once while it is idle; otherwise the operator has 30
    // seconds to keep it, and no answer hands it over.
    "POST /radio/request": async (req) => {
      const uid = req.headers["x-zerobeat-user"];
      if (typeof uid !== "string" || !uid) throw new HttpError(400, "asking for the radio needs a signed-in user");
      const r = d.station.requestRadio(uid);
      if (r.error) throw new HttpError(409, r.error);
      return { ok: true, granted: r.granted };
    },
    "POST /radio/answer": async (req) => {
      const b = parse(z.object({ release: z.boolean() }), await body(req));
      const uid = req.headers["x-zerobeat-user"];
      if (typeof uid !== "string" || !uid) throw new HttpError(400, "answering needs a signed-in user");
      const err = d.station.answerRadioRequest(uid, b.release);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /control": async (req) => {
      const b = parse(z.object({ take: z.boolean(), by: z.string().max(100).default("operator") }), await body(req));
      const uid = req.headers["x-zerobeat-user"];
      if (b.take && typeof uid !== "string") throw new HttpError(400, "taking control needs a signed-in user");
      const err = d.station.setControlOp(b.take ? (uid as string) : null, b.by);
      if (err) throw new HttpError(409, err);
      return { ok: true };
    },
    "POST /tx-offset": async (req) => {
      const b = parse(z.object({ hz: z.number().min(200).max(2900) }), await body(req));
      d.station.setTxOffset(b.hz);
      return { ok: true };
    },
    "POST /power": async (req) => {
      const b = parse(z.object({ pct: z.number().int().min(1).max(100) }), await body(req));
      d.settings.write({ "radio.rfPowerPct": b.pct }, null);
      await d.station.radio?.setRfPower(b.pct);
      d.station.emit("state");
      return { ok: true };
    },
    "POST /atu": async () => {
      const blocked = d.station.txBlocked(false);
      if (blocked) throw new HttpError(409, blocked);
      await d.station.radio!.atuStart();
      return { ok: true };
    },
    "POST /ft0": async (req) => {
      const b = parse(z.object({ engage: z.boolean(), by: z.string().max(100).default("operator") }), await body(req));
      if (b.engage) await d.station.engageFt0(b.by);
      else d.station.releaseFt0(b.by);
      return { ok: true, ft0: d.station.ft0 };
    },
    // One user's services: ?for= (the web passes it only for an admin looking at someone),
    // else the signed-in user, else whoever has the radio.
    "GET /services": async (req, url) => {
      const uid = userFor(req, url);
      const s = d.settings.snapshot(uid);
      const st = d.state.forUser(uid);
      const sid = uid ? (stationForUser(getDb(), uid)?.id ?? "") : "";
      const pending = getSqlite()
        .prepare("SELECT u.service, u.status, COUNT(*) AS n FROM upload_state u JOIN qsos q ON q.id = u.qso_id WHERE q.station_id = ? GROUP BY u.service, u.status")
        .all(sid) as { service: string; status: string; n: number }[];
      return {
        uploads: UPLOAD_SERVICES.map((svc) => ({
          service: svc,
          enabled: s[`uploads.${svc}` as const],
          notReady: serviceReady(svc, s, st),
          paused: uid ? d.uploads.paused(svc, uid) : null,
          counts: Object.fromEntries(pending.filter((p) => p.service === svc).map((p) => [p.status, p.n])),
        })),
        jobs: d.state.get("jobs") ?? {},
        jobNames: d.jobs.names(),
        lotwCert: st.get("lotwCert")?.info ?? null,
      };
    },
    "POST /jobs/run": async (req) => {
      const b = parse(z.object({ name: z.string().max(40) }), await body(req));
      return d.jobs.runJob(b.name);
    },
    "POST /uploads/resume": async (req, url) => {
      const b = parse(z.object({ service: z.enum(UPLOAD_SERVICES) }), await body(req));
      const uid = userFor(req, url);
      if (!uid) throw new HttpError(400, "resuming needs a signed-in user");
      d.uploads.resume(b.service as UploadService, uid);
      return { ok: true };
    },
    "POST /lotw/cert": async (req, url) => {
      const b = parse(z.object({ p12: z.string().max(200_000), password: z.string().max(200) }), await body(req, 400_000));
      try {
        const cert = readP12(Buffer.from(b.p12, "base64"), b.password);
        if (cert.validTo < Date.now()) throw new HttpError(400, `that certificate expired on ${new Date(cert.validTo).toISOString().slice(0, 10)}; renew it in TQSL`);
        const { certPem, keyPem, ...info } = cert;
        const uid = userFor(req, url);
        if (!uid) throw new HttpError(400, "a certificate needs a signed-in user");
        d.state.forUser(uid).set("lotwCert", { certPem, keyEnc: SecretBox.fromEnv().encrypt(keyPem), info, uploadedAt: Date.now() });
        return { ok: true, info };
      } catch (e) {
        if (e instanceof LotwCertError) throw new HttpError(400, e.message);
        throw e;
      }
    },
    "DELETE /lotw/cert": async (req, url) => {
      const uid = userFor(req, url);
      if (!uid) throw new HttpError(400, "a certificate needs a signed-in user");
      d.state.forUser(uid).set("lotwCert", null);
      return { ok: true };
    },
    "POST /test": async (req, url) => {
      const b = parse(z.object({ what: z.enum(["qrz-logbook", "wrl", "email"]), to: z.string().email().optional() }), await body(req));
      const s = d.settings.snapshot(userFor(req, url));
      if (b.what === "qrz-logbook") return qrzStatus(s["qrz.logbookKey"]);
      if (b.what === "wrl") return wrlStatus(s["wrl.apiKey"], s["wrl.logbookId"] || null);
      if (!mailConfigured(s)) return { ok: false, detail: "set the SMTP host and From address first" };
      try {
        await sendMail(s, { to: b.to ?? s["alerts.email"], subject: "Zerobeat test message", text: "Email from Zerobeat works." });
        return { ok: true, detail: "sent" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const send = (status: number, v: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(v));
    };
    const auth = req.headers.authorization ?? "";
    const want = Buffer.from(`Bearer ${d.token}`);
    const got = Buffer.from(auth);
    if (url.pathname !== "/health" && (want.length !== got.length || !timingSafeEqual(want, got))) return send(401, { error: "unauthorized" });
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return send(404, { error: "not found" });
    // Operating actions make their user the one who "has the radio": their license
    // applies and the contacts that follow are logged as theirs.
    // While someone else is using the radio, it has to be asked for (POST /radio/request).
    const actor = req.headers["x-zerobeat-user"];
    if (req.method === "POST" && typeof actor === "string" && actor && OPERATING.has(url.pathname)) {
      const busy = d.station.noteOperator(actor);
      if (busy) return send(409, { error: busy, radioBusy: true });
    }
    try {
      send(200, await handler(req, url));
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message });
      else {
        d.log.error(`api ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
        send(500, { error: (e as Error).message });
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const user = url.pathname === "/ws" ? verifyTicket(d.token, url.searchParams.get("ticket") ?? "") : null;
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // Which user this page is (tickets carry the email): an open page counts as signed in,
    // which radio bookings go by. API keys are nobody.
    const uid = user.startsWith("apikey:") ? null : (getDb().select({ id: users.id }).from(users).where(eq(users.email, user)).get()?.id ?? null);
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      let gone = false;
      const leave = () => {
        clients.delete(ws);
        if (uid && !gone) d.station.notePresence(uid, -1);
        gone = true;
      };
      ws.on("close", leave);
      ws.on("error", leave);
      if (uid) d.station.notePresence(uid, 1);
      const call = me();
      ws.send(JSON.stringify({ t: "hello", version: d.version, state: d.station.snapshot(), decodes: d.station.recent.slice(-200).map((x) => slimDecode(x, call, null, myGrid())), activity: d.station.activity.slice(-100), keyLines: d.station.keys.lines.slice(-200), hell: d.station.keys.hellHistory().map(hellJson), hellSeen: d.station.keys.hellSeen }));
    });
  });
  // Keep sockets alive through proxies and drop dead ones.
  const ping = setInterval(() => {
    for (const c of clients) {
      if (c.readyState === 1) c.ping();
    }
  }, 25_000);

  server.listen(d.port, "127.0.0.1", () => d.log.info(`engine API on 127.0.0.1:${d.port}`));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(ping);
        for (const c of clients) c.terminate();
        server.close(() => resolve());
      }),
  };
}

function radioKey(s: SettingsStore): string {
  const v = s.snapshot();
  return [v["radio.type"], v["radio.host"], v["radio.daxChannel"], v["radio.rxAntenna"], v["radio.txAntenna"], v["icom.connection"], v["icom.host"], v["icom.port"], v["icom.username"], v["icom.password"], v["icom.serialPath"], v["icom.baud"], v["icom.civAddress"], v["icom.audioDevice"], v["icom.ratedWatts"], v["hamlib.model"], v["hamlib.device"], v["hamlib.baud"], v["hamlib.pttMethod"], v["hamlib.host"], v["hamlib.port"], v["hamlib.audioDevice"], v["hamlib.ratedWatts"]].join("|");
}
