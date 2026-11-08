/**
 * eQSL.cc: upload by form POST (credentials in the file, not the URL) and inbox download.
 *
 * Upload reply is HTML. "Result: N out of M records added" alone is not enough: eQSL
 * reports 0 of 1 both for a duplicate and for a rejected record, so the Warning/Error
 * lines decide which it was.
 */
import { adifField } from "../adif/adif.ts";
import { httpRequest, NetError, type UploadOutcome } from "./http.ts";

export interface EqslCreds {
  username: string;
  password: string;
  qthNickname: string;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyEqslReply(html: string): UploadOutcome {
  const text = stripHtml(html);
  if (/No match on eQSL_User/i.test(text) || /No such Username\/Password/i.test(text)) {
    return { status: "auth", detail: "eQSL refused the username or password (or the QTH nickname matches no account)" };
  }
  const m = /Result:\s*(\d+)\s+out of\s+(\d+)\s+records added/i.exec(text);
  if (/Duplicate/i.test(text)) return { status: "duplicate", detail: "already in eQSL" };
  if (m && Number(m[1]) > 0 && m[1] === m[2]) return { status: "sent" };
  const warn = /(Warning|Error|Bad record)[:\s][^.]*\.?/i.exec(text)?.[0];
  if (m && Number(m[2]) > 0) return { status: "rejected", detail: warn ?? `eQSL added ${m[1]} of ${m[2]}` };
  return { status: "retry", detail: warn ?? `unexpected eQSL reply: ${text.slice(0, 160)}` };
}

export async function eqslUpload(creds: EqslCreds, record: string): Promise<UploadOutcome> {
  const header = [
    "Zerobeat upload",
    adifField("ADIF_VER", "3.1.5"),
    adifField("EQSL_USER", creds.username),
    adifField("EQSL_PSWD", creds.password),
    "<EOH>",
    "",
  ].join("\n");
  const rec = creds.qthNickname ? record.replace(/<EOR>\s*$/i, `${adifField("APP_EQSL_QTH_NICKNAME", creds.qthNickname)} <EOR>\n`) : record;
  const form = new FormData();
  form.append("Filename", new Blob([header + rec], { type: "text/plain" }), "zerobeat.adi");
  let r;
  try {
    r = await httpRequest("https://www.eqsl.cc/qslcard/ImportADIF.cfm", { method: "POST", body: form, timeoutMs: 60_000 });
  } catch (e) {
    return { status: "retry", detail: (e as Error).message };
  }
  if (r.status >= 500) return { status: "retry", detail: `eQSL HTTP ${r.status}` };
  return classifyEqslReply(r.text);
}

/** Download inbox confirmations received since `rcvdSince` (YYYYMMDDHHMM). Returns ADIF text. */
export async function eqslInbox(creds: EqslCreds, rcvdSince: string | null): Promise<string> {
  const form = new URLSearchParams({ UserName: creds.username, Password: creds.password });
  if (creds.qthNickname) form.set("QTHNickname", creds.qthNickname);
  if (rcvdSince) form.set("RcvdSince", rcvdSince);
  const r = await httpRequest("https://www.eqsl.cc/qslcard/DownloadInBox.cfm", {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeoutMs: 120_000,
  });
  const link = /HREF="([^"]+\.adi)"/i.exec(r.text)?.[1];
  if (!link) {
    const text = stripHtml(r.text);
    if (/No such Username|Password/i.test(text)) throw new NetError("eQSL refused the username or password (or the QTH nickname matches no account)", false);
    if (/You have no log entries|No log entries/i.test(text)) return "";
    throw new NetError(`eQSL inbox: ${text.slice(0, 200) || `HTTP ${r.status}`}`);
  }
  const url = new URL(link, "https://www.eqsl.cc/qslcard/").toString();
  const file = await httpRequest(url, { timeoutMs: 120_000 });
  if (file.status !== 200) throw new NetError(`eQSL inbox file HTTP ${file.status}`);
  return file.text;
}
