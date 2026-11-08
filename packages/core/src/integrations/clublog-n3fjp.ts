/**
 * Club Log realtime upload and N3FJP Amateur Contact Log.
 *
 * Club Log: POST clublog.org/realtime.php with email, password, callsign, adif, api.
 * The `api` key is mandatory; without it Club Log's edge returns a bare nginx 403, which
 * is what the previous install did for two months. Treat 403 as a configuration fault
 * (pause the service), never as a per-contact failure.
 *
 * N3FJP: one TCP command per record. The API has no acknowledgement, so "sent" means the
 * record was written to a healthy socket.
 */
import net from "node:net";

import { httpRequest, type UploadOutcome } from "./http.ts";

export interface ClubLogCreds {
  email: string;
  password: string;
  callsign: string;
  apiKey: string;
}

export async function clublogUpload(creds: ClubLogCreds, record: string): Promise<UploadOutcome> {
  if (!creds.apiKey) return { status: "auth", detail: "Club Log needs an API key (request one from the Club Log helpdesk)" };
  const body = new URLSearchParams({ email: creds.email, password: creds.password, callsign: creds.callsign, adif: record.trim(), api: creds.apiKey });
  let r;
  try {
    r = await httpRequest("https://clublog.org/realtime.php", {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      timeoutMs: 30_000,
    });
  } catch (e) {
    return { status: "retry", detail: (e as Error).message };
  }
  const text = r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (r.status === 403) return { status: "auth", detail: `Club Log refused the request (403): ${text.includes("nginx") ? "missing or invalid API key" : text.slice(0, 120)}` };
  if (r.status === 200 && /^OK/i.test(text)) return { status: "sent" };
  if (/^Dupe/i.test(text)) return { status: "duplicate" };
  if (r.status === 400 || r.status === 200) {
    if (/password|login|callsign/i.test(text) && /invalid|incorrect|denied/i.test(text)) return { status: "auth", detail: text.slice(0, 200) };
    return { status: "rejected", detail: text.slice(0, 200) || `HTTP ${r.status}` };
  }
  if (r.status >= 500 || r.status === 429) return { status: "retry", detail: `Club Log HTTP ${r.status}` };
  return { status: "rejected", detail: `HTTP ${r.status}: ${text.slice(0, 160)}` };
}

export async function n3fjpSend(host: string, port: number, records: string[], timeoutMs = 10_000): Promise<{ sent: number; error?: string }> {
  return new Promise((resolve) => {
    let sent = 0;
    let settled = false;
    const done = (error?: string) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(error ? { sent, error } : { sent });
    };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => done(`N3FJP at ${host}:${port} stopped responding`));
    sock.on("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" ? `N3FJP is not listening at ${host}:${port} (is the program running with its API enabled?)` : e.message),
    );
    sock.on("connect", () => {
      const writeNext = () => {
        if (sent >= records.length) {
          sock.end("\r\n", () => done());
          return;
        }
        const rec = records[sent]!.trim().replace(/<EOR>\s*$/i, "<EOR>");
        sock.write(`<CMD><ADDADIFRECORD><VALUE>${rec}</VALUE></CMD>\r\n`, (err) => {
          if (err) return done(err.message);
          sent++;
          writeNext();
        });
      };
      writeNext();
    });
  });
}
