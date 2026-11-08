/**
 * Cabrillo 3.0 logs for the contests the station can work: ARRL Field Day, the ARRL RTTY
 * Roundup, the WW Digi DX Contest and the ARRL International Digital Contest. Each
 * contact carries what was sent and received in its ADIF extras (CONTEST_ID,
 * STX_STRING, SRX_STRING), written when the station logged it, so the QSO lines are
 * built from those.
 *
 * QSO line layouts, from each contest's Cabrillo specification:
 *   ARRL-FD    freq mo date time  call class sec    call class sec
 *   ARRL-RTTY  freq mo date time  call rst exch     call rst exch
 *   WW-DIGI    freq mo date time  call grid4        call grid4
 *   ARRL-DIGI  freq mo date time  call grid4        call grid4
 */
import { displayMode } from "../ham/modes.ts";

export const CABRILLO_CONTESTS = ["ARRL-FD", "ARRL-RTTY", "WW-DIGI", "ARRL-DIGI"] as const;
export type CabrilloContest = (typeof CABRILLO_CONTESTS)[number];

export interface CabrilloQso {
  startTime: number;
  freqHz: number | null;
  band: string;
  mode: string;
  submode: string | null;
  callsign: string;
  rstSent: string | null;
  rstRcvd: string | null;
  grid: string | null;
  extras: string | null;
}

export interface CabrilloStation {
  callsign: string;
  grid: string;
  /** ARRL/RAC section or state, for LOCATION. */
  location?: string;
  power?: "HIGH" | "LOW" | "QRP";
  name?: string;
  email?: string;
  operators?: string;
}

/** Cabrillo's mode: CW, PH, RY (RTTY) or DG (other digital, FT8/FT4/JTTY/PSK). */
function cabMode(q: CabrilloQso): string {
  const m = displayMode(q.mode, q.submode).toUpperCase();
  if (m === "CW") return "CW";
  if (m === "RTTY") return "RY";
  if (["SSB", "USB", "LSB", "AM", "FM"].includes(m)) return "PH";
  return "DG";
}

/** Frequency in kHz for HF; the band's Cabrillo name above 30 MHz. */
function cabFreq(q: CabrilloQso): string {
  const vhf: Record<string, string> = { "6M": "50", "4M": "70", "2M": "144", "1.25M": "222", "70CM": "432", "33CM": "902", "23CM": "1.2G" };
  if (q.freqHz && q.freqHz < 30_000_000) return String(Math.round(q.freqHz / 1000)).padStart(5, " ");
  return (vhf[q.band.toUpperCase()] ?? String(Math.round((q.freqHz ?? 0) / 1000))).padStart(5, " ");
}

function utc(ms: number): { date: string; time: string } {
  const d = new Date(ms).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 13) + d.slice(14, 16) };
}

function extrasOf(q: CabrilloQso): Record<string, string> {
  try {
    return q.extras ? (JSON.parse(q.extras) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The contacts that belong to a contest. */
export function inContest(q: CabrilloQso, contest: CabrilloContest): boolean {
  return extrasOf(q).CONTEST_ID === contest;
}

export function qsoLine(q: CabrilloQso, contest: CabrilloContest, st: CabrilloStation): string {
  const x = extrasOf(q);
  const { date, time } = utc(q.startTime);
  const head = `QSO: ${cabFreq(q)} ${cabMode(q)} ${date} ${time}`;
  const me = st.callsign.toUpperCase().padEnd(13);
  const them = q.callsign.toUpperCase().padEnd(13);
  const sent = (x.STX_STRING ?? "").toUpperCase();
  const rcvd = (x.SRX_STRING ?? "").toUpperCase();
  if (contest === "ARRL-FD") {
    const [sc = "", ss = ""] = sent.split(" ");
    const [rc = x.CLASS ?? "", rs = x.ARRL_SECT ?? ""] = rcvd.split(" ");
    return `${head} ${me} ${sc.padEnd(3)} ${ss.padEnd(3)} ${them} ${rc.padEnd(3)} ${rs}`.trimEnd();
  }
  if (contest === "ARRL-RTTY") {
    const rstS = (q.rstSent ?? "599").padEnd(3);
    const [rr = q.rstRcvd ?? "599", rx = x.STATE ?? x.SRX ?? ""] = rcvd.split(" ");
    return `${head} ${me} ${rstS} ${sent.padEnd(6)} ${them} ${rr.padEnd(3)} ${rx}`.trimEnd();
  }
  // WW Digi and ARRL Digi: the 4-character grid each way.
  const mine = (sent || st.grid).slice(0, 4).toUpperCase();
  const theirs = (rcvd || q.grid || "").slice(0, 4).toUpperCase();
  return `${head} ${me} ${mine.padEnd(4)} ${them} ${theirs}`.trimEnd();
}

export function cabrilloLog(qsos: CabrilloQso[], contest: CabrilloContest, st: CabrilloStation, createdBy: string): string {
  const rows = qsos.filter((q) => inContest(q, contest)).sort((a, b) => a.startTime - b.startTime);
  const modes = new Set(rows.map(cabMode));
  const catMode = modes.size === 1 ? ({ CW: "CW", RY: "RTTY", DG: "DIGI", PH: "SSB" } as Record<string, string>)[[...modes][0]!] ?? "MIXED" : modes.size === 0 ? "DIGI" : "MIXED";
  const lines = [
    "START-OF-LOG: 3.0",
    `CONTEST: ${contest}`,
    `CALLSIGN: ${st.callsign.toUpperCase()}`,
    st.location ? `LOCATION: ${st.location.toUpperCase()}` : null,
    `GRID-LOCATOR: ${st.grid.slice(0, 4).toUpperCase()}`,
    "CATEGORY-OPERATOR: SINGLE-OP",
    "CATEGORY-BAND: ALL",
    `CATEGORY-MODE: ${catMode}`,
    `CATEGORY-POWER: ${st.power ?? "LOW"}`,
    "CATEGORY-ASSISTED: NON-ASSISTED",
    "CATEGORY-TRANSMITTER: ONE",
    st.name ? `NAME: ${st.name}` : null,
    st.email ? `EMAIL: ${st.email}` : null,
    `OPERATORS: ${(st.operators || st.callsign).toUpperCase()}`,
    `CREATED-BY: ${createdBy}`,
    ...rows.map((q) => qsoLine(q, contest, st)),
    "END-OF-LOG:",
  ];
  return lines.filter((l): l is string => l !== null).join("\r\n") + "\r\n";
}
