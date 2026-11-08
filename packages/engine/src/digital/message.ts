/**
 * FT8/FT4 message grammar, as the sequencer and the hunt logic need it.
 *
 *   CQ [modifier] CALL [GRID]            Tx6 / a CQ
 *   QRZ CALL [GRID]                      treated as a CQ
 *   TO FROM GRID                         Tx1
 *   TO FROM ±NN                          Tx2
 *   TO FROM R±NN                         Tx3
 *   TO FROM RRR | RR73                   Tx4
 *   TO FROM 73                           Tx5
 *   TO FROM                              two-token (non-standard call) Tx1
 *   TO FROM R GRID / R <exchange>        contest close
 *   TO FROM 2A WI | R 3A EMA             ARRL Field Day (class and section)
 *   TO FROM 579 WI | R 589 0013          ARRL RTTY Roundup (RST and state, province or serial)
 *   A RR73; B FOX ±NN                    fox/hound compound (two messages from FOX)
 *
 * A token is a callsign when it has at least one letter and one digit, is 3+ chars, and
 * is not a grid, report or sign-off. So `CQ 9 K9XYZ` is a call-area CQ from K9XYZ, not a
 * CQ from "9". `<CALL>` is a hashed call (resolved by the decoder); `<...>` is unknown.
 */

export type Payload =
  | { kind: "none" }
  | { kind: "grid"; grid: string }
  | { kind: "report"; db: number }
  | { kind: "rreport"; db: number }
  | { kind: "rrr" }
  | { kind: "rr73" }
  | { kind: "73" }
  | { kind: "rgrid"; grid: string }
  | { kind: "exch"; text: string }
  | { kind: "rexch"; text: string }
  | { kind: "other"; text: string };

export type Parsed =
  | { kind: "cq"; from: string; modifier: string | null; grid: string | null; nonstandard: boolean }
  | { kind: "directed"; to: string; from: string; payload: Payload; nonstandard: boolean }
  | { kind: "text"; text: string };

const GRID4 = /^[A-R]{2}\d{2}$/;
const REPORT = /^[+-]\d{1,2}$/;
const RREPORT = /^R[+-]\d{1,2}$/;
const STANDARD_CALL = /^[A-Z0-9]{1,2}\d[A-Z]{1,3}$|^[A-Z]\d{1,2}[A-Z]{1,3}$|^\d[A-Z]\d[A-Z]{1,3}$/;

export function isGrid4(t: string): boolean {
  return GRID4.test(t) && t !== "RR73";
}

function stripHash(t: string): { call: string | null; hashed: boolean } {
  if (t.startsWith("<") && t.endsWith(">")) {
    const inner = t.slice(1, -1);
    return { call: inner === "..." || inner === "" ? null : inner, hashed: true };
  }
  return { call: t, hashed: false };
}

export function isCallToken(t: string): boolean {
  const { call } = stripHash(t);
  if (!call) return t === "<...>";
  if (call.length < 3 || call.length > 13) return false;
  if (!/[A-Z]/.test(call) || !/\d/.test(call)) return false;
  if (isGrid4(call) || call === "RR73" || REPORT.test(call) || RREPORT.test(call)) return false;
  return /^[A-Z0-9/]+$/.test(call);
}

/** A call that packs as a standard 28-bit call (no slashes beyond /P /R, standard shape). */
export function isStandardCall(call: string): boolean {
  const base = call.replace(/\/[PR]$/, "");
  return !base.includes("/") && STANDARD_CALL.test(base);
}

function normCall(t: string): string {
  return stripHash(t).call ?? "<...>";
}

function parsePayload(tokens: string[]): Payload {
  if (tokens.length === 0) return { kind: "none" };
  const [a, b] = tokens;
  if (tokens.length === 1) {
    if (a === "RR73") return { kind: "rr73" };
    if (a === "RRR") return { kind: "rrr" };
    if (a === "73") return { kind: "73" };
    if (REPORT.test(a!)) return { kind: "report", db: Number(a) };
    if (RREPORT.test(a!)) return { kind: "rreport", db: Number(a!.slice(1)) };
    if (isGrid4(a!)) return { kind: "grid", grid: a! };
  }
  if (tokens.length === 2 && a === "R" && isGrid4(b!)) return { kind: "rgrid", grid: b! };
  const exch = contestExchange(a === "R" ? tokens.slice(1) : tokens);
  if (exch) return { kind: a === "R" ? "rexch" : "exch", text: exch };
  return { kind: "other", text: tokens.join(" ") };
}

const FD_CLASS = /^\d{1,2}[A-F]$/;
const RU_RST = /^5[2-9]9$/;
const SECTION = /^[A-Z]{2,3}$/;

/** A Field Day or RTTY Roundup exchange ("2A WI", "579 MA", "599 0013"), or null. */
function contestExchange(t: string[]): string | null {
  if (t.length !== 2) return null;
  const [x, y] = t as [string, string];
  if (FD_CLASS.test(x) && SECTION.test(y)) return `${x} ${y}`;
  if (RU_RST.test(x) && (SECTION.test(y) || /^\d{4}$/.test(y))) return `${x} ${y}`;
  return null;
}

function parseOne(msg: string): Parsed {
  const tokens = msg.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "text", text: "" };
  const first = tokens[0]!;

  if (first === "CQ" || first === "QRZ") {
    let i = 1;
    let modifier: string | null = null;
    // A modifier is a token that is not a callsign, followed by one that is.
    if (tokens.length >= 3 && !isCallToken(tokens[1]!) && isCallToken(tokens[2]!)) {
      modifier = tokens[1]!;
      i = 2;
    }
    const from = tokens[i];
    if (!from || !isCallToken(from)) return { kind: "text", text: tokens.join(" ") };
    const grid = tokens[i + 1] && isGrid4(tokens[i + 1]!) ? tokens[i + 1]! : null;
    const call = normCall(from);
    return { kind: "cq", from: call, modifier, grid, nonstandard: !isStandardCall(call) || from.startsWith("<") };
  }

  if (tokens.length >= 2 && isCallToken(tokens[0]!) && isCallToken(tokens[1]!)) {
    const to = normCall(tokens[0]!);
    const from = normCall(tokens[1]!);
    return {
      kind: "directed",
      to,
      from,
      payload: parsePayload(tokens.slice(2)),
      nonstandard: !isStandardCall(to) || !isStandardCall(from) || tokens[0]!.startsWith("<") || tokens[1]!.startsWith("<"),
    };
  }
  return { kind: "text", text: tokens.join(" ") };
}

/** Parse a decoded message; compound fox/hound messages yield two. */
export function parseMessage(raw: string): Parsed[] {
  const text = raw.trim().toUpperCase();
  const semi = text.indexOf(";");
  if (semi === -1) return [parseOne(text)];
  // "HOUND1 RR73; HOUND2 <FOX> -12": both statements are from the fox.
  const left = text.slice(0, semi).trim().split(/\s+/);
  const right = parseOne(text.slice(semi + 1));
  if (right.kind !== "directed") return [right];
  const out: Parsed[] = [];
  if (left.length === 2 && isCallToken(left[0]!)) {
    out.push({ kind: "directed", to: normCall(left[0]!), from: right.from, payload: parsePayload([left[1]!]), nonstandard: true });
  }
  out.push(right);
  return out;
}

/** The station that sent a message, when the grammar says. */
export function senderOf(p: Parsed): string | null {
  return p.kind === "cq" || p.kind === "directed" ? (p.from === "<...>" ? null : p.from) : null;
}

export function isClosing(p: Payload): boolean {
  return p.kind === "rr73" || p.kind === "rrr" || p.kind === "73";
}

export function formatReport(db: number): string {
  const v = Math.max(-50, Math.min(49, Math.round(db)));
  return `${v < 0 ? "-" : "+"}${String(Math.abs(v)).padStart(2, "0")}`;
}

/**
 * The standard messages for a contact, packed the way WSJT-X packs them.
 *
 * Both calls standard: the usual i3=1 messages. One call non-standard (PJ4/K1ABC):
 *   Tx1, Tx4, Tx5 are i3=4 — the non-standard call spelled out, the other hashed:
 *     "PJ4/K1ABC <W1XYZ>", "PJ4/K1ABC <W1XYZ> RR73"
 *   Tx2, Tx3 are i3=1 with the non-standard call hashed:
 *     "<PJ4/K1ABC> W1XYZ -10"
 * Sent plainly, "PJ4/K1ABC W1XYZ FN42" degrades to truncated
 * free text on the air.
 */
/**
 * Is this a Fox's message? A Fox works two Hounds at once: "K1ABC RR73; W9XYZ <FOX> -08".
 * A contest "TU; K1ABC W9XYZ R 579 MA" also has a semicolon and is not a Fox.
 */
export function isFoxMessage(text: string): boolean {
  return / RR73; /.test(text);
}

/** The contests the sequencer knows, as WSJT-X's special operating activities. */
export type Contest = "none" | "ww-digi" | "arrl-digi" | "field-day" | "rtty-roundup";

/** WSJT-X's CQ modifier for each contest. */
export const CONTEST_CQ: Record<Contest, string | null> = { none: null, "ww-digi": "WW", "arrl-digi": "TEST", "field-day": "FD", "rtty-roundup": "RU" };

/** An RTTY Roundup RST from an SNR, as WSJT-X: 5, then (snr + 36) / 6 clamped to 2..9, then 9. */
export function rstFromSnr(snr: number): string {
  return `5${Math.max(2, Math.min(9, Math.trunc((snr + 36) / 6)))}9`;
}

/**
 * The messages for a contest contact (WSJT-X genStdMsgs): what we send is the grid in
 * the Digi contests, class and section on Field Day, RST and state or serial in the RTTY
 * Roundup. Tx2 is the exchange, Tx3 is R and the exchange.
 */
export function contestMessages(me: string, them: string, myGrid4: string, report: number, contest: Contest, myExch: string) {
  const m = standardMessages(me, them, myGrid4, report);
  if (contest === "none") return m;
  const mod = CONTEST_CQ[contest];
  // Contest exchanges need both calls standard: Field Day and Roundup messages (i3=3)
  // cannot carry a hash at all, and a compound own call cannot carry a modifier. The
  // plain "PJ4/K1ABC W1XYZ -05" would pack as truncated free text.
  if (!isStandardCall(me)) return m;
  if (!isStandardCall(them)) {
    if (contest === "field-day" || contest === "rtty-roundup") return m;
    // Digi contests exchange grids: the i3=1 forms with the other call hashed pack fine.
    return { ...m, tx2: `<${them}> ${me} ${myGrid4}`, tx3: `<${them}> ${me} R ${myGrid4}`, tx6: `CQ ${mod} ${me} ${myGrid4}` };
  }
  const sent = contest === "field-day" ? myExch : contest === "rtty-roundup" ? `${rstFromSnr(report)} ${myExch}` : myGrid4;
  const head = `${them} ${me}`;
  return { ...m, tx2: `${head} ${sent}`, tx3: `${head} R ${sent}`, tx6: `CQ ${mod} ${me} ${myGrid4}` };
}

export function standardMessages(me: string, them: string, myGrid4: string, report: number) {
  const rpt = formatReport(report);
  const meStd = isStandardCall(me);
  const themStd = isStandardCall(them);
  if (meStd && themStd) {
    return {
      tx1: `${them} ${me} ${myGrid4}`,
      tx2: `${them} ${me} ${rpt}`,
      tx3: `${them} ${me} R${rpt}`,
      tx4: `${them} ${me} RR73`,
      tx5: `${them} ${me} 73`,
      tx6: `CQ ${me} ${myGrid4}`,
    };
  }
  if (!themStd) {
    return {
      tx1: `${them} <${me}>`,
      tx2: `<${them}> ${me} ${rpt}`,
      tx3: `<${them}> ${me} R${rpt}`,
      tx4: `${them} <${me}> RR73`,
      tx5: `${them} <${me}> 73`,
      tx6: meStd ? `CQ ${me} ${myGrid4}` : `CQ ${me}`,
    };
  }
  return {
    tx1: `<${them}> ${me}`,
    tx2: `${them} <${me}> ${rpt}`,
    tx3: `${them} <${me}> R${rpt}`,
    tx4: `<${them}> ${me} RR73`,
    tx5: `<${them}> ${me} 73`,
    tx6: `CQ ${me}`,
  };
}
