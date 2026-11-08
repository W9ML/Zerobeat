import { notFound } from "next/navigation";

import { SETTING_GROUPS, SETTING_SECTIONS, SETTINGS, isPersonal, sectionFor, type SettingDef } from "@zerobeat/core/settings/registry";

import { Notice } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";
import { settingsStore } from "@/lib/server/ctx";

import { PushCard } from "@/components/push-card";

import { SettingsForm, type FieldDef } from "./form";

export const dynamic = "force-dynamic";

export default async function SettingsGroupPage({ params }: { params: Promise<{ group: string }> }) {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const scope = await pageScope(user);
  const { group } = await params;
  const g = SETTING_GROUPS.find((x) => x.id === group);
  if (!g) notFound();
  // Everyone sees their own settings; admins also the shack's (not while viewing someone).
  const shown = (key: string) => isPersonal(key) || (admin && !scope.readOnly);
  const defs = (SETTINGS as readonly SettingDef<any>[]).filter((s) => s.group === group && shown(s.key));
  if (!defs.length) notFound();
  const views = new Map(settingsStore().describe(scope.userId).map((v) => [v.key, v]));
  const fields: FieldDef[] = defs
    .map((s) => ({
      key: s.key,
      label: s.label,
      help: s.help ?? null,
      kind: s.kind,
      options: s.options ?? null,
      placeholder: s.placeholder ?? null,
      unit: s.unit ?? null,
      value: views.get(s.key)?.value ?? s.default,
      set: views.get(s.key)?.set ?? false,
      hint: views.get(s.key)?.hint ?? null,
      unreadable: views.get(s.key)?.unreadable ?? false,
      when: s.when ?? null,
      widget: s.widget ?? null,
      section: sectionFor(s.key, group)?.id ?? null,
      shared: !isPersonal(s.key),
    }));
  const sections = SETTING_SECTIONS.filter((x) => x.group === group).map(({ id, label, description, toggle }) => ({ id, label, description, toggle: toggle ?? null }));
  const form = (
    <div className="space-y-4">
      {scope.readOnly && <Notice tone="info">Viewing {scope.callsign ?? "another user"}'s settings: read-only.</Notice>}
      <SettingsForm key={`${group}|${scope.userId}`} title={g.label} description={g.description} fields={fields} sections={sections} readOnly={scope.readOnly} />
    </div>
  );
  if (group !== "email" || scope.readOnly) return form;
  return (
    <div className="space-y-4">
      {form}
      <PushCard isAdmin={admin} />
    </div>
  );
}
