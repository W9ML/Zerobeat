import { requireUser } from "@/lib/server/auth";

import { OperateView } from "./view";

export const metadata = { title: "Operate" };

export default async function OperatePage() {
  const user = await requireUser();
  return <OperateView canOperate={user.role !== "VIEWER"} me={user.id} />;
}
