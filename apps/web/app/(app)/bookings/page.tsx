import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/server/auth";

import { BookingsView } from "./bookings-view";

export const metadata = { title: "Radio time" };

export default async function BookingsPage() {
  const user = await requireUser();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Radio time"
        subtitle="Book time on the radio. During your time, while you have Zerobeat open, the radio is yours: it comes to you at the start (whoever is on it hears 5 minutes before) and nobody else can take it. Not signed in, your booking doesn't hold it, and anyone can use the radio as usual."
      />
      <BookingsView canBook={user.role !== "VIEWER"} />
    </div>
  );
}
