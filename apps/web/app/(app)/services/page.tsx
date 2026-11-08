import { requireUser } from "@/lib/server/auth";
import { pageScope } from "@/lib/server/scope";

import { ServicesView } from "./view";

export const metadata = { title: "Services" };

export default async function ServicesPage() {
  const user = await requireUser();
  // Your own logbook services: yours to manage (not while an admin is viewing someone).
  const scope = await pageScope(user);
  const mine = user.role !== "VIEWER" && !scope.readOnly;
  return <ServicesView admin={mine} canOperate={mine} />;
}
