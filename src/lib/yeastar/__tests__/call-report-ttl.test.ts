/**
 * Call Report cache lifetime.
 *
 * Two slow PBX requests per miss, on the page that also runs the CDR sweep. The
 * rule that matters: a window whose last day has already ended is FINISHED — the
 * PBX does not revise last month's queue performance — so it must not be
 * re-fetched on a five-minute timer. Only a window containing today can move.
 *
 * The policy is expressed here rather than reaching into the server function,
 * which is unreachable from a test without a Supabase session.
 */
import { describe, expect, it } from "vitest";
import { __ttls } from "@/lib/yeastar/cdr-window.server";

/** Mirrors `callReportTtl` in yeastar.functions.ts. */
function callReportTtl(to: string, today: string, liveTtl: number): number {
  return to < today ? __ttls.CLOSED_DAY_TTL_MS : liveTtl;
}

const LIVE = 5 * 60_000;
const TODAY = "2026-08-05";

describe("callReportTtl", () => {
  it("holds a closed month for hours, not minutes", () => {
    // Last month: every day has ended, the report is final.
    expect(callReportTtl("2026-07-31", TODAY, LIVE)).toBe(__ttls.CLOSED_DAY_TTL_MS);
    expect(callReportTtl("2026-07-31", TODAY, LIVE)).toBeGreaterThan(LIVE);
  });

  it("expires quickly for a window that still includes today", () => {
    expect(callReportTtl(TODAY, TODAY, LIVE)).toBe(LIVE);
  });

  it("treats yesterday as closed", () => {
    expect(callReportTtl("2026-08-04", TODAY, LIVE)).toBe(__ttls.CLOSED_DAY_TTL_MS);
  });

  it("treats a future end date as live rather than closed", () => {
    // A range picker can hand back a `to` past today; that window can still gain
    // calls, so it must not be pinned for twelve hours.
    expect(callReportTtl("2026-08-31", TODAY, LIVE)).toBe(LIVE);
  });

  it("is a strict date comparison, not a prefix or numeric one", () => {
    // ISO dates compare correctly as strings only because they are zero-padded;
    // this pins that the boundary is exact rather than accidental.
    expect(callReportTtl("2026-08-04", "2026-08-05", LIVE)).toBe(__ttls.CLOSED_DAY_TTL_MS);
    expect(callReportTtl("2026-09-01", "2026-08-31", LIVE)).toBe(LIVE);
    expect(callReportTtl("2025-12-31", "2026-01-01", LIVE)).toBe(__ttls.CLOSED_DAY_TTL_MS);
  });

  it("keeps the closed lifetime aligned with the CDR day store", () => {
    // Both answer the same question — "can this still change?" — so a split
    // between them would show up as one source refreshing without the other.
    expect(__ttls.CLOSED_DAY_TTL_MS).toBeGreaterThanOrEqual(60 * 60_000);
    expect(__ttls.LIVE_DAY_TTL_MS).toBe(LIVE);
  });
});
