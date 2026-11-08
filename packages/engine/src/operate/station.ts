/**
 * The station: owns the current contact, the automatic mode and the transmit schedule.
 *
 * Event flow is one way: radio audio → receiver → window → station. Every slotted
 * transmission goes through `transmit()` and every keyboard one through `sendKeyboard()`; both
 * check the master switch, FT-0 and the guards before keying, and nothing else keys the radio.
 */
import { EventEmitter } from "node:events";
import { and, between, eq, gte, like } from "drizzle-orm";

import type { Db } from "@zerobeat/core/db/client";
import { decodes as decodesTable, incompleteExchanges, qsos as qsosTable } from "@zerobeat/core/db/schema";
import { checkStation, CONTESTS, roundupMissing, summarize, type ContestSummary } from "@zerobeat/core/contest/scoring";
import { bandName } from "@zerobeat/core/ham/bands";
import { createQso, defaultStation, enabledUploadServices } from "@zerobeat/core/log/qsos";
import { stationForUser } from "@zerobeat/core/log/owners";
import type { SettingsStore } from "@zerobeat/core/settings/store";
import type { EngineState } from "@zerobeat/core/state/engine-state";
import type { Logger } from "@zerobeat/core/util/log";
import { newId } from "@zerobeat/core/util/id";

import type { RadioSupervisor } from "../flex/supervisor.ts";
import type { Rig, Telemetry, TxReport } from "../rig/types.ts";
import type { Decode, Receiver, WindowResult } from "../digital/receiver.ts";
import { CONTEST_CQ, formatReport, isFoxMessage, isStandardCall, rstFromSnr, type Contest, type Parsed } from "../digital/message.ts";
import {
  abandon,
  afterTx,
  isActive,
  nextMessage,
  receive,
  startAnswer,
  startCall,
  transcriptText,
  type QsoEvent,
  type QsoState,
  type RxDecode,
} from "../digital/sequencer.ts";
import { bandPlan, bandsFor, CALLING_FREQS, FREE_TUNING, OPERATING_MODES, TIMING, isDigitalMode, modeForDial, nextTxWindow, parity, parityName, slottedModeForDial, txStartAt, type DigitalMode, type OperatingMode, windowIndex } from "../digital/timing.ts";
import { KeyboardDesk, KEY_MODES, type KeyContext, type KeyMode } from "./keyboard.ts";
import { HELL_SPEEDS } from "../digital/keyboard/hell.ts";
import { SstvDesk } from "./sstv.ts";
import { WsprDesk, wsprMessage } from "./wspr.ts";
import { Js8Desk } from "./js8.ts";
import { AuxDecoder } from "../digital/aux-decoder.ts";
import { wsprTones, wsprWaveform, normalizeWsprPower } from "../digital/wspr/index.ts";
import { modeById as sstvMode } from "@zerobeat/core/sstv/modes";
import { sstvWaveform } from "../digital/sstv/encode.ts";
import { resolve as resolvePath } from "node:path";
import { buildWaveform, MAX_TX_HZ, MIN_TX_HZ } from "../digital/waveform.ts";
import { cqClearSpot } from "./cq-spot.ts";
import { Guards } from "./guards.ts";
import { cqIsForUs, LogQueries, score, type Scored } from "./worked.ts";
import { RunRecorder, type NewOne } from "./runs.ts";
import { BandMemory } from "./band-memory.ts";
import { decideSchedule, PaDuty, type AutoMode } from "./schedule.ts";
import { parkFor, potaSpotsCached, type PotaSpot } from "../services/pota.ts";
import type { PskReporter } from "../services/pskreporter.ts";
import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { emissionKind, higherClass, isLicenseClass, LICENSE_NAMES, privilegeProblem, usPowerNote, type LicenseClass } from "@zerobeat/core/ham/privileges";
import { operatorForUser } from "@zerobeat/core/log/operators";
import { bookedOut, bookingAt, decideBooking, nextBooking, PRESENT_GRACE_MS, type Booking } from "@zerobeat/core/radio/bookings";
import { backfillEntities } from "@zerobeat/core/log/heard-entities";
import { users } from "@zerobeat/core/db/schema";

export interface ActivityLine {
  at: number;
  /** "state": an echo of a setting or mode change, kept in the history but not shown as news. */
  level: "info" | "warn" | "tx" | "log" | "state";
  text: string;
}

export interface Caller {
  callsign: string;
  snr: number;
  offsetHz: number;
  text: string;
  windowIndex: number;
  at: number;
}

export interface NeededAlert {
  callsign: string;
  band: string;
  mode: string;
  /** Set when the alert came from a DX spot rather than our own decode: where to tune. */
  spotHz?: number;
  snr: number;
  offsetHz: number;
  windowIndex: number;
  text: string;
  grid: string | null;
  reasons: string[];
  /** The headline: "New DXCC: Japan". */
  headline: string;
  at: number;
}

/** A signed-in user at the radio. */
export interface Person {
  userId: string;
  name: string;
  callsign: string | null;
  licenseClass: LicenseClass | null;
}

type Events = {
  decodes: [WindowResult];
  state: [];
  activity: [ActivityLine];
  logged: [string];
  needed: [NeededAlert];
  fault: [string];
  /** The radio changed hands (the new holder's user id). */
  operator: [string];
  /** Someone asked the holder for the radio. */
  radioRequest: [{ to: string; from: Person }];
  /** A booking is about to take the radio from the operator who has it. */
  bookingSoon: [{ to: string; booking: Booking }];
};

const HOP_AFTER_EMPTY_WINDOWS = 20;
const CALLER_TTL_MS = 3 * 60_000;
/** Below this peak forward power a completed transmission counts as "no RF out". */
const NO_RF_WATTS = 0.5;
const NEEDED_REPEAT_MS = 30 * 60_000;

const isKeyMode = (m: string): m is KeyMode => (KEY_MODES as readonly string[]).includes(m);

export class Station extends EventEmitter<Events> {
  /** The slotted mode; while a keyboard mode is on it is the one to go back to. */
  mode: DigitalMode = "FT8";
  /** A keyboard mode (JTTY, RTTY, PSK31, CW, Hell) has the receiver (see keyboard.ts). */
  keyMode: KeyMode | null = null;
  readonly keys: KeyboardDesk;
  private keyTxSeq = 0;
  /** SSTV has the receiver (see sstv.ts). */
  sstvOn = false;
  readonly sstv: SstvDesk;
  private sstvTxSeq = 0;
  /** WSPR has the receiver (see wspr.ts). */
  wsprOn = false;
  readonly wspr: WsprDesk;
  /** JS8 has the receiver (see js8.ts). */
  js8On = false;
  readonly js8: Js8Desk;
  private js8TxSeq = 0;
  /** When SWR faults happened: a second one inside 10 minutes stops the run instead of hopping again. */
  private swrFaults: number[] = [];
  private warnedNoMeter = false;
  readonly aux: AuxDecoder;
  qso: QsoState | null = null;
  auto: AutoMode = "off";
  autoSource = "operator";
  cqParity: 0 | 1 | null = null;
  txOffsetHz = 1500;
  ft0 = false;
  transmitting = false;
  lastTx: { at: number; message: string; ok: boolean; detail: string; fwdW: number | null; swr: number | null } | null = null;
  readonly runs: RunRecorder;
  readonly memory: BandMemory;
  private noRfCount = 0;
  private neededSeen = new Map<string, number>();
  lastWindow: { index: number; decodes: number; decodeMs: number; skipped: string | null; at: number } | null = null;
  recent: Decode[] = [];
  /** The unanswered-CQ count at the last window we skipped to listen in our own slot. */
  private cqListenedAt = 0;
  private cqMovedAt = 0;
  callers: Caller[] = [];
  activity: ActivityLine[] = [];
  candidates: Scored[] = [];
  readonly guards: Guards;
  readonly pa = new PaDuty();
  private plannedTx = new Set<number>();
  private emptyHuntWindows = 0;
  private hopCursor = -1;
  /** The band a hop last left, and when: not hopped straight back to. */
  private hopLeft: { band: string; at: number } | null = null;
  private yieldCache: { key: string; at: number; bands: Map<string, { avg: number; samples: number; best: number | null }> } | null = null;

  /** Band memory for this UTC hour in the current FT mode: what each band usually holds. */
  bandYield(): Map<string, { avg: number; samples: number; best: number | null }> | null {
    if (!isDigitalMode(this.opMode)) return null;
    const h = new Date().getUTCHours();
    const key = `${this.opMode}|${h}`;
    const now = Date.now();
    if (!this.yieldCache || this.yieldCache.key !== key || now - this.yieldCache.at > 10 * 60_000) {
      this.yieldCache = { key, at: now, bands: this.memory.yieldAt(h, this.opMode) };
    }
    return this.yieldCache.bands;
  }
  private chase: { home: { hz: number; mode: DigitalMode } | null; target: PotaSpot | null; parkedAt: number; tried: Map<string, number> } = {
    home: null,
    target: null,
    parkedAt: 0,
    tried: new Map(),
  };
  private qsoPeakW = 0;
  private decodeBuffer: (typeof decodesTable.$inferInsert)[] = [];
  private scheduleLast: string | null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private bookingTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsStore,
    private readonly state: EngineState,
    private readonly supervisor: RadioSupervisor,
    private readonly receiver: Receiver,
    private readonly worked: LogQueries,
    private readonly psk: PskReporter,
    private readonly log: Logger,
  ) {
    super();
    state.owner = () => state.get("holder")?.userId ?? null;
    settings.actAs(state.get("holder")?.userId ?? null);
    worked.station = () => this.me()?.stationId ?? null;
    this.guards = new Guards(() => {
      const s = this.settings.snapshot();
      return {
        maxRunMinutes: s["auto.maxRunMinutes"],
        maxQsosPerRun: s["auto.maxQsosPerRun"],
        maxUnansweredCqs: s["auto.maxUnansweredCqs"],
        maxSwr: s["auto.maxSwr"],
        maxPaTempC: s["auto.maxPaTempC"],
        deafWindows: 8,
      };
    });
    this.runs = new RunRecorder(db);
    this.memory = new BandMemory(db);
    // Entity memory starts with what the decodes table already holds (once).
    setTimeout(() => {
      try {
        const n = backfillEntities(db);
        if (n) this.log.info(`heard entities: filled from ${n} stored decodes`);
      } catch (e) {
        this.log.warn(`heard entities backfill: ${(e as Error).message}`);
      }
    }, 5_000);
    this.scheduleLast = state.get("scheduleLast") ?? null;
    const ft0 = state.get("ft0");
    this.ft0 = !!ft0;
    const last = state.get("lastTune");
    if (last?.mode === "SSTV") this.sstvOn = true;
    else if (last?.mode === "WSPR") this.wsprOn = true;
    else if (last?.mode === "JS8") this.js8On = true;
    else if (last && KEY_MODES.includes(last.mode as KeyMode)) this.keyMode = last.mode as KeyMode;
    else if (last && isDigitalMode(last.mode)) this.mode = last.mode;
    receiver.setMode(this.mode);
    receiver.on("window", (w) => this.onWindow(w));
    this.keys = new KeyboardDesk(state.get("keyContext") ?? state.get("jttyContext") ?? undefined);
    this.keys.customFkeys = { ...(state.get("fkeys") ?? {}) };
    // A contest's exchange left over from before this fix: with no contest there is none.
    if ((state.get("contest")?.id ?? "none") === "none" && (this.keys.ctx.profile !== "unknown" || this.keys.ctx.exchange)) {
      this.keys.setContext({ profile: "unknown", exchange: "", serialOn: false });
    }
    this.on("logged", () => this.invalidateContest());
    this.keys.rxHz = this.txOffsetHz;
    this.keys.on("state", () => this.emit("state"));
    receiver.on("audio", (x, at) => setImmediate(() => this.keys.feed(x, at)));
    this.sstv = new SstvDesk(resolvePath(process.env.ZEROBEAT_DATA ?? "./data"));
    this.sstv.dialHz = () => this.dialHz || null;
    this.sstv.keepDays = () => this.settings.get("sstv.keepDays");
    this.sstv.on("state", () => this.emit("state"));
    receiver.on("audio", (x, at) => setImmediate(() => this.sstv.feed(x, at)));
    if (this.sstvOn) {
      receiver.setSlotted(false);
      this.sstv.start();
    }
    this.aux = new AuxDecoder((m) => this.log.warn(m));
    this.wspr = new WsprDesk(
      this.aux,
      resolvePath(process.env.ZEROBEAT_DATA ?? "./data"),
      () => {
        const s = this.settings.snapshot();
        const st = this.me();
        return { call: st?.call ?? "", grid6: (st?.grid ?? "").slice(0, 6), dialHz: this.dialHz, txPct: s["wspr.txPct"], dbm: normalizeWsprPower(s["wspr.dbm"]), upload: s["wspr.upload"], version: "Zerobeat", canTransmit: !this.txBlocked(true) };
      },
      (start) => this.transmitWspr(start),
      (level, msg) => this.say(level === "warn" ? "warn" : "info", msg),
    );
    this.wspr.on("state", () => this.emit("state"));
    this.wspr.on("spots", (found) => {
      if (found.length) this.say("info", `WSPR: ${found.map((s) => `${s.callsign ?? s.message} ${s.snrDb} dB`).join(", ")}`);
    });
    receiver.on("audio", (x, at) => setImmediate(() => this.wspr.feed(x, at)));
    if (this.wsprOn) {
      receiver.setSlotted(false);
      this.wspr.start();
    }
    this.js8 = new Js8Desk(
      this.aux,
      resolvePath(process.env.ZEROBEAT_DATA ?? "./data"),
      () => {
        const s = this.settings.snapshot();
        const st = this.me();
        return {
          call: st?.call ?? "",
          grid: (st?.grid ?? "").slice(0, 6).toUpperCase(),
          submode: s["js8.submode"] as "normal" | "fast" | "turbo" | "slow",
          autoReply: s["js8.autoReply"] && s["radio.allowTransmit"],
          hbAck: s["js8.hbAck"],
          hbMinutes: s["js8.hbMinutes"],
          info: s["js8.info"].toUpperCase(),
          status: s["js8.status"].toUpperCase(),
          groups: s["js8.groups"].split(",").map((g) => g.trim().toUpperCase()).filter((g) => g.startsWith("@")),
          txOffsetHz: this.txOffsetHz,
        };
      },
      (samples, startAt, label, auto) => this.transmitJs8(samples, startAt, label, auto),
      (level, msg) => this.say(level === "warn" ? "warn" : "info", msg),
    );
    this.js8.on("state", () => this.emit("state"));
    receiver.on("audio", (x, at) => setImmediate(() => this.js8.feed(x, at)));
    if (this.js8On) {
      receiver.setSlotted(false);
      this.js8.start();
    }
    if (this.keyMode) {
      receiver.setSlotted(false);
      this.keys.start(this.keyMode);
    }
  }

  /** What the Operate page shows as the mode. */
  get opMode(): OperatingMode {
    return this.sstvOn ? "SSTV" : this.wsprOn ? "WSPR" : this.js8On ? "JS8" : (this.keyMode ?? this.mode);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    // The last contact stays on the contact card across a restart; one cut off by the
    // restart shows as stopped, not as still going.
    const last = this.state.get("lastQso") as QsoState | null | undefined;
    if (last?.id && last.them && Array.isArray(last.transcript)) {
      this.qso = isActive(last) ? { ...last, phase: "abandoned", reason: "the engine restarted" } : last;
    }
    this.receiver.start();
    this.supervisor.on("radio", (r) => void this.onRadio(r));
    if (!this.ft0) this.supervisor.start();
    this.scheduleTimer = setInterval(() => this.scheduleTick(), 30_000);
    this.bookingTimer = setInterval(() => this.bookingTick(), 15_000);
    this.bookingTick();
    let ticks = 0;
    this.flushTimer = setInterval(() => {
      this.flushDecodes();
      if (++ticks % 60 === 0) this.memory.flush();
    }, 5_000);
    const resume = this.state.get("auto");
    if (resume && resume.mode !== "off" && !this.ft0) {
      this.say("info", `will resume automatic ${resume.mode} once the radio is connected`);
    }
  }

  async stop(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.bookingTimer) clearInterval(this.bookingTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushDecodes();
    this.memory.flush();
    this.runs.stop("engine stopped");
    if (this.qso) this.state.set("lastQso", this.qso as unknown as Record<string, unknown>);
    this.receiver.stop();
    this.wspr.stop();
    this.js8.stop();
    await this.aux.close().catch(() => {});
    await this.radio?.unkey().catch(() => {});
    await this.supervisor.stop();
  }

  get radio(): Rig | null {
    return this.supervisor.radio;
  }

  private async onRadio(r: Rig | null): Promise<void> {
    this.emit("state");
    if (!r) return;
    r.on("audio", (s, at, lost) => this.receiver.feed(s, at, lost));
    r.on("telemetry", (t) => this.onTelemetry(t));
    r.on("slice", () => this.emit("state"));
    r.on("txReady", () => {
      const p = r.txProblem;
      this.say(p ? "warn" : "info", p ?? "the radio is ready to transmit again");
      this.emit("state");
    });
    r.on("transmitting", (tx) => {
      this.transmitting = tx;
      this.keys.muted = tx;
      this.sstv.muted = tx;
      this.receiver.txKeyed(tx);
      // The contact card shows our message as it starts, as WSJT-X does, not when it ends.
      if (tx && this.txArmed && !this.txNow) this.txNow = { ...this.txArmed, at: Date.now() };
      this.emit("state");
    });
    r.on("otherTx", () => {
      // The operator (or a second client) keyed from the radio's own software. Whatever we
      // were doing automatically stops until someone here re-arms: two programs taking
      // turns at one transmitter is how a station ends up keyed over its own phone QSO.
      const busy = this.auto !== "off" || this.js8On || this.wsprOn;
      if (!busy) return;
      const reason = "another client keyed the radio; automatic operating stood down";
      this.guards.state.paused = { cause: "limit", reason, at: Date.now() };
      this.say("warn", reason);
      if (this.auto !== "off") void this.setAuto("off", "another client transmitted");
      this.emit("state");
    });
    const s = this.settings.snapshot();
    await r.setRfPower(s["radio.rfPowerPct"]).catch((e) => this.say("warn", `RF power: ${(e as Error).message}`));
    // Go back to where the station was. With nothing saved (a fresh install), leave the
    // radio where its owner left it: moving a new Technician's radio to 20 m made
    // transmitting outside their privileges the easiest thing on the screen.
    const last = this.state.get("lastTune");
    if (last?.hz) await this.tuneHz(last.hz).catch((e) => this.say("warn", `tune: ${(e as Error).message}`));
    else this.say("state", "staying on the radio's frequency; pick a band to move");
    const resume = this.state.get("auto");
    if (resume && resume.mode !== "off" && this.auto === "off") {
      if (s["radio.allowTransmit"]) await this.setAuto(resume.mode as AutoMode, "resume after restart", resume.since);
      else this.say("info", `not resuming ${resume.mode}: transmit is off`);
    }
  }

  // -------------------------------------------------------------------------
  // Info
  // -------------------------------------------------------------------------

  get dialHz(): number {
    return this.radio?.slice?.freqHz ?? this.state.get("lastTune")?.hz ?? 0;
  }

  get band(): string | null {
    return bandName(this.dialHz);
  }

  private say(level: ActivityLine["level"], text: string): void {
    const line = { at: Date.now(), level, text };
    this.activity.push(line);
    if (this.activity.length > 200) this.activity.shift();
    if (level === "warn") this.log.warn(text);
    else if (level === "state") this.log.info(text);
    else this.log.info(text);
    this.emit("activity", line);
  }

  /**
   * Who is on the air: the station (callsign, grid, logbook) of whoever has the radio. With
   * nobody holding it yet, the shack's first station; null for a holder with no callsign.
   */
  me(): { call: string; grid: string; grid4: string; stationId: string } | null {
    const uid = this.holderId;
    const st = uid ? stationForUser(this.db, uid) : defaultStation(this.db);
    if (!st) return null;
    return { call: st.callsign.toUpperCase(), grid: st.grid, grid4: st.grid.slice(0, 4).toUpperCase(), stationId: st.id };
  }

  // -------------------------------------------------------------------------
  // Who is operating
  // -------------------------------------------------------------------------

  private person(userId: string | undefined | null): Person | null {
    if (!userId) return null;
    const u = this.db.select({ id: users.id, name: users.name, callsign: users.callsign, licenseClass: users.licenseClass, active: users.active }).from(users).where(eq(users.id, userId)).get();
    if (!u || !u.active) return null;
    return { userId: u.id, name: u.name, callsign: u.callsign, licenseClass: isLicenseClass(u.licenseClass) ? u.licenseClass : null };
  }

  /** The person who last operated: their contacts carry their name, their license applies. */
  get holder(): Person | null {
    return this.person(this.state.get("holder")?.userId);
  }

  /** A control operator who took control: their privileges extend to whoever operates. */
  get controlOp(): Person | null {
    return this.person(this.state.get("control")?.userId);
  }

  get holderId(): string | null {
    return this.state.get("holder")?.userId ?? null;
  }

  /** Nobody would be cut off: no automatic run, no contact going, nothing on the air. */
  private radioIdle(): boolean {
    return this.auto === "off" && !(this.qso && isActive(this.qso)) && !this.transmitting && this.nextTxAt === null && !this.sstv.sending && !this.js8.sending;
  }

  /**
   * A signed-in user did something at the radio (called, tuned, armed, sent). The radio
   * becomes theirs while it is idle; in use by someone else, they have to ask for it.
   * Returns why not, or null.
   */
  noteOperator(userId: string): string | null {
    if (this.holderId === userId) return null;
    if (!this.person(userId)) return null;
    const booked = bookedOut(this.booking.holding, userId);
    if (booked) return booked;
    if (this.holderId && this.holder && !this.radioIdle()) {
      return `${this.holder.callsign ?? this.holder.name} has the radio: ask for it first`;
    }
    this.switchOperator(userId);
    return null;
  }

  /** Someone asked for the radio while it was in use: who, and until when the holder can answer. */
  radioRequest: { userId: string; name: string; callsign: string | null; at: number; until: number } | null = null;
  private requestTimer: NodeJS.Timeout | null = null;
  static readonly REQUEST_WAIT_MS = 30_000;

  /**
   * Ask for the radio. Idle (or nobody's), it is the asker's at once; in use, the holder
   * has 30 seconds to keep it, and no answer hands it over.
   */
  requestRadio(userId: string): { granted: boolean; error?: string } {
    if (this.holderId === userId) return { granted: true };
    const p = this.person(userId);
    if (!p) return { granted: false, error: "no such user" };
    const booked = bookedOut(this.booking.holding, userId);
    if (booked) return { granted: false, error: booked };
    if (!this.holderId || !this.holder || this.radioIdle()) {
      void this.handOver(userId, null);
      return { granted: true };
    }
    if (this.radioRequest && this.radioRequest.userId !== userId) {
      return { granted: false, error: `${this.radioRequest.callsign ?? this.radioRequest.name} asked first` };
    }
    if (!this.radioRequest) {
      const now = Date.now();
      this.radioRequest = { userId, name: p.name, callsign: p.callsign, at: now, until: now + Station.REQUEST_WAIT_MS };
      this.requestTimer = setTimeout(() => void this.handOver(userId, "no answer in 30 seconds"), Station.REQUEST_WAIT_MS);
      this.say("info", `${p.callsign ?? p.name} asked for the radio`);
      this.emit("radioRequest", { to: this.holderId, from: p });
      this.emit("state");
    }
    return { granted: false };
  }

  /** The holder's answer to a request: release it, or keep it. */
  answerRadioRequest(byUserId: string, release: boolean): string | null {
    const req = this.radioRequest;
    if (!req) return "nobody is asking for the radio";
    if (byUserId !== this.holderId) return "only the operator who has the radio can answer";
    if (release) {
      void this.handOver(req.userId, `${this.holder?.callsign ?? this.holder?.name ?? "the operator"} handed it over`);
      return null;
    }
    this.clearRequest();
    this.say("info", `${this.holder?.callsign ?? this.holder?.name} is keeping the radio; ${req.callsign ?? req.name} can ask again later`);
    this.emit("state");
    return null;
  }

  private clearRequest(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
    this.radioRequest = null;
  }

  /** Give the radio to someone: the holder's automatic stops and any contact ends first. */
  private async handOver(to: string, why: string | null): Promise<void> {
    this.clearRequest();
    if (this.holderId === to) return;
    const p = this.person(to);
    if (!p) return;
    const reason = `handed to ${p.callsign ?? p.name}${why ? ` (${why})` : ""}`;
    if (this.auto !== "off") await this.setAuto("off", reason);
    if (this.qso && isActive(this.qso)) this.haltQso(reason);
    this.switchOperator(to);
  }

  /**
   * The radio changes hands: the last operator's contact stays with them, and the new one
   * gets their own settings, keys, contest and last contact, their call on the air and
   * their logbook for dupes and needs.
   */
  private switchOperator(userId: string): void {
    const p = this.person(userId);
    if (!p) return;
    if (this.qso) this.state.set("lastQso", this.qso as unknown as Record<string, unknown>);
    this.clearRequest();
    this.state.set("holder", { userId, at: Date.now() });
    this.settings.actAs(userId);
    const last = this.state.get("lastQso") as QsoState | null | undefined;
    this.qso = last?.id && last.them && Array.isArray(last.transcript) ? (isActive(last) ? { ...last, phase: "abandoned", reason: "the radio changed hands" } : last) : null;
    this.keys.setContext({ hisCall: "", queueCall: "", exchange: "", profile: "unknown", serial: 1, serialOn: false, ...(this.state.get("keyContext") ?? {}) });
    this.keys.customFkeys = { ...(this.state.get("fkeys") ?? {}) };
    this.callers = [];
    this.candidates = [];
    this.neededSeen.clear();
    this.worked.invalidate();
    this.invalidateContest();
    this.cqParity = null;
    const me = this.me();
    this.say("info", me ? `${p.callsign ?? p.name} has the radio: on the air as ${me.call}` : `${p.name} has the radio, but their account has no callsign yet`);
    this.emit("operator", userId);
    this.emit("state");
  }

  // -------------------------------------------------------------------------
  // Radio time (bookings; @zerobeat/core/radio/bookings)
  // -------------------------------------------------------------------------

  /** Open Zerobeat pages per user, and when each user's last one closed. */
  private presence = new Map<string, { open: number; leftAt: number }>();
  /** The booking on now and the next, as last looked up; `holding` while its operator is signed in. */
  booking: { current: Booking | null; next: Booking | null; holding: Booking | null } = { current: null, next: null, holding: null };
  private bookingWarned: string | null = null;
  private bookingKey = "";

  /** A user opened (+1) or closed (-1) a Zerobeat page. */
  notePresence(userId: string, delta: 1 | -1): void {
    const p = this.presence.get(userId) ?? { open: 0, leftAt: 0 };
    p.open = Math.max(0, p.open + delta);
    if (p.open === 0) p.leftAt = Date.now();
    this.presence.set(userId, p);
    // Someone with the radio booked who just opened Zerobeat gets it now, not in 15 s.
    if (delta === 1) this.bookingTick();
  }

  /** Signed in: a Zerobeat page open, or one closed within the grace time. */
  isPresent(userId: string, now = Date.now()): boolean {
    const p = this.presence.get(userId);
    return !!p && (p.open > 0 || now - p.leftAt < PRESENT_GRACE_MS);
  }

  /** Apply the bookings: hand the radio to a signed-in booker, warn whoever is on it first. */
  bookingTick(now = Date.now()): void {
    let current: Booking | null = null;
    let next: Booking | null = null;
    try {
      current = bookingAt(this.db, now);
      next = nextBooking(this.db, now);
    } catch (e) {
      this.log.warn(`bookings: ${(e as Error).message}`);
      return;
    }
    const d = decideBooking({ now, holderId: this.holderId, current, next, present: (u) => this.isPresent(u, now), warned: this.bookingWarned });
    this.booking = { current, next, holding: d.holding };
    if (d.headsUp && this.holderId) {
      this.bookingWarned = d.headsUp.id;
      const who = d.headsUp.callsign ?? d.headsUp.name;
      this.say("info", `${who} has the radio booked from ${new Date(d.headsUp.startsAt).toISOString().slice(11, 16)}Z: it goes to them then`);
      this.emit("bookingSoon", { to: this.holderId, booking: d.headsUp });
    }
    if (d.handTo) {
      const b = d.holding!;
      void this.handOver(d.handTo, `booked until ${new Date(b.endsAt).toISOString().slice(11, 16)}Z`);
    }
    const key = JSON.stringify([current?.id, current?.endsAt, next?.id, next?.startsAt, d.holding?.id]);
    if (key !== this.bookingKey) {
      this.bookingKey = key;
      this.emit("state");
    }
  }

  /** Take (userId) or give up (null) control-operator duty. */
  setControlOp(userId: string | null, by: string): string | null {
    if (userId) {
      const p = this.person(userId);
      if (!p) return "no such user";
      this.state.set("control", { userId, at: Date.now() });
      this.say("info", `${p.callsign ?? p.name}${p.licenseClass ? ` (${LICENSE_NAMES[p.licenseClass]})` : ""} is the control operator`);
    } else {
      this.state.set("control", null);
      this.say("info", `control operator released by ${by}`);
    }
    this.emit("state");
    return null;
  }

  /** The class whose privileges apply: the higher of the operator's and the control operator's. */
  private licenseClass(): LicenseClass | null {
    return higherClass(this.holder?.licenseClass, this.controlOp?.licenseClass);
  }

  /** Where our signal would be, low and high edge in Hz, at this dial in the current mode. */
  private emissionSpan(dialHz = this.dialHz): [number, number] {
    const m = this.opMode;
    if (m === "SSTV") return [dialHz + 1100, dialHz + 2300];
    if (m === "WSPR") {
      const f0 = Math.max(1410, Math.min(1590, this.txOffsetHz));
      return [dialHz + f0 - 5, dialHz + f0 + 5];
    }
    const offs = [this.txOffsetHz, this.qso && isActive(this.qso) ? this.qso.txOffsetHz : this.txOffsetHz];
    return [dialHz + Math.min(...offs) - 100, dialHz + Math.max(...offs) + 100];
  }

  /** Why the license that applies does not cover a transmission here, or null. */
  private privilegeBlock(dialHz = this.dialHz): string | null {
    const cls = this.licenseClass();
    if (!cls) return null;
    const [lo, hi] = this.emissionSpan(dialHz);
    return privilegeProblem(cls, emissionKind(this.opMode), lo, hi);
  }

  /** Bands of the current mode the license that applies covers, for the band buttons. */
  private privilegeBands(): Record<string, boolean> | null {
    if (!this.licenseClass()) return null;
    const out: Record<string, boolean> = {};
    for (const band of this.bandsOf(this.opMode)) {
      const hz = this.bandFreq(this.opMode, band);
      if (hz) out[band] = !this.privilegeBlock(hz);
    }
    return out;
  }

  /** The dial a band button goes to: the operator's own frequency there, else the built-in one. */
  bandFreq(mode: OperatingMode, band: string): number | undefined {
    return this.state.get("myFreqs")?.[mode]?.[band] ?? CALLING_FREQS[mode][band];
  }

  /** The bands a mode has a frequency on, the operator's own included, low to high. */
  bandsOf(mode: OperatingMode): string[] {
    const mine = Object.keys(this.state.get("myFreqs")?.[mode] ?? {});
    const all = [...new Set([...bandsFor(mode), ...mine])];
    return all.sort((a, b) => (this.bandFreq(mode, a) ?? 0) - (this.bandFreq(mode, b) ?? 0));
  }

  /**
   * Keep the dial as the operator's own frequency for this mode on this band (the band
   * button goes there from now on), or with `reset`, go back to the built-in one. Only
   * the modes tuned freely: FT8 and the like are identified by their dial frequency.
   */
  saveBandFreq(reset: boolean): string | null {
    const mode = this.opMode;
    if (!FREE_TUNING.includes(mode)) return `${mode} uses fixed frequencies; tune anywhere with the dial instead`;
    const band = this.band;
    if (!band) return "the dial is out of band";
    const all = { ...(this.state.get("myFreqs") ?? {}) };
    const mine = { ...(all[mode] ?? {}) };
    if (reset || this.dialHz === CALLING_FREQS[mode][band]) delete mine[band];
    else mine[band] = this.dialHz;
    all[mode] = mine;
    this.state.set("myFreqs", all);
    this.say("state", reset ? `${band} ${mode}: back to the built-in frequency` : `${band} ${mode}: ${(this.dialHz / 1e6).toFixed(4)} MHz saved as your frequency`);
    this.emit("state");
    return null;
  }

  /** The operator record for a contact logged now. */
  private operatorId(stationId: string, stationCall: string): string | null {
    const uid = this.state.get("holder")?.userId;
    return uid ? operatorForUser(this.db, stationId, uid, stationCall) : null;
  }

  /** Why a transmission would be refused right now, or null. */
  txBlocked(auto: boolean, now = Date.now()): string | null {
    const s = this.settings.snapshot();
    if (this.ft0) return "FT-0 is engaged";
    if (!s["radio.allowTransmit"]) return "transmit is off (the TX switch at the top of the page)";
    if (!this.radio) return "the radio is not connected";
    if (this.radio.txProblem) return this.radio.txProblem;
    if (!this.me()) return this.holderId ? "your account has no callsign yet (Account)" : "no station is set up";
    const priv = this.privilegeBlock();
    if (priv) return this.controlOp ? priv : `${priv}; a control operator with the privileges can take control`;
    if (this.guards.state.paused?.cause === "fault") return this.guards.state.paused.reason;
    if (auto) {
      const g = this.guards.checkAuto(now);
      if (g) return g;
      if (this.pa.resting(now)) return "PA resting";
      if (s["schedule.enabled"] && s["schedule.sleep"]) {
        const d = decideSchedule({ blocks: "", sleep: s["schedule.sleep"], paResting: false }, new Date(now));
        if (d.why.startsWith("quiet hours")) return `quiet hours ${s["schedule.sleep"]}`;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------

  private onWindow(w: WindowResult): void {
    const now = Date.now();
    this.lastWindow = { index: w.index, decodes: w.decodes.length, decodeMs: w.decodeMs, skipped: w.skipped, at: now };
    if (w.mode !== this.mode) return;
    if (!w.ownTx && !w.skipped) this.guards.onRxWindow(w.decodes.length, w.rms, now);

    const me = this.me();
    const band = this.band;
    this.recent.push(...w.decodes);
    if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
    if (band) {
      const s = this.settings.snapshot();
      for (const d of w.decodes) {
        this.decodeBuffer.push({
          at: w.start,
          mode: w.mode,
          band,
          dialHz: this.dialHz,
          audioHz: d.offsetHz,
          snr: d.snr,
          dtMs: Math.round(d.dt * 1000),
          message: d.text.slice(0, 64),
          callsign: d.sender,
          grid: d.parsed.find((p): p is Extract<Parsed, { kind: "cq" }> => p.kind === "cq")?.grid ?? null,
          isCq: d.parsed.some((p) => p.kind === "cq"),
        });
        if (s["pskreporter.enabled"] && d.sender && d.sender !== me?.call && !d.ap) {
          const cq = d.parsed.find((p): p is Extract<Parsed, { kind: "cq" }> => p.kind === "cq");
          const grid = cq?.grid ?? null;
          this.psk.add({ callsign: d.sender, freqHz: this.dialHz + d.offsetHz, snr: d.snr, mode: w.mode, grid, at: w.start }, band);
        }
      }
    }
    this.emit("decodes", w);
    if (band && !w.ownTx && !w.skipped) {
      this.memory.add(w.start, band, w.mode, w.decodes.filter((d) => !d.ap && d.sender !== me?.call));
      if (me) this.detectNeeded(w, band, me.call);
    }

    if (me) {
      // Stations calling us.
      for (const d of w.decodes) {
        for (const p of d.parsed) {
          if (p.kind === "directed" && p.to === me.call && p.from !== this.qso?.them && (p.payload.kind === "grid" || p.payload.kind === "report" || p.payload.kind === "none")) {
            this.callers = this.callers.filter((c) => c.callsign !== p.from);
            this.callers.push({ callsign: p.from, snr: d.snr, offsetHz: d.offsetHz, text: d.text, windowIndex: w.index, at: w.start });
          }
        }
      }
      this.callers = this.callers.filter((c) => now - c.at < CALLER_TTL_MS).slice(-10);

      if (this.qso && isActive(this.qso) && !w.ownTx && parity(w.index) !== this.qso.ourParity) {
        const rx: RxDecode[] = w.decodes.flatMap((d) => d.parsed.map((p) => ({ parsed: p, text: d.text, snr: d.snr, offsetHz: d.offsetHz, at: w.start })));
        const r = receive(this.qso, rx, w.start);
        this.qso = r.state;
        this.handleEvents(r.events);
      }
      if (this.auto !== "off") this.autoStep(w, me);
      this.planNextTx(w.index + 1);
    }
    this.emit("state");
  }

  /** Alert on a CQ from a station that would be new, at the level the operator chose. */
  /** A DX cluster or RBN spot: alert when it is a station the log needs, on any band. */
  spotNeeded(spot: { call: string; freqHz: number; mode: string | null; snr: number | null; grid: string | null; spotter: string; comment: string }): void {
    const level = this.settings.get("alerts.needed");
    if (level === "off" || !this.settings.get("spots.alertNeeded")) return;
    const me = this.me();
    const band = bandName(spot.freqHz);
    if (!band || !me || spot.call === me.call) return;
    const key = `${spot.call}|${band}`;
    const now = Date.now();
    if (this.neededSeen.has(key) && now - this.neededSeen.get(key)! < NEEDED_REPEAT_MS) return;
    const want = new Set(level === "dxcc" ? ["dxcc"] : level === "award" ? ["dxcc", "zone", "continent", "park"] : ["dxcc", "zone", "continent", "park", "band"]);
    const sc = score({ callsign: spot.call, grid: spot.grid, snr: spot.snr ?? -10, park: null, potaCq: false }, this.worked.worked(band));
    const hits = sc.kinds.map((k, i) => ({ k, why: sc.reasons[i]! })).filter((x) => want.has(x.k));
    if (!hits.length) return;
    this.neededSeen.set(key, now);
    const alert: NeededAlert = {
      callsign: spot.call,
      band,
      mode: spot.mode ?? "spot",
      spotHz: spot.freqHz,
      snr: spot.snr ?? 0,
      offsetHz: 0,
      windowIndex: -1,
      text: `spotted by ${spot.spotter}${spot.comment ? `: ${spot.comment}` : ""}`,
      grid: spot.grid,
      reasons: hits.map((h) => h.why),
      headline: hits[0]!.why.replace(/^new /, "New ").replace(/^(\w)/, (c) => c.toUpperCase()),
      at: now,
    };
    this.say("state", `${alert.headline}: ${spot.call} spotted on ${band}${spot.mode ? ` ${spot.mode}` : ""} by ${spot.spotter}`);
    this.emit("needed", alert);
  }

  /**
   * Go to a spot. A channelised mode (FT8, JTTY…) goes to that band's calling frequency;
   * RTTY, PSK31 and CW tune so the signal lands on the marker; anything else just tunes.
   */
  async tuneToSpot(freqHz: number, mode: string | null): Promise<string | null> {
    const band = bandName(freqHz);
    if (!band) return "that spot is outside the amateur bands";
    const m = (mode ?? "").toUpperCase();
    if (m === "FT8" || m === "FT4" || m === "FT2" || m === "JTTY") {
      // A spot on the calling frequency goes there; one elsewhere (a Fox on 14.090) is
      // tuned exactly, in the spot's mode. Dial = spot minus our audio offset.
      const call = CALLING_FREQS[m][band];
      if (call && Math.abs(freqHz - call) <= 3_000) return this.tuneBand(band, m);
      await this.tuneBand(band, m);
      await this.tuneHz(Math.round(freqHz - Math.min(this.txOffsetHz, 1_000)), m);
      return null;
    }
    if (m === "RTTY" || m === "PSK31" || m === "CW" || m === "HELL") {
      // Hell has frequencies on three bands only; elsewhere just switch to it and tune.
      if (this.keyMode !== m) {
        if (this.bandFreq(m, band)) await this.tuneBand(band, m);
        else this.enterKeyboard(m);
      }
      await this.tuneHz(Math.round(freqHz - this.txOffsetHz));
      return null;
    }
    // A spot with no mode we know: tune there and stay in the mode we are in, rather
    // than switching to whichever mode has a calling frequency nearby.
    await this.tuneHz(Math.round(freqHz - (this.opMode === "CW" ? this.txOffsetHz : 0)), this.opMode);
    return null;
  }

  private detectNeeded(w: WindowResult, band: string, myCall: string): void {
    const level = this.settings.get("alerts.needed");
    if (level === "off") return;
    const want = new Set(level === "dxcc" ? ["dxcc"] : level === "award" ? ["dxcc", "zone", "continent", "park"] : ["dxcc", "zone", "continent", "park", "band"]);
    const idx = this.worked.worked(band);
    const spots = potaSpotsCached();
    const now = Date.now();
    for (const [k, t] of this.neededSeen) if (now - t > NEEDED_REPEAT_MS) this.neededSeen.delete(k);
    for (const d of w.decodes) {
      const cq = d.parsed.find((p): p is Extract<Parsed, { kind: "cq" }> => p.kind === "cq");
      if (!cq || !d.sender || d.sender === myCall || d.ap) continue;
      const key = `${d.sender}|${band}`;
      if (this.neededSeen.has(key)) continue;
      const park = spots.find((sp) => sp.activator === d.sender && bandName(sp.freqHz) === band)?.reference ?? null;
      const sc = score({ callsign: d.sender, grid: cq.grid, snr: d.snr, park, potaCq: cq.modifier === "POTA" }, idx);
      const hits = sc.kinds.map((k, i) => ({ k, why: sc.reasons[i]! })).filter((x) => want.has(x.k));
      if (!hits.length) continue;
      this.neededSeen.set(key, now);
      const alert: NeededAlert = {
        callsign: d.sender,
        band,
        mode: w.mode,
        snr: d.snr,
        offsetHz: d.offsetHz,
        windowIndex: w.index,
        text: d.text,
        grid: cq.grid,
        reasons: hits.map((h) => h.why),
        headline: hits[0]!.why.replace(/^new /, "New ").replace(/^(\w)/, (c) => c.toUpperCase()),
        at: now,
      };
      this.say("state", `${alert.headline}: ${d.sender} calling CQ on ${band} (${d.snr} dB)`);
      this.emit("needed", alert);
    }
  }

  private fault(reason: string): void {
    this.runs.fault(reason);
    this.emit("fault", reason);
  }

  private onTelemetry(t: Telemetry): void {
    const keyed = this.radio?.isKeyed ?? false;
    const before = this.guards.state.paused;
    this.guards.onTelemetry(t, keyed, Date.now());
    const after = this.guards.state.paused;
    if (after && after !== before && after.cause === "fault") {
      this.say("warn", `transmit stopped: ${after.reason}`);
      this.fault(after.reason);
      void this.radio?.unkey();
      if (/SWR/.test(after.reason) && this.auto !== "off" && this.settings.get("hop.enabled")) {
        // Hop once to re-measure on another band. A second SWR fault within ten minutes
        // means the antenna, not the band: stop, and keep the fault until someone re-arms.
        const now = Date.now();
        this.swrFaults = this.swrFaults.filter((t) => now - t < 10 * 60_000);
        this.swrFaults.push(now);
        if (this.swrFaults.length >= 2) {
          this.say("warn", "SWR fault on a second band; automatic operating stopped");
          void this.setAuto("off", "SWR fault on two bands");
        } else void this.hop("SWR fault");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  private handleEvents(events: QsoEvent[]): void {
    for (const e of events) {
      if (e.type === "log") this.logQso(e.qso);
      else if (e.type === "abandon") {
        this.say("info", `stopped working ${e.qso.them}: ${e.reason}`);
        if (e.qso.origin !== "manual") this.worked.recordFailure(e.qso.them, this.settings.get("auto.failureCooldownMin") * 60_000);
        if (e.incomplete) this.recordIncomplete(e.qso, e.reason);
      } else if (e.type === "done") {
        this.say("info", `finished with ${e.qso.them}`);
      }
    }
  }

  private logQso(q: QsoState): void {
    const me = this.me();
    const band = this.band;
    if (!me || !band) return;
    const s = this.settings.snapshot();
    // What this contact is new for, judged against the log BEFORE it is added.
    const sc = score({ callsign: q.them, grid: q.theirGrid, snr: q.reportSent, park: q.sigInfo, potaCq: false }, this.worked.worked(band));
    const LABEL: Partial<Record<string, NewOne["kind"]>> = { dxcc: "dxcc", band: "band", zone: "zone", continent: "continent", park: "park", grid: "grid" };
    const newOnes: NewOne[] = sc.kinds.flatMap((k, i) => (LABEL[k] ? [{ kind: LABEL[k]!, label: sc.reasons[i]!, callsign: q.them }] : []));
    try {
      const { qso } = createQso(
        this.db,
        {
          stationId: me.stationId,
          operatorId: this.operatorId(me.stationId, me.call),
          callsign: q.them,
          band,
          freqHz: this.dialHz + q.txOffsetHz,
          mode: q.mode,
          startTime: q.startedAt,
          endTime: Date.now(),
          rstSent: q.contest === "rtty-roundup" ? rstFromSnr(q.reportSent) : q.contest === "none" ? formatReport(q.reportSent) : null,
          rstRcvd: q.contest === "rtty-roundup" ? (q.theirExch?.split(" ")[0] ?? null) : q.reportRcvd !== null ? formatReport(q.reportRcvd) : null,
          grid: q.theirGrid,
          myGrid: null,
          radio: this.radio?.info.model ?? null,
          txPowerW: this.qsoPeakW > 0 ? Math.round(this.qsoPeakW) : null,
          extras: this.contestFields(q) ? JSON.stringify(this.contestFields(q)) : null,
          transcript: transcriptText(q),
          sigRefs: q.sig && q.sigInfo ? [{ sig: q.sig, ref: q.sigInfo }] : [],
          notes: null,
        },
        { uploadServices: enabledUploadServices(s) },
      );
      this.say("log", `logged ${q.them} ${band} ${q.mode} sent ${formatReport(q.reportSent)} rcvd ${q.reportRcvd !== null ? formatReport(q.reportRcvd) : "—"}`);
      this.linkDecodes(qso.id, q.them, q.startedAt, Date.now());
      this.runs.qso(band, newOnes);
      if (newOnes.some((n) => n.kind === "dxcc")) this.say("log", `${newOnes.find((n) => n.kind === "dxcc")!.label} — first contact with ${q.them}'s entity`);
      this.guards.onQsoLogged();
      this.worked.invalidate();
      // The Roundup serial moves on with each contact.
      if (q.contest === "rtty-roundup" && /^\d{4}$/.test(q.myExch)) this.setContest({ serial: this.contest.serial + 1 }, true);
      this.emit("logged", qso.id);
    } catch (e) {
      this.say("warn", `could not log ${q.them}: ${(e as Error).message}`);
    }
  }

  private recordIncomplete(q: QsoState, reason: string): void {
    const me = this.me();
    const band = this.band;
    if (!me || !band) return;
    this.db
      .insert(incompleteExchanges)
      .values({
        id: newId(),
        stationId: me.stationId,
        callsign: q.them,
        band,
        freqHz: this.dialHz + q.txOffsetHz,
        mode: q.mode,
        startTime: q.startedAt,
        rstSent: formatReport(q.reportSent),
        rstRcvd: q.reportRcvd !== null ? formatReport(q.reportRcvd) : null,
        grid: q.theirGrid,
        transcript: transcriptText(q),
        reason,
      })
      .run();
  }

  private clearOffset(ourParity: 0 | 1, minHz = 400): number {
    const busy = this.recent.filter((d) => parity(d.windowIndex) === ourParity && Date.now() - d.at < 60_000).map((d) => d.offsetHz);
    const preferred = this.txOffsetHz >= minHz ? this.txOffsetHz : minHz + Math.floor(Math.random() * (2600 - minHz));
    if (!busy.some((f) => Math.abs(f - preferred) < 60)) return preferred;
    let best = preferred;
    let bestGap = -1;
    for (let f = minHz; f <= 2600; f += 25) {
      const gap = Math.min(...busy.map((b) => Math.abs(b - f)), 9999);
      if (gap > bestGap + 1 || (Math.abs(gap - bestGap) <= 1 && Math.abs(f - preferred) < Math.abs(best - preferred))) {
        best = f;
        bestGap = gap;
      }
    }
    return best;
  }

  /** Someone else on our CQ frequency in our own slot lately, and where to go instead. */
  private cqSpot(ourParity: 0 | 1): ReturnType<typeof cqClearSpot> {
    const mode = this.mode;
    const since = Date.now() - 8 * TIMING[mode].periodMs;
    const myCall = this.me()?.call;
    const heard = this.recent.filter((d) => d.mode === mode && parity(d.windowIndex) === ourParity && d.at >= since && d.sender !== myCall);
    return cqClearSpot(heard, this.txOffsetHz, mode);
  }

  /** Call a station (from a decode the operator clicked, or the auto operator). */
  callStation(opts: { callsign: string; grid: string | null; snr: number; offsetHz: number; windowIndex: number; origin: QsoState["origin"]; park?: string | null; replyTo?: Decode | null }): string | null {
    const me = this.me();
    if (!me) return "no station is set up";
    if (this.keyMode || this.sstvOn || this.wsprOn || this.js8On) return `${this.opMode} is on; switch to FT8, FT4 or FT2 to call from the decode list`;
    const cp = this.contestProblem();
    if (cp) return cp;
    if (opts.origin === "manual") {
      const blocked = this.txBlocked(false);
      if (blocked) return `cannot call ${opts.callsign}: ${blocked}`;
    }
    // Clicking the station we are already working (a double-click, or one of its later
    // messages) keeps the contact going; only a different station replaces it.
    if (opts.origin === "manual" && this.qso && isActive(this.qso) && this.qso.them === opts.callsign.toUpperCase()) return null;
    if (this.qso && isActive(this.qso)) {
      if (opts.origin !== "manual") return `already working ${this.qso.them}`;
      const r = abandon(this.qso, `operator switched to ${opts.callsign}`);
      this.qso = r.state;
      this.handleEvents(r.events);
    }
    // A station clicked in the decode list, or answered, that is spotted at a park on this
    // band: log the park (hunters were losing park credit on every manual contact).
    if (opts.park === undefined) opts = { ...opts, park: this.parkFor(opts.callsign) };
    const theirParity = parity(opts.windowIndex);
    // A DXpedition Fox sends "HOUND1 RR73; HOUND2 <FOX> -12": seeing that, or the Hound
    // switch on, means we call as a Hound (above 1000 Hz, WSJT-X's rule).
    const hound = this.houndMode || this.isFox(opts.callsign);
    const params = {
      id: newId(),
      me: me.call,
      myGrid4: me.grid4,
      them: opts.callsign,
      theirGrid: opts.grid,
      theirSnr: opts.snr,
      theirOffsetHz: opts.offsetHz,
      theirParity,
      mode: this.mode,
      txOffsetHz: this.clearOffset((1 - theirParity) as 0 | 1, hound ? 1000 : 400),
      now: Date.now(),
      maxRepeats: this.settings.get("auto.maxRepeats"),
      origin: opts.origin,
      sig: opts.park ? "POTA" : null,
      sigInfo: opts.park ?? null,
      hound,
      contest: this.contest.id,
      myExch: this.contestExchange(),
    };
    this.qsoPeakW = 0;
    if (opts.replyTo) {
      const first = opts.replyTo.parsed.find((p) => p.kind === "directed") ?? opts.replyTo.parsed[0]!;
      const r = startAnswer(params, { parsed: first, text: opts.replyTo.text, snr: opts.replyTo.snr, offsetHz: opts.replyTo.offsetHz, at: opts.replyTo.at });
      this.qso = r.state;
      this.handleEvents(r.events);
    } else {
      this.qso = startCall(params);
    }
    this.callers = this.callers.filter((c) => c.callsign !== opts.callsign);
    if (opts.origin === "manual") {
      // A click gets the generous late start, so it goes out in the very next slot.
      const late = TIMING[this.mode].manualLateMs;
      const idx = nextTxWindow(Date.now(), this.mode, this.qso.ourParity, late);
      const at = txStartAt(idx, this.mode);
      const wait = at - Date.now();
      this.say("info", `${opts.replyTo ? "answering" : "calling"} ${opts.callsign}${opts.park ? ` at ${opts.park}` : ""} ${wait <= 0 ? "now" : `at ${new Date(at).toISOString().slice(11, 19)}Z`} (${parityName(this.qso.ourParity)} slot)`);
      this.planNextTx(idx, late);
    } else {
      this.say("info", `${opts.replyTo ? "answering" : "calling"} ${opts.callsign}${opts.park ? ` at ${opts.park}` : ""}`);
    }
    this.emit("state");
    return null;
  }

  /** The contest the station is working, if any. */
  get contest(): { id: Contest; exchange: string; serial: number; since: number; fdPower: 1 | 2 | 5 } {
    const c = this.state.get("contest") ?? { id: "none", exchange: "", serial: 1 };
    return { since: 0, fdPower: 2, ...c };
  }

  /**
   * Change the contest. A new contest starts its log now (or at `since`), and its serial
   * follows on from the last one sent in that log. `quiet`: the serial moving on after a
   * contact, which needs no activity line.
   */
  setContest(patch: Partial<{ id: Contest; exchange: string; serial: number; since: number; fdPower: 1 | 2 | 5 }>, quiet = false): void {
    const prev = this.contest;
    const c = { ...prev, ...patch };
    c.exchange = c.exchange.trim().toUpperCase().slice(0, 12);
    if (patch.id !== undefined && patch.id !== prev.id) c.since = patch.since ?? Date.now();
    this.state.set("contest", c);
    this.invalidateContest();
    if ((patch.id !== undefined && patch.id !== prev.id) || patch.since !== undefined) {
      // Pick up the serial where this contest's log left it.
      const last = this.contestSummary()?.lastSerialSent ?? 0;
      if (patch.serial === undefined) c.serial = last + 1;
    }
    c.serial = Math.max(1, Math.min(9999, Math.round(c.serial)));
    this.state.set("contest", c);
    // Every sponsor requires a person to start each contact: no hunting by itself.
    if (c.id !== "none" && (this.auto === "hunt" || this.auto === "hunt-pota" || this.auto === "pota-chase")) {
      void this.setAuto("off", "contest: a person must start each contact");
    }
    // The keyboard desk sends the same exchange and serial; with no contest it sends none
    // (it used to keep the last contest's Field Day exchange on every ragchew).
    if (c.id !== "none") {
      const kp = c.id === "field-day" || c.id === "rtty-roundup" ? c.id : "unknown";
      const me = this.me();
      const kx = c.id === "field-day" ? c.exchange : c.id === "rtty-roundup" ? (c.exchange === "DX" || c.exchange === "#" ? "" : c.exchange) : (me?.grid4 ?? "");
      this.setKeyContext({ profile: kp, exchange: kx, serial: c.serial, serialOn: !kx });
    } else if (prev.id !== "none" || this.keys.ctx.profile !== "unknown" || this.keys.ctx.exchange) {
      this.setKeyContext({ profile: "unknown", exchange: "", serialOn: false });
    }
    if (!quiet) this.say("state", c.id === "none" ? "contest off" : `contest: ${CONTESTS[c.id].name}, sending ${this.contestExchange() || "your grid"}${this.contestUsesSerial() ? `, serial ${c.serial}` : ""}`);
    this.emit("state");
  }

  /** Whether what we send carries the serial (Roundup from DX, or a keyboard exchange left blank). */
  private contestUsesSerial(): boolean {
    const c = this.contest;
    return c.id === "rtty-roundup" && (!c.exchange || c.exchange === "DX" || c.exchange === "#");
  }

  private contestCache: { key: string; at: number; summary: ContestSummary } | null = null;

  invalidateContest(): void {
    this.contestCache = null;
  }

  /** The contest log so far: points, multipliers, score, rate; null with no contest. */
  contestSummary(): ContestSummary | null {
    const c = this.contest;
    if (c.id === "none") return null;
    const key = `${c.id}|${c.since}|${c.fdPower}`;
    const now = Date.now();
    if (this.contestCache && this.contestCache.key === key && now - this.contestCache.at < 30_000) return this.contestCache.summary;
    const def = CONTESTS[c.id];
    const rows = this.db
      .select({ callsign: qsosTable.callsign, band: qsosTable.band, mode: qsosTable.mode, submode: qsosTable.submode, startTime: qsosTable.startTime, grid: qsosTable.grid, dxcc: qsosTable.dxcc, state: qsosTable.state, extras: qsosTable.extras })
      .from(qsosTable)
      .where(and(eq(qsosTable.stationId, this.me()?.stationId ?? ""), gte(qsosTable.startTime, c.since), like(qsosTable.extras, `%"CONTEST_ID":"${def.cabrillo}"%`)))
      .all();
    const summary = summarize(c.id, rows, { myGrid: this.me()?.grid4 ?? "", fdPowerMult: c.fdPower, now });
    this.contestCache = { key, at: now, summary };
    return summary;
  }

  /** The station being worked now: the FT contact, or the keyboard desk's call. */
  private contestCurrentCall(): string | null {
    if (this.qso && isActive(this.qso)) return this.qso.them;
    return this.keyMode && this.keys.ctx.hisCall ? this.keys.ctx.hisCall : null;
  }

  /** The contest numbers the page shows. */
  private contestDesk() {
    const s = this.contestSummary();
    const c = this.contest;
    if (!s || c.id === "none") return null;
    const def = CONTESTS[c.id];
    return {
      name: def.name,
      note: def.note ?? null,
      since: c.since,
      qsos: s.qsos,
      dupes: s.dupes,
      points: s.points,
      mults: s.mults,
      multsPer: def.multsPer,
      score: s.score,
      rate10: s.rate10,
      rate60: s.rate60,
      byBand: s.byBand,
      serial: c.serial,
      usesSerial: this.contestUsesSerial() || (this.keyMode && !this.keys.ctx.exchange),
      fdPower: c.fdPower,
      cabrillo: def.cabrillo,
      currentCall: this.contestCurrentCall(),
      current: (() => {
        const call = this.contestCurrentCall();
        return call && this.band ? this.contestCheck({ callsign: call, band: this.band, grid: this.qso && isActive(this.qso) ? this.qso.theirGrid : null }) : null;
      })(),
    };
  }

  /** Save the operator's function keys for a keyboard mode (null: back to the defaults). */
  setFkeys(mode: KeyMode, keys: string[] | null): string | null {
    const err = this.keys.setFkeys(mode, keys);
    if (err) return err;
    this.state.set("fkeys", { ...this.keys.customFkeys });
    this.say("state", keys ? `${mode} function keys saved` : `${mode} function keys back to the defaults`);
    return null;
  }

  /** Is this station a dupe here, and what would it add? For the desk's check box and the decode list. */
  contestCheck(x: { callsign: string; band?: string | null; mode?: string; grid?: string | null; exchange?: string; dxcc?: number | null }) {
    const c = this.contest;
    const s = this.contestSummary();
    if (c.id === "none" || !s) return null;
    return checkStation(c.id, s, { callsign: x.callsign, band: x.band ?? this.band ?? "", mode: x.mode ?? this.opMode, grid: x.grid ?? null, exchange: x.exchange, dxcc: x.dxcc ?? getDxcc().resolve(x.callsign)?.adif ?? null });
  }

  /** The dupe sheet: every contact in the contest log, newest first, and the multipliers. */
  contestSheet() {
    const c = this.contest;
    const s = this.contestSummary();
    if (c.id === "none" || !s) return null;
    return {
      id: c.id,
      rows: [...s.rows].reverse().slice(0, 3000).map((r) => ({ call: r.callsign, band: r.band, group: r.modeGroup, at: r.startTime, points: r.points, mults: r.mults, dupe: r.dupe, invalid: r.invalid, exchange: r.exchange })),
      multList: s.multList,
      missing: c.id === "rtty-roundup" ? roundupMissing(s.multList) : [],
    };
  }

  /**
   * What we send as the exchange: Field Day class and section; in the RTTY Roundup a
   * state or province, or the serial (four digits) for DX or "#", as WSJT-X does.
   */
  private contestExchange(): string {
    const c = this.contest;
    if (c.id === "field-day") return c.exchange;
    if (c.id === "rtty-roundup") return !c.exchange || c.exchange === "DX" || c.exchange === "#" ? String(c.serial).padStart(4, "0") : c.exchange;
    return "";
  }

  /** Why the contest setup cannot be sent yet, or null. */
  contestProblem(): string | null {
    const c = this.contest;
    if (c.id === "field-day" && !/^\d{1,2}[A-F] [A-Z]{2,3}$/.test(c.exchange)) return "set your Field Day exchange first: class and section, like 1D WI";
    if (c.id === "rtty-roundup" && c.exchange && c.exchange !== "DX" && c.exchange !== "#" && !/^[A-Z]{2,3}$/.test(c.exchange)) return "the Roundup exchange is a state or province (WI, ON), or blank for a serial";
    return null;
  }

  /** ADIF contest fields for a logged contest contact. */
  private contestFields(q: QsoState): Record<string, string> | null {
    if (q.contest === "none") return null;
    const id = { "ww-digi": "WW-DIGI", "arrl-digi": "ARRL-DIGI", "field-day": "ARRL-FD", "rtty-roundup": "ARRL-RTTY" }[q.contest];
    const f: Record<string, string> = { CONTEST_ID: id };
    const sent = q.contest.endsWith("digi") ? q.myGrid4 : q.myExch;
    if (sent) f.STX_STRING = sent;
    if (q.theirExch) f.SRX_STRING = q.theirExch;
    const theirs = (q.theirExch ?? "").split(" ");
    if (q.contest === "field-day" && theirs.length === 2) {
      f.CLASS = theirs[0]!;
      f.ARRL_SECT = theirs[1]!;
    }
    if (q.contest === "rtty-roundup" && theirs.length === 2) {
      if (/^\d{4}$/.test(theirs[1]!)) f.SRX = String(Number(theirs[1]));
      else f.STATE = theirs[1]!;
    }
    return f;
  }

  /**
   * ADIF contest fields for a keyboard-mode contact (RTTY Roundup, Field Day on CW or
   * RTTY), from the desk's exchange profile or the station's contest. Without these the
   * contact never reached the Cabrillo export, which selects on CONTEST_ID.
   */
  private keyboardContestFields(input: { rstRcvd: string; exchSent: string; exchRcvd: string }): Record<string, string> | null {
    const profile = this.keys.ctx.profile;
    const active = this.contest.id;
    if (active === "ww-digi" || active === "arrl-digi") {
      // The Digi contests exchange 4-character grids.
      const me = this.me();
      const f: Record<string, string> = { CONTEST_ID: CONTESTS[active].cabrillo };
      if (me) f.STX_STRING = me.grid4;
      const g = input.exchRcvd.trim().toUpperCase().split(/\s+/).find((t) => /^[A-R]{2}\d{2}/.test(t));
      if (g) f.SRX_STRING = g.slice(0, 4);
      return f;
    }
    const contest = active === "field-day" || active === "rtty-roundup" ? active : profile === "field-day" || profile === "rtty-roundup" ? profile : null;
    if (!contest) return null;
    const f: Record<string, string> = { CONTEST_ID: contest === "field-day" ? "ARRL-FD" : "ARRL-RTTY" };
    const sent = input.exchSent.trim().toUpperCase();
    const rcvd = input.exchRcvd.trim().toUpperCase();
    if (sent) f.STX_STRING = sent;
    if (contest === "field-day") {
      if (rcvd) f.SRX_STRING = rcvd;
      const [cls, sect] = rcvd.split(/\s+/);
      if (cls && sect) {
        f.CLASS = cls;
        f.ARRL_SECT = sect;
      }
      return f;
    }
    // The Roundup's received exchange is RST plus a state, province or serial; the
    // Cabrillo writer reads it as "RST EXCH".
    const exch = rcvd.split(/\s+/).at(-1) ?? "";
    if (rcvd) f.SRX_STRING = `${input.rstRcvd || "599"} ${exch}`;
    if (/^\d+$/.test(exch)) f.SRX = String(Number(exch));
    else if (exch) f.STATE = exch;
    if (/^\d+$/.test(sent)) f.STX = String(Number(sent));
    return f;
  }

  /** Hound (FT8 DXpedition mode) for every call, not only to stations seen working as a Fox. */
  get houndMode(): boolean {
    return !!this.state.get("houndMode");
  }

  setHoundMode(on: boolean): void {
    this.state.set("houndMode", on);
    this.say("state", on ? "Hound mode on: calls go out above 1000 Hz and follow the Fox's rules" : "Hound mode off");
    this.emit("state");
  }

  /** Has this station been heard sending a Fox's two-station messages lately? */
  private isFox(call: string): boolean {
    const c = call.toUpperCase();
    // Fox messages work two stations at once: "K1ABC RR73; W9XYZ <FOX> -08". Contest
    // "TU; K1ABC W9XYZ R 579 MA" messages also contain a semicolon and are not a Fox.
    return this.recent.some((d) => d.sender === c && isFoxMessage(d.text) && Date.now() - d.at < 10 * 60_000);
  }

  /**
   * Which slot to transmit in while hunting: an answer goes out in the slot opposite the
   * CQ, so only stations calling in the other slot are called. null: either.
   */
  setHuntSlot(p: 0 | 1 | null): void {
    this.state.set("huntSlot", p);
    this.say("state", p === null ? "hunting in either slot" : `hunting to transmit in the ${parityName(p)} slot`);
    this.emit("state");
  }

  /** Which slot to call CQ in. Takes effect at once if CQ is running, and is remembered. */
  setCqSlot(p: 0 | 1): void {
    this.state.set("cqSlot", p);
    if (this.auto === "cq") this.cqParity = p;
    this.say("state", `CQ in the ${parityName(p)} slot`);
    this.emit("state");
  }

  haltQso(reason = "operator halted"): void {
    this.keyTxSeq++; // a keyboard-mode message waiting to key is cancelled too
    this.sstvTxSeq++;
    if (this.qso && isActive(this.qso)) {
      const r = abandon(this.qso, reason);
      this.qso = r.state;
      this.handleEvents(r.events);
    }
    void this.radio?.unkey();
    this.emit("state");
  }

  // -------------------------------------------------------------------------
  // Transmit
  // -------------------------------------------------------------------------

  private planNextTx(index: number, lateLimitMs?: number): void {
    if (this.plannedTx.has(index)) return;
    let message: string | null = null;
    let auto = false;
    let isCq = false;
    if (this.qso && isActive(this.qso) && parity(index) === this.qso.ourParity) {
      const n = nextMessage(this.qso);
      this.qso = n.state;
      this.handleEvents(n.events);
      message = n.message;
      auto = this.qso.origin !== "manual";
    } else if (this.auto === "cq" && !(this.qso && isActive(this.qso)) && this.cqParity !== null && parity(index) === this.cqParity) {
      const me = this.me();
      if (me) {
        const mod = CONTEST_CQ[this.contest.id];
        // A compound own call packs only as "CQ CALL" (no grid, no modifier); anything
        // longer degrades to truncated free text on the air.
        message = !isStandardCall(me.call) ? `CQ ${me.call}` : mod ? `CQ ${mod} ${me.call} ${me.grid4}` : `CQ ${me.call} ${me.grid4}`;
        auto = true;
        isCq = true;
        if (this.settings.get("auto.cqClearSpot")) {
          // A station sharing our slot is never heard while we transmit: while no one
          // answers, every fourth unanswered CQ is a window spent listening instead.
          const unanswered = this.guards.state.unansweredCqs;
          if (unanswered > 0 && unanswered % 4 === 0 && this.cqListenedAt !== unanswered) {
            this.cqListenedAt = unanswered;
            return;
          }
          if (unanswered === 0) this.cqListenedAt = 0;
          const spot = Date.now() - this.cqMovedAt > 2 * TIMING[this.mode].periodMs ? this.cqSpot(this.cqParity) : null;
          if (spot) {
            const was = this.txOffsetHz;
            this.setTxOffset(spot.hz);
            this.cqMovedAt = Date.now();
            this.say("info", `CQ moved from ${was} to ${this.txOffsetHz} Hz: ${spot.call} is on ${spot.theirHz} Hz in our slot`);
          }
        }
      }
    }
    if (!message) return;
    const blocked = this.txBlocked(auto);
    if (blocked) {
      if (auto && this.auto !== "off" && this.guards.state.paused) {
        const p = this.guards.state.paused;
        if (p.cause === "quiet" && this.settings.get("hop.enabled")) void this.hop(p.reason);
        else {
          this.say("warn", `automatic operating paused: ${blocked}`);
          if (p.cause === "fault") this.fault(blocked);
          void this.setAuto("off", "guard", undefined, blocked);
        }
      }
      return;
    }
    this.plannedTx.add(index);
    if (this.plannedTx.size > 16) this.plannedTx.delete(this.plannedTx.values().next().value!);
    const offset = isCq ? this.txOffsetHz : (this.qso?.txOffsetHz ?? this.txOffsetHz);
    void this.transmit(index, message, offset, isCq ? null : (this.qso?.id ?? null), lateLimitMs);
  }

  /** Checked at the moment of keying: a halt, FT-0, TX off or a mode change during the wait cancels it. */
  private stillWanted(qsoId: string | null, mode: DigitalMode): boolean {
    if (this.ft0 || !this.settings.get("radio.allowTransmit") || this.mode !== mode) return false;
    if (qsoId === null) return this.auto === "cq" && !(this.qso && isActive(this.qso));
    return !!this.qso && this.qso.id === qsoId && isActive(this.qso);
  }

  /** When the next transmission is due to start (epoch ms), for the Operate page. */
  nextTxAt: number | null = null;
  /** The contact message waiting to go out, and once the radio keys, the one going out now. */
  private txArmed: { qsoId: string; message: string } | null = null;
  private txNow: { qsoId: string; message: string; at: number } | null = null;

  private async transmit(index: number, message: string, offsetHz: number, qsoId: string | null, lateLimitMs?: number): Promise<void> {
    const isCq = qsoId === null;
    const radio = this.radio;
    if (!radio) return;
    const mode = this.mode;
    let samples: Float32Array;
    try {
      samples = buildWaveform(message, mode, offsetHz);
    } catch (e) {
      this.say("warn", `cannot build "${message}": ${(e as Error).message}`);
      return;
    }
    this.receiver.markOwnTx(index, mode);
    const startAt = txStartAt(index, mode);
    this.receiver.armTx(samples, startAt);
    this.nextTxAt = startAt;
    this.txArmed = qsoId ? { qsoId, message } : null;
    this.txNow = null;
    this.emit("state");
    let report;
    try {
      report = await radio.transmitAudio({ samples, startAt, lateLimitMs: lateLimitMs ?? TIMING[mode].lateLimitMs, stillWanted: () => this.stillWanted(qsoId, mode) });
    } catch (e) {
      report = { ok: false, detail: (e as Error).message, startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    }
    if (this.nextTxAt === startAt) this.nextTxAt = null;
    // Set by the radio's transmitting event during the wait (TypeScript cannot see that).
    const live = this.txNow as { message: string; at: number } | null;
    const keyedAt = live?.message === message ? live.at : Date.now();
    this.txArmed = null;
    this.txNow = null;
    this.recordTx(message, report, TIMING[mode].txLenMs, isCq);
    if (qsoId && this.qso?.id === qsoId) this.qso = afterTx(this.qso, message, report.ok, keyedAt);
    this.emit("state");
  }

  /** After any transmission: the activity line, RF verification and PA duty. */
  private recordTx(message: string, report: TxReport, keyedMs: number, isCq: boolean): void {
    const now = Date.now();
    this.lastTx = { at: now, message, ok: report.ok, detail: report.detail, fwdW: report.ok ? report.peakFwdW : null, swr: report.ok && report.peakSwr ? report.peakSwr : null };
    if (report.ok) {
      const meas = report.peakFwdW >= NO_RF_WATTS ? ` · ${Math.round(report.peakFwdW)} W${report.peakSwr ? `, SWR ${report.peakSwr.toFixed(1)}` : ""}` : "";
      this.say("tx", `${message}${meas}${report.startedLateMs > 100 ? ` (started ${report.startedLateMs} ms late)` : ""}`);
      this.runs.transmission(keyedMs / 1000);
      // Transmit verification: a radio that keys with no RF output is broken somewhere
      // (antenna, DAX route, TX slice, inhibit). Twice in a row stops everything.
      if (report.metered === false) {
        if (!this.warnedNoMeter) this.say("warn", "this radio gives no power reading, so transmissions cannot be checked for RF output");
        this.warnedNoMeter = true;
      } else if (report.peakFwdW < NO_RF_WATTS) {
        this.noRfCount++;
        this.say("warn", `transmitted "${message}" but the radio measured no RF output (${report.peakFwdW} W)`);
        if (this.noRfCount >= 2) {
          const reason = "the radio keyed twice with no RF output — check the antenna, that the radio is set to transmit, and the transmit audio route";
          this.guards.state.paused = { cause: "fault", reason, at: now };
          this.fault(reason);
          if (this.auto !== "off") void this.setAuto("off", "no RF output");
        }
      } else this.noRfCount = 0;
      if (report.peakFwdW > this.qsoPeakW) this.qsoPeakW = report.peakFwdW;
      if (isCq) this.guards.onCqSent(now);
      const s = this.settings.snapshot();
      if (this.pa.addKeyed(keyedMs, s["schedule.paOnMinutes"], s["schedule.paRestMinutes"], now)) {
        this.say("info", `PA rest for ${s["schedule.paRestMinutes"]} min after ${s["schedule.paOnMinutes"]} min keyed`);
      }
    } else {
      if (report.detail === "cancelled") this.say("info", `canceled "${message}" before it went out`);
      else this.say("warn", `not sent "${message}": ${report.detail}`);
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard modes: JTTY, RTTY, PSK31, CW
  // -------------------------------------------------------------------------

  private enterJs8(): void {
    if (this.js8On) return;
    this.leaveKeyboard();
    this.leaveSstv();
    this.leaveWspr();
    if (this.qso && isActive(this.qso)) this.haltQso("switched to JS8");
    if (this.auto !== "off") void this.setAuto("off", "switched to JS8");
    this.js8On = true;
    this.receiver.setSlotted(false);
    this.js8.start();
    this.recent = [];
    this.callers = [];
    this.say("state", `JS8 (${this.settings.get("js8.submode")}): listening${this.settings.get("js8.autoReply") ? "; answering queries" : ""}`);
  }

  private leaveJs8(): void {
    if (!this.js8On) return;
    this.js8TxSeq++;
    this.js8On = false;
    this.js8.stop();
    void this.radio?.unkey();
    this.receiver.setSlotted(true);
  }

  /** One JS8 frame at the start of its period. */
  private async transmitJs8(samples: Float32Array, startAt: number, label: string, auto: boolean): Promise<boolean> {
    const radio = this.radio;
    const blocked = this.txBlocked(auto);
    if (!radio || blocked) {
      if (blocked) this.say("warn", `JS8 not sent: ${blocked}`);
      return false;
    }
    const seq = this.js8TxSeq;
    this.nextTxAt = startAt;
    this.receiver.armTx(samples, startAt);
    this.emit("state");
    let report: TxReport;
    try {
      report = await radio.transmitAudio({ samples, startAt, lateLimitMs: 600, stillWanted: () => this.js8On && this.js8TxSeq === seq && !this.ft0 && this.settings.get("radio.allowTransmit") });
    } catch (e) {
      report = { ok: false, detail: (e as Error).message, startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    }
    if (this.nextTxAt === startAt) this.nextTxAt = null;
    this.recordTx(label, report, (samples.length / 24_000) * 1000, false);
    this.emit("state");
    return report.ok;
  }

  /** Send text in JS8 (it goes out in the next periods, one frame each). */
  sendJs8(text: string): string | null {
    if (!this.js8On) return "switch to JS8 first";
    const blocked = this.txBlocked(false);
    if (blocked) return blocked;
    return this.js8.enqueue(text);
  }

  haltJs8(): void {
    this.js8TxSeq++;
    this.js8.halt();
    void this.radio?.unkey();
  }

  /** Log a JS8 contact (MODE MFSK, SUBMODE JS8). */
  logJs8(input: { callsign: string; rstSent: string; rstRcvd: string; grid: string | null; notes: string }): { id: string } | { error: string } {
    const me = this.me();
    const band = this.band;
    if (!me) return { error: "no station is set up" };
    if (!band) return { error: "the dial is out of band" };
    const call = input.callsign.toUpperCase();
    const transcript = this.js8.messages
      .filter((m) => Date.now() - m.startMs < 60 * 60_000 && (m.from === call || m.to === call || m.dir === "tx"))
      .map((m) => `${new Date(m.startMs).toISOString().slice(11, 19)} ${m.dir === "tx" ? "TX" : "RX"} ${m.text}`)
      .join("\n");
    try {
      const { qso } = createQso(
        this.db,
        {
          stationId: me.stationId,
          operatorId: this.operatorId(me.stationId, me.call),
          callsign: call,
          band,
          freqHz: this.dialHz + this.txOffsetHz,
          mode: "JS8",
          startTime: Date.now(),
          endTime: Date.now(),
          rstSent: input.rstSent || null,
          rstRcvd: input.rstRcvd || null,
          grid: input.grid || this.js8.heard.get(call)?.grid || null,
          myGrid: null,
          radio: this.radio?.info.model ?? null,
          txPowerW: this.lastTx?.fwdW ? Math.round(this.lastTx.fwdW) : null,
          transcript: transcript || null,
          sigRefs: [],
          notes: input.notes || null,
        },
        { uploadServices: enabledUploadServices(this.settings.snapshot()) },
      );
      this.say("log", `logged ${call} ${band} JS8`);
      this.worked.invalidate();
      this.emit("logged", qso.id);
      return { id: qso.id };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  private enterWspr(): void {
    if (this.wsprOn) return;
    this.leaveKeyboard();
    this.leaveSstv();
    this.leaveJs8();
    if (this.qso && isActive(this.qso)) this.haltQso("switched to WSPR");
    if (this.auto !== "off") void this.setAuto("off", "switched to WSPR");
    this.wsprOn = true;
    this.receiver.setSlotted(false);
    this.wspr.start();
    this.recent = [];
    this.callers = [];
    const pct = this.settings.get("wspr.txPct");
    this.say("state", `WSPR: listening${pct > 0 ? `, beaconing in about ${pct} % of periods when transmit is on` : " only"}`);
  }

  private leaveWspr(): void {
    if (!this.wsprOn) return;
    this.wsprOn = false;
    this.wspr.stop();
    void this.radio?.unkey();
    this.receiver.setSlotted(true);
  }

  /** One WSPR beacon, 1 s after the even minute, 110.6 s long. */
  private async transmitWspr(periodStart: number): Promise<void> {
    const radio = this.radio;
    if (!radio || this.txBlocked(true)) return;
    const st = this.me();
    if (!st) return;
    const dbm = normalizeWsprPower(this.settings.get("wspr.dbm"));
    const message = wsprMessage(st.call, st.grid, dbm);
    const f0 = Math.max(1410, Math.min(1590, this.txOffsetHz));
    const samples = wsprWaveform(wsprTones(message), f0, 24_000);
    const startAt = periodStart + 1000;
    const keyedMs = (samples.length / 24_000) * 1000;
    this.nextTxAt = startAt;
    this.receiver.armTx(samples, startAt);
    this.emit("state");
    let report: TxReport;
    try {
      report = await radio.transmitAudio({ samples, startAt, lateLimitMs: 1500, stillWanted: () => this.wsprOn && !this.ft0 && this.settings.get("radio.allowTransmit") && !this.txBlocked(true) });
    } catch (e) {
      report = { ok: false, detail: (e as Error).message, startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
    }
    if (this.nextTxAt === startAt) this.nextTxAt = null;
    this.recordTx(`WSPR ${message} at ${f0} Hz`, report, keyedMs, false);
    this.emit("state");
  }

  private enterSstv(): void {
    if (this.sstvOn) return;
    this.leaveWspr();
    this.leaveJs8();
    this.leaveKeyboard();
    if (this.qso && isActive(this.qso)) this.haltQso("switched to SSTV");
    if (this.auto !== "off") void this.setAuto("off", "switched to SSTV");
    this.sstvOn = true;
    this.receiver.setSlotted(false);
    this.sstv.start();
    this.recent = [];
    this.callers = [];
    this.say("state", "SSTV: watching for pictures (VIS header names the mode)");
  }

  private leaveSstv(): void {
    if (!this.sstvOn) return;
    if (this.sstv.sending) this.haltSstv();
    this.sstvOn = false;
    this.sstv.stop();
    this.receiver.setSlotted(true);
  }

  /** Send a picture: `rgb` is the mode's width × height × 3 bytes. */
  sendSstv(modeId: string, rgb: Uint8Array): string | null {
    if (!this.sstvOn) return "switch to SSTV first";
    const m = sstvMode(modeId);
    if (!m) return `no SSTV mode ${modeId}`;
    if (rgb.length !== m.width * m.height * 3) return `${m.name} needs a ${m.width}x${m.height} picture`;
    const blocked = this.txBlocked(false);
    if (blocked) return blocked;
    if (this.sstv.sending || this.transmitting) return "still transmitting; wait for it to finish or halt it";
    // Someone is sending a picture on this frequency: keying over it ruins theirs.
    const rx = this.sstv.receiving;
    if (rx) return `a ${rx.modeName} picture is coming in (line ${rx.line} of ${rx.of}); wait for it to finish`;
    const radio = this.radio!;
    const samples = sstvWaveform(m, rgb, 24_000);
    const keyedMs = (samples.length / 24_000) * 1000;
    const startAt = Date.now() + 500;
    const seq = ++this.sstvTxSeq;
    this.sstv.sending = { mode: m.id, startedAt: startAt, durationMs: Math.round(keyedMs) };
    this.nextTxAt = startAt;
    this.receiver.armTx(samples, startAt);
    this.emit("state");
    const wanted = () => this.sstvOn && this.sstvTxSeq === seq && !this.ft0 && this.settings.get("radio.allowTransmit");
    void (async () => {
      let report: TxReport;
      try {
        report = await radio.transmitAudio({ samples, startAt, lateLimitMs: 400, stillWanted: wanted });
      } catch (e) {
        report = { ok: false, detail: (e as Error).message, startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
      }
      if (this.sstv.sending?.startedAt === startAt) this.sstv.sending = null;
      if (this.nextTxAt === startAt) this.nextTxAt = null;
      if (report.ok) await this.sstv.save(m, rgb, { at: startAt, lines: m.height, complete: true, slantPpm: 0, dir: "tx" }).catch(() => {});
      this.recordTx(`SSTV ${m.name} picture`, report, keyedMs, false);
      this.emit("state");
    })();
    return null;
  }

  haltSstv(): void {
    this.sstvTxSeq++;
    if (this.sstv.sending) void this.radio?.unkey();
  }

  private enterKeyboard(mode: KeyMode): void {
    this.leaveSstv();
    this.leaveWspr();
    this.leaveJs8();
    if (this.keyMode === mode) return;
    if (this.keyMode && this.keys.sending) this.haltKeyboard();
    if (this.qso && isActive(this.qso)) this.haltQso(`switched to ${mode}`);
    if (this.auto !== "off") void this.setAuto("off", `switched to ${mode}`);
    this.keyMode = mode;
    this.receiver.setSlotted(false);
    this.keys.rxHz = this.txOffsetHz;
    this.keys.start(mode);
    this.recent = [];
    this.callers = [];
    this.say("state", `${mode}: listening across the passband; type to transmit`);
  }

  private leaveKeyboard(): void {
    if (!this.keyMode) return;
    if (this.keys.sending) this.haltKeyboard();
    this.keyMode = null;
    this.keys.stop();
    this.receiver.setSlotted(true);
  }

  /**
   * Send text or a function key now. Refused, with the reason, when transmit is off or
   * blocked, while a message is still going out, or when the text cannot be encoded.
   */
  sendKeyboard(input: { text?: string; fkey?: number }): string | null {
    if (!this.keyMode) return "switch to a keyboard mode (JTTY, RTTY, PSK31, CW or Hell) first";
    const blocked = this.txBlocked(false);
    if (blocked) return blocked;
    if (this.keys.sending || this.transmitting) return "still transmitting; wait for it to finish or halt it";
    const me = this.me()!;
    const c = this.keys.compose(input, me.call);
    if ("error" in c) return c.error;
    const radio = this.radio!;
    const offsetHz = this.txOffsetHz;
    const samples = this.keys.waveform(c, offsetHz);
    const keyedMs = (samples.length / 24_000) * 1000;
    // Untimed: start as soon as the radio can key. A late start would clip the first sync
    // symbols, so the limit is tight and the lead covers the radio's own setup.
    const startAt = Date.now() + 400;
    const seq = ++this.keyTxSeq;
    this.receiver.armTx(samples, startAt);
    this.keys.sending = { text: c.text, frames: c.atoms?.length ?? 0, startedAt: startAt, durationMs: Math.round(keyedMs) };
    this.nextTxAt = startAt;
    this.emit("state");
    const mode = this.keyMode;
    const wanted = () => this.keyMode === mode && this.keyTxSeq === seq && !this.ft0 && this.settings.get("radio.allowTransmit");
    void (async () => {
      let report: TxReport;
      try {
        report = await radio.transmitAudio({ samples, startAt, lateLimitMs: 300, stillWanted: wanted });
      } catch (e) {
        report = { ok: false, detail: (e as Error).message, startedLateMs: 0, packets: 0, peakFwdW: 0, peakSwr: 0 };
      }
      if (this.keys.sending?.startedAt === startAt) this.keys.sending = null;
      if (this.nextTxAt === startAt) this.nextTxAt = null;
      if (report.ok || report.detail === "interrupted") this.keys.sent(report.ok ? c.text : `${c.text} [halted]`, offsetHz, startAt);
      this.recordTx(`${mode} ${c.text}`, report, keyedMs, false);
      this.emit("state");
    })();
    return null;
  }

  /** Stop a keyboard-mode message mid-air, or before it keys. */
  haltKeyboard(): void {
    this.keyTxSeq++;
    if (this.keys.sending) void this.radio?.unkey();
  }

  setKeyContext(patch: Partial<KeyContext>): void {
    this.keys.setContext(patch);
    const { exchange, profile, serial, wpm, serialOn, hellSpeed, hellReverse } = this.keys.ctx;
    this.state.set("keyContext", { exchange, profile, serial, wpm, serialOn, hellSpeed, hellReverse });
  }

  /** Log a contact the operator worked in a keyboard mode: MODE JTTY, RTTY, CW, PSK/PSK31, or HELL (SLOWHELL, HELLX5, HELLX9 as submodes). */
  logKeyboard(input: { callsign: string; rstSent: string; rstRcvd: string; grid: string | null; exchSent: string; exchRcvd: string; startTime: number | null; notes: string; name?: string | null; qth?: string | null }): { id: string } | { error: string } {
    const me = this.me();
    const band = this.band;
    if (!me) return { error: "no station is set up" };
    if (!band) return { error: "the dial is out of band" };
    const mode = this.keyMode ?? "JTTY";
    const exch = [input.exchSent && `sent ${input.exchSent}`, input.exchRcvd && `rcvd ${input.exchRcvd}`].filter(Boolean).join(", ");
    const notes = [exch && `exch ${exch}`, input.notes].filter(Boolean).join(" · ") || null;
    const since = input.startTime ?? Date.now() - 15 * 60_000;
    const transcript = this.keys.lines
      .filter((l) => l.mode === mode && l.startMs >= since - 5_000 && (l.dir === "tx" || l.atRx || l.text.includes(input.callsign)))
      .map((l) => `${new Date(l.startMs).toISOString().slice(11, 19)} ${l.dir === "tx" ? "TX" : "RX"} ${l.text}`)
      .join("\n");
    try {
      const { qso } = createQso(
        this.db,
        {
          stationId: me.stationId,
          operatorId: this.operatorId(me.stationId, me.call),
          callsign: input.callsign,
          name: input.name?.trim() || null,
          qth: input.qth?.trim() || null,
          band,
          freqHz: this.dialHz + this.txOffsetHz,
          mode: mode === "HELL" ? (HELL_SPEEDS[this.keys.ctx.hellSpeed].submode ?? "HELL") : mode,
          startTime: input.startTime ?? Date.now(),
          endTime: Date.now(),
          rstSent: input.rstSent || null,
          rstRcvd: input.rstRcvd || null,
          grid: input.grid,
          myGrid: null,
          radio: this.radio?.info.model ?? null,
          txPowerW: this.lastTx?.fwdW ? Math.round(this.lastTx.fwdW) : null,
          transcript: transcript || null,
          extras: (() => {
            const f = this.keyboardContestFields(input);
            return f ? JSON.stringify(f) : null;
          })(),
          sigRefs: [],
          notes,
        },
        { uploadServices: enabledUploadServices(this.settings.snapshot()) },
      );
      this.say("log", `logged ${input.callsign} ${band} ${mode} sent ${input.rstSent || "—"} rcvd ${input.rstRcvd || "—"}${exch ? ` · ${exch}` : ""}`);
      this.worked.invalidate();
      // The running serial moves on after each contact, as a contest logger's does.
      // In a contest the serial is the contest's, shared with the FT modes; JTTY's own
      // exchange is a serial too. A ragchew in the other modes sent none.
      if (!this.keys.ctx.exchange) {
        if (this.contest.id !== "none") this.setContest({ serial: this.keys.ctx.serial + 1 }, true);
        else if (this.keyMode === "JTTY") this.setKeyContext({ serial: this.keys.ctx.serial + 1 });
      }
      this.setKeyContext({ hisCall: "" });
      this.invalidateContest();
      this.emit("logged", qso.id);
      return { id: qso.id };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  // -------------------------------------------------------------------------
  // Automatic operating
  // -------------------------------------------------------------------------

  async setAuto(mode: AutoMode, source: string, resumedFrom?: number, stopReason?: string): Promise<string | null> {
    if (mode !== "off" && mode !== "cq" && this.contest.id !== "none") {
      return `${CONTESTS[this.contest.id].name} rules require a person to start each contact: automatic hunting is off during a contest (CQ works, answered as you watch)`;
    }
    if (mode !== "off") {
      const blocked = this.txBlocked(false);
      if (blocked) return blocked;
      if (this.keyMode || this.sstvOn || this.wsprOn || this.js8On) return `automatic operating is for FT8, FT4 and FT2, not ${this.opMode}`;
      const cp = this.contestProblem();
      if (cp) return cp;
      const band = this.band;
      if (!band || !slottedModeForDial(this.dialHz)) return "tune to an FT8, FT4 or FT2 calling frequency first";
    }
    const prev = this.auto;
    this.auto = mode;
    this.autoSource = source;
    this.emptyHuntWindows = 0;
    if (mode === "off") {
      this.guards.endRun();
      this.cqParity = null;
      if (prev === "pota-chase") await this.chaseGoHome();
      this.state.set("auto", source === "guard" || source === "ft0" ? null : { mode: "off", since: Date.now(), source });
      if (prev !== "off") this.runs.stop(stopReason ?? (source === "guard" ? "stopped by a safety limit" : source));
    } else {
      // One clock reading for the run record and the saved state, so a restart finds the run again.
      const since = resumedFrom ?? Date.now();
      if (prev === "off") {
        // After a restart the same run carries on, contacts and all.
        const sofar = resumedFrom ? this.runs.resume(resumedFrom, mode, this.band) : null;
        if (sofar === null) this.runs.start(mode, source, this.band, since, this.me()?.stationId ?? null);
        this.guards.beginRun(Date.now(), since, sofar ?? 0);
      } else if (prev !== mode) this.runs.mode(mode, this.band);
      if (mode === "cq") this.cqParity = this.state.get("cqSlot") ?? parity(windowIndex(Date.now(), this.mode) + 1);
      if (mode === "pota-chase") this.chase = { home: { hz: this.dialHz, mode: this.mode }, target: null, parkedAt: 0, tried: new Map() };
      this.state.set("auto", { mode, since, source });
      const s = this.settings.snapshot();
      await this.radio?.setRfPower(s["radio.rfPowerPct"]).catch(() => {});
    }
    if (prev !== mode) this.say("info", mode === "off" ? `automatic operating off (${source})` : `automatic ${mode} on (${source})`);
    this.emit("state");
    return null;
  }

  /** The park this station is spotted at on our band, from the POTA spots. */
  private parkFor(call: string): string | null {
    return this.band ? parkFor(potaSpotsCached(), call, bandName, this.band) : null;
  }

  private mayCall(call: string, band: string, park?: string | null): string | null {
    const now = Date.now();
    const dnc = this.worked.doNotCall(call, now);
    if (dnc) return dnc;
    if (this.worked.coolingDown(call, now)) return "failed recently";
    // An activator at a park: the hunter's credit is per park, band, mode and UTC day, so
    // the same activator at a new park (or the same park tomorrow) is a new contact. The
    // old rules skipped them for having been worked at another park.
    if (park) {
      const dayStart = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
      return this.worked.workedAtPark(call, park, band, this.mode, dayStart) ? `worked at ${park} today` : null;
    }
    const s = this.settings.snapshot();
    if (s["auto.skipWorkedBandMode"] && this.worked.workedSince(call, band, this.mode, 0)) return "worked on this band and mode";
    const dayStart = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
    const since = Math.min(dayStart, now - s["auto.dupeWindowHours"] * 3_600_000);
    if (this.worked.workedSince(call, band, this.mode, since)) return "worked recently";
    return null;
  }

  private rank(w: WindowResult, me: { call: string }, potaOnly: boolean, spots: PotaSpot[]): Scored[] {
    const band = this.band;
    if (!band) return [];
    const s = this.settings.snapshot();
    const idx = this.worked.worked(band);
    const ours = getDxcc().resolve(me.call);
    const out: Scored[] = [];
    for (const d of w.decodes) {
      for (const p of d.parsed) {
        let call: string | null = null;
        let grid: string | null = null;
        let potaCq = false;
        if (p.kind === "cq") {
          if (p.from === me.call || p.from === "<...>") continue;
          potaCq = p.modifier === "POTA";
          if (potaOnly && !potaCq) continue;
          const theirs = getDxcc().resolve(p.from);
          if (!cqIsForUs(p.modifier, { continent: ours?.continent ?? null, dxcc: ours?.adif ?? null }, { continent: theirs?.continent ?? null, dxcc: theirs?.adif ?? null })) continue;
          call = p.from;
          grid = p.grid;
        } else if (p.kind === "directed" && s["auto.callFinishedStations"] && !potaOnly && p.to !== me.call && (p.payload.kind === "rr73" || p.payload.kind === "73")) {
          call = p.from;
        }
        if (!call || d.snr < s["auto.huntMinSnr"]) continue;
        const park = spots.find((sp) => sp.activator === call && bandName(sp.freqHz) === band)?.reference ?? null;
        const sc = score({ callsign: call, grid, snr: d.snr, park, potaCq }, idx);
        if (s["auto.huntNewOnly"] && sc.routine && !potaCq) continue;
        out.push(sc);
      }
    }
    return out.sort((a, b) => b.points - a.points);
  }

  private findDecode(w: WindowResult, call: string): Decode | undefined {
    return w.decodes.find((d) => d.sender === call);
  }

  private autoStep(w: WindowResult, me: { call: string }): void {
    if (this.auto === "off" || (this.qso && isActive(this.qso))) {
      this.candidates = [];
      return;
    }
    const band = this.band;
    if (!band) return;
    if (this.txBlocked(true)) return;

    // Someone calling us comes first, in every mode.
    // Someone answering us is answered whatever the dupe rules say; only do-not-call applies.
    const caller = [...this.callers].filter((c) => c.windowIndex === w.index && !this.worked.doNotCall(c.callsign)).sort((a, b) => b.snr - a.snr)[0];
    if (caller) {
      const d = w.decodes.find((x) => x.sender === caller.callsign && x.text === caller.text);
      if (d) {
        this.guards.onAnswered();
        this.callStation({ callsign: caller.callsign, grid: null, snr: caller.snr, offsetHz: caller.offsetHz, windowIndex: w.index, origin: "answer", replyTo: d });
        return;
      }
    }
    if (this.auto === "cq") return;

    // A CQ in our own transmit slot would put the answer in the other one.
    const huntSlot = this.state.get("huntSlot") ?? null;
    if (huntSlot !== null && this.auto !== "pota-chase" && parity(w.index) === huntSlot) {
      this.candidates = [];
      return;
    }

    const spots = this.auto === "hunt" ? [] : potaSpotsCached();
    if (this.auto === "pota-chase") {
      void this.chaseStep(w, me, spots);
      return;
    }

    const ranked = this.rank(w, me, this.auto === "hunt-pota", spots);
    this.candidates = ranked.slice(0, 10);
    for (const c of ranked) {
      if (this.mayCall(c.callsign, band, c.park)) continue;
      const d = this.findDecode(w, c.callsign);
      if (!d) continue;
      this.emptyHuntWindows = 0;
      this.callStation({ callsign: c.callsign, grid: c.grid, snr: c.snr, offsetHz: d.offsetHz, windowIndex: w.index, origin: "auto", park: c.park });
      return;
    }
    if (++this.emptyHuntWindows >= HOP_AFTER_EMPTY_WINDOWS && this.settings.get("hop.enabled")) {
      void this.hop(`${this.settings.get("auto.huntNewOnly") ? "nobody new" : "nobody"} to call on ${band} for ${this.emptyHuntWindows} windows`);
    }
  }

  private async chaseStep(w: WindowResult, me: { call: string }, spots: PotaSpot[]): Promise<void> {
    const s = this.settings.snapshot();
    const now = Date.now();
    const t = this.chase.target;
    if (t) {
      const d = w.decodes.find((x) => x.sender === t.activator && x.parsed.some((p) => p.kind === "cq"));
      if (d) {
        const why = this.mayCall(t.activator, this.band!, t.reference);
        this.chase.tried.set(`${t.activator}|${t.reference}`, now);
        this.chase.target = null;
        if (!why) {
          const cq = d.parsed.find((p) => p.kind === "cq") as Extract<Parsed, { kind: "cq" }>;
          this.callStation({ callsign: t.activator, grid: cq.grid, snr: d.snr, offsetHz: d.offsetHz, windowIndex: w.index, origin: "auto", park: t.reference });
        }
        return;
      }
      if (now - this.chase.parkedAt < s["pota.chaseGiveUpSec"] * 1000) return;
      this.say("info", `chase: gave up on ${t.activator} at ${t.reference}`);
      this.chase.tried.set(`${t.activator}|${t.reference}`, now);
      this.chase.target = null;
    }
    const allowed = s["pota.chaseBands"] ? s["pota.chaseBands"].split(",") : [bandName(this.chase.home?.hz ?? this.dialHz) ?? ""];
    const retryMs = s["pota.chaseRetryMin"] * 60_000;
    const options = spots
      .filter((sp) => sp.mode === this.mode)
      .map((sp) => ({ sp, band: bandName(sp.freqHz) }))
      .filter(({ sp, band }) => band && allowed.includes(band) && now - (this.chase.tried.get(`${sp.activator}|${sp.reference}`) ?? 0) > retryMs && !this.mayCall(sp.activator, band!, sp.reference))
      .map(({ sp, band }) => ({ sp, band: band!, dial: CALLING_FREQS[this.mode][band!] }))
      .filter((o) => o.dial && Math.abs(o.sp.freqHz - o.dial) <= 3000)
      .sort((a, b) => Number(b.band === this.band) - Number(a.band === this.band));
    const pick = options[0];
    if (!pick) {
      await this.chaseGoHome();
      return;
    }
    this.chase.target = pick.sp;
    this.chase.parkedAt = now;
    if (Math.abs(this.dialHz - pick.dial!) > 100) await this.tuneHz(pick.dial!);
    this.say("info", `chase: waiting for ${pick.sp.activator} at ${pick.sp.reference} on ${pick.band}`);
  }

  private async chaseGoHome(): Promise<void> {
    const home = this.chase.home;
    if (home && Math.abs(this.dialHz - home.hz) > 100) await this.tuneHz(home.hz).catch(() => {});
  }

  private async hop(why: string): Promise<void> {
    const bands = this.settings.get("hop.bands").split(",").filter((b) => CALLING_FREQS[this.mode][b]);
    if (bands.length < 2) {
      this.say("warn", `${why}; band hopping needs at least two bands with ${this.mode} frequencies`);
      await this.setAuto("off", "guard");
      return;
    }
    const cur = bands.indexOf(this.band ?? "");
    // Band memory picks: the band that usually holds the most stations at this hour, not
    // the one just left. Bands it knows nothing about keep the old turn order.
    const now = Date.now();
    const y = this.bandYield();
    const recent = this.hopLeft && now - this.hopLeft.at < 20 * 60_000 ? this.hopLeft.band : null;
    const others = bands.filter((b) => b !== this.band && (b !== recent || bands.length <= 2));
    const known = others.filter((b) => (y?.get(b)?.samples ?? 0) >= 2).sort((a, b) => y!.get(b)!.avg - y!.get(a)!.avg);
    let next: string;
    let reason = "";
    if (known.length) {
      next = known[0]!;
      const k = y!.get(next)!;
      reason = `: usually ${k.avg} stations there at this hour (${k.samples} days)`;
      this.hopCursor = bands.indexOf(next);
    } else {
      this.hopCursor = ((cur >= 0 ? cur : this.hopCursor) + 1) % bands.length;
      next = bands[this.hopCursor]!;
      if (next === this.band) next = bands[(this.hopCursor = (this.hopCursor + 1) % bands.length)]!;
    }
    if (this.band) this.hopLeft = { band: this.band, at: now };
    this.say("info", `${why} — moving to ${next}${reason}`);
    await this.tuneHz(CALLING_FREQS[this.mode][next]!);
    this.guards.afterBandChange();
    this.emptyHuntWindows = 0;
    if (this.auto === "cq") this.cqParity = this.state.get("cqSlot") ?? parity(windowIndex(Date.now(), this.mode) + 1);
  }

  // -------------------------------------------------------------------------
  // Tuning
  // -------------------------------------------------------------------------

  /** Tune the dial. With `keep`, stay in that mode instead of guessing it from the frequency. */
  async tuneHz(hz: number, keep?: OperatingMode): Promise<void> {
    const r = this.radio;
    const prevBand = this.band;
    if (r) await r.tune(hz);
    // RTTY, PSK31 and CW are tuned freely: moving the dial keeps them.
    const m = keep || FREE_TUNING.includes(this.opMode) ? null : modeForDial(hz, this.opMode);
    if (m === "JTTY") this.enterKeyboard("JTTY");
    else if (m === "WSPR") this.enterWspr();
    else if (m === "JS8") this.enterJs8();
    else if (m && isDigitalMode(m)) {
      this.leaveWspr();
      this.leaveJs8();
      this.leaveSstv();
      this.leaveKeyboard();
      if (m !== this.mode) {
        this.mode = m;
        this.receiver.setMode(m);
      }
    }
    this.state.set("lastTune", { hz, mode: this.opMode });
    if (this.auto !== "off" && bandName(hz)) this.runs.band(bandName(hz)!);
    if (this.qso && isActive(this.qso)) this.haltQso("retuned");
    const band = bandName(hz);
    if (r && band && prevBand && band !== prevBand && this.settings.get("radio.atuOnBandChange") && r.info.atu && this.settings.get("radio.allowTransmit") && !this.ft0) {
      await r.atuStart().catch((e) => this.say("warn", `ATU: ${(e as Error).message}`));
    }
    this.recent = [];
    this.callers = [];
    this.emit("state");
  }

  async tuneBand(band: string, mode: OperatingMode = this.opMode): Promise<string | null> {
    const hz = this.bandFreq(mode, band);
    if (!hz) return `no ${mode} frequency for ${band}`;
    if (mode === "SSTV") this.enterSstv();
    else if (mode === "WSPR") this.enterWspr();
    else if (mode === "JS8") this.enterJs8();
    else if (isKeyMode(mode)) this.enterKeyboard(mode);
    else {
      this.leaveSstv();
      this.leaveWspr();
      this.leaveJs8();
      this.leaveKeyboard();
    }
    if (isDigitalMode(mode) && mode !== this.mode) {
      this.mode = mode;
      this.receiver.setMode(mode);
      if (this.auto === "cq") this.cqParity = this.state.get("cqSlot") ?? parity(windowIndex(Date.now(), mode) + 1);
    }
    await this.tuneHz(hz);
    return null;
  }

  setTxOffset(hz: number): void {
    this.txOffsetHz = Math.max(MIN_TX_HZ + 100, Math.min(MAX_TX_HZ - 100, Math.round(hz)));
    this.keys.rxHz = this.txOffsetHz;
    this.emit("state");
  }

  // -------------------------------------------------------------------------
  // FT-0
  // -------------------------------------------------------------------------

  async engageFt0(by: string): Promise<void> {
    // Flags first: a transmission due while the unkey round trip is in flight must not key.
    this.ft0 = true;
    this.settings.write({ "radio.allowTransmit": false }, null);
    await this.radio?.unkey().catch(() => {});
    this.haltQso("FT-0");
    await this.setAuto("off", "ft0");
    this.settings.write({ "radio.allowTransmit": false }, null);
    this.ft0 = true;
    this.state.set("ft0", { engagedAt: Date.now(), by });
    await this.supervisor.stop();
    this.say("warn", `FT-0 engaged by ${by}: transmit off, radio released`);
    this.emit("state");
  }

  releaseFt0(by: string): void {
    this.ft0 = false;
    this.state.set("ft0", null);
    this.supervisor.start();
    this.say("info", `FT-0 released by ${by}: reconnecting; transmit stays off until you enable it`);
    this.emit("state");
  }

  // -------------------------------------------------------------------------
  // Schedule and housekeeping
  // -------------------------------------------------------------------------

  private scheduleTick(): void {
    const s = this.settings.snapshot();
    const now = Date.now();
    if (this.callers.length) this.callers = this.callers.filter((c) => now - c.at < CALLER_TTL_MS);
    if (!s["schedule.enabled"] || this.ft0) return;
    const d = decideSchedule({ blocks: s["schedule.blocks"], sleep: s["schedule.sleep"], paResting: this.pa.resting(now) }, new Date(now));
    const key = `${d.mode}|${d.why}`;
    if (key === this.scheduleLast) return;
    this.scheduleLast = key;
    this.state.set("scheduleLast", key);
    if (d.mode === this.auto) return;
    void this.setAuto(d.mode, `schedule: ${d.why}`).then((err) => {
      if (err) this.say("warn", `schedule wanted ${d.mode} but: ${err}`);
    });
  }

  private flushDecodes(): void {
    if (!this.decodeBuffer.length) return;
    const rows = this.decodeBuffer.splice(0);
    try {
      this.db.transaction((tx) => {
        for (const r of rows) tx.insert(decodesTable).values(r).run();
      });
    } catch (e) {
      this.log.warn(`decode write failed: ${(e as Error).message}`);
    }
  }

  snapshot() {
    const r = this.radio;
    const s = this.settings.snapshot();
    const me = this.me();
    return {
      station: me ? { callsign: me.call, grid: me.grid4 } : null,
      distanceUnit: s["app.distanceUnit"],
      // The WSJT-X style UDP feed, for its switch on the Operate page (null: none set up).
      udpFeed: s["udp.targets"].trim() ? { on: s["udp.enabled"], name: s["udp.name"], targets: s["udp.targets"] } : null,
      radio: {
        link: this.supervisor.state,
        detail: this.supervisor.detail,
        model: r?.info.model ?? null,
        nickname: r?.info.nickname ?? null,
        version: r?.info.version ?? null,
        type: s["radio.type"],
        holder: this.holder,
        radioRequest: this.radioRequest ? { userId: this.radioRequest.userId, name: this.radioRequest.name, callsign: this.radioRequest.callsign, until: this.radioRequest.until } : null,
        // Radio time: the booking on now (holding: its operator is signed in, so the radio is
        // theirs) and the next one.
        booking: { current: this.booking.current, next: this.booking.next, holding: !!this.booking.holding },
        controlOp: this.controlOp,
        licenseClass: this.licenseClass(),
        privilegeBands: this.privilegeBands(),
        privilegeBlock: this.privilegeBlock(),
        bands: Object.fromEntries(OPERATING_MODES.map((m) => [m, this.bandsOf(m)])),
        // The band button's frequency where the dial is: built in, and the operator's own.
        bandFreq: (() => {
          const band = this.band;
          if (!band || !FREE_TUNING.includes(this.opMode)) return null;
          return { band, mode: this.opMode, builtIn: CALLING_FREQS[this.opMode][band] ?? null, mine: this.state.get("myFreqs")?.[this.opMode]?.[band] ?? null };
        })(),
        bandPlan: bandPlan(),
        powerNote: bandPlan() === "us" ? usPowerNote(...this.emissionSpan()) : null,
        bandYield: (() => {
          const y = this.bandYield();
          return y ? Object.fromEntries([...y.entries()].map(([b, v]) => [b, v])) : null;
        })(),
        host: r?.host ?? null,
        sliceIndex: r?.slice?.index ?? null,
        sliceMode: r?.slice?.mode ?? null,
        rxAnt: r?.slice?.rxAnt ?? null,
        txAnt: r?.slice?.txAnt ?? null,
        antennas: r?.slice?.antList ?? [],
        txAntennas: r?.slice?.txAntList ?? [],
        rfPowerPct: r?.transmit.rfpower ?? s["radio.rfPowerPct"],
        atu: r?.info.atu ?? false,
        telemetry: r?.telemetry ?? null,
        transmitting: this.transmitting,
        audioAgeMs: Number.isFinite(this.receiver.audioAgeMs) ? this.receiver.audioAgeMs : null,
        waterfallLagMs: this.receiver.lastRowLagMs === null ? null : Math.round(this.receiver.lastRowLagMs),
      },
      dialHz: this.dialHz,
      band: this.band,
      mode: this.opMode,
      slottedMode: this.mode,
      keyboard: this.keys.snapshot(),
      sstv: this.sstv.snapshot(),
      wspr: this.wspr.snapshot(),
      /** The engine clock, so pages can run slot clocks on station time. */
      now: Date.now(),
      js8: this.js8.snapshot(),
      txOffsetHz: this.txOffsetHz,
      tx: { allowed: s["radio.allowTransmit"], blocked: this.txBlocked(false), last: this.lastTx, nextAt: this.nextTxAt },
      ft0: this.ft0,
      auto: {
        mode: this.auto,
        source: this.autoSource,
        paused: this.guards.state.paused,
        runStartedAt: this.guards.state.runStartedAt,
        qsosThisRun: this.guards.state.qsosThisRun,
        unansweredCqs: this.guards.state.unansweredCqs,
        cqParity: this.cqParity,
        cqSlot: this.state.get("cqSlot") ?? null,
        huntSlot: this.state.get("huntSlot") ?? null,
        hound: this.houndMode,
        contest: { ...this.contest, sending: this.contestExchange(), problem: this.contestProblem(), desk: this.contestDesk() },
        runId: this.runs.active,
        paResting: this.pa.resting(Date.now()),
        chase: this.chase.target ? { activator: this.chase.target.activator, park: this.chase.target.reference, since: this.chase.parkedAt } : null,
        candidates: this.candidates.slice(0, 6).map((c) => ({ callsign: c.callsign, points: c.points, reasons: c.reasons })),
      },
      qso: this.qso
        ? {
            id: this.qso.id,
            them: this.qso.them,
            grid: this.qso.theirGrid,
            phase: this.qso.phase,
            reportSent: formatReport(this.qso.reportSent),
            reportRcvd: this.qso.reportRcvd !== null ? formatReport(this.qso.reportRcvd) : null,
            txOffsetHz: this.qso.txOffsetHz,
            ourParity: this.qso.ourParity,
            repeats: this.qso.repeats,
            maxRepeats: this.qso.maxRepeats,
            logged: this.qso.logged,
            reason: this.qso.reason,
            park: this.qso.sigInfo,
            hound: this.qso.hound,
            contest: this.qso.contest,
            exchSent: this.qso.myExch,
            exchRcvd: this.qso.theirExch,
            transcript:
              this.txNow && this.txNow.qsoId === this.qso.id
                ? [...this.qso.transcript, { at: this.txNow.at, dir: "tx" as const, text: this.txNow.message, live: true }]
                : this.qso.transcript,
          }
        : null,
      callers: this.callers,
      lastWindow: this.lastWindow,
    };
  }

  /** Attach this contact's decodes to the logged row. */
  private linkDecodes(qsoId: string, call: string, from: number, to: number): void {
    this.flushDecodes();
    this.db
      .update(decodesTable)
      .set({ loggedQsoId: qsoId })
      .where(and(eq(decodesTable.callsign, call), between(decodesTable.at, from - 30_000, to + 15_000)))
      .run();
  }
}
