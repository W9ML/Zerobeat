/** An Operate card in its own window: no sidebar or top bar, just the card. */
import { PopOutView } from "../../(app)/operate/popout-view";
import { requireUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

const TITLES: Record<string, string> = {
  map: "Map",
  contact: "Contact",
  "keyboard-contact": "Contact",
  station: "Station",
  wanted: "Wanted",
  callers: "Calling you",
  auto: "Automatic",
  contest: "Contest",
  spots: "Spots",
  radio: "Radio",
  heard: "Heard by",
  activity: "Activity",
  js8: "JS8",
  "sstv-send": "Send a picture",
  "sstv-log": "Log a contact",
};

export async function generateMetadata({ params }: { params: Promise<{ card: string }> }) {
  const { card } = await params;
  return { title: TITLES[card] ?? "Card" };
}

export default async function PopOutPage({ params }: { params: Promise<{ card: string }> }) {
  const user = await requireUser();
  const { card } = await params;
  return <PopOutView card={card.slice(0, 40)} canOperate={user.role !== "VIEWER"} />;
}
