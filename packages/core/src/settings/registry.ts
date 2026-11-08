/**
 * Every operator-facing setting, in one typed table.
 *
 * This registry holds configuration only, about seventy keys, and each one is something
 * an operator would plausibly change. Runtime state
 * (last tune, auto run start, sync cursors) lives in the `engine_state` table.
 *
 * Each entry carries its type, default, validation, UI group and help text, so the
 * settings page, the API and the engine all read the same definition.
 */
import { z } from "zod";

export type SettingKind = "string" | "secret" | "number" | "boolean" | "select" | "text";

export interface SettingDef<T = unknown> {
  key: string;
  group: SettingGroup;
  label: string;
  help?: string;
  kind: SettingKind;
  default: T;
  schema: z.ZodType<T, any>;
  options?: { value: string; label: string }[];
  placeholder?: string;
  unit?: string;
  /** Show only when other settings have these values (e.g. ICOM LAN fields for a networked ICOM). */
  when?: { key: string; is: string }[];
  /** A special editor on the settings page instead of the plain input. */
  widget?: "wrl-logbook";
}

export const SETTING_GROUPS = [
  { id: "general", label: "General", description: "Site address, sessions and data retention." },
  { id: "radio", label: "Radio", description: "Which radio, how to reach it, power and antennas." },
  { id: "operating", label: "Operating", description: "Automatic operating: who to call, limits and safety brakes." },
  { id: "schedule", label: "Schedule", description: "When automatic operating runs, quiet hours and PA rest." },
  { id: "services", label: "Logbook services", description: "QRZ, LoTW, eQSL, Club Log, World Radio League, N3FJP, PSKReporter and the UDP feed for other station software." },
  { id: "email", label: "Alerts & email", description: "What the station tells you about, and the mail server it uses. Phone notifications are set up per device at the bottom of this page." },
  { id: "qsl", label: "QSL", description: "Emailed QSL cards." },
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number]["id"];

/**
 * Sections split a long group into one collapsible block per thing (one per logbook
 * service). A setting belongs to the first section whose prefixes match its key. The
 * section's `toggle` setting is shown in its header, so a service can be switched on or
 * off without opening it.
 */
export interface SettingSection {
  id: string;
  group: SettingGroup;
  label: string;
  description: string;
  prefixes: string[];
  toggle?: string;
}

export const SETTING_SECTIONS: SettingSection[] = [
  { id: "js8", group: "operating", label: "JS8", description: "JS8Call's keyboard network: speed, automatic replies, heartbeats and what you tell stations that ask.", prefixes: ["js8."], toggle: "js8.autoReply" },
  { id: "qrz", group: "services", label: "QRZ", description: "Callsign lookups and the QRZ Logbook.", prefixes: ["qrz.", "uploads.qrz"], toggle: "uploads.qrz" },
  { id: "lotw", group: "services", label: "LoTW", description: "Logbook of The World uploads and confirmations.", prefixes: ["lotw.", "uploads.lotw"], toggle: "uploads.lotw" },
  { id: "eqsl", group: "services", label: "eQSL", description: "eQSL.cc uploads and confirmations.", prefixes: ["eqsl.", "uploads.eqsl"], toggle: "uploads.eqsl" },
  { id: "clublog", group: "services", label: "Club Log", description: "Club Log uploads.", prefixes: ["clublog.", "uploads.clublog"], toggle: "uploads.clublog" },
  { id: "wrl", group: "services", label: "World Radio League", description: "WRL logbook uploads through its API.", prefixes: ["wrl.", "uploads.wrl"], toggle: "uploads.wrl" },
  { id: "n3fjp", group: "services", label: "N3FJP", description: "Send contacts to N3FJP Amateur Contact Log over its TCP API.", prefixes: ["n3fjp.", "uploads.n3fjp"], toggle: "uploads.n3fjp" },
  { id: "pskreporter", group: "services", label: "PSKReporter", description: "Report what this station decodes.", prefixes: ["pskreporter."], toggle: "pskreporter.enabled" },
  { id: "spots", group: "services", label: "DX cluster and RBN", description: "Spots from a DX cluster node and the Reverse Beacon Network, read-only: shown on Operate, used by the hunt and the needed alerts.", prefixes: ["spots."] },
  { id: "wspr", group: "services", label: "WSPR and WSPRnet", description: "Beacon and listen in WSPR (pick WSPR on Operate), and report what this station hears to WSPRnet.", prefixes: ["wspr."], toggle: "wspr.upload" },
  { id: "udp", group: "services", label: "UDP feed", description: "GridTracker, Log4OM, N1MM Logger+ and anything else that listens for WSJT-X.", prefixes: ["udp."], toggle: "udp.enabled" },
];

export function sectionFor(key: string, group: string): SettingSection | null {
  return SETTING_SECTIONS.find((s) => s.group === group && s.prefixes.some((p) => key.startsWith(p))) ?? null;
}

const str = (max = 200) => z.string().trim().max(max);
const bool = z.boolean();
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const num = (min: number, max: number) => z.number().min(min).max(max);
const bandList = z
  .string()
  .trim()
  .max(120)
  .regex(/^$|^[0-9.]+C?M(\s*,\s*[0-9.]+C?M)*$/i, "Comma-separated bands, e.g. 40M,20M,15M")
  .transform((s) => s.toUpperCase().replace(/\s+/g, ""));
const HHMM_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const BLOCK = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d=(hunt|hunt-pota|pota-chase|cq)$/;

function def<const K extends string, T>(d: SettingDef<T> & { key: K }): SettingDef<T> & { key: K } {
  return d;
}

export const SETTINGS = [
  // ---------------------------------------------------------------- general
  def({
    key: "app.publicUrl",
    group: "general",
    label: "Public URL",
    help: "Where this site is reached, e.g. https://zerobeat.example.com. Used in QSL unsubscribe links and password-reset email; never taken from the request.",
    kind: "string",
    default: "",
    placeholder: "https://zerobeat.example.com",
    schema: z.union([z.literal(""), z.string().trim().url().max(200).transform((s) => s.replace(/\/+$/, ""))]),
  }),
  def({
    key: "app.backupCopyDir",
    group: "general",
    label: "Also copy the nightly backup to",
    help: "A folder on another disk or a network share (it must exist and the engine's user must be able to write it). The last 14 are kept there too. Empty keeps backups only in the data folder, on the same disk as the database.",
    kind: "string",
    default: "",
    placeholder: "/mnt/nas/zerobeat",
    schema: z.union([z.literal(""), z.string().trim().max(300).regex(/^\//, "use an absolute path")]),
  }),
  def({
    key: "app.distanceUnit",
    group: "general",
    label: "Show distances in",
    kind: "select",
    default: "mi",
    options: [
      { value: "mi", label: "Miles" },
      { value: "km", label: "Kilometres" },
    ],
    schema: z.enum(["mi", "km"]),
  }),
  def({ key: "app.sessionDays", group: "general", label: "Stay signed in for", kind: "number", unit: "days", default: 30, schema: int(1, 365) }),
  def({
    key: "app.decodeRetentionDays",
    group: "general",
    label: "Keep decodes for",
    help: "Decodes that belong to a logged contact are kept forever.",
    kind: "number",
    unit: "days",
    default: 14,
    schema: int(1, 365),
  }),

  // ---------------------------------------------------------------- spots
  def({ key: "spots.cluster.enabled", group: "services", label: "Connect to a DX cluster", help: "A telnet DX cluster node. The station only logs in with its callsign and reads spots; it never posts any.", kind: "boolean", default: false, schema: bool }),
  def({ key: "spots.cluster.host", when: [{ key: "spots.cluster.enabled", is: "true" }], group: "services", label: "Cluster address", kind: "string", default: "dxc.nc7j.com", schema: str(120) }),
  def({ key: "spots.cluster.port", when: [{ key: "spots.cluster.enabled", is: "true" }], group: "services", label: "Cluster port", kind: "number", default: 7373, schema: int(1, 65535) }),
  def({ key: "spots.rbn.digital", group: "services", label: "Reverse Beacon Network: FT8 and FT4 spots", help: "telnet.reversebeacon.net port 7001: skimmers worldwide reporting FT8/FT4 stations, including you.", kind: "boolean", default: false, schema: bool }),
  def({ key: "spots.rbn.cw", group: "services", label: "Reverse Beacon Network: CW and RTTY spots", help: "telnet.reversebeacon.net port 7000.", kind: "boolean", default: false, schema: bool }),
  def({ key: "spots.login", group: "services", label: "Log in as", help: "Blank uses the station callsign.", kind: "string", default: "", schema: str(16) }),
  def({ key: "spots.alertNeeded", group: "services", label: "Alert when a needed station is spotted", help: "Uses the same rule as \"Needed stations\" in Alerts: a spot of a new entity (or zone, band…) on any band, not only the one the radio is on.", kind: "boolean", default: true, schema: bool }),

  // ---------------------------------------------------------------- js8
  def({
    key: "js8.submode",
    group: "operating",
    label: "JS8 speed",
    help: "Normal (15 s frames) is what most stations use; Slow reaches further, Fast and Turbo move more text.",
    kind: "select",
    default: "normal",
    options: [
      { value: "normal", label: "Normal (15 s, -24 dB)" },
      { value: "fast", label: "Fast (10 s)" },
      { value: "turbo", label: "Turbo (6 s)" },
      { value: "slow", label: "Slow (30 s, -28 dB)" },
    ],
    schema: z.enum(["normal", "fast", "turbo", "slow"]),
  }),
  def({ key: "js8.autoReply", group: "operating", label: "Answer queries automatically", help: "As JS8Call's AUTO: answer SNR?, GRID?, INFO?, STATUS?, HEARING?, QUERY MSGS, store messages left for you or for others with an ACK, and repeat on AGN?. Needs transmit on.", kind: "boolean", default: false, schema: bool }),
  def({ key: "js8.hbAck", group: "operating", label: "Acknowledge heartbeats", help: "Reply HEARTBEAT SNR to stations' heartbeats, as JS8Call's heartbeat acknowledgements.", kind: "boolean", default: false, schema: bool }),
  def({ key: "js8.hbMinutes", group: "operating", label: "Send a heartbeat every", help: "0: only when you press HB. Timed heartbeats start after you press HB once, and wait for that again after a restart.", kind: "number", unit: "min", default: 0, schema: int(0, 240) }),
  def({ key: "js8.info", group: "operating", label: "INFO reply", help: "What you send when asked INFO?, e.g. your rig and antenna.", kind: "string", default: "", schema: str(60) }),
  def({ key: "js8.status", group: "operating", label: "STATUS reply", help: "What you send when asked STATUS?.", kind: "string", default: "", schema: str(60) }),
  def({ key: "js8.groups", group: "operating", label: "Groups", help: "Groups you answer as well as @ALLCALL, comma separated, e.g. @GROUP/1, @ARES.", kind: "string", default: "", schema: str(120) }),

  // ---------------------------------------------------------------- wspr
  def({ key: "wspr.upload", group: "services", label: "Report spots to WSPRnet", help: "Each decoded WSPR station, and a status report for quiet periods, as WSJT-X sends them to wsprnet.org.", kind: "boolean", default: false, schema: bool }),
  def({ key: "wspr.txPct", group: "services", label: "Transmit in this share of periods", help: "0 only listens (the default). 20 % is WSJT-X's usual choice: a two-minute beacon every five periods or so, at random so stations do not collide.", kind: "number", unit: "%", default: 0, schema: int(0, 100) }),
  def({ key: "wspr.dbm", group: "services", label: "Power to report", help: "What the beacon says it is sending, in dBm: 30 is 1 W, 37 is 5 W, 40 is 10 W. Set the radio's power to match.", kind: "number", unit: "dBm", default: 30, schema: int(0, 60) }),

  // ---------------------------------------------------------------- radio
  def({
    key: "radio.type",
    group: "radio",
    label: "Radio",
    kind: "select",
    default: "flex",
    options: [
      { value: "flex", label: "FlexRadio (network)" },
      { value: "icom", label: "ICOM (IC-7300MK2, IC-7300, IC-705, IC-9700)" },
      { value: "hamlib", label: "Other radio, through Hamlib (Yaesu, Kenwood, Elecraft, Xiegu…)" },
    ],
    schema: z.enum(["flex", "icom", "hamlib"]),
  }),
  def({
    key: "radio.host", when: [{ key: "radio.type", is: "flex" }],
    group: "radio",
    label: "FlexRadio address",
    help: "IP address or hostname. Leave blank to find the radio by its LAN broadcast; the last address that worked is remembered either way.",
    kind: "string",
    default: "",
    placeholder: "192.168.0.105",
    schema: str(120),
  }),
  def({ key: "radio.daxChannel", when: [{ key: "radio.type", is: "flex" }], group: "radio", label: "FlexRadio DAX channel", kind: "number", default: 1, schema: int(1, 8) }),
  def({
    key: "icom.connection",
    when: [{ key: "radio.type", is: "icom" }],
    group: "radio",
    label: "ICOM connection",
    help: "Network uses the radio's LAN port and its built-in server, so the radio can be anywhere on the network. USB needs the radio plugged into this server.",
    kind: "select",
    default: "lan",
    options: [
      { value: "lan", label: "Network (the radio's LAN port)" },
      { value: "usb", label: "USB cable to this server" },
    ],
    schema: z.enum(["lan", "usb"]),
  }),
  def({
    key: "icom.host",
    when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "lan" }],
    group: "radio",
    label: "ICOM address",
    help: "The radio's IP address (Menu → Set → Network shows it). A DHCP reservation keeps it from moving.",
    kind: "string",
    default: "",
    placeholder: "192.168.0.120",
    schema: str(120),
  }),
  def({
    key: "icom.port",
    when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "lan" }],
    group: "radio",
    label: "ICOM control port",
    help: "The radio's Network Control Port, 50001 unless changed. The radio picks the CI-V and audio ports itself.",
    kind: "number",
    default: 50001,
    schema: int(1, 65535),
  }),
  def({
    key: "icom.username",
    when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "lan" }],
    group: "radio",
    label: "ICOM network username",
    help: "Menu → Set → Network → Network User1 ID.",
    kind: "string",
    default: "",
    schema: str(16),
  }),
  def({
    key: "icom.password",
    when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "lan" }],
    group: "radio",
    label: "ICOM network password",
    help: "Network User1 password. ICOM's protocol only scrambles it, so keep the radio on your LAN; never forward its ports.",
    kind: "secret",
    default: "",
    schema: str(16),
  }),
  def({
    key: "icom.serialPath", when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "usb" }],
    group: "radio",
    label: "ICOM serial port",
    help: "The radio's USB port A. A /dev/serial/by-id/… path survives reboots and other USB devices; /dev/ttyACM0 is usual for the IC-7300MK2, /dev/ttyUSB0 for the original IC-7300.",
    kind: "string",
    default: "/dev/ttyACM0",
    schema: z.string().trim().max(200).regex(/^\/dev\/[A-Za-z0-9._\/:+-]+$/, "a /dev/… path"),
  }),
  def({
    key: "icom.baud", when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "usb" }],
    group: "radio",
    label: "ICOM CI-V baud rate",
    help: "Must match the radio: Menu → Set → Connectors → CI-V → CI-V USB Baud Rate (with CI-V USB Port set to Unlink from [REMOTE]).",
    kind: "select",
    default: "115200",
    options: ["115200", "57600", "38400", "19200", "9600"].map((v) => ({ value: v, label: v })),
    schema: z.enum(["115200", "57600", "38400", "19200", "9600"]),
  }),
  def({
    key: "icom.civAddress", when: [{ key: "radio.type", is: "icom" }],
    group: "radio",
    label: "ICOM CI-V address",
    help: "Hex. IC-7300MK2 B6, IC-7300 94, IC-705 A4, IC-9700 A2.",
    kind: "string",
    default: "B6",
    schema: z.string().trim().regex(/^[0-9A-Fa-f]{2}$/, "two hex digits, like B6"),
  }),
  def({
    key: "icom.audioDevice", when: [{ key: "radio.type", is: "icom" }, { key: "icom.connection", is: "usb" }],
    group: "radio",
    label: "ICOM sound card",
    help: "ALSA device of the radio's USB audio. plughw:CARD=CODEC,DEV=0 is the IC-7300 family's card; run arecord -l on the server to list others.",
    kind: "string",
    default: "plughw:CARD=CODEC,DEV=0",
    schema: z.string().trim().min(2).max(120).regex(/^[A-Za-z0-9_:=,.-]+$/, "an ALSA device name"),
  }),
  def({
    key: "hamlib.model",
    when: [{ key: "radio.type", is: "hamlib" }],
    group: "radio",
    label: "Hamlib model number",
    help: "The engine starts rigctld for this model (rigctl -l lists them: Yaesu FT-991A 1035, FT-710 1049, Kenwood TS-590SG 2037, Elecraft K3 2029, Xiegu G90 3088). 0 connects to a rigctld you run yourself.",
    kind: "number",
    default: 0,
    schema: int(0, 99999),
  }),
  def({
    key: "hamlib.device",
    when: [{ key: "radio.type", is: "hamlib" }],
    group: "radio",
    label: "Radio serial port",
    help: "The radio's CAT port. A /dev/serial/by-id/… path survives reboots. Not used when the model is 0.",
    kind: "string",
    default: "",
    placeholder: "/dev/serial/by-id/usb-Silicon_Labs_CP2105…-if00-port0",
    schema: str(200),
  }),
  def({ key: "hamlib.baud", when: [{ key: "radio.type", is: "hamlib" }], group: "radio", label: "CAT baud rate", help: "Must match the radio's CAT setting. 0 uses Hamlib's default for the model.", kind: "number", default: 38400, schema: int(0, 1_000_000) }),
  def({
    key: "hamlib.pttMethod",
    when: [{ key: "radio.type", is: "hamlib" }],
    group: "radio",
    label: "PTT",
    help: "How the radio is keyed. CAT works for almost every modern radio; DTR or RTS for an interface that keys on a serial control line.",
    kind: "select",
    default: "cat",
    options: [
      { value: "cat", label: "CAT command" },
      { value: "dtr", label: "Serial DTR line" },
      { value: "rts", label: "Serial RTS line" },
    ],
    schema: z.enum(["cat", "dtr", "rts"]),
  }),
  def({ key: "hamlib.host", when: [{ key: "radio.type", is: "hamlib" }, { key: "hamlib.model", is: "0" }], group: "radio", label: "rigctld address", help: "Where your rigctld runs, when the engine does not start one.", kind: "string", default: "127.0.0.1", schema: str(200) }),
  def({ key: "hamlib.port", when: [{ key: "radio.type", is: "hamlib" }], group: "radio", label: "rigctld port", kind: "number", default: 4532, schema: int(1, 65535) }),
  def({
    key: "hamlib.audioDevice",
    when: [{ key: "radio.type", is: "hamlib" }],
    group: "radio",
    label: "Radio sound card",
    help: "ALSA device of the radio's USB audio or interface (a SignaLink, the radio's own USB CODEC). arecord -l on the server lists them; plughw:CARD=CODEC,DEV=0 is common.",
    kind: "string",
    default: "plughw:CARD=CODEC,DEV=0",
    schema: str(120),
  }),
  def({ key: "hamlib.ratedWatts", when: [{ key: "radio.type", is: "hamlib" }], group: "radio", label: "Rated power", help: "Full output, used to turn a 0–1 power meter into watts on radios whose Hamlib driver has no watts reading.", kind: "number", unit: "W", default: 100, schema: int(1, 2000) }),
  def({ key: "icom.ratedWatts", when: [{ key: "radio.type", is: "icom" }], group: "radio", label: "ICOM rated power", help: "Full output, used to turn the power meter into watts.", kind: "number", unit: "W", default: 100, schema: int(1, 2000) }),
  def({
    key: "radio.allowTransmit",
    group: "radio",
    label: "Allow transmit",
    help: "Master switch, checked before every transmission. FT-0 turns it off.",
    kind: "boolean",
    default: false,
    schema: bool,
  }),
  def({
    key: "radio.rfPowerPct",
    group: "radio",
    label: "RF power",
    help: "Percent of the radio's rated output. Applied when the engine connects.",
    kind: "number",
    unit: "%",
    default: 30,
    schema: int(1, 100),
  }),
  def({ key: "radio.atuOnBandChange", group: "radio", label: "Run the ATU after a band change", kind: "boolean", default: false, schema: bool }),
  def({
    key: "radio.rxAntenna", when: [{ key: "radio.type", is: "flex" }],
    group: "radio",
    label: "Receive antenna",
    help: "Port name as the radio lists it (ANT1, ANT2, RX_A). Blank leaves the slice as it is.",
    kind: "string",
    default: "",
    schema: str(16),
  }),
  def({ key: "radio.txAntenna", when: [{ key: "radio.type", is: "flex" }], group: "radio", label: "Transmit antenna", kind: "string", default: "", schema: str(16) }),
  def({
    key: "radio.bandPlan",
    group: "radio",
    label: "Band plan",
    help: "Which dial frequencies the band buttons use. The US plan follows FCC Part 97 (60 m: the 5351.5-5366.5 kHz segment and four channels); the IARU regions use their own lists (Region 3 FT4 on 80 m, 4 m in Region 1).",
    kind: "select",
    default: "us",
    options: [
      { value: "us", label: "United States" },
      { value: "r1", label: "IARU Region 1 (Europe, Africa, Middle East)" },
      { value: "r2", label: "IARU Region 2 (the Americas, outside the US)" },
      { value: "r3", label: "IARU Region 3 (Asia and the Pacific)" },
    ],
    schema: z.enum(["us", "r1", "r2", "r3"]),
  }),
  def({
    key: "radio.decodeDepth",
    group: "radio",
    label: "Decode depth",
    help: "Deep finds a few weaker signals and spends more CPU per window.",
    kind: "select",
    default: "2",
    options: [
      { value: "1", label: "Fast" },
      { value: "2", label: "Normal" },
      { value: "3", label: "Deep" },
    ],
    schema: z.enum(["1", "2", "3"]),
  }),

  // ---------------------------------------------------------------- operating
  def({
    key: "auto.huntNewOnly",
    group: "operating",
    label: "Hunt only stations that are new for something",
    help: "New DXCC, continent, zone, state, grid or park. Off: any callable CQ, best first.",
    kind: "boolean",
    default: true,
    schema: bool,
  }),
  def({ key: "auto.huntMinSnr", group: "operating", label: "Weakest station to call", kind: "number", unit: "dB", default: -20, schema: int(-30, 10) }),
  def({ key: "sstv.keepDays", group: "operating", label: "Keep SSTV pictures for", help: "Received and sent pictures older than this are deleted. About 200 KB each.", kind: "number", unit: "days", default: 90, schema: int(1, 3650) }),
  def({
    key: "auto.cqClearSpot",
    group: "operating",
    label: "Move CQ off a frequency someone else is using in our slot",
    help: "Before each CQ, checks who was heard in our own time slot on our frequency, and moves to the nearest clear spot when it is taken. While no one answers it skips one CQ in four to listen, since a station sharing our slot cannot be heard while we transmit.",
    kind: "boolean",
    default: true,
    schema: bool,
  }),
  def({ key: "auto.callFinishedStations", group: "operating", label: "Call stations that just signed off with someone else", kind: "boolean", default: false, schema: bool }),
  def({
    key: "auto.skipWorkedBandMode",
    group: "operating",
    label: "Never re-work a station on the same band and mode",
    help: "Off: a station becomes callable again after the dupe window.",
    kind: "boolean",
    default: true,
    schema: bool,
  }),
  def({
    key: "auto.dupeWindowHours",
    group: "operating",
    label: "Dupe window",
    help: "Do not work the same station on the same band and mode within this many hours, and never twice in one UTC day.",
    kind: "number",
    unit: "hours",
    default: 24,
    schema: int(0, 720),
  }),
  def({
    key: "auto.maxRepeats",
    group: "operating",
    label: "Give up on a contact after",
    help: "Unanswered repeats of one message.",
    kind: "number",
    unit: "tries",
    default: 4,
    schema: int(2, 10),
  }),
  def({ key: "auto.failureCooldownMin", group: "operating", label: "After a failed contact, leave that station alone for", kind: "number", unit: "min", default: 30, schema: int(0, 1440) }),
  def({ key: "auto.maxRunMinutes", group: "operating", label: "Stop an automatic run after", help: "0 means no limit.", kind: "number", unit: "min", default: 240, schema: int(0, 10080) }),
  def({ key: "auto.maxQsosPerRun", group: "operating", label: "Stop after this many contacts in one run", help: "0 means no limit.", kind: "number", default: 0, schema: int(0, 10000) }),
  def({
    key: "auto.maxUnansweredCqs",
    group: "operating",
    label: "Pause CQ after this many unanswered calls",
    help: "0 means no limit. With band hopping on, a pause moves to the next band instead.",
    kind: "number",
    default: 15,
    schema: int(0, 500),
  }),
  def({ key: "auto.maxSwr", group: "operating", label: "Stop transmitting above SWR", kind: "number", unit: ":1", default: 3, schema: num(1.2, 10) }),
  def({ key: "auto.maxPaTempC", group: "operating", label: "Stop transmitting above PA temperature", help: "FlexRadio only: other radios do not report their PA temperature, so this brake does nothing for them.", kind: "number", unit: "°C", default: 75, schema: int(40, 100) }),
  def({ key: "hop.enabled", group: "operating", label: "Hop bands when a band goes quiet", kind: "boolean", default: false, schema: bool }),
  def({ key: "hop.bands", group: "operating", label: "Bands to hop between", help: "Comma separated, e.g. 40M,20M,15M. Only bands your licence lets you transmit on; leave out the WARC bands (30, 17, 12 m) for contests.", kind: "string", default: "", schema: bandList }),
  def({ key: "pota.chaseBands", group: "operating", label: "POTA chase bands", help: "Blank: only the band the radio is on when chase starts.", kind: "string", default: "", schema: bandList }),
  def({ key: "pota.chaseGiveUpSec", group: "operating", label: "POTA chase: give up on an activator after", kind: "number", unit: "s", default: 90, schema: int(30, 900) }),
  def({ key: "pota.chaseRetryMin", group: "operating", label: "POTA chase: retry a spot after", kind: "number", unit: "min", default: 30, schema: int(1, 600) }),

  // ---------------------------------------------------------------- schedule
  def({ key: "schedule.enabled", group: "schedule", label: "Follow the schedule", kind: "boolean", default: false, schema: bool }),
  def({
    key: "schedule.blocks",
    group: "schedule",
    label: "Blocks",
    help: "Local time, one per line: 08:00-12:00=hunt. Modes: hunt, hunt-pota, pota-chase, cq. The last matching block wins.",
    kind: "text",
    default: "",
    placeholder: "08:00-12:00=hunt\n18:00-22:00=cq",
    schema: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (s) =>
          s
            .split(/[\n,]+/)
            .map((p) => p.trim())
            .filter(Boolean)
            .every((p) => BLOCK.test(p)),
        "Each block is HH:MM-HH:MM=mode",
      ),
  }),
  def({
    key: "schedule.sleep",
    group: "schedule",
    label: "Quiet hours",
    help: "No automatic operating in this range, whatever the blocks say. Blank for none.",
    kind: "string",
    default: "",
    placeholder: "23:00-07:00",
    schema: z.string().trim().refine((s) => s === "" || HHMM_RANGE.test(s), "HH:MM-HH:MM"),
  }),
  def({
    key: "schedule.paOnMinutes",
    group: "schedule",
    label: "Rest the PA after this much keyed time",
    help: "Measured keyed time, not run time. 0 disables PA rest.",
    kind: "number",
    unit: "min",
    default: 0,
    schema: int(0, 600),
  }),
  def({ key: "schedule.paRestMinutes", group: "schedule", label: "PA rest length", kind: "number", unit: "min", default: 10, schema: int(1, 240) }),

  // ---------------------------------------------------------------- services
  def({ key: "qrz.username", group: "services", label: "QRZ username", help: "For callsign lookups (needs a QRZ XML subscription).", kind: "string", default: "", schema: str(64) }),
  def({ key: "qrz.password", group: "services", label: "QRZ password", kind: "secret", default: "", schema: str(128) }),
  def({ key: "qrz.logbookKey", group: "services", label: "QRZ Logbook API key", kind: "secret", default: "", schema: str(64) }),
  def({ key: "uploads.qrz", group: "services", label: "Upload new contacts to QRZ Logbook", kind: "boolean", default: false, schema: bool }),

  def({ key: "lotw.username", group: "services", label: "LoTW username", help: "For downloading confirmations.", kind: "string", default: "", schema: str(64) }),
  def({ key: "lotw.password", group: "services", label: "LoTW password", kind: "secret", default: "", schema: str(128) }),
  def({
    key: "lotw.state",
    group: "services",
    label: "LoTW station US state",
    help: "Two-letter code signed into each upload.",
    kind: "string",
    default: "",
    schema: z.string().trim().toUpperCase().regex(/^$|^[A-Z]{2}$/, "Two letters"),
  }),
  def({ key: "lotw.county", group: "services", label: "LoTW station county", kind: "string", default: "", schema: str(64) }),
  def({ key: "lotw.cqZone", group: "services", label: "LoTW station CQ zone", kind: "number", default: 0, schema: int(0, 40) }),
  def({ key: "lotw.ituZone", group: "services", label: "LoTW station ITU zone", kind: "number", default: 0, schema: int(0, 90) }),
  def({ key: "uploads.lotw", group: "services", label: "Upload new contacts to LoTW", help: "Needs your TQSL certificate, uploaded on the Services page.", kind: "boolean", default: false, schema: bool }),

  def({ key: "eqsl.username", group: "services", label: "eQSL username", kind: "string", default: "", schema: str(64) }),
  def({ key: "eqsl.password", group: "services", label: "eQSL password", kind: "secret", default: "", schema: str(128) }),
  def({
    key: "eqsl.qthNickname",
    group: "services",
    label: "eQSL QTH nickname",
    help: "Leave blank unless your callsign has more than one eQSL account. It must match that account's QTH Nickname exactly; a wrong value makes eQSL answer \"No such Username/Password\".",
    kind: "string",
    default: "",
    schema: str(64),
  }),
  def({ key: "uploads.eqsl", group: "services", label: "Upload new contacts to eQSL", kind: "boolean", default: false, schema: bool }),

  def({ key: "clublog.email", group: "services", label: "Club Log email", kind: "string", default: "", schema: str(120) }),
  def({ key: "clublog.password", group: "services", label: "Club Log password", help: "An application password from clublog.org is best.", kind: "secret", default: "", schema: str(128) }),
  def({ key: "clublog.callsign", group: "services", label: "Club Log callsign", kind: "string", default: "", schema: str(16) }),
  def({
    key: "clublog.apiKey",
    group: "services",
    label: "Club Log API key",
    help: "Required. Club Log refuses uploads without one (a bare 403). Request it from the Club Log helpdesk.",
    kind: "secret",
    default: "",
    schema: str(128),
  }),
  def({ key: "uploads.clublog", group: "services", label: "Upload new contacts to Club Log", kind: "boolean", default: false, schema: bool }),

  def({
    key: "wrl.apiKey",
    group: "services",
    label: "World Radio League API key",
    help: "From World Radio League: Integrations → Developer API. It starts with wrl_live_.",
    kind: "secret",
    default: "",
    schema: str(200),
  }),
  def({
    key: "wrl.logbookId",
    group: "services",
    widget: "wrl-logbook",
    label: "World Radio League logbook",
    help: "Which of your WRL logbooks contacts go to. The list loads from WRL once the API key is entered.",
    kind: "string",
    default: "",
    schema: z.union([z.literal(""), z.string().trim().uuid("not a logbook ID")]),
  }),
  def({ key: "uploads.wrl", group: "services", label: "Upload new contacts to World Radio League", kind: "boolean", default: false, schema: bool }),

  def({ key: "n3fjp.host", group: "services", label: "N3FJP host", help: "The PC running N3FJP Amateur Contact Log with its TCP API enabled.", kind: "string", default: "", schema: str(120) }),
  def({ key: "n3fjp.port", group: "services", label: "N3FJP port", kind: "number", default: 1100, schema: int(1, 65535) }),
  def({ key: "uploads.n3fjp", group: "services", label: "Send new contacts to N3FJP", kind: "boolean", default: false, schema: bool }),

  def({
    key: "udp.targets",
    group: "services",
    label: "UDP feed to other programs",
    help: 'host:port of GridTracker, Log4OM, N1MM Logger+ or anything else that listens for WSJT-X. Separate several with commas. Add "adif" after one to send plain ADIF records instead. Blank turns the feed off.',
    placeholder: "192.168.0.50:2237, 192.168.0.50:2333 adif",
    kind: "string",
    default: "",
    schema: z
      .string()
      .trim()
      .max(300)
      .refine((v) => v.split(/[,;\n]+/).every((x) => !x.trim() || /^[A-Za-z0-9.-]+(:\d{1,5})?(\s+(wsjtx|wsjt-x|adif))?$/i.test(x.trim())), "use host:port, separated by commas"),
  }),
  def({
    key: "udp.enabled",
    group: "services",
    label: "Send the UDP feed",
    help: "Off pauses the feed and keeps the addresses above. The same switch is on the Operate page, in the Automatic card.",
    kind: "boolean",
    default: true,
    schema: bool,
  }),
  def({ key: "udp.name", group: "services", label: "Name for the feed on the Operate page", help: "What the feed goes to, e.g. GridTracker. Empty shows the address.", placeholder: "GridTracker", kind: "string", default: "", schema: str(40) }),
  def({
    key: "udp.clientId",
    group: "services",
    label: "Name the feed as",
    help: "The program name every UDP message carries. Programs that listen for WSJT-X may expect WSJT-X.",
    kind: "select",
    default: "WSJT-X",
    options: [
      { value: "WSJT-X", label: "WSJT-X" },
      { value: "Zerobeat", label: "Zerobeat" },
    ],
    schema: z.enum(["WSJT-X", "Zerobeat"]),
  }),
  def({
    key: "udp.wsjtxVersion",
    group: "services",
    label: "WSJT-X version to report",
    help: "Sent in the feed's heartbeat while it is named WSJT-X. 3.0.2 is the latest full release (June 2026).",
    placeholder: "3.0.2",
    kind: "string",
    default: "3.0.2",
    schema: z.string().trim().regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/, "a version like 3.0.2"),
  }),
  def({ key: "udp.sendDecodes", group: "services", label: "Include every decode in the UDP feed", help: "Off sends only status and logged contacts.", kind: "boolean", default: true, schema: bool }),
  def({
    key: "udp.acceptControl",
    group: "services",
    label: "Let those programs start contacts and stop transmitting",
    help: "Accepts Reply (double-clicking a CQ in GridTracker) and Halt Tx, and only from the addresses above. Off by default.",
    kind: "boolean",
    default: false,
    schema: bool,
  }),

  def({ key: "pskreporter.enabled", group: "services", label: "Report decodes to PSKReporter", kind: "boolean", default: false, schema: bool }),
  def({ key: "pskreporter.antenna", group: "services", label: "Antenna description for PSKReporter", kind: "string", default: "", schema: str(64) }),
  def({ key: "pskreporter.contact", group: "services", label: "Contact email for PSKReporter lookups", help: "PSKReporter asks programs that look up who heard you to give an address it can write to if they query too often. Empty sends none. Whatever you enter is sent to pskreporter.info with each lookup.", kind: "string", default: "", schema: str(120) }),

  // ---------------------------------------------------------------- email
  def({ key: "smtp.host", group: "email", label: "SMTP host", kind: "string", default: "", schema: str(120) }),
  def({ key: "smtp.port", group: "email", label: "SMTP port", kind: "number", default: 587, schema: int(1, 65535) }),
  def({
    key: "smtp.security",
    group: "email",
    label: "Connection security",
    kind: "select",
    default: "starttls",
    options: [
      { value: "starttls", label: "STARTTLS (usually 587)" },
      { value: "tls", label: "TLS (usually 465)" },
      { value: "none", label: "None" },
    ],
    schema: z.enum(["starttls", "tls", "none"]),
  }),
  def({ key: "smtp.user", group: "email", label: "SMTP username", kind: "string", default: "", schema: str(120) }),
  def({ key: "smtp.password", group: "email", label: "SMTP password", kind: "secret", default: "", schema: str(256) }),
  def({ key: "smtp.from", group: "email", label: "From address", placeholder: "Station <station@example.com>", kind: "string", default: "", schema: str(200) }),
  def({
    key: "alerts.email",
    group: "email",
    label: "Send station alerts to",
    help: "Radio down, SWR and PA faults, services that keep failing. Blank disables alerts.",
    kind: "string",
    default: "",
    schema: z.union([z.literal(""), z.string().trim().email()]),
  }),
  def({
    key: "alerts.needed",
    group: "email",
    label: "Alert me when a station I need calls CQ",
    help: "Shown in the app with a Call button, and pushed to phones that have notifications on.",
    kind: "select",
    default: "award",
    options: [
      { value: "off", label: "Off" },
      { value: "dxcc", label: "New DXCC entities only" },
      { value: "award", label: "New DXCC, zones, continents and parks" },
      { value: "band", label: "…and entities new on this band" },
    ],
    schema: z.enum(["off", "dxcc", "award", "band"]),
  }),
  def({
    key: "alerts.digestTime",
    group: "email",
    label: "Morning summary at",
    help: "Local time. What the station did since the last summary, by push and email. Blank for none.",
    kind: "string",
    default: "07:00",
    placeholder: "07:00",
    schema: z.string().trim().refine((s) => s === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(s), "HH:MM"),
  }),

  // ---------------------------------------------------------------- qsl
  def({
    key: "qsl.mode",
    group: "qsl",
    label: "Emailed QSLs",
    help: "New contacts with an email address on QRZ are queued. Needs the Public URL, SMTP and a QRZ lookup login.",
    kind: "select",
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "queue", label: "Queue for my approval" },
      { value: "send", label: "Send automatically" },
    ],
    schema: z.enum(["off", "queue", "send"]),
  }),
  def({ key: "qsl.maxPerDay", group: "qsl", label: "Send at most", unit: "per day", kind: "number", default: 50, schema: int(1, 2000) }),
  def({ key: "qsl.minAgeMinutes", group: "qsl", label: "Wait before queueing", help: "Time to fix or delete a contact first.", unit: "min", kind: "number", default: 10, schema: int(0, 1440) }),
  def({ key: "qsl.subject", group: "qsl", label: "Subject", kind: "string", default: "QSL {call} de {mycall} {date} {band} {mode}", schema: str(200) }),
  def({
    key: "qsl.body",
    group: "qsl",
    label: "Message",
    help: "Tokens: {call} {name} {mycall} {date} {time} {band} {mode} {rst_sent} {rst_rcvd} {mygrid} {operator}",
    kind: "text",
    default:
      "Hi {name},\n\nThanks for the {band} {mode} contact on {date} at {time} UTC. Your report was {rst_sent}.\n\nYour QSL card is attached.\n\n73,\n{operator} {mycall}",
    schema: z.string().max(4000),
  }),
  def({ key: "qsl.operatorName", group: "qsl", label: "Sign as", kind: "string", default: "", schema: str(64) }),
  def({ key: "qsl.card.enabled", group: "qsl", label: "Attach a card image", help: "Upload artwork on the QSL page.", kind: "boolean", default: true, schema: bool }),
  def({ key: "qsl.card.tableX", group: "qsl", label: "Card table left edge", help: "Fraction of the card width.", kind: "number", default: 0.05, schema: num(0, 0.95) }),
  def({ key: "qsl.card.tableY", group: "qsl", label: "Card table top edge", help: "Fraction of the card height.", kind: "number", default: 0.72, schema: num(0, 0.95) }),
  def({ key: "qsl.card.tableWidth", group: "qsl", label: "Card table width", help: "Fraction of the card width.", kind: "number", default: 0.9, schema: num(0.2, 1) }),
  def({ key: "qsl.card.textColor", group: "qsl", label: "Card text color", kind: "string", default: "#111111", schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb") }),
  def({
    key: "qsl.card.backgroundColor",
    group: "qsl",
    label: "Card table background",
    kind: "string",
    default: "#ffffffdd",
    schema: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "#rrggbb or #rrggbbaa"),
  }),
] as const;

type Defs = (typeof SETTINGS)[number];
export type SettingKey = Defs["key"];
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;
export type SettingValue<K extends SettingKey> = Widen<Extract<Defs, { key: K }>["default"]>;
export type SettingsSnapshot = { [K in SettingKey]: SettingValue<K> };

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef<any>> = new Map(
  (SETTINGS as readonly SettingDef<any>[]).map((s) => [s.key, s]),
);

export function isSecret(key: string): boolean {
  return SETTINGS_BY_KEY.get(key)?.kind === "secret";
}

export function settingDefaults(): SettingsSnapshot {
  const out: Record<string, unknown> = {};
  for (const s of SETTINGS as readonly SettingDef<any>[]) out[s.key] = s.default;
  return out as SettingsSnapshot;
}

/**
 * Settings that belong to a person rather than the shack: their service accounts and where
 * contacts go, emailed QSLs, alerts, what they report and send under their call, and how
 * they like to operate. Each user has their own (user_settings); the rest are the shack's,
 * one set for everyone, changed by an admin.
 */
const PERSONAL_PREFIXES = ["qrz.", "lotw.", "eqsl.", "clublog.", "wrl.", "n3fjp.", "uploads.", "qsl.", "alerts.", "pskreporter.", "js8.", "wspr.", "udp.", "pota.", "hop."];
const PERSONAL_KEYS = new Set([
  "app.distanceUnit",
  "spots.login",
  "spots.alertNeeded",
  "auto.huntNewOnly",
  "auto.huntMinSnr",
  "auto.cqClearSpot",
  "auto.callFinishedStations",
  "auto.skipWorkedBandMode",
  "auto.dupeWindowHours",
  "auto.maxRepeats",
  "auto.failureCooldownMin",
]);

export function isPersonal(key: string): boolean {
  return PERSONAL_KEYS.has(key) || PERSONAL_PREFIXES.some((p) => key.startsWith(p));
}
