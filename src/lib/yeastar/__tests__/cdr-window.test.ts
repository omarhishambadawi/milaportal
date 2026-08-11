/**
 * Day-partitioned CDR window store.
 *
 * The whole point of this layer is to stop re-fetching data it already holds
 * WITHOUT changing what a window contains. So the tests come in two halves:
 * what it fetches (fewer requests, correct ranges) and what it returns (the
 * same rows, in the same order, as a single sweep would have produced).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const fetchCdrRange = vi.fn();
vi.mock("../cdr.server", () => ({
  fetchCdrRange: (...args: unknown[]) => fetchCdrRange(...args),
}));

const { getCdrWindow, enumerateDays, contiguousRanges, windowCacheState, __resetCdrWindowCache } =
  await import("../cdr-window.server");

/** Business timezone is UTC+3, so 12:00 UTC is safely mid-day everywhere. */
function rowAt(day: string, id: string) {
  return {
    new_id: id,
    call_id: id,
    timestamp: Math.floor(Date.parse(`${day}T09:00:00Z`) / 1000),
    call_type: "Inbound",
    call_from_number: "0501234567",
    call_to_number: "6400",
  };
}

/** Answer any range with one row per day it covers. */
function respondPerDay() {
  fetchCdrRange.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    const days = enumerateDays(from, to);
    const records = days.map((d) => rowAt(d, `r-${d}`));
    return {
      records,
      totalReported: records.length,
      fetchedRows: records.length,
      droppedOutOfWindow: 0,
      pagesFetched: 1,
      path: "search",
      startEpoch: 0,
      endEpoch: 0,
      elapsedMs: 1,
      truncated: false,
    };
  });
}

/** Ranges the mock was asked for, in call order. */
const askedRanges = () =>
  fetchCdrRange.mock.calls.map((c) => `${(c[0] as any).from}..${(c[0] as any).to}`);

beforeEach(() => {
  fetchCdrRange.mockReset();
  __resetCdrWindowCache();
  respondPerDay();
});

describe("enumerateDays", () => {
  it("is inclusive at both ends", () => {
    expect(enumerateDays("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("handles a single day and an inverted range", () => {
    expect(enumerateDays("2026-07-01", "2026-07-01")).toEqual(["2026-07-01"]);
    expect(enumerateDays("2026-07-05", "2026-07-01")).toEqual([]);
  });

  it("crosses a month boundary", () => {
    expect(enumerateDays("2026-06-29", "2026-07-02")).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
  });
});

describe("contiguousRanges", () => {
  it("merges adjacent days into one range", () => {
    expect(contiguousRanges(["2026-07-01", "2026-07-02", "2026-07-03"])).toEqual([
      { from: "2026-07-01", to: "2026-07-03" },
    ]);
  });

  it("splits on a gap", () => {
    expect(contiguousRanges(["2026-07-01", "2026-07-02", "2026-07-05"])).toEqual([
      { from: "2026-07-01", to: "2026-07-02" },
      { from: "2026-07-05", to: "2026-07-05" },
    ]);
  });

  it("is empty for no days", () => {
    expect(contiguousRanges([])).toEqual([]);
  });
});

describe("getCdrWindow", () => {
  it("sweeps a cold month as ONE request, not one per day", async () => {
    const res = await getCdrWindow("2026-06-01", "2026-06-30");
    expect(askedRanges()).toEqual(["2026-06-01..2026-06-30"]);
    expect(res.records).toHaveLength(30);
    expect(res.daysFetched).toBe(30);
    expect(res.daysFromCache).toBe(0);
  });

  it("touches the PBX not at all on the second identical request", async () => {
    await getCdrWindow("2026-06-01", "2026-06-30");
    fetchCdrRange.mockClear();

    const res = await getCdrWindow("2026-06-01", "2026-06-30");
    expect(fetchCdrRange).not.toHaveBeenCalled();
    expect(res.records).toHaveLength(30);
    expect(res.sweeps).toBe(0);
    expect(res.daysFromCache).toBe(30);
  });

  it("serves a narrower range entirely from the wider one already fetched", async () => {
    await getCdrWindow("2026-06-01", "2026-06-30");
    fetchCdrRange.mockClear();

    // This is the filter interaction that used to cost a whole second sweep.
    const res = await getCdrWindow("2026-06-10", "2026-06-16");
    expect(fetchCdrRange).not.toHaveBeenCalled();
    expect(res.records.map((r) => r.new_id)).toEqual(
      enumerateDays("2026-06-10", "2026-06-16").map((d) => `r-${d}`),
    );
  });

  it("fetches only the days it is missing when a range is extended", async () => {
    await getCdrWindow("2026-06-01", "2026-06-20");
    fetchCdrRange.mockClear();

    const res = await getCdrWindow("2026-06-01", "2026-06-30");
    // Only the tail is new.
    expect(askedRanges()).toEqual(["2026-06-21..2026-06-30"]);
    expect(res.daysFromCache).toBe(20);
    expect(res.daysFetched).toBe(10);
    expect(res.records).toHaveLength(30);
  });

  it("fetches two ranges when the gap is in the middle", async () => {
    await getCdrWindow("2026-06-10", "2026-06-12");
    fetchCdrRange.mockClear();

    await getCdrWindow("2026-06-08", "2026-06-15");
    expect(askedRanges().sort()).toEqual(["2026-06-08..2026-06-09", "2026-06-13..2026-06-15"]);
  });

  it("returns days in chronological order however they were fetched", async () => {
    await getCdrWindow("2026-06-10", "2026-06-12");
    const res = await getCdrWindow("2026-06-08", "2026-06-15");
    expect(res.records.map((r) => r.new_id)).toEqual(
      enumerateDays("2026-06-08", "2026-06-15").map((d) => `r-${d}`),
    );
  });

  it("does not re-sweep a day that genuinely had no calls", async () => {
    // A quiet day returns no rows. If emptiness were treated as "not cached"
    // the window would re-fetch it forever.
    fetchCdrRange.mockImplementation(async () => ({
      records: [],
      totalReported: 0,
      fetchedRows: 0,
      droppedOutOfWindow: 0,
      pagesFetched: 1,
      path: "search",
      startEpoch: 0,
      endEpoch: 0,
      elapsedMs: 1,
      truncated: false,
    }));

    await getCdrWindow("2026-06-01", "2026-06-05");
    fetchCdrRange.mockClear();
    const res = await getCdrWindow("2026-06-01", "2026-06-05");

    expect(fetchCdrRange).not.toHaveBeenCalled();
    expect(res.records).toEqual([]);
    expect(res.daysFromCache).toBe(5);
  });

  it("hands back the SAME array instance for an unchanged window", async () => {
    // The normalization cache upstream is identity-checked against this array;
    // a fresh instance each time would silently re-normalize every request.
    const a = await getCdrWindow("2026-06-01", "2026-06-30");
    const b = await getCdrWindow("2026-06-01", "2026-06-30");
    expect(b.records).toBe(a.records);
  });

  it("composes exactly the rows a single sweep would have returned", async () => {
    // Fetched in three disjoint pieces...
    await getCdrWindow("2026-06-11", "2026-06-20");
    await getCdrWindow("2026-06-01", "2026-06-05");
    const pieced = await getCdrWindow("2026-06-01", "2026-06-30");

    // ...must equal one clean sweep of the whole thing.
    __resetCdrWindowCache();
    fetchCdrRange.mockClear();
    const whole = await getCdrWindow("2026-06-01", "2026-06-30");

    expect(pieced.records.map((r) => r.new_id)).toEqual(whole.records.map((r) => r.new_id));
  });

  it("reports window warmth without fetching anything", async () => {
    expect(windowCacheState("2026-06-01", "2026-06-30").status).toBe("cold");

    await getCdrWindow("2026-06-01", "2026-06-20");
    fetchCdrRange.mockClear();

    expect(windowCacheState("2026-06-01", "2026-06-20").status).toBe("warm");
    expect(windowCacheState("2026-06-01", "2026-06-30").status).toBe("partial");
    expect(fetchCdrRange).not.toHaveBeenCalled();
  });

  it("suppresses totalReported when part of the window came from cache", async () => {
    await getCdrWindow("2026-06-01", "2026-06-20");
    const res = await getCdrWindow("2026-06-01", "2026-06-30");
    // The PBX only reported on the ten days actually asked for; presenting that
    // as the month's total would understate it.
    expect(res.totalReported).toBeNull();
  });
});

/**
 * Days that have not happened yet.
 *
 * The month presets select a whole CALENDAR month, so "this month" on the 12th
 * asks for the 1st to the 31st. Nineteen of those days do not exist yet: they
 * can hold no call, they have no mirror row and they never will. Treating them
 * as merely "not synced recently" put them in the same contiguous range as
 * today and turned a one-day live sweep into a twenty-day one — on every
 * request, forever, because a future day can never satisfy a freshness check.
 *
 * That is what made the first load of the current month never finish.
 */
describe("getCdrWindow — days that have not begun", () => {
  const TODAY = "2026-08-12";
  // 21:00 in the business timezone (UTC+3) on the 12th. Late enough in the day
  // that the clock can be pushed over the business-day boundary later in this
  // block without ageing the cached days past their twelve-hour closed TTL —
  // which would evict them for a reason that has nothing to do with the future.
  const NOW = Date.parse(`${TODAY}T18:00:00Z`);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetCdrWindowCache();
    fetchCdrRange.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never asks the PBX for a day that has not started", async () => {
    const res = await getCdrWindow("2026-08-01", "2026-08-31");

    // One sweep, ending TODAY — not on the 31st.
    expect(askedRanges()).toEqual(["2026-08-01..2026-08-12"]);
    expect(res.daysFetched).toBe(12);
    expect(res.daysInFuture).toBe(19);
  });

  it("issues no request at all for a window entirely in the future", async () => {
    const res = await getCdrWindow("2026-09-01", "2026-09-30");
    expect(fetchCdrRange).not.toHaveBeenCalled();
    expect(res.records).toEqual([]);
    expect(res.daysInFuture).toBe(30);
    expect(res.sweeps).toBe(0);
  });

  it("returns exactly the days that exist, and no placeholder rows for the rest", async () => {
    const res = await getCdrWindow("2026-08-01", "2026-08-31");
    expect(res.records.map((r) => r.new_id)).toEqual(
      enumerateDays("2026-08-01", TODAY).map((d) => `r-${d}`),
    );
  });

  it("counts a month-to-the-31st as WARM once its real days are cached", async () => {
    // Previously impossible: the future days were never cached, so the window
    // read "partial" for the rest of the month and Call Lookup could never take
    // its free path on the current month.
    await getCdrWindow("2026-08-01", "2026-08-31");
    expect(windowCacheState("2026-08-01", "2026-08-31").status).toBe("warm");
  });

  it("costs nothing on the second request — the trap this whole layer exists for", async () => {
    await getCdrWindow("2026-08-01", "2026-08-31");
    fetchCdrRange.mockClear();

    const res = await getCdrWindow("2026-08-01", "2026-08-31");
    expect(fetchCdrRange).not.toHaveBeenCalled();
    expect(res.sweeps).toBe(0);
    expect(res.daysFromCache).toBe(12);
  });

  it("picks the new day up once it actually arrives", async () => {
    await getCdrWindow("2026-08-01", "2026-08-31");
    fetchCdrRange.mockClear();

    // Tomorrow becomes today. The day that was skipped as future is now real,
    // and must be fetched rather than assumed empty forever. Three and a half
    // hours later, so the closed days stay cached and only the live tail moves.
    vi.setSystemTime(Date.parse("2026-08-12T21:30:00Z"));
    const res = await getCdrWindow("2026-08-01", "2026-08-31");

    // The 12th is re-fetched because it was the live day when it was cached and
    // its five-minute TTL has lapsed; the 13th because it has just begun.
    expect(askedRanges()).toEqual(["2026-08-12..2026-08-13"]);
    expect(res.daysInFuture).toBe(18);
    expect(res.records.map((r) => r.new_id)).toContain("r-2026-08-13");
  });
});
