
import { QsoForm } from "@/components/qso-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";
import { pageScope } from "@/lib/server/scope";

export const metadata = { title: "Log a contact" };

export default async function NewQsoPage() {
  const own = await pageScope(await requireUser("OPERATOR"));
  const st = own.readOnly || !own.callsign ? null : { callsign: own.callsign, grid: own.grid ?? "" };
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Log a contact" subtitle={st ? `As ${st.callsign} from ${st.grid}` : own.readOnly ? "You are viewing someone else's logbook" : "Your account has no callsign yet"} />
      <QsoForm stationGrid={st?.grid} />
    </div>
  );
}
