/**
 * Public, signed opt-out from emailed QSLs (no account needed). Opening the link only
 * asks: mail security scanners open every link in a message, and used to unsubscribe
 * people who never clicked. The button posts to /api/qsl/unsubscribe, which also takes
 * mail clients' RFC 8058 one-click POST.
 */
import { verifyUnsubscribe } from "@zerobeat/core/qsl/queue";
import { defaultStation } from "@zerobeat/core/log/qsos";

import { db } from "@/lib/server/ctx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Unsubscribe" };

export default async function Unsubscribe({ searchParams }: { searchParams: Promise<{ call?: string; t?: string; done?: string }> }) {
  const { call, t, done } = await searchParams;
  const st = defaultStation(db());
  const ok = !!call && !!t && verifyUnsubscribe(call, t);
  const from = st?.callsign ?? "this station";
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="max-w-md rounded-lg border border-line bg-panel p-6 text-center">
        {!ok ? (
          <>
            <h1 className="text-lg font-semibold">That link is not valid</h1>
            <p className="mt-2 text-sm text-muted">The unsubscribe link is incomplete or has been altered.</p>
          </>
        ) : done ? (
          <>
            <h1 className="text-lg font-semibold">You are unsubscribed</h1>
            <p className="mt-2 text-sm text-muted">{call!.toUpperCase()} will not receive emailed QSL cards from {from} again. 73!</p>
          </>
        ) : (
          <form method="post" action={`/api/qsl/unsubscribe?call=${encodeURIComponent(call!)}&t=${encodeURIComponent(t!)}`}>
            <h1 className="text-lg font-semibold">Stop emailed QSLs?</h1>
            <p className="mt-2 text-sm text-muted">{call!.toUpperCase()} will not receive emailed QSL cards from {from} again.</p>
            <input type="hidden" name="confirm" value="1" />
            <button type="submit" className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">
              Unsubscribe
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
