/**
 * Each user's QSL card picture: data/qsl/cards/<userId>.png. The shack's old single
 * picture (data/qsl/card.png) stays the card of whoever owned the station before users
 * were independent, until they upload their own.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export function qslCardFile(dataDir: string, userId: string): string {
  return join(dataDir, "qsl", "cards", `${userId}.png`);
}

/** The picture to put on a user's card: their own, else the old shared one for its owner. */
export function qslCardPath(dataDir: string, userId: string, legacyOwner?: string | null): string {
  const own = qslCardFile(dataDir, userId);
  if (existsSync(own) || (legacyOwner && legacyOwner !== userId)) return own;
  return join(dataDir, "qsl", "card.png");
}
