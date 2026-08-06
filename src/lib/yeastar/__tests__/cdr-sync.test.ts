/**
 * The two pure decisions the synchronization layer makes.
 *
 * `cdrRowKey` is the idempotency key — the single reason a re-sync cannot
 * duplicate a row — and `selectDueDays` is the whole scheduling policy. Both are
 * assertable without a PBX or a database, which is exactly why they were written
 * as pure functions.
 */
import { describe, expect, it } from "vitest";
import { cdrRowKey } from "../cdr-store.server";
import { selectDueDays } from "../cdr-sync.server";
import { contiguousRanges, enumerateDays, shiftDay } from "../cdr-days";

describe("cdrRowKey", () => {
  it("keys on new_id, which is row-unique on this firmware", () => {
    expect(cdrRowKey({ new_id: "42", call_id: "1782844637.854" })).toBe("n:42");
  });

  it("gives the legs of one call DIFFERENT keys", () => {
    // The whole point: `call_id` is shared by every leg, so keying on it would
    // collapse a multi-leg call to a single row on write.
    const call_id = "1782844637.854";
    const legs = [
      { new_id: "1", call_id },
      { new_id: "2", call_id },
      { new_id: "3", call_id },
    ];
    expect(new Set(legs.map(cdrRowKey)).size).toBe(3);
  });

  it("is stable across repeated syncs of the same row", () => {
    const row = { new_id: "7", call_id: "c1", timestamp: 1_780_000_000 };
    expect(cdrRowKey(row)).toBe(cdrRowKey({ ...row }));
  });

  it("falls back to a deterministic composite when new_id is absent", () => {
    const row = {
      call_id: "c1",
      timestamp: 1_780_000_000,
      call_to_number: "6400",
      call_from_number: "0538000046",
    };
    expect(cdrRowKey(row)).toBe(cdrRowKey({ ...row }));
    // Still distinguishes two legs of the same call by their destination.
    expect(cdrRowKey(row)).not.toBe(cdrRowKey({ ...row, call_to_number: "4005" }));
  });

  it("does not collide a new_id row with a composite row", () => {
    expect(cdrRowKey({ new_id: "1" }).startsWith("n:")).toBe(true);
    expect(cdrRowKey({ call_id: "1" }).startsWith("c:")).toBe(true);
  });
});

describe("selectDueDays", () => {
  const today = "2026-08-06";
  const horizon = enumerateDays("2026-07-28", today); // 10 days

  it("selects nothing when the horizon is fully covered", () => {
    const covered = new Set(horizon.filter((d) => d < "2026-08-05"));
    // Today and yesterday are always due, so a "fully covered" horizon still
    // returns the live tail — that is the point of the tail.
    covered.add("2026-08-05");
    covered.add("2026-08-06");
    expect(selectDueDays(horizon, covered, today, 7, false)).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("always refetches the live tail even when it is recorded as covered", () => {
    const covered = new Set(horizon);
    const due = selectDueDays(horizon, covered, today, 7, false);
    expect(due).toContain(today);
    expect(due).toContain(shiftDay(today, -1));
  });

  it("never refetches a closed day the mirror already covers", () => {
    const covered = new Set(horizon);
    const due = selectDueDays(horizon, covered, today, 7, false);
    expect(due.filter((d) => d < shiftDay(today, -1))).toEqual([]);
  });

  it("bounds one run to the day cap", () => {
    const due = selectDueDays(horizon, new Set(), today, 4, false);
    expect(due.length).toBeLessThanOrEqual(4);
  });

  it("prioritises the live tail over an old gap", () => {
    // Cap of 2 with nothing covered: the two live days win, because falling
    // behind on today to make progress on a week-old gap is the wrong trade.
    const due = selectDueDays(horizon, new Set(), today, 2, false);
    expect(due).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("walks a backfill oldest-first with the spare capacity", () => {
    const due = selectDueDays(horizon, new Set(), today, 4, false);
    expect(due).toEqual(["2026-07-28", "2026-07-29", "2026-08-05", "2026-08-06"]);
  });

  it("converges: successive runs cover the whole horizon", () => {
    const covered = new Set<string>();
    for (let run = 0; run < 10; run++) {
      for (const d of selectDueDays(horizon, covered, today, 4, false)) covered.add(d);
    }
    expect(horizon.every((d) => covered.has(d))).toBe(true);
  });

  it("re-sweeps everything under force", () => {
    expect(selectDueDays(horizon, new Set(horizon), today, 99, true)).toEqual(horizon);
  });

  it("collapses the selection into as few PBX sweeps as possible", () => {
    const due = selectDueDays(horizon, new Set(), today, 4, false);
    // Two bands — the old gap and the live tail — so two sweeps, not four.
    expect(contiguousRanges(due)).toEqual([
      { from: "2026-07-28", to: "2026-07-29" },
      { from: "2026-08-05", to: "2026-08-06" },
    ]);
  });
});
