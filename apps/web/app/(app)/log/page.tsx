import Link from "next/link";

import { getDxcc } from "@zerobeat/core/dxcc/cty";
import { operatorCalls } from "@zerobeat/core/log/operators";
import { logFacets, searchQsos } from "@zerobeat/core/log/qsos";
import { HF_BANDS } from "@zerobeat/core/ham/bands";

import { Badge, Empty, Input, LinkButton, PageHeader, Select, Table, buttonClass } from "@/components/ui";
import { db } from "@/lib/server/ctx";
import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";
import { displayMode, num, utcDate, utcTime } from "@/lib/format";

export const metadata = { title: "Logbook" };

type SP = Promise<Record<string, string | undefined>>;

function Confirmations({ q }: { q: { lotwRcvd: boolean; qslRcvd: string; eqslRcvd: boolean; qrzRcvd: boolean } }) {
  return (
    <span className="flex gap-1">
      {q.lotwRcvd && <Badge tone="ok">LoTW</Badge>}
      {q.qslRcvd === "CONFIRMED" && <Badge tone="ok">Card</Badge>}
      {q.eqslRcvd && <Badge tone="info">eQSL</Badge>}
      {q.qrzRcvd && <Badge tone="info">QRZ</Badge>}
    </span>
  );
}

export default async function LogPage({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const scope = await pageScope(user);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const day = (s: string | undefined, end: boolean) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T${end ? "23:59:59" : "00:00:00"}Z`) : undefined);
  const r = searchQsos(db(), {
    stationId: scope.stationId,
    q: sp.q || undefined,
    band: sp.band || undefined,
    mode: sp.mode || undefined,
    confirmed: (sp.confirmed as "credit" | "any" | "lotw" | "none" | "nocredit") || undefined,
    park: sp.park || undefined,
    from: day(sp.from, false),
    to: day(sp.to, true),
    dxcc: sp.dxcc && /^\d+$/.test(sp.dxcc) ? Number(sp.dxcc) : undefined,
    sort: sp.sort || undefined,
    page,
    pageSize: 100,
  });
  const dx = getDxcc();
  const facets = logFacets(db(), scope.stationId);
  const entities = facets.dxcc.map((d) => ({ d, name: dx.entity(d)?.name ?? `DXCC ${d}` })).sort((a, b) => a.name.localeCompare(b.name));
  const ops = operatorCalls(db());
  const showOp = r.rows.some((q) => q.operatorId);
  const qs = (p: number) => {
    const u = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    u.set("page", String(p));
    return `/log?${u}`;
  };
  // A header link sorts by its column; again reverses.
  const sorted = /^(time|call|band|mode|grid|country)-(asc|desc)$/.exec(sp.sort ?? "") ?? ["", "time", "desc"];
  const sortLink = (col: string) => {
    const u = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page" && k !== "sort") as [string, string][]);
    const dir = sorted[1] === col ? (sorted[2] === "asc" ? "desc" : "asc") : col === "time" ? "desc" : "asc";
    u.set("sort", `${col}-${dir}`);
    return `/log?${u}`;
  };
  const Th = ({ col, children }: { col: string; children: React.ReactNode }) => (
    <th aria-sort={sorted[1] === col ? (sorted[2] === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={sortLink(col)} className="hover:text-fg">
        {children}
        {sorted[1] === col ? (sorted[2] === "asc" ? " ▲" : " ▼") : ""}
      </Link>
    </th>
  );
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Logbook"
        subtitle={`${num(r.total)} contacts`}
        actions={
          <>
            <LinkButton href="/log/incomplete" variant="ghost">
              Incomplete exchanges
            </LinkButton>
            {user.role !== "VIEWER" && (
              <LinkButton href="/log/new" variant="primary">
                Log a contact
              </LinkButton>
            )}
          </>
        }
      />
      <form className="mb-4 flex flex-wrap items-end gap-2" action="/log">
        <div className="w-64">
          <Input name="q" defaultValue={sp.q} placeholder="Callsign, name, grid or park" />
        </div>
        <div className="w-32">
        <Select name="band" defaultValue={sp.band ?? ""}>
          <option value="">Any band</option>
          {[...HF_BANDS, "2M", "70CM"].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </Select>
        </div>
        <div className="w-36">
          <Select name="mode" defaultValue={sp.mode ?? ""}>
            <option value="">Any mode</option>
            {facets.modes.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <Select name="dxcc" defaultValue={sp.dxcc ?? ""}>
            <option value="">Any country</option>
            {entities.map((e) => (
              <option key={e.d} value={e.d}>
                {e.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-1 text-xs text-muted">
          From
          <Input type="date" name="from" defaultValue={sp.from} className="w-36" />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          to
          <Input type="date" name="to" defaultValue={sp.to} className="w-36" />
        </label>
        {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
        <div className="w-44">
        <Select name="confirmed" defaultValue={sp.confirmed ?? ""}>
          <option value="">All contacts</option>
          <option value="credit">Confirmed (card or LoTW)</option>
          <option value="nocredit">Not confirmed yet</option>
          <option value="lotw">LoTW confirmed</option>
          <option value="any">Any confirmation (incl. eQSL, QRZ)</option>
          <option value="none">No confirmation at all</option>
        </Select>
        </div>
        <button className={buttonClass("secondary")}>Filter</button>
        {Object.values(sp).some(Boolean) && (
          <Link href="/log" className={buttonClass("ghost")}>
            Clear
          </Link>
        )}
      </form>
      {r.rows.length === 0 ? (
        <Empty>No contacts match.</Empty>
      ) : (
        <div className="rounded-lg border border-line bg-panel">
          <Table>
            <thead>
              <tr>
                <Th col="time">Date</Th>
                <th>UTC</th>
                <Th col="call">Call</Th>
                <Th col="band">Band</Th>
                <Th col="mode">Mode</Th>
                <th>Sent</th>
                <th>Rcvd</th>
                <Th col="grid">Grid</Th>
                <Th col="country">Country</Th>
                <th>Name</th>
                <th>Park</th>
                {showOp && <th>Operator</th>}
                <th>Confirmed</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((q) => (
                <tr key={q.id}>
                  <td className="font-mono text-xs text-muted">{utcDate(q.startTime)}</td>
                  <td className="font-mono text-xs text-muted">{utcTime(q.startTime)}</td>
                  <td>
                    <Link href={`/log/${q.id}`} className="font-mono font-medium text-fg hover:text-accent-strong">
                      {q.callsign}
                    </Link>
                  </td>
                  <td className="font-mono text-xs">{q.band.toLowerCase()}</td>
                  <td className="text-xs">{displayMode(q.mode, q.submode)}</td>
                  <td className="font-mono text-xs">{q.rstSent}</td>
                  <td className="font-mono text-xs">{q.rstRcvd}</td>
                  <td className="font-mono text-xs">{q.grid}</td>
                  <td className="max-w-36 truncate text-xs text-muted" title={q.dxcc ? (dx.entity(q.dxcc)?.name ?? undefined) : undefined}>
                    {q.dxcc ? (dx.entity(q.dxcc)?.name ?? "") : ""}
                  </td>
                  <td className="max-w-40 truncate text-xs text-muted">{q.name}</td>
                  <td className="font-mono text-xs">{q.sigInfo}</td>
                  {showOp && <td className="font-mono text-xs text-muted">{q.operatorId ? (ops.get(q.operatorId) ?? "") : ""}</td>}
                  <td>
                    <Confirmations q={q} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {r.pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-sm text-muted">
              <span>
                Page {r.page} of {r.pages}
              </span>
              <span className="flex gap-2">
                {r.page > 1 && (
                  <Link className={buttonClass("secondary", "sm")} href={qs(r.page - 1)}>
                    Newer
                  </Link>
                )}
                {r.page < r.pages && (
                  <Link className={buttonClass("secondary", "sm")} href={qs(r.page + 1)}>
                    Older
                  </Link>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
