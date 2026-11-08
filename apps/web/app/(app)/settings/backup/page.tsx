import { existsSync, readdirSync, statSync } from "node:fs";
import { requireUser } from "@/lib/server/auth";
import { join } from "node:path";

import { Card, Notice, Table } from "@/components/ui";
import { dataDir } from "@/lib/server/paths";

export const dynamic = "force-dynamic";

export default async function BackupPage() {
  await requireUser("ADMIN");
  const dir = join(dataDir(), "backups");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^zerobeat-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .reverse()
        .map((f) => ({ name: f, mb: (statSync(join(dir, f)).size / 1048576).toFixed(1) }))
    : [];
  return (
    <div className="space-y-4">
      <Card title="Backup">
        <p className="-mt-1 mb-4 text-sm text-muted">
          The whole station is one SQLite file. The engine writes a backup every night and keeps fourteen. Credentials in the backup stay encrypted; you also need <code className="font-mono text-fg">ZEROBEAT_SECRET_KEY</code> from <code className="font-mono">/etc/zerobeat/zerobeat.env</code> to read them, so keep a copy of that key somewhere safe.
        </p>
        <a href="/api/backup" className="inline-flex h-8.5 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-white hover:bg-accent-strong">
          Download a backup now
        </a>
      </Card>
      <Card title="Nightly backups" pad={false}>
        {files.length === 0 ? (
          <div className="p-4 text-sm text-muted">None yet. The first is written ten minutes after the engine starts.</div>
        ) : (
          <Table>
            <tbody>
              {files.map((f) => (
                <tr key={f.name}>
                  <td className="font-mono text-xs">{f.name}</td>
                  <td className="text-xs text-muted">{f.mb} MB</td>
                  <td className="text-right">
                    <a className="text-xs text-accent-strong hover:underline" href={`/api/backup?file=${f.name}`}>
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Notice>
        To restore: stop both services, copy the backup over <code className="font-mono">/var/lib/zerobeat/zerobeat.db</code> (removing the -wal and -shm files), and start them again.
      </Notice>
    </div>
  );
}
