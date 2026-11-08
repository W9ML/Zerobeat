import { PushCard } from "@/components/push-card";
import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";

import { PasswordCard } from "./password";

export const metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  const row = (k: string, v: string) => (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <span className="text-muted">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Account" subtitle="Your sign-in and the devices that get notifications from your station." />
      <Card title="You">
        {row("Name", user.name)}
        {row("Callsign", user.callsign ?? "none")}
        {row("Email", user.email)}
        {row("Role", user.role.charAt(0) + user.role.slice(1).toLowerCase())}
      </Card>
      <PushCard isAdmin={user.role === "ADMIN"} />
      <PasswordCard />
    </div>
  );
}
