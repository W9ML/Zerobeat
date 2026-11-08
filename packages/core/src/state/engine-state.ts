/**
 * Engine runtime state that must survive a restart. JSON values keyed by name, in their
 * own table so they never show up as "settings" and never invalidate the settings cache.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { engineState } from "../db/schema.ts";

export interface EngineStateShape {
  /** Last dial frequency and mode the engine tuned, restored on reconnect. */
  lastTune: { hz: number; mode: "FT8" | "FT4" | "FT2" | "JTTY" | "RTTY" | "PSK31" | "CW" | "HELL" | "SSTV" | "WSPR" | "JS8" };
  /** The radio address that last worked, used when discovery is unavailable. */
  lastRadioHost: string;
  /** The automatic mode to resume after a restart, and why it was set. */
  auto: { mode: string; since: number; source: string } | null;
  /** The user who last operated the station ("has the radio"), and a control operator who took control. */
  holder: { userId: string; at: number } | null;
  control: { userId: string; at: number } | null;
  /** FT-0 engaged: transmit disabled and the radio released until an operator resumes. */
  ft0: { engagedAt: number; by: string } | null;
  /** Schedule decision last acted on, so a restart is not seen as a boundary. */
  scheduleLast: string | null;
  /** PSKReporter, LoTW, eQSL, QRZ sync cursors. */
  lotwLastQslSince: string;
  eqslLastRcvd: string;
  qrzLastLogId: number;
  /** yyyy-mm-dd of the last QRZ confirmation sync: the next one asks for records modified since. */
  qrzModSince: string;
  /** Log id an unfinished QRZ sync stopped after, or 0. */
  qrzResumeAfter: number;
  /** Service-level pause after authentication failures: service → {until, error}. */
  servicePause: Record<string, { until: number; error: string }>;
  /** The TQSL callsign certificate: PEM, the private key encrypted, and what it says. */
  lotwCert: { certPem: string; keyEnc: string; info: import("../integrations/lotw.ts").LotwCertInfo; uploadedAt: number };
  /** Web Push keys. The private key is encrypted with ZEROBEAT_SECRET_KEY. */
  vapid: { publicKey: string; privateKeyEnc: string };
  /** When the last morning summary went out. */
  digestLastAt: number;
  /** When the shared station was split into one per user (accounts/split.ts). */
  usersSplitAt: number;
  /** When PSKReporter was last asked who heard us (their limit is one query per 5 min). */
  heardLastQueryAt: number;
  /** The contest the station is in (WSJT-X's special operating activity) and what it sends. */
  contest: {
    id: "none" | "ww-digi" | "arrl-digi" | "field-day" | "rtty-roundup";
    exchange: string;
    serial: number;
    /** Contacts from this time on make up the contest log (when the contest was chosen, or set). */
    since?: number;
    /** Field Day power multiplier: 5 (5 W from batteries or solar), 2 (100 W or less), 1. */
    fdPower?: 1 | 2 | 5;
  };
  /** Function keys the operator edited, by keyboard mode (eight each). */
  fkeys: Partial<Record<"JTTY" | "RTTY" | "PSK31" | "CW" | "HELL", string[]>>;
  /** Call as a Hound (FT8 DXpedition mode). */
  houndMode: boolean;
  /** The slot the operator wants to call CQ in: 0 even (:00/:30 in FT8), 1 odd. */
  cqSlot: 0 | 1;
  /** The last contact (the engine's QSO state), so the contact card survives a restart. */
  lastQso: Record<string, unknown> | null;
  /** Hunting: only call stations whose answer goes out in this slot (unset: either). */
  huntSlot: 0 | 1 | null;
  /** JTTY exchange settings, kept across restarts. */
  jttyContext: { exchange: string; profile: "unknown" | "field-day" | "rtty-roundup"; serial: number };
  /** Keyboard-mode exchange settings and CW speed, kept across restarts (replaces jttyContext). */
  keyContext: { exchange: string; profile: "unknown" | "field-day" | "rtty-roundup"; serial: number; wpm: number; serialOn?: boolean; hellSpeed?: "feld" | "slow" | "x5" | "x9" | "fsk105" | "fsk245" | "hell80"; hellReverse?: boolean };
  /** The operator's own dial frequency by mode and band (free-tuned modes), in place of the built-in one. */
  myFreqs: Record<string, Record<string, number>>;
  /** Last run of each background job: when, and what happened. */
  jobs: Record<string, { at: number; ok: boolean; detail: string }>;
}

export type EngineStateKey = keyof EngineStateShape;

/**
 * State that belongs to the person operating, not the radio: kept per user (stored as
 * "u:<userId>:<key>"), so each operator finds their contest, keys, slots, last contact,
 * LoTW certificate and sync cursors as they left them.
 */
export const PERSONAL_STATE: ReadonlySet<EngineStateKey> = new Set<EngineStateKey>([
  "contest",
  "fkeys",
  "keyContext",
  "jttyContext",
  "houndMode",
  "cqSlot",
  "huntSlot",
  "myFreqs",
  "lastQso",
  "lotwCert",
  "lotwLastQslSince",
  "eqslLastRcvd",
  "qrzLastLogId",
  "qrzModSince",
  "qrzResumeAfter",
  "servicePause",
  "heardLastQueryAt",
  "digestLastAt",
]);

export const userStateKey = (userId: string, key: string) => `u:${userId}:${key}`;

export class EngineState {
  /** Whose personal state get/set use: the operator (the engine), or a fixed user (forUser). */
  owner: () => string | null = () => null;

  constructor(private readonly db: Db) {}

  /** The same store, reading and writing one user's personal state. */
  forUser(userId: string | null): EngineState {
    const s = new EngineState(this.db);
    s.owner = () => userId;
    return s;
  }

  private stored(key: EngineStateKey): string {
    const who = PERSONAL_STATE.has(key) ? this.owner() : null;
    return who ? userStateKey(who, key) : key;
  }

  get<K extends EngineStateKey>(key: K): EngineStateShape[K] | undefined {
    const row = this.db.select().from(engineState).where(eq(engineState.key, this.stored(key))).get();
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as EngineStateShape[K];
    } catch {
      return undefined;
    }
  }

  set<K extends EngineStateKey>(key: K, value: EngineStateShape[K] | null): void {
    const k = this.stored(key);
    if (value === null) {
      this.db.delete(engineState).where(eq(engineState.key, k)).run();
      return;
    }
    const v = JSON.stringify(value);
    const now = Date.now();
    this.db
      .insert(engineState)
      .values({ key: k, value: v, updatedAt: now })
      .onConflictDoUpdate({ target: engineState.key, set: { value: v, updatedAt: now } })
      .run();
  }
}
