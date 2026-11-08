/**
 * The operator's order for a column of cards. The saved order lists every card the column
 * can show, present now or not; a card the save does not know yet goes in after the card
 * it follows by default.
 */
export function mergeOrder(defaults: readonly string[], saved: readonly string[] | null): string[] {
  if (!saved?.length) return [...defaults];
  const out = saved.filter((id, i) => defaults.includes(id) && saved.indexOf(id) === i);
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(defaults[j]!);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
  });
  return out;
}

/** The order with one card moved to a new place. */
export function moveTo(order: readonly string[], id: string, to: number): string[] {
  const out = order.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}

/** The order with one card dropped just before (or after) another. */
export function placeNear(order: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target) return [...order];
  const out = order.filter((x) => x !== id);
  const at = out.indexOf(target);
  if (at < 0) return [...order];
  out.splice(after ? at + 1 : at, 0, id);
  return out;
}
