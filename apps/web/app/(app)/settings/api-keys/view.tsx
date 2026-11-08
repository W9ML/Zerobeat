"use client";
import { useState } from "react";

import { useAdmin } from "@/components/admin-form";
import { Badge, Button, Card, Input, Notice, Select, Table } from "@/components/ui";
import { ago, utcDate } from "@/lib/format";

interface Row {
  id: string;
  name: string;
  prefix: string;
  role: string;
  active: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export function KeysView({ rows }: { rows: Row[] }) {
  const a = useAdmin();
  const [name, setName] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [days, setDays] = useState(0);
  const [token, setToken] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card title="API keys">
        <p className="-mt-1 mb-3 text-sm text-muted">
          For scripts and other programs. Send as <code className="font-mono text-fg">Authorization: Bearer dsk_…</code>. Endpoints: <code className="font-mono">GET /api/v1/qsos</code> (on-air fields; add <code className="font-mono">?full=1</code> with an Operator key for names, QTH, email and notes), <code className="font-mono">POST /api/v1/qsos</code>, <code className="font-mono">GET /api/v1/status</code>, <code className="font-mono">GET /api/v1/needed?calls=K1ABC:20M,…</code> (what you still need, from your log), <code className="font-mono">GET /api/v1/heard-by?minutes=30</code> (who received you on PSKReporter), <code className="font-mono">GET /api/v1/bands?mode=FT8</code> (what your receiver hears per band, now and usually at this hour), <code className="font-mono">GET /api/adif</code>.
        </p>
        {rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Role</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="font-mono text-xs">{k.prefix}…</td>
                  <td className="text-xs">{k.role}</td>
                  <td className="text-xs text-muted">{k.lastUsedAt ? ago(k.lastUsedAt) : "never"}</td>
                  <td className="text-xs text-muted">{k.expiresAt ? utcDate(k.expiresAt) : "never"}</td>
                  <td className="text-right">
                    {k.active ? (
                      <Button size="sm" variant="ghost" className="text-bad" onClick={() => a.run({ action: "apikey.revoke", id: k.id })}>
                        Revoke
                      </Button>
                    ) : (
                      <Badge>revoked</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Input placeholder="What it is for" value={name} onChange={(e) => setName(e.target.value)} className="w-56" />
          <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-40">
            <option value="VIEWER">Read only</option>
            <option value="OPERATOR">Read and log</option>
          </Select>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
            <option value="0">Never expires</option>
            <option value="30">30 days</option>
            <option value="365">1 year</option>
          </Select>
          <Button
            variant="primary"
            disabled={!name || a.busy}
            onClick={async () => {
              const r = await a.run<{ token: string }>({ action: "apikey.create", name, role, days });
              if (r) {
                setToken(r.token);
                setName("");
              }
            }}
          >
            Create key
          </Button>
        </div>
      </Card>
      {token && (
        <Notice tone="ok">
          Copy this key now; it is not shown again:
          <div className="mt-1 font-mono text-sm break-all text-fg select-all">{token}</div>
        </Notice>
      )}
      {a.err && <Notice tone="bad">{a.err}</Notice>}
    </div>
  );
}
