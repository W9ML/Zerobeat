"use client";
import { useState } from "react";

import { Button, Card, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { api } from "@/lib/client/api";

interface Report {
  records: number;
  imported: number;
  duplicates: number;
  rejected: { index: number; error: string }[];
  warnings: string[];
}

const SERVICES = [
  ["qrz", "QRZ Logbook"],
  ["lotw", "LoTW"],
  ["eqsl", "eQSL"],
  ["clublog", "Club Log"],
  ["wrl", "World Radio League"],
  ["n3fjp", "N3FJP"],
];

const CONTESTS = [
  ["ARRL-FD", "ARRL Field Day"],
  ["ARRL-RTTY", "ARRL RTTY Roundup"],
  ["WW-DIGI", "WW Digi DX Contest"],
  ["ARRL-DIGI", "ARRL International Digital Contest"],
];

/** A Cabrillo log of the contacts the station logged in a contest. */
function CabrilloCard() {
  const [contest, setContest] = useState("ARRL-FD");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [power, setPower] = useState("LOW");
  const [location, setLocation] = useState("");
  const href = `/api/cabrillo?${new URLSearchParams(Object.entries({ contest, from, to, power, location }).filter(([, v]) => v))}`;
  return (
    <Card title="Cabrillo (contests)">
      <div className="space-y-3">
        <p className="text-xs text-muted">Contacts the station logged in a contest on the Operate page, with the exchanges each way, ready to submit to the sponsor.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Contest">
            <Select value={contest} onChange={(e) => setContest(e.target.value)}>
              {CONTESTS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From (optional)">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (optional)">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Power">
            <Select value={power} onChange={(e) => setPower(e.target.value)}>
              <option value="QRP">QRP</option>
              <option value="LOW">Low</option>
              <option value="HIGH">High</option>
            </Select>
          </Field>
          <Field label="Location (section)">
            <Input value={location} placeholder="IN" onChange={(e) => setLocation(e.target.value.toUpperCase())} className="w-24" />
          </Field>
          <a href={href} className="inline-flex h-8.5 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent-strong">
            Download Cabrillo
          </a>
        </div>
      </div>
    </Card>
  );
}

export function ImportExport({ canImport }: { canImport: boolean }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<Set<string>>(new Set());
  const [keepDupes, setKeepDupes] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    if (dryRun) fd.set("dryRun", "1");
    if (keepDupes) fd.set("dupes", "keep");
    for (const s of upload) fd.append("upload", s);
    setBusy(true);
    setErr(null);
    try {
      setReport({ ...(await api<Report>("/api/adif", { body: fd })), ...{} });
      if (!dryRun) setFile(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const exportHref = `/api/adif?${new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v))}`;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Import / export" subtitle="ADIF 3.1. Fields Zerobeat has no column for are kept and exported again." />
      <Card title="Export">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From (optional)">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To (optional)">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <a href={exportHref} className="inline-flex h-8.5 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent-strong">
            Download ADIF
          </a>
        </div>
      </Card>
      <CabrilloCard />
      {canImport && (
        <Card title="Import">
          <div className="space-y-4">
            <input type="file" accept=".adi,.adif,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-panel-3 file:px-3 file:py-1.5 file:text-fg" />
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">Queue the imported contacts for upload to</div>
              <div className="flex flex-wrap gap-3 text-sm">
                {SERVICES.map(([k, l]) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={upload.has(k!)}
                      onChange={(e) =>
                        setUpload((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(k!);
                          else n.delete(k!);
                          return n;
                        })
                      }
                    />
                    {l}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-subtle">Leave all unticked for history you have already uploaded elsewhere.</p>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={keepDupes} onChange={(e) => setKeepDupes(e.target.checked)} /> Import contacts that already exist (same call, band, mode and minute)
            </label>
            <div className="flex gap-2">
              <Button disabled={!file || busy} onClick={() => run(true)}>
                Check file
              </Button>
              <Button variant="primary" disabled={!file || busy} onClick={() => run(false)}>
                {busy ? "Working…" : "Import"}
              </Button>
            </div>
            {err && <Notice tone="bad">{err}</Notice>}
            {report && (
              <Notice tone={report.rejected.length ? "warn" : "ok"}>
                {report.records} records: {report.imported} {busy ? "" : "imported or importable"}, {report.duplicates} duplicates skipped, {report.rejected.length} rejected.
                {report.rejected.slice(0, 10).map((r) => (
                  <div key={r.index} className="text-xs">
                    record {r.index + 1}: {r.error}
                  </div>
                ))}
                {report.warnings.slice(0, 10).map((w, i) => (
                  <div key={i} className="text-xs text-muted">
                    {w}
                  </div>
                ))}
              </Notice>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
