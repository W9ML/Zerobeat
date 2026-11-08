"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { confirmDialog } from "@/components/overlays";
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Table } from "@/components/ui";
import { api } from "@/lib/client/api";
import { ago, utcDate } from "@/lib/format";

interface Services {
  uploads: { service: string; enabled: boolean; notReady: string | null; paused: { until: number; error: string } | null; counts: Record<string, number> }[];
  jobs: Record<string, { at: number; ok: boolean; detail: string }>;
  jobNames: string[];
  lotwCert: { callsign: string; dxcc: number | null; validFrom: number; validTo: number; qsoStart: number | null; qsoEnd: number | null } | null;
}

const NAME: Record<string, string> = { qrz: "QRZ Logbook", lotw: "LoTW", eqsl: "eQSL", clublog: "Club Log", wrl: "World Radio League", n3fjp: "N3FJP" };
const JOB: Record<string, string> = {
  uploads: "Upload queue",
  "lotw-confirmations": "LoTW confirmations",
  "eqsl-confirmations": "eQSL inbox",
  "qrz-confirmations": "QRZ confirmations",
  qsl: "Emailed QSLs",
  housekeeping: "Housekeeping",
  backup: "Nightly backup",
  "dxcc-refresh": "DXCC data refresh",
};

export function ServicesView({ admin, canOperate }: { admin: boolean; canOperate: boolean }) {
  const [data, setData] = useState<Services | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Services>("/api/engine/services"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setMsg(null);
    try {
      const r = (await fn()) as { detail?: string; changed?: number } | undefined;
      setMsg(r?.detail ?? (r?.changed !== undefined ? `${label}: ${r.changed} contacts` : `${label}: done`));
      await load();
    } catch (e) {
      setMsg(`${label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Services" subtitle={<>Credentials live in <Link href="/settings/services" className="text-accent-strong hover:underline">Settings → Logbook services</Link>.</>} />
      {err && <Notice tone="bad">{err}</Notice>}
      {msg && <Notice>{msg}</Notice>}
      {data && (
        <>
          <Card title="Uploads" pad={false}>
            <Table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>State</th>
                  <th>Sent</th>
                  <th>Waiting</th>
                  <th>Failed</th>
                  <th>Skipped</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.uploads.map((u) => (
                  <tr key={u.service}>
                    <td className="font-medium">{NAME[u.service]}</td>
                    <td>
                      {!u.enabled ? (
                        <Badge>off</Badge>
                      ) : u.notReady ? (
                        <Badge tone="warn" title={u.notReady}>
                          {u.notReady}
                        </Badge>
                      ) : u.paused ? (
                        <Badge tone="bad" title={u.paused.error}>
                          paused: {u.paused.error.slice(0, 50)}
                        </Badge>
                      ) : (
                        <Badge tone="ok">active</Badge>
                      )}
                    </td>
                    <td className="font-mono">{u.counts.sent ?? 0}</td>
                    <td className="font-mono">{u.counts.pending ?? 0}</td>
                    <td className="font-mono">{u.counts.failed ? <span className="text-bad">{u.counts.failed}</span> : 0}</td>
                    <td className="font-mono">{u.counts.skipped ?? 0}</td>
                    <td className="space-x-1 text-right whitespace-nowrap">
                      {admin && u.paused && (
                        <Button size="sm" disabled={!!busy} onClick={() => run(`Resume ${NAME[u.service]}`, () => api("/api/engine/uploads/resume", { body: { service: u.service } }))}>
                          Resume
                        </Button>
                      )}
                      {admin && (u.counts.failed ?? 0) > 0 && (
                        <Button size="sm" disabled={!!busy} onClick={() => run(`Retry ${NAME[u.service]}`, () => api("/api/uploads", { body: { service: u.service, action: "retry-failed" } }))}>
                          Retry failed
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {admin && <QueueTools busy={!!busy} run={run} />}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Background jobs">
              <div className="divide-y divide-line">
                {data.jobNames
                  .filter((n) => JOB[n])
                  .map((n) => {
                    const j = data.jobs[n];
                    return (
                      <div key={n} className="flex items-start justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm">{JOB[n]}</div>
                          <div className="truncate text-xs text-muted" title={j?.detail}>
                            {j ? `${ago(j.at)} · ${j.detail}` : "not run yet"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {j && <Badge tone={j.ok ? "ok" : "bad"}>{j.ok ? "ok" : "failed"}</Badge>}
                          {canOperate && (
                            <Button size="sm" variant="ghost" disabled={busy === n} onClick={() => run(JOB[n]!, () => api("/api/engine/jobs/run", { body: { name: n } }))}>
                              {busy === n ? "…" : "Run"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </Card>
            <div className="space-y-4">
              <LotwCert cert={data.lotwCert} admin={admin} onChange={load} />
              {admin && <Tests run={run} busy={!!busy} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function QueueTools({ busy, run }: { busy: boolean; run: (label: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const [service, setService] = useState("qrz");
  const [date, setDate] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3 text-sm">
      <Field label="Service">
        <select value={service} onChange={(e) => setService(e.target.value)} className="h-8.5 rounded-md border border-line-strong bg-panel-2 px-2">
          {Object.entries(NAME).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date (UTC)">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
      </Field>
      <Button disabled={busy || !date} onClick={() => run(`Queue ${NAME[service]} since ${date}`, () => api("/api/uploads", { body: { service, action: "queue-since", date } }))}>
        Queue contacts since date
      </Button>
      <Button
        variant="ghost"
        disabled={busy || !date}
        onClick={async () =>
          (await confirmDialog({
            title: `Treat contacts before ${date} as already on ${NAME[service]}?`,
            body: "Anything from before this date still waiting for that service is marked skipped and will not be uploaded.",
            confirmLabel: "Mark as uploaded",
          })) &&
          run(`Skip ${NAME[service]} before ${date}`, () => api("/api/uploads", { body: { service, action: "skip-before", date } }))}
      >
        Treat earlier as already uploaded
      </Button>
    </div>
  );
}

function LotwCert({ cert, admin, onChange }: { cert: Services["lotwCert"]; admin: boolean; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function upload() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (const b of buf) bin += String.fromCharCode(b);
      await api("/api/engine/lotw/cert", { body: { p12: btoa(bin), password: pw } });
      setMsg({ tone: "ok", text: "Certificate stored. The private key is encrypted at rest." });
      setFile(null);
      setPw("");
      onChange();
    } catch (e) {
      setMsg({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="LoTW certificate">
      {cert ? (
        <div className="mb-3 space-y-1 text-sm">
          <div>
            <span className="font-mono font-medium">{cert.callsign}</span> <span className="text-muted">DXCC {cert.dxcc ?? "?"}</span>
          </div>
          <div className="text-xs text-muted">
            Valid {utcDate(cert.validFrom)} to {utcDate(cert.validTo)}
            {cert.qsoStart && ` · signs contacts from ${utcDate(cert.qsoStart)}`}
          </div>
          {cert.validTo - Date.now() < 60 * 86_400_000 && <Notice tone="warn">Expires soon. Renew it in TQSL and upload the new one.</Notice>}
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted">No certificate. In TQSL, select your callsign certificate and choose Save Callsign Certificate File to export a .p12.</p>
      )}
      {admin && (
        <div className="space-y-2">
          <input type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-panel-3 file:px-3 file:py-1.5 file:text-fg" />
          <div className="flex gap-2">
            <Input type="password" placeholder="Certificate password (blank if none)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button variant="primary" disabled={!file || busy} onClick={upload}>
              {busy ? "…" : cert ? "Replace" : "Upload"}
            </Button>
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      )}
    </Card>
  );
}

function Tests({ run, busy }: { run: (label: string, fn: () => Promise<unknown>) => Promise<void>; busy: boolean }) {
  const [to, setTo] = useState("");
  return (
    <Card title="Connection tests">
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input placeholder="Send a test email to" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button disabled={busy || !to} onClick={() => run("Test email", () => api("/api/engine/test", { body: { what: "email", to } }))}>
            Send
          </Button>
        </div>
        <Button disabled={busy} onClick={() => run("QRZ Logbook", () => api("/api/engine/test", { body: { what: "qrz-logbook" } }))}>
          Check QRZ Logbook key
        </Button>
        <Button disabled={busy} onClick={() => run("World Radio League", () => api("/api/engine/test", { body: { what: "wrl" } }))}>
          Check World Radio League key
        </Button>
      </div>
    </Card>
  );
}
