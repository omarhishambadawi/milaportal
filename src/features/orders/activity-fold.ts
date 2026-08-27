/**
 * How much of an order's history the timeline shows before it is asked for the rest.
 *
 * The activity panel is the last card in the order page's context column and the
 * least urgent thing on the page, and it had become the tallest. An order that
 * has been verified, synced, flagged, scheduled, dispatched and accepted carries
 * a dozen entries within an hour of being taken, at three to five lines each —
 * so the panel nobody opens the page for was consuming more of the column than
 * the invoice and the delivery above it combined.
 *
 * Folding it is a presentation decision, and this is the whole of it: which
 * entries are on screen while the panel is closed. Nothing is dropped, nothing
 * is fetched differently, and one click shows every row.
 *
 * Pure and in its own module for the reason the rest of this feature's policy
 * is: the suite runs in Node with nothing rendered, so a rule that lives in a
 * function is asserted over values, and a rule that lives in a component is
 * asserted by reading its source and hoping.
 */

/**
 * The default fold.
 *
 * Roughly one screen of history, which is as much as anyone reads before
 * deciding whether they want the rest.
 */
export const COMPACT_ENTRIES = 6;

/** The only thing the fold needs to know about an entry. */
export interface FoldableEntry {
  /** Set on dispatch entries; `"scheduled"` is the one that can carry a clock. */
  dispatchKind?: string;
}

/**
 * How many entries the compact view renders.
 *
 * `min`, with one exception: when a live countdown is attached to the scheduled
 * dispatch entry, the cut is extended far enough to include it. That entry
 * carries the only ticking number on the page — how long until a courier is
 * contacted — and a fold that hid it would hide the one thing here nobody
 * should have to click for.
 *
 * The cut is *extended* rather than the entry being hoisted, deliberately. The
 * list is in time order and reads as a sequence down a rail; a timeline that
 * reorders itself to promote a row is no longer a timeline, and the extra rows
 * that come with the extension are the ones immediately around the scheduled
 * event anyway — which is the context that makes it legible.
 */
export function compactTimelineCount(
  entries: readonly FoldableEntry[],
  hasCountdown: boolean,
  min: number = COMPACT_ENTRIES,
): number {
  if (entries.length <= min) return entries.length;
  if (!hasCountdown) return min;
  const scheduled = entries.findIndex((e) => e.dispatchKind === "scheduled");
  return scheduled === -1 ? min : Math.max(min, scheduled + 1);
}
