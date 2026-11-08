"use client";
import { useState } from "react";

import { useAdmin } from "@/components/admin-form";
import { confirmDialog, promptDialog } from "@/components/overlays";
import { Badge, Button, Card, Input, Notice, Select, Table } from "@/components/ui";
import { ago } from "@/lib/format";
import { MIN_PASSWORD_LENGTH } from "@zerobeat/core/auth/policy";

interface Row {
  id: string;
  email: string;
  name: string;
  callsign: string | null;
  licenseClass: string | null;
  role: string;
  active: boolean;
  lastLoginAt: number | null;
}

const LICENSE_OPTIONS: [string, string][] = [
  ["", "None"],
  ["T", "Technician"],
  ["G", "General"],
  ["A", "Advanced"],
  ["E", "Extra"],
];

export function UsersView({ me, rows }: { me: string; rows: Row[] }) {
  const a = useAdmin();
  const [d, setD] = useState({ email: "", name: "", callsign: "", role: "VIEWER", licenseClass: "", password: "" });
  return (
    <div className="space-y-4">
      <Card title="Users" pad={false}>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th title="US license class: transmitting outside its privileges is refused. None: not checked (a station outside the US).">License</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name} {u.callsign && <span className="font-mono text-xs text-muted">{u.callsign}</span>} {!u.active && <Badge tone="bad">disabled</Badge>}
                </td>
                <td className="text-xs text-muted">{u.email}</td>
                <td>
                  <select
                    value={u.role}
                    disabled={a.busy || u.id === me}
                    onChange={(e) => a.run({ action: "user.update", id: u.id, role: e.target.value })}
                    className="rounded-md border border-line-strong bg-panel-2 px-2 py-1 text-xs"
                  >
                    <option>ADMIN</option>
                    <option>OPERATOR</option>
                    <option>VIEWER</option>
                  </select>
                </td>
                <td>
                  <select
                    value={u.licenseClass ?? ""}
                    disabled={a.busy}
                    onChange={(e) => a.run({ action: "user.update", id: u.id, licenseClass: e.target.value })}
                    className="rounded-md border border-line-strong bg-panel-2 px-2 py-1 text-xs"
                  >
                    {LICENSE_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-xs text-muted">{u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</td>
                <td className="space-x-1 text-right whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const pw = await promptDialog({
                        title: `New password for ${u.name}`,
                        body: "They are signed out everywhere and use the new password from now on.",
                        label: `Password (${MIN_PASSWORD_LENGTH} characters or more)`,
                        type: "password",
                        confirmLabel: "Set password",
                        validate: (v) => (v.length < MIN_PASSWORD_LENGTH ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : null),
                      });
                      if (pw) void a.run({ action: "user.update", id: u.id, password: pw });
                    }}
                  >
                    Set password
                  </Button>
                  {u.id !== me && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => a.run({ action: "user.update", id: u.id, active: !u.active })}>
                        {u.active ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-bad" onClick={async () =>
                          (await confirmDialog({ title: `Delete ${u.name}?`, body: `${u.email} loses access immediately. Contacts they logged stay in the log.`, confirmLabel: "Delete user", tone: "danger" })) &&
                          a.run({ action: "user.delete", id: u.id })
                        }>
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Add a user">
        <div className="grid gap-2 sm:grid-cols-6">
          <Input placeholder="Name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <Input placeholder="Email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />
          <Input placeholder="Callsign" value={d.callsign} onChange={(e) => setD({ ...d, callsign: e.target.value.toUpperCase() })} />
          <Select value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })}>
            <option value="VIEWER">Viewer: read only</option>
            <option value="OPERATOR">Operator: can transmit and log</option>
            <option value="ADMIN">Admin: everything</option>
          </Select>
          <Select value={d.licenseClass} onChange={(e) => setD({ ...d, licenseClass: e.target.value })}>
            {LICENSE_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {v ? `License: ${l}` : "License: not checked"}
              </option>
            ))}
          </Select>
          <Input type="password" placeholder={`Password (${MIN_PASSWORD_LENGTH}+)`} value={d.password} onChange={(e) => setD({ ...d, password: e.target.value })} />
        </div>
        <div className="mt-3">
          <Button variant="primary" disabled={a.busy || !d.email || !d.name || !d.password} onClick={async () => (await a.run({ action: "user.create", ...d })) && setD({ email: "", name: "", callsign: "", role: "VIEWER", licenseClass: "", password: "" })}>
            Add user
          </Button>
        </div>
      </Card>
      {a.err && <Notice tone="bad">{a.err}</Notice>}
    </div>
  );
}
