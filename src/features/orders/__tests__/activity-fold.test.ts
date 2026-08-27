/**
 * The activity timeline's fold.
 *
 * A presentation rule, but one with a correctness edge: the compact view must
 * never hide the live countdown. That entry is the only ticking number on the
 * order page — how long until a courier is contacted — and it arrives on the
 * scheduled-dispatch row, whose position in the list depends entirely on how
 * much else has happened to the order. On a busy order it can fall past the
 * fold, and an agent watching a clock that is not on screen has no clock.
 *
 * Everything here is values in, a number out, so the awkward cases are covered
 * by arithmetic rather than by dispatching an order and counting rows.
 */

import { describe, expect, it } from "vitest";
import { COMPACT_ENTRIES, compactTimelineCount, type FoldableEntry } from "../activity-fold";

/** `n` ordinary activity rows — nothing a countdown could attach to. */
const plain = (n: number): FoldableEntry[] => Array.from({ length: n }, () => ({}));

/** `n` rows with the scheduled dispatch entry at `at`. */
const withScheduledAt = (n: number, at: number): FoldableEntry[] =>
  Array.from({ length: n }, (_, i) => (i === at ? { dispatchKind: "scheduled" } : {}));

describe("compactTimelineCount", () => {
  it("shows everything when there is less than a foldful", () => {
    expect(compactTimelineCount(plain(0), false)).toBe(0);
    expect(compactTimelineCount(plain(1), false)).toBe(1);
    expect(compactTimelineCount(plain(COMPACT_ENTRIES), false)).toBe(COMPACT_ENTRIES);
  });

  it("folds to the default once there is more history than that", () => {
    expect(compactTimelineCount(plain(COMPACT_ENTRIES + 1), false)).toBe(COMPACT_ENTRIES);
    expect(compactTimelineCount(plain(40), false)).toBe(COMPACT_ENTRIES);
  });

  it("extends the cut to reach a countdown that would fall past it", () => {
    // The scheduled entry is the ninth row of twenty; the fold has to reach it.
    expect(compactTimelineCount(withScheduledAt(20, 8), true)).toBe(9);
  });

  it("does not shorten the fold for a countdown already inside it", () => {
    // Second row of twenty: already visible, so the default still applies and
    // the extension must not cut the list down to two.
    expect(compactTimelineCount(withScheduledAt(20, 1), true)).toBe(COMPACT_ENTRIES);
  });

  it("ignores the scheduled row when no countdown is running", () => {
    // A dispatch that has since been claimed reports `inactive`, and a number
    // ticking down beside it would be a lie — so there is nothing to protect.
    expect(compactTimelineCount(withScheduledAt(20, 8), false)).toBe(COMPACT_ENTRIES);
  });

  it("falls back to the default when a countdown has no scheduled row to sit on", () => {
    expect(compactTimelineCount(plain(20), true)).toBe(COMPACT_ENTRIES);
  });

  it("never asks for more entries than exist", () => {
    for (const n of [0, 1, 5, 6, 7, 12]) {
      for (const countdown of [true, false]) {
        const entries = n > 3 ? withScheduledAt(n, n - 1) : plain(n);
        expect(compactTimelineCount(entries, countdown)).toBeLessThanOrEqual(n);
      }
    }
  });

  it("takes the fold size as a parameter, so the rule is not tied to one number", () => {
    expect(compactTimelineCount(plain(10), false, 3)).toBe(3);
    expect(compactTimelineCount(withScheduledAt(10, 5), true, 3)).toBe(6);
  });
});
