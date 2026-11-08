/**
 * Zerobeat data model (SQLite via Drizzle).
 *
 * Design rules:
 *  - Configuration lives in `settings`; runtime state the engine needs across restarts
 *    lives in `engine_state`. They were one table before and it made backups, audits and
 *    "what did the operator actually change" impossible to answer.
 *  - A contact's upload status per service is a ROW in `upload_state`, not a boolean column
 *    per service on the contact. Adding a service is a new enum value, not a migration, and
 *    "what still needs sending" is one indexed query.
 *  - Received confirmations (LoTW, eQSL, QRZ) stay on the contact because awards read them.
 *  - Timestamps are integer unix milliseconds (UTC). The log is UTC everywhere.
 *  - Frequencies are integer Hz.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch('subsec') * 1000)`;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    callsign: text("callsign"),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ROLES }).notNull().default("VIEWER"),
    /** US license class (T, G, A, E), or null: not checked. See ham/privileges.ts. */
    licenseClass: text("license_class"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastLoginAt: integer("last_login_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /** SHA-256 hex of the cookie token. The raw token exists only in the browser. */
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    lastSeenAt: integer("last_seen_at").notNull().default(now),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [
    uniqueIndex("sessions_token_uq").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

/** Login throttle, persisted so a restart does not clear a lockout. */
export const loginAttempts = sqliteTable("login_attempts", {
  /** `ip:<addr>` or `user:<email>`. */
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lockedUntil: integer("locked_until"),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, for telling keys apart in a list. */
    prefix: text("prefix").notNull(),
    role: text("role", { enum: ROLES }).notNull().default("VIEWER"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    expiresAt: integer("expires_at"),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("api_keys_token_uq").on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Configuration and runtime state
// ---------------------------------------------------------------------------

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** Plaintext, or `v1:<iv>:<tag>:<ciphertext>` when `encrypted`. */
  value: text("value").notNull(),
  encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull().default(now),
  updatedBy: text("updated_by"),
});

/**
 * A user's own settings: the ones the registry marks personal (their service accounts,
 * QSL email, hunting rules…). The shack's settings stay in `settings`.
 */
export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Engine runtime state that must survive a restart: last tune, auto run, caches. JSON. */
export const engineState = sqliteTable("engine_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// Station and log
// ---------------------------------------------------------------------------

export const stations = sqliteTable(
  "stations",
  {
    id: text("id").primaryKey(),
    callsign: text("callsign").notNull(),
    grid: text("grid").notNull(),
    /** Free text: "Home", "Portable". */
    name: text("name"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** The user whose station (callsign and logbook) this is. One each. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("stations_callsign_idx").on(t.callsign), uniqueIndex("stations_user_uq").on(t.userId)],
);

export const operators = sqliteTable(
  "operators",
  {
    id: text("id").primaryKey(),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    callsign: text("callsign").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("operators_station_idx").on(t.stationId)],
);

export const QSL_STATUS = ["NONE", "REQUESTED", "SENT", "CONFIRMED"] as const;
export type QslStatus = (typeof QSL_STATUS)[number];
export const QSL_ROUTE = ["BUREAU", "DIRECT", "ELECTRONIC", "MANAGER"] as const;
export type QslRoute = (typeof QSL_ROUTE)[number];

export const qsos = sqliteTable(
  "qsos",
  {
    id: text("id").primaryKey(),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id),
    operatorId: text("operator_id").references(() => operators.id, { onDelete: "set null" }),
    /** Browser-chosen idempotency key for manual entry; null for everything else. */
    clientId: text("client_id"),

    callsign: text("callsign").notNull(),
    band: text("band").notNull(),
    freqHz: integer("freq_hz").notNull(),
    mode: text("mode").notNull(),
    submode: text("submode"),
    startTime: integer("start_time").notNull(),
    endTime: integer("end_time"),
    rstSent: text("rst_sent"),
    rstRcvd: text("rst_rcvd"),
    txPowerW: integer("tx_power_w"),

    // The other station.
    grid: text("grid"),
    name: text("name"),
    qth: text("qth"),
    dxcc: integer("dxcc"),
    state: text("state"),
    county: text("county"),
    cqZone: integer("cq_zone"),
    ituZone: integer("itu_zone"),
    iota: text("iota"),
    continent: text("continent"),
    /** Their special activity: ADIF SIG / SIG_INFO (primary reference; all in qso_sig_refs). */
    sig: text("sig"),
    sigInfo: text("sig_info"),

    // Our side, when it differs from the station row.
    mySig: text("my_sig"),
    mySigInfo: text("my_sig_info"),
    myGrid: text("my_grid"),
    /** The radio that keyed, as it identified itself. Null for manual/imported contacts. */
    radio: text("radio"),

    // Paper/electronic QSL.
    qslSent: text("qsl_sent", { enum: QSL_STATUS }).notNull().default("NONE"),
    qslRcvd: text("qsl_rcvd", { enum: QSL_STATUS }).notNull().default("NONE"),
    qslSentAt: integer("qsl_sent_at"),
    qslRcvdAt: integer("qsl_rcvd_at"),
    qslSentVia: text("qsl_sent_via", { enum: QSL_ROUTE }),
    qslRcvdVia: text("qsl_rcvd_via", { enum: QSL_ROUTE }),

    // Confirmations received from services (awards read these).
    lotwRcvd: integer("lotw_rcvd", { mode: "boolean" }).notNull().default(false),
    lotwRcvdAt: integer("lotw_rcvd_at"),
    eqslRcvd: integer("eqsl_rcvd", { mode: "boolean" }).notNull().default(false),
    qrzRcvd: integer("qrz_rcvd", { mode: "boolean" }).notNull().default(false),
    /** QRZ Logbook's own record id, for differential download. */
    qrzLogId: integer("qrz_log_id"),

    /** ADIF PROP_MODE (SAT, EME, ES, ...) and SAT_NAME. */
    propMode: text("prop_mode"),
    satName: text("sat_name"),
    email: text("email"),
    notes: text("notes"),
    /** Every ADIF field from an import that has no column here, as JSON, so export round-trips. */
    extras: text("extras"),
    /** The full digital exchange, one message per line. Native digital contacts only. */
    transcript: text("transcript"),

    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("qsos_client_id_uq").on(t.clientId),
    index("qsos_callsign_idx").on(t.callsign),
    index("qsos_start_idx").on(t.startTime),
    index("qsos_call_band_mode_idx").on(t.callsign, t.band, t.mode),
    index("qsos_band_mode_idx").on(t.band, t.mode),
    index("qsos_dxcc_idx").on(t.dxcc),
    index("qsos_grid_idx").on(t.grid),
    index("qsos_state_idx").on(t.state),
    index("qsos_sig_info_idx").on(t.sigInfo),
    index("qsos_my_sig_info_idx").on(t.mySigInfo, t.startTime),
    index("qsos_station_idx").on(t.stationId),
  ],
);

/** Every special-activity reference on a contact (n-fers), primary included. */
export const qsoSigRefs = sqliteTable(
  "qso_sig_refs",
  {
    qsoId: text("qso_id")
      .notNull()
      .references(() => qsos.id, { onDelete: "cascade" }),
    sig: text("sig").notNull(),
    ref: text("ref").notNull(),
  },
  (t) => [primaryKey({ columns: [t.qsoId, t.sig, t.ref] }), index("qso_sig_refs_ref_idx").on(t.sig, t.ref)],
);

// ---------------------------------------------------------------------------
// Outbound services
// ---------------------------------------------------------------------------

export const UPLOAD_SERVICES = ["qrz", "lotw", "eqsl", "clublog", "wrl", "n3fjp"] as const;
export type UploadService = (typeof UPLOAD_SERVICES)[number];
export const UPLOAD_STATUS = ["pending", "sent", "failed", "skipped"] as const;
export type UploadStatus = (typeof UPLOAD_STATUS)[number];

/**
 * One row per (contact, service). `pending` rows are the work queue. `failed` means the
 * service rejected THIS contact (bad data); transport failures stay `pending` with a
 * `nextAttemptAt` in the future and are retried with backoff. `skipped` is an operator
 * decision.
 */
export const uploadState = sqliteTable(
  "upload_state",
  {
    qsoId: text("qso_id")
      .notNull()
      .references(() => qsos.id, { onDelete: "cascade" }),
    service: text("service", { enum: UPLOAD_SERVICES }).notNull(),
    status: text("status", { enum: UPLOAD_STATUS }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    sentAt: integer("sent_at"),
    lastError: text("last_error"),
    /** Whatever the service handed back that identifies the record. */
    remoteId: text("remote_id"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.qsoId, t.service] }),
    index("upload_state_queue_idx").on(t.service, t.status, t.nextAttemptAt),
  ],
);

// ---------------------------------------------------------------------------
// Digital
// ---------------------------------------------------------------------------

export const decodes = sqliteTable(
  "decodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Start of the receive window (unix ms). */
    at: integer("at").notNull(),
    mode: text("mode").notNull(),
    band: text("band").notNull(),
    /** Dial frequency in Hz. */
    dialHz: integer("dial_hz").notNull(),
    /** Audio offset in Hz within the passband. */
    audioHz: integer("audio_hz").notNull(),
    snr: integer("snr").notNull(),
    /** Time offset in ms as reported by the decoder. */
    dtMs: integer("dt_ms").notNull(),
    message: text("message").notNull(),
    /** Sender callsign when the message grammar yields one. */
    callsign: text("callsign"),
    grid: text("grid"),
    isCq: integer("is_cq", { mode: "boolean" }).notNull().default(false),
    loggedQsoId: text("logged_qso_id").references(() => qsos.id, { onDelete: "set null" }),
  },
  (t) => [index("decodes_at_idx").on(t.at), index("decodes_band_at_idx").on(t.band, t.at), index("decodes_call_idx").on(t.callsign)],
);

/**
 * A digital exchange that got as far as a report but not a sign-off. Not a contact;
 * the operator decides, on the Incomplete page, whether to promote or discard it.
 */
export const incompleteExchanges = sqliteTable(
  "incomplete_exchanges",
  {
    id: text("id").primaryKey(),
    stationId: text("station_id")
      .notNull()
      .references(() => stations.id),
    callsign: text("callsign").notNull(),
    band: text("band").notNull(),
    freqHz: integer("freq_hz").notNull(),
    mode: text("mode").notNull(),
    startTime: integer("start_time").notNull(),
    rstSent: text("rst_sent"),
    rstRcvd: text("rst_rcvd"),
    grid: text("grid"),
    /** What was exchanged and why it stopped. */
    transcript: text("transcript"),
    reason: text("reason").notNull(),
    resolvedAt: integer("resolved_at"),
    promotedQsoId: text("promoted_qso_id").references(() => qsos.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("incomplete_unresolved_idx").on(t.resolvedAt, t.startTime)],
);

export const DNC_KIND = ["never", "today", "pirate", "manual"] as const;
export const doNotCall = sqliteTable("do_not_call", {
  callsign: text("callsign").primaryKey(),
  kind: text("kind", { enum: DNC_KIND }).notNull().default("manual"),
  note: text("note"),
  /** Null = permanent. */
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// QSL
// ---------------------------------------------------------------------------

export const QSL_EMAIL_STATUS = ["queued", "approved", "sent", "failed", "cancelled"] as const;
export type QslEmailStatus = (typeof QSL_EMAIL_STATUS)[number];

export const qslEmails = sqliteTable(
  "qsl_emails",
  {
    id: text("id").primaryKey(),
    qsoId: text("qso_id")
      .notNull()
      .references(() => qsos.id, { onDelete: "cascade" }),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: QSL_EMAIL_STATUS }).notNull().default("queued"),
    approvedById: text("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    sentAt: integer("sent_at"),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("qsl_emails_status_idx").on(t.status, t.createdAt), index("qsl_emails_qso_idx").on(t.qsoId)],
);

export const QSL_OPTOUT_SOURCE = ["unsubscribe", "bounce", "manual"] as const;
export const qslOptOuts = sqliteTable("qsl_opt_outs", {
  /** Callsign (uppercase) or an email address (lowercase). */
  target: text("target").primaryKey(),
  source: text("source", { enum: QSL_OPTOUT_SOURCE }).notNull(),
  note: text("note"),
  createdAt: integer("created_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// Station memory
// ---------------------------------------------------------------------------

/** One automatic operating run: from switching a mode on to switching it off. */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    /** Who or what started it: an operator's email, "schedule: …", "resume after restart". */
    startedBy: text("started_by").notNull(),
    /** Whose station (and logbook) the run was for. */
    stationId: text("station_id").references(() => stations.id, { onDelete: "set null" }),
    stopReason: text("stop_reason"),
    /** JSON: modes used in order, e.g. ["hunt","cq"]. */
    modes: text("modes").notNull().default("[]"),
    /** JSON: bands visited. */
    bands: text("bands").notNull().default("[]"),
    qsos: integer("qsos").notNull().default(0),
    /** JSON: [{kind:"dxcc"|"band"|"zone"|"park"|"grid", label, callsign}] */
    newOnes: text("new_ones").notNull().default("[]"),
    transmissions: integer("transmissions").notNull().default(0),
    txSeconds: integer("tx_seconds").notNull().default(0),
    /** JSON: [{at, reason}] */
    faults: text("faults").notNull().default("[]"),
  },
  (t) => [index("runs_started_idx").on(t.startedAt)],
);

/**
 * What the receiver heard, summarised per UTC hour, band, mode and continent. Kept
 * forever (a few hundred rows a day) so the station learns when its bands open.
 * continent "*" rows carry the number of windows decoded in that hour.
 */
export const bandHours = sqliteTable(
  "band_hours",
  {
    hour: integer("hour").notNull(),
    band: text("band").notNull(),
    mode: text("mode").notNull(),
    continent: text("continent").notNull(),
    windows: integer("windows").notNull().default(0),
    decodes: integer("decodes").notNull().default(0),
    stations: integer("stations").notNull().default(0),
    bestSnr: integer("best_snr"),
  },
  (t) => [primaryKey({ columns: [t.hour, t.band, t.mode, t.continent] })],
);

/**
 * Which DXCC entities the receiver hears, by band, mode and UTC hour of the day, kept
 * forever: a few thousand rows at most. Band memory says when a band opens to a
 * continent; this says when it opens to Bhutan. "days" counts the distinct UTC days.
 */
export const heardEntities = sqliteTable(
  "heard_entities",
  {
    dxcc: integer("dxcc").notNull(),
    band: text("band").notNull(),
    mode: text("mode").notNull(),
    /** UTC hour of the day, 0-23. */
    hourOfDay: integer("hour_of_day").notNull(),
    decodes: integer("decodes").notNull().default(0),
    days: integer("days").notNull().default(0),
    /** The last UTC day heard (days since 1970), for counting days. */
    lastDay: integer("last_day").notNull().default(0),
    bestSnr: integer("best_snr"),
    firstAt: integer("first_at").notNull(),
    lastAt: integer("last_at").notNull(),
    lastCall: text("last_call"),
  },
  (t) => [primaryKey({ columns: [t.dxcc, t.band, t.mode, t.hourOfDay] })],
);

/** PSKReporter reports of our own signal. */
export const heardReports = sqliteTable(
  "heard_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    receiver: text("receiver").notNull(),
    grid: text("grid"),
    freqHz: integer("freq_hz").notNull(),
    band: text("band").notNull(),
    mode: text("mode").notNull(),
    snr: integer("snr"),
    distanceKm: integer("distance_km"),
    dxcc: integer("dxcc"),
    continent: text("continent"),
  },
  (t) => [uniqueIndex("heard_reports_uq").on(t.receiver, t.at, t.band), index("heard_reports_at_idx").on(t.at)],
);

/** Web Push subscriptions, one per browser a user enabled notifications in. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** JSON array of categories: "needed", "faults", "digest". */
    categories: text("categories").notNull().default('["needed","faults","digest"]'),
    label: text("label"),
    createdAt: integer("created_at").notNull().default(now),
    lastOkAt: integer("last_ok_at"),
    failures: integer("failures").notNull().default(0),
  },
  (t) => [uniqueIndex("push_endpoint_uq").on(t.endpoint)],
);

/**
 * Radio time booked by an operator: while they are signed in during it, the radio is theirs
 * (see radio/bookings.ts). Times are ms; start inclusive, end exclusive.
 */
export const radioBookings = sqliteTable(
  "radio_bookings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("radio_bookings_start_idx").on(t.startsAt)],
);

export type RadioBookingRow = typeof radioBookings.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type HeardReport = typeof heardReports.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Station = typeof stations.$inferSelect;
export type Operator = typeof operators.$inferSelect;
export type Qso = typeof qsos.$inferSelect;
export type NewQso = typeof qsos.$inferInsert;
export type Decode = typeof decodes.$inferSelect;
export type UploadStateRow = typeof uploadState.$inferSelect;
export type QslEmail = typeof qslEmails.$inferSelect;
export type IncompleteExchange = typeof incompleteExchanges.$inferSelect;
