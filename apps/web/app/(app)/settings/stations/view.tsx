"use client";
import { useState } from "react";

import { useAdmin } from "@/components/admin-form";
import { confirmDialog } from "@/components/overlays";
import { Badge, Button, Card, Input, Notice } from "@/components/ui";

interface Row {
  id: string;
  callsign: string;
  grid: string;
  name: string | null;
  isDefault: boolean;
  qsos: number;
}

export function StationsView({ rows }: { rows: Row[] }) {
  const a = useAdmin();
  const [draft, setDraft] = useState({ callsign: "", grid: "", name: "" });
  return (
    <Card title="Stations">
      <p className="-mt-1 mb-4 text-sm text-muted">The callsign and grid you log as. The default station is used by the engine and for new contacts. A portable setup is its own station.</p>
      <div className="space-y-2">
        {rows.map((s) => (
          <StationRow key={s.id} s={s} a={a} />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <Input placeholder="Callsign" value={draft.callsign} onChange={(e) => setDraft({ ...draft, callsign: e.target.value.toUpperCase() })} className="w-32 font-mono" />
        <Input placeholder="Grid" value={draft.grid} onChange={(e) => setDraft({ ...draft, grid: e.target.value })} className="w-28 font-mono" />
        <Input placeholder="Name (Portable, Club…)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-56" />
        <Button variant="primary" disabled={a.busy || !draft.callsign || !draft.grid} onClick={async () => (await a.run({ action: "station.save", ...draft })) && setDraft({ callsign: "", grid: "", name: "" })}>
          Add station
        </Button>
      </div>
      {a.err && (
        <div className="mt-3">
          <Notice tone="bad">{a.err}</Notice>
        </div>
      )}
    </Card>
  );
}

function StationRow({ s, a }: { s: Row; a: ReturnType<typeof useAdmin> }) {
  const [v, setV] = useState({ callsign: s.callsign, grid: s.grid, name: s.name ?? "" });
  const dirty = v.callsign !== s.callsign || v.grid !== s.grid || v.name !== (s.name ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2">
      <Input value={v.callsign} onChange={(e) => setV({ ...v, callsign: e.target.value.toUpperCase() })} className="w-32 font-mono" />
      <Input value={v.grid} onChange={(e) => setV({ ...v, grid: e.target.value })} className="w-28 font-mono" />
      <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Name" className="w-44" />
      <span className="text-xs text-muted">{s.qsos} contacts</span>
      {s.isDefault ? <Badge tone="accent">default</Badge> : <Button size="sm" variant="ghost" onClick={() => a.run({ action: "station.save", id: s.id, ...v, isDefault: true })}>Make default</Button>}
      <span className="ml-auto flex gap-1">
        {dirty && (
          <Button size="sm" variant="primary" disabled={a.busy} onClick={() => a.run({ action: "station.save", id: s.id, ...v })}>
            Save
          </Button>
        )}
        {!s.isDefault && s.qsos === 0 && (
          <Button size="sm" variant="ghost" className="text-bad" onClick={async () => (await confirmDialog({ title: `Delete station ${s.callsign}?`, confirmLabel: "Delete", tone: "danger" })) && a.run({ action: "station.delete", id: s.id })}>
            Delete
          </Button>
        )}
      </span>
    </div>
  );
}
