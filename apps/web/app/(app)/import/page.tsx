import { requireUser } from "@/lib/server/auth";

import { ImportExport } from "./view";

export const metadata = { title: "Import / export" };

export default async function Page() {
  const user = await requireUser();
  return <ImportExport canImport={user.role !== "VIEWER"} />;
}
