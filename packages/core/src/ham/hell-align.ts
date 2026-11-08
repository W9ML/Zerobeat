/**
 * Hell print structure: where a received print's columns really start, and whether what
 * printed is text at all.
 *
 * The tape shows two columns' worth of the pixel stream in each printed column (the helix),
 * so the text always appears whole somewhere, but where the column boundary falls depends
 * on when the sender's columns started against ours. Started half a column out, a line
 * prints as half a copy, a whole copy and half a copy. A real Hell receiver lets you move
 * the start; hellPhase finds it.
 *
 * Every character has paper above and below it in its column (fldigi's fonts and ours
 * both leave it), so over a line the ink, folded on to the 14 rows of a column,
 * runs on from row to row everywhere except across that gap. Put the column boundary in
 * the middle of the gap and both copies print whole.
 *
 * The same fold says whether a print is text: printed at the right speed, a line of text
 * folds into a clear gap; noise, a carrier keyed some other way (CW), or Hell printed at
 * the wrong speed (it slopes and smears) folds flat. The mode detector leans on that.
 */
export const HELL_ROWS = 14;

export interface HellStructure {
  /** The offset (0..13 pixels into the stream) to start every column at. */
  phase: number;
  /** 0 for a flat fold (noise) up to 1 for a gap with no ink across it at all. */
  strength: number;
  /** Columns that counted. */
  columns: number;
}

/**
 * The fold of the columns [from, to) of a print (HELL_ROWS bytes a column, bottom pixel
 * first, 0 paper to 255 ink). `use(k)` picks which columns count (for example, only
 * received ones). Null with fewer than `minColumns` to go on.
 */
export function hellStructure(px: Uint8Array, from: number, to: number, use: (k: number) => boolean = () => true, minColumns = 21): HellStructure | null {
  // join[r]: how much ink runs on from row r - 1 into row r. Inside a character a stroke
  // runs on; in the paper above and below the letters, nothing runs on at all.
  const join = new Float64Array(HELL_ROWS);
  const ink = new Float64Array(HELL_ROWS);
  let n = 0;
  for (let k = from; k < to; k++) {
    if (!use(k)) continue;
    const s = k * HELL_ROWS;
    if (s < 0 || s + HELL_ROWS > px.length) continue;
    for (let r = 0; r < HELL_ROWS; r++) {
      const a = (px[s + r - 1] ?? 0) / 255;
      const b = px[s + r]! / 255;
      join[r] = join[r]! + a * b;
      ink[r] = ink[r]! + b;
    }
    n++;
  }
  if (n < minColumns) return null;
  // With a gap two rows high, a boundary at its edge joins nothing either; the ink beside
  // it settles the tie, so the boundary lands in the middle of the gap.
  const score = (r: number) => join[r]! + 0.05 * (ink[(r + HELL_ROWS - 1) % HELL_ROWS]! + ink[r]!);
  let lo = 0;
  let mean = 0;
  for (let r = 0; r < HELL_ROWS; r++) {
    mean += score(r) / HELL_ROWS;
    if (score(r) < score(lo)) lo = r;
  }
  if (mean <= 0) return null;
  return { phase: lo, strength: Math.max(0, 1 - score(lo) / mean), columns: n };
}

/** A fold this strong is text; noise alone comes out well under it. */
export const HELL_TEXT_STRENGTH = 0.4;

/**
 * The offset to start every column of [from, to) at, or null when there is not enough
 * ink there to tell: noise alone has no gap.
 */
export function hellPhase(px: Uint8Array, from: number, to: number, use: (k: number) => boolean = () => true): number | null {
  const s = hellStructure(px, from, to, use);
  return s && s.strength >= HELL_TEXT_STRENGTH ? s.phase : null;
}
