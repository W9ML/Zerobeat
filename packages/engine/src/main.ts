/**
 * Zerobeat engine: radio, decoder, automatic operating and background jobs.
 * Composition only; each piece owns its own state and is stopped in reverse order.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { getDb, closeDb } from "@zerobeat/core/db/client";
import { runMigrations } from "@zerobeat/core/db/migrate";
import { Alerter } from "@zerobeat/core/mail";
import { openSettings } from "@zerobeat/core/settings/store";
import { EngineState } from "@zerobeat/core/state/engine-state";
import { Logger } from "@zerobeat/core/util/log";
import { SecretBox } from "@zerobeat/core/crypto/secrets";

import { startApi } from "./api/server.ts";
import { Decoder } from "./digital/decoder.ts";
import { Receiver } from "./digital/receiver.ts";
import { CALLING_FREQS, setBandPlan } from "./digital/timing.ts";
import { RadioSupervisor } from "./flex/supervisor.ts";
import { Station } from "./operate/station.ts";
import { LogQueries } from "./operate/worked.ts";
import { Jobs } from "./services/jobs.ts";
import { PskReporter } from "./services/pskreporter.ts";
import { UploadRunner } from "./services/uploads.ts";
import { Pusher } from "./services/push.ts";
import { UdpFeed } from "./services/udp.ts";
import { SpotFeed, type SpotSource } from "./services/spots.ts";
import { TIMING, isDigitalMode } from "./digital/timing.ts";
import { eq } from "drizzle-orm";
import { qsoSigRefs, qsos, stations } from "@zerobeat/core/db/schema";
import { qsoToAdif } from "@zerobeat/core/adif/adif";
import { operatorCalls } from "@zerobeat/core/log/operators";
import { ensureUserStations, splitSharedStation } from "@zerobeat/core/log/owners";

const VERSION = process.env.ZEROBEAT_VERSION ?? "2.0.0";

async function main(): Promise<void> {
  const log = new Logger("engine");
  const token = process.env.ENGINE_TOKEN ?? "";
  if (token.length < 32) throw new Error("ENGINE_TOKEN must be set (32+ characters) in the environment");
  SecretBox.fromEnv(); // fail at start, not at the first secret
  const dataDir = resolve(process.env.ZEROBEAT_DATA ?? "./data");
  mkdirSync(dataDir, { recursive: true });

  const db = getDb();
  runMigrations(db);
  // Each user is their own station; once, the shared station's settings become its owner's.
  const split = splitSharedStation(db);
  if (split.owner) log.info(`independent users: ${split.settings} settings and ${split.state} saved states moved to the owner of the shack's station`);
  ensureUserStations(db);
  const settings = openSettings(db);
  const state = new EngineState(db);
  const alerter = new Alerter((userId) => settings.snapshot(userId), 6 * 3_600_000, (m) => log.warn(m));

  const decoder = new Decoder((m) => log.warn(m));
  const receiver = new Receiver(decoder, (m) => log.warn(m));
  receiver.depth = Number(settings.get("radio.decodeDepth"));
  setBandPlan(settings.get("radio.bandPlan"));

  const supervisor = new RadioSupervisor(
    () => {
      const s = settings.snapshot();
      const last = state.get("lastTune");
      return {
        kind: s["radio.type"] === "icom" ? "icom" : s["radio.type"] === "hamlib" ? "hamlib" : "flex",
        hamlib: {
          host: s["hamlib.host"],
          port: s["hamlib.port"],
          model: s["hamlib.model"],
          device: s["hamlib.device"],
          baud: s["hamlib.baud"],
          pttMethod: s["hamlib.pttMethod"] as "cat" | "dtr" | "rts",
          audioDevice: s["hamlib.audioDevice"],
          ratedWatts: s["hamlib.ratedWatts"],
        },
        host: s["radio.host"],
        lastGoodHost: state.get("lastRadioHost") ?? null,
        icom: {
          connection: s["icom.connection"] === "lan" ? "lan" : "usb",
          lan: { host: s["icom.host"], port: s["icom.port"], username: s["icom.username"], password: s["icom.password"] },
          serialPath: s["icom.serialPath"],
          baud: Number(s["icom.baud"]),
          civAddress: parseInt(s["icom.civAddress"], 16),
          audioDevice: s["icom.audioDevice"],
          ratedWatts: s["icom.ratedWatts"],
        },
        radio: {
          daxChannel: s["radio.daxChannel"],
          defaultFreqHz: last?.hz ?? CALLING_FREQS.FT8["20M"]!,
          rxAntenna: s["radio.rxAntenna"] || undefined,
          txAntenna: s["radio.txAntenna"] || undefined,
          log: (level, msg) => (level === "warn" ? log.warn(msg) : log.info(msg)),
        },
      };
    },
    (host) => state.set("lastRadioHost", host),
    (level, msg) => (level === "warn" ? log.warn(msg) : log.info(msg)),
  );

  const worked = new LogQueries(db);
  const psk = new PskReporter((m) => log.warn(m));
  const station = new Station(db, settings, state, supervisor, receiver, worked, psk, log.child("station"));
  const uploads = new UploadRunner(db, settings, state, alerter, log.child("uploads"));
  const pusher = new Pusher(
    db,
    state,
    () => {
      const s = settings.snapshot();
      return s["alerts.email"] ? `mailto:${s["alerts.email"]}` : s["app.publicUrl"] || "mailto:zerobeat@localhost";
    },
    (m) => log.warn(m),
  );
  const jobs = new Jobs(db, settings, state, uploads, station, psk, alerter, log.child("jobs"), dataDir, pusher);

  station.on("needed", (a) => {
    void pusher.send("needed", {
      title: a.headline,
      body: `${a.callsign} calling CQ on ${a.band.toLowerCase()} ${a.mode}, ${a.snr} dB${a.reasons.length > 1 ? ` · ${a.reasons.slice(1).join(", ")}` : ""}`,
      url: "/operate",
      tag: `needed-${a.callsign}-${a.band}`,
    });
  });
  station.on("fault", (reason) => {
    void pusher.send("faults", { title: "Station fault", body: reason, url: "/operate", tag: "fault" });
    void alerter.raise(`fault-${reason.slice(0, 40)}`, "station fault", `Zerobeat stopped transmitting:\n\n${reason}\n\nRe-arm on the Operate page once it is fixed.`);
  });

  // ---- UDP feed for GridTracker, Log4OM, N1MM Logger+ and friends
  const udpLog = log.child("udp");
  type RecentDecode = (typeof station.recent)[number];
  const toUdpDecode = (d: RecentDecode) => ({ at: d.at, snr: d.snr, dt: d.dt, dfHz: d.offsetHz, mode: d.mode, text: d.text, lowConfidence: d.ap });
  const udp = new UdpFeed({
    id: "Zerobeat",
    version: VERSION,
    log: (level, msg) => (level === "warn" ? udpLog.warn(msg) : udpLog.info(msg)),
    onReply: (r, from) => {
      // Act only on a message that exactly matches a recent decode, as WSJT-X does.
      const d = [...station.recent].reverse().find((x) => x.text === r.text && Math.abs(x.offsetHz - r.dfHz) <= 15);
      if (!d || !d.sender) {
        udpLog.info(`${from} asked to answer "${r.text}", which is not a recent decode`);
        return;
      }
      const cq = d.parsed.find((p) => p.kind === "cq");
      const directed = d.parsed.some((p) => p.kind === "directed");
      const err = station.callStation({
        callsign: d.sender,
        grid: cq && "grid" in cq ? (cq.grid ?? null) : null,
        snr: d.snr,
        offsetHz: d.offsetHz,
        windowIndex: d.windowIndex,
        origin: "manual",
        replyTo: directed ? d : null,
      });
      udpLog.info(`${from} asked to call ${d.sender}: ${err ?? "calling"}`);
    },
    onHaltTx: (autoOnly, from) => {
      udpLog.info(`${from} sent Halt Tx${autoOnly ? " (automatic operating only)" : ""}`);
      if (!autoOnly) station.haltQso("halted from another program");
      void station.setAuto("off", `halt from ${from}`);
    },
    onReplay: () => udp.decodes(station.recent.slice(-80).map(toUdpDecode), false),
  });
  const pushUdpStatus = () => {
    if (!udp.active) return;
    const snap = station.snapshot();
    const q = snap.qso && !["done", "abandoned"].includes(snap.qso.phase) ? snap.qso : null;
    const period = isDigitalMode(snap.mode) ? TIMING[snap.mode].periodMs / 1000 : null;
    const lastTx = q ? [...q.transcript].reverse().find((t) => t.dir === "tx") : undefined;
    udp.status({
      dialHz: snap.dialHz,
      mode: snap.mode,
      dxCall: q?.them ?? "",
      report: q?.reportSent ?? "",
      txEnabled: snap.auto.mode !== "off" || !!q,
      transmitting: snap.radio.transmitting,
      decoding: false,
      rxDf: q?.txOffsetHz ?? snap.txOffsetHz,
      txDf: snap.txOffsetHz,
      deCall: snap.station?.callsign ?? "",
      deGrid: snap.station?.grid ?? "",
      dxGrid: q?.grid ?? "",
      periodSec: period !== null && Number.isInteger(period) ? period : null,
      configName: udp.id === "WSJT-X" ? "Default" : "Zerobeat",
      txMessage: lastTx?.text ?? "",
    });
  };
  const syncUdp = async () => {
    const s = settings.snapshot();
    // Switched off, the feed stops and the addresses stay for the next time.
    await udp.configure({ targets: s["udp.enabled"] ? s["udp.targets"] : "", id: s["udp.clientId"], wsjtxVersion: s["udp.wsjtxVersion"], sendDecodes: s["udp.sendDecodes"], acceptControl: s["udp.acceptControl"] });
    pushUdpStatus();
  };
  station.on("state", pushUdpStatus);
  station.on("decodes", (w) => {
    if (!w.ownTx) udp.decodes(w.decodes.map(toUdpDecode));
  });
  const broadcastLogged = (id: string) => {
    if (!udp.active) return;
    const q = db.select().from(qsos).where(eq(qsos.id, id)).get();
    // The feed is the operator's: a contact someone else logged by hand is not sent on it.
    if (!q || q.stationId !== station.me()?.stationId) return;
    const st = db.select().from(stations).where(eq(stations.id, q.stationId)).get();
    if (!st) return;
    const refs = db.select().from(qsoSigRefs).where(eq(qsoSigRefs.qsoId, id)).all();
    const op = q.operatorId ? (operatorCalls(db).get(q.operatorId) ?? "") : "";
    udp.logged(
      {
        timeOn: q.startTime,
        timeOff: q.endTime ?? q.startTime,
        dxCall: q.callsign,
        dxGrid: q.grid ?? "",
        freqHz: q.freqHz ?? 0,
        mode: q.submode ?? q.mode,
        rstSent: q.rstSent ?? "",
        rstRcvd: q.rstRcvd ?? "",
        txPower: q.txPowerW ? String(q.txPowerW) : "",
        comments: q.notes ?? "",
        name: q.name ?? "",
        operator: op,
        myCall: st.callsign,
        myGrid: q.myGrid ?? st.grid,
        propMode: q.propMode ?? "",
      },
      qsoToAdif(q, st, refs, { operator: op || null }),
    );
  };
  const afterLogged = (id: string) => {
    try {
      broadcastLogged(id);
    } catch (e) {
      udpLog.warn(`UDP logged message: ${(e as Error).message}`);
    }
    setTimeout(() => void jobs.runJob("uploads"), 5_000);
  };
  station.on("logged", afterLogged);

  // ---- DX cluster and Reverse Beacon Network (read-only)
  const spots = new SpotFeed((m) => log.child("spots").warn(m));
  spots.on("spot", (sp) => station.spotNeeded(sp));
  const syncSpots = () => {
    const s = settings.snapshot();
    const sources: SpotSource[] = [];
    if (s["spots.cluster.enabled"] && s["spots.cluster.host"]) sources.push({ id: "cluster", host: s["spots.cluster.host"], port: s["spots.cluster.port"], source: "cluster" });
    if (s["spots.rbn.digital"]) sources.push({ id: "rbn-digital", host: "telnet.reversebeacon.net", port: 7001, source: "rbn" });
    if (s["spots.rbn.cw"]) sources.push({ id: "rbn-cw", host: "telnet.reversebeacon.net", port: 7000, source: "rbn" });
    spots.configure(sources, (s["spots.login"] || station.snapshot().station?.callsign || "").toUpperCase());
  };

  const api = startApi({ token, port: Number(process.env.ENGINE_PORT ?? 3101), settings, state, station, receiver, supervisor, jobs, uploads, worked, pusher, log: log.child("api"), version: VERSION, spots, onReload: async () => {
    ensureUserStations(db);
    syncSpots();
    await syncUdp();
  }, onQsoLogged: afterLogged });

  station.start();
  jobs.start();
  await syncUdp().catch((e) => udpLog.warn(`UDP feed: ${(e as Error).message}`));
  syncSpots();
  // The radio changed hands: the feed and the spot login follow the new operator.
  station.on("operator", () => {
    syncSpots();
    void syncUdp().catch((e) => udpLog.warn(`UDP feed: ${(e as Error).message}`));
  });
  // Someone asked for the radio: tell its operator on their devices too.
  station.on("radioRequest", ({ to, from }) => {
    void pusher
      .send("faults", { title: "The radio is wanted", body: `${from.callsign ?? from.name} asked for the radio. Keep it within 30 seconds, or it goes to them.`, url: "/operate", tag: "radio-request" }, to)
      .catch(() => {});
  });
  // A booking is about to take the radio: tell the operator who has it, on their devices too.
  station.on("bookingSoon", ({ to, booking }) => {
    const at = new Date(booking.startsAt).toISOString().slice(11, 16);
    void pusher
      .send("faults", { title: "Radio time booked", body: `${booking.callsign ?? booking.name} has the radio booked from ${at}Z. It goes to them then; your automatic stops.`, url: "/bookings", tag: "radio-booking" }, to)
      .catch(() => {});
  });
  log.info(`Zerobeat engine ${VERSION} started`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    jobs.stop();
    udp.close();
    spots.stop();
    await station.stop().catch(() => {});
    await api.close().catch(() => {});
    await decoder.close().catch(() => {});
    closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${(e as Error)?.stack ?? e}`));
}

main().catch((e) => {
  console.error(`engine failed to start: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
