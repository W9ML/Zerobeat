import Link from "next/link";

import { SETTING_GROUPS, SETTINGS, isPersonal, sectionFor, type SettingDef } from "@zerobeat/core/settings/registry";

import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";

import { SettingsNav } from "./nav";
import { SettingsSearch, type SearchItem } from "./search";

/** Everything the settings search can find: each setting, and the pages that are not settings groups. */
function searchIndex(admin: boolean): SearchItem[] {
  const all = (SETTINGS as readonly SettingDef<any>[]).filter((s) => admin || isPersonal(s.key));
  const byKey = new Map(all.map((s) => [s.key, s]));
  const items: SearchItem[] = all.map((s) => {
    const g = SETTING_GROUPS.find((x) => x.id === s.group)!;
    const sec = sectionFor(s.key, s.group);
    const note = s.when?.length
      ? `Shown when ${s.when
          .map((c) => {
            const d = byKey.get(c.key);
            const opt = d?.options?.find((o) => o.value === c.is)?.label ?? (c.is === "true" ? "on" : c.is === "false" ? "off" : c.is);
            return `${d?.label ?? c.key} is ${opt}`;
          })
          .join(" and ")}`
      : null;
    return {
      key: s.key,
      label: s.label,
      help: s.help ?? "",
      where: sec ? `${g.label} › ${sec.label}` : g.label,
      href: `/settings/${s.group}#setting-${s.key}`,
      words: [s.key, ...(s.options ?? []).map((o) => o.label), s.unit ?? ""].join(" "),
      note,
    };
  });
  const pages: [string, string, string][] = [
    ["/settings/stations", "Stations", "Callsign, grid, location, QTH and station profiles"],
    ["/settings/users", "Users", "Accounts, roles (viewer, operator, admin) and passwords"],
    ["/settings/api-keys", "API keys", "Keys for other programs to use the logbook API"],
    ["/settings/backup", "Backup", "Nightly backups, download a backup, restore"],
  ];
  if (admin) for (const [href, label, help] of pages) items.push({ key: href, label, help, where: "Page", href, words: "", note: null });
  return items;
}

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  // Groups with something this user can set: their own, plus the shack's for admins.
  const groups = SETTING_GROUPS.filter((g) => (SETTINGS as readonly SettingDef<any>[]).some((s) => s.group === g.id && (admin || isPersonal(s.key))));
  const items = [
    ...groups.map((g) => ({ href: `/settings/${g.id}`, label: g.label })),
    ...(admin
      ? [
          { href: "/settings/stations", label: "Stations" },
          { href: "/settings/users", label: "Users" },
          { href: "/settings/api-keys", label: "API keys" },
          { href: "/settings/backup", label: "Backup" },
        ]
      : []),
  ];
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Settings" subtitle={<>Configuration only. Live state lives on the <Link href="/operate" className="text-accent-strong hover:underline">Operate</Link> page.</>} />
      <div className="grid gap-6 md:grid-cols-[190px_1fr]">
        <div className="space-y-3">
          <SettingsSearch items={searchIndex(admin)} />
          <SettingsNav items={items} />
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
