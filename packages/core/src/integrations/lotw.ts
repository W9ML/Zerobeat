/**
 * Logbook of the World: certificate handling, TQSL-compatible .tq8 signing, upload, and
 * confirmation download.
 *
 * The .tq8 is a gzipped GABBI stream (tCERT, tSTATION, tCONTACT records). Each contact
 * is signed with RSA-SHA1 over LoTW's "sigspec 2.0" field concatenation: station fields
 * alphabetically, then contact fields, upper-cased, absent ones omitted. This is what
 * tqsllib does, and the construction was measured accepted by LoTW on the previous
 * install.
 *
 * The .p12 from TQSL is parsed in-process with node-forge (handles TQSL's legacy RC2-40
 * bags), so there is no openssl binary dependency.
 */
import { createSign, X509Certificate } from "node:crypto";
import { gzipSync } from "node:zlib";
import forge from "node-forge";

import { httpRequest, NetError, type UploadOutcome } from "./http.ts";

const OID_CALLSIGN = "1.3.6.1.4.1.12348.1.1";
const OID_QSO_FIRST = "1.3.6.1.4.1.12348.1.2";
const OID_QSO_END = "1.3.6.1.4.1.12348.1.3";
const OID_DXCC = "1.3.6.1.4.1.12348.1.4";

export interface LotwCertInfo {
  callsign: string;
  name: string | null;
  dxcc: number | null;
  validFrom: number;
  validTo: number;
  qsoStart: number | null;
  qsoEnd: number | null;
}

export interface LotwCert extends LotwCertInfo {
  certPem: string;
  keyPem: string;
}

export class LotwCertError extends Error {
  override readonly name = "LotwCertError";
}

function extText(cert: forge.pki.Certificate, oid: string): string | null {
  const ext = (cert.extensions as { id: string; value: string }[]).find((e) => e.id === oid);
  if (!ext) return null;
  // The value is a DER string; LoTW stores IA5/UTF8 strings. Decode, falling back to raw.
  try {
    const asn = forge.asn1.fromDer(ext.value);
    return typeof asn.value === "string" ? asn.value.trim() : null;
  } catch {
    return ext.value.replace(/[^\x20-\x7e]/g, "").trim() || null;
  }
}

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Read a TQSL .p12 export. Throws LotwCertError with an operator-facing message. */
export function readP12(p12: Buffer, password: string): LotwCert {
  let pkcs12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn = forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary")));
    pkcs12 = forge.pkcs12.pkcs12FromAsn1(asn, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/mac|password|decrypt/i.test(msg)) throw new LotwCertError("That password does not open the certificate file.");
    throw new LotwCertError(`That file is not a readable .p12 certificate (${msg}).`);
  }
  const bags = (type: string): forge.pkcs12.Bag[] => pkcs12.getBags({ bagType: type })[type] ?? [];
  const certBags = bags(forge.pki.oids.certBag!);
  const keyBags = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag!), ...bags(forge.pki.oids.keyBag!)];
  const key = keyBags[0]?.key;
  if (!key) throw new LotwCertError("The file has no private key. Export it from TQSL with the private key included.");

  // The callsign certificate is the one whose public key matches the private key.
  const rsaKey = key as forge.pki.rsa.PrivateKey;
  const cert = certBags
    .map((b: forge.pkcs12.Bag) => b.cert)
    .find((c: forge.pki.Certificate | undefined): c is forge.pki.Certificate => !!c && (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(rsaKey.n));
  if (!cert) throw new LotwCertError("No certificate in the file matches its private key.");

  const subjectAttr = (oid: string) => cert.subject.attributes.find((a: forge.pki.CertificateField) => a.type === oid)?.value as string | undefined;
  const callsign = subjectAttr(OID_CALLSIGN);
  if (!callsign) throw new LotwCertError("That is not a LoTW callsign certificate (no callsign in it). Export the one under Callsign Certificates in TQSL.");

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(key);
  // Cross-check with Node's own parser so a malformed cert fails now, not at upload.
  const x = new X509Certificate(certPem);
  const dxccRaw = extText(cert, OID_DXCC);
  return {
    callsign: callsign.toUpperCase(),
    name: (subjectAttr("2.5.4.3") as string | undefined) ?? null,
    dxcc: dxccRaw && /^\d+$/.test(dxccRaw) ? Number(dxccRaw) : null,
    validFrom: new Date(x.validFrom).getTime(),
    validTo: new Date(x.validTo).getTime(),
    qsoStart: parseDate(extText(cert, OID_QSO_FIRST)),
    qsoEnd: parseDate(extText(cert, OID_QSO_END)),
    certPem,
    keyPem,
  };
}

// ---------------------------------------------------------------------------
// Modes as LoTW names them
// ---------------------------------------------------------------------------

const SUBMODE_KEPT: Record<string, readonly string[]> = {
  MFSK: ["FT4", "FST4", "FST4W", "MFSK16", "MFSK8", "Q65", "JS8"],
  PSK: ["PSK31", "PSK63", "PSK63F", "PSK125", "PSK10", "PSK2K", "FSK31", "PSKFEC31"],
  HELL: ["HFSK"],
};
const PARENT_COLLAPSE: Record<string, string> = { PKT: "PACKET", PAC: "PACTOR", TOR: "AMTOR", THRB: "THROB", CLO: "CLOVER", V4: "DATA", JTTY: "DATA" };

export function lotwMode(mode: string, submode?: string | null): string {
  const m = mode.trim().toUpperCase();
  const s = (submode ?? "").trim().toUpperCase();
  if (s && SUBMODE_KEPT[m]?.includes(s)) return s;
  if (s === "USB" || s === "LSB") return "SSB";
  if (m === "MFSK" || m === "PSK") return "DATA";
  return PARENT_COLLAPSE[m] ?? m;
}

// ---------------------------------------------------------------------------
// .tq8
// ---------------------------------------------------------------------------

export interface LotwStation {
  callsign: string;
  dxcc: number;
  grid: string | null;
  state: string | null;
  county: string | null;
  cqZone: number | null;
  ituZone: number | null;
}

export interface LotwContact {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  submode: string | null;
  freqHz: number | null;
  propMode: string | null;
  satName: string | null;
  startTime: number;
}

const f = (name: string, value: string) => `<${name}:${Buffer.byteLength(value, "utf8")}>${value}\n`;
const fNl = (name: string, value: string, suffix = "") => {
  const v = `${value}\n`;
  return `<${name}:${Buffer.byteLength(v, "utf8")}${suffix}>${v}`;
};
const up = (s: string | null | undefined) => {
  const v = (s ?? "").trim();
  return v ? v.toUpperCase() : null;
};
export function mhz(hz: number): string {
  return (hz / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}
const sigDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sigTime = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export function signData(st: LotwStation, q: LotwContact): string {
  return [
    st.cqZone ? String(st.cqZone) : null,
    up(st.grid)?.slice(0, 6) ?? null,
    st.ituZone ? String(st.ituZone) : null,
    up(st.county),
    up(st.state),
    up(q.band),
    up(q.callsign),
    q.freqHz ? mhz(q.freqHz) : null,
    lotwMode(q.mode, q.submode),
    up(q.propMode),
    sigDate(q.startTime),
    `${sigTime(q.startTime)}Z`,
    up(q.satName),
  ]
    .filter((p): p is string => !!p)
    .join("");
}

// The identity string the previous install sent and LoTW accepted (measured).
const IDENT = "TQSL V2.5.4 Lib: V2.5 Config: V11.12 AllowDupes: false";

export interface Tq8 {
  gz: Buffer;
  included: string[];
  excluded: { id: string; reason: string }[];
}

export function buildTq8(cert: LotwCert, st: LotwStation, contacts: LotwContact[]): Tq8 {
  const included: string[] = [];
  const excluded: Tq8["excluded"] = [];
  const records: string[] = [];
  for (const q of contacts) {
    if (cert.qsoStart && q.startTime < cert.qsoStart) {
      excluded.push({ id: q.id, reason: `before the certificate's QSO start date ${sigDate(cert.qsoStart)}` });
      continue;
    }
    if (cert.qsoEnd && q.startTime > cert.qsoEnd + 86_400_000) {
      excluded.push({ id: q.id, reason: `after the certificate's QSO end date ${sigDate(cert.qsoEnd)}` });
      continue;
    }
    const sd = signData(st, q);
    const sig = createSign("RSA-SHA1").update(sd, "utf8").sign(cert.keyPem, "base64");
    const out = [f("Rec_Type", "tCONTACT"), f("STATION_UID", "1"), f("CALL", q.callsign.toUpperCase()), f("BAND", q.band.toUpperCase()), f("MODE", lotwMode(q.mode, q.submode))];
    if (q.freqHz) out.push(f("FREQ", mhz(q.freqHz)));
    if (up(q.propMode)) out.push(f("PROP_MODE", up(q.propMode)!));
    if (up(q.satName)) out.push(f("SAT_NAME", up(q.satName)!));
    out.push(f("QSO_DATE", sigDate(q.startTime)), f("QSO_TIME", `${sigTime(q.startTime)}Z`), fNl("SIGN_LOTW_V2.0", sig, ":6"), f("SIGNDATA", sd));
    records.push(out.join("") + "<EOR>\n\n");
    included.push(q.id);
  }
  const certBody = cert.certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").trim();
  const station = [f("Rec_Type", "tSTATION"), f("STATION_UID", "1"), f("CERT_UID", "1"), f("CALL", st.callsign.toUpperCase()), f("DXCC", String(st.dxcc))];
  if (up(st.grid)) station.push(f("GRIDSQUARE", up(st.grid)!.slice(0, 6)));
  if (st.ituZone) station.push(f("ITUZ", String(st.ituZone)));
  if (st.cqZone) station.push(f("CQZ", String(st.cqZone)));
  if (up(st.state)) station.push(f("US_STATE", up(st.state)!));
  if (up(st.county)) station.push(f("US_COUNTY", up(st.county)!));
  const body =
    `<TQSL_IDENT:${IDENT.length}>${IDENT}\n\n` +
    f("Rec_Type", "tCERT") + f("CERT_UID", "1") + fNl("CERTIFICATE", certBody) + "<EOR>\n\n" +
    station.join("") + "<EOR>\n\n" +
    records.join("");
  return { gz: gzipSync(Buffer.from(body, "utf8"), { level: 9 }), included, excluded };
}

export async function lotwUpload(tq8: Buffer, callsign: string): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("upfile", new Blob([new Uint8Array(tq8)], { type: "application/octet-stream" }), `${callsign}-${Date.now()}-zerobeat.tq8`);
  let r;
  try {
    r = await httpRequest("https://lotw.arrl.org/lotw/upload", { method: "POST", body: form, timeoutMs: 120_000 });
  } catch (e) {
    return { status: "retry", detail: (e as Error).message };
  }
  if (r.text.includes("<!-- .UPL. accepted -->")) return { status: "sent", detail: "queued by LoTW for processing" };
  const msg = /<!-- \.UPLMESSAGE\. ([\s\S]*?) -->/.exec(r.text)?.[1]?.trim();
  if (r.text.includes("<!-- .UPL. rejected -->")) {
    if (/certificate|signature|expired/i.test(msg ?? "")) return { status: "auth", detail: `LoTW rejected the file: ${msg}` };
    return { status: "rejected", detail: `LoTW rejected the file: ${msg ?? "no reason given"}` };
  }
  return { status: "retry", detail: `LoTW answered HTTP ${r.status} without accepting the file` };
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export async function lotwDownloadConfirmations(opts: { username: string; password: string; since: string; ownCall?: string }): Promise<string> {
  const p = new URLSearchParams({
    login: opts.username,
    password: opts.password,
    qso_query: "1",
    qso_qsl: "yes",
    qso_qsldetail: "yes",
    qso_withown: "yes",
    qso_qslsince: opts.since,
  });
  if (opts.ownCall) p.set("qso_owncall", opts.ownCall);
  const r = await httpRequest(`https://lotw.arrl.org/lotwuser/lotwreport.adi?${p}`, { timeoutMs: 180_000 });
  if (r.status >= 500) throw new NetError(`LoTW HTTP ${r.status}`);
  if (!/<eoh>/i.test(r.text)) {
    if (/password|login|invalid/i.test(r.text)) throw new NetError("LoTW refused the username or password", false);
    throw new NetError(`LoTW returned no report (HTTP ${r.status})`);
  }
  return r.text;
}
