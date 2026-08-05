import { describe, it, expect } from "vitest";
import { resolveRefreshPolicy, windowDays, SERVER_CACHE_TTL_MS } from "../refresh-policy";

const LIVE_MS = 20_000;
const TODAY = "2026-08-05";

describe("windowDays", () => {
  it("counts a single day as one, not zero", () => {
    expect(windowDays("2026-08-05", "2026-08-05")).toBe(1);
  });

  it("is inclusive of both ends", () => {
    expect(windowDays("2026-08-01", "2026-08-07")).toBe(7);
    expect(windowDays("2026-07-01", "2026-07-31")).toBe(31);
  });

  it("survives a DST-style offset without dropping a day", () => {
    // Parsed as UTC precisely so a local DST shift cannot round 31 down to 30.
    expect(windowDays("2026-03-01", "2026-03-31")).toBe(31);
    expect(windowDays("2026-10-01", "2026-10-31")).toBe(31);
  });

  it("falls back to one day rather than NaN on an unparseable key", () => {
    // The normalizer emits a `—` bucket for a call with no usable timestamp;
    // a NaN here would become a NaN refetchInterval, which React Query treats
    // as "poll immediately, forever".
    expect(windowDays("—", "2026-08-05")).toBe(1);
    expect(windowDays("2026-08-05", "")).toBe(1);
  });
});

describe("resolveRefreshPolicy", () => {
  it("polls a live single-day window at the operational cadence", () => {
    const p = resolveRefreshPolicy(TODAY, TODAY, LIVE_MS, TODAY);
    expect(p.intervalMs).toBe(LIVE_MS);
    expect(p.staleMs).toBe(LIVE_MS);
    expect(p.windowDays).toBe(1);
    expect(p.label).toContain("20s");
  });

  it("still polls today-plus-yesterday — an overnight shift is one window", () => {
    const p = resolveRefreshPolicy("2026-08-04", TODAY, LIVE_MS, TODAY);
    expect(p.intervalMs).toBe(LIVE_MS);
  });

  it("backs a live week off to the server cache TTL, not to nothing", () => {
    // The band exists so "last 7 days" does not fall off a cliff into never
    // refreshing; it refreshes at the only rate the server can actually answer
    // with new rows.
    const p = resolveRefreshPolicy("2026-07-30", TODAY, LIVE_MS, TODAY);
    expect(p.windowDays).toBe(7);
    expect(p.intervalMs).toBe(SERVER_CACHE_TTL_MS);
  });

  it("stops polling a month — the whole point of the change", () => {
    // A month re-aggregates the full window server-side on every tick, for
    // numbers that are historical. Three times a minute was the page's single
    // largest cost.
    const p = resolveRefreshPolicy("2026-07-06", TODAY, LIVE_MS, TODAY);
    expect(p.windowDays).toBe(31);
    expect(p.intervalMs).toBe(false);
    expect(p.staleMs).toBe(SERVER_CACHE_TTL_MS);
  });

  it("never polls a window that already ended, however small", () => {
    // Yesterday alone cannot gain a call, so no cadence can improve it.
    const p = resolveRefreshPolicy("2026-08-04", "2026-08-04", LIVE_MS, TODAY);
    expect(p.windowDays).toBe(1);
    expect(p.intervalMs).toBe(false);
    expect(p.label).toContain("Closed window");
  });

  it("treats a window ending in the future as live", () => {
    // The date picker allows it, and such a window still gains today's calls.
    const p = resolveRefreshPolicy(TODAY, "2026-08-06", LIVE_MS, TODAY);
    expect(p.intervalMs).toBe(LIVE_MS);
  });

  it("distinguishes a large live window from a closed one in its label", () => {
    expect(resolveRefreshPolicy("2026-07-06", TODAY, LIVE_MS, TODAY).label).toContain(
      "Large window",
    );
    expect(resolveRefreshPolicy("2026-06-01", "2026-06-30", LIVE_MS, TODAY).label).toContain(
      "Closed window",
    );
  });

  it("always reports a usable interval — never NaN or a negative", () => {
    for (const [from, to] of [
      [TODAY, TODAY],
      ["2026-07-30", TODAY],
      ["2026-01-01", TODAY],
      ["2026-01-01", "2026-01-31"],
      ["—", TODAY],
    ]) {
      const p = resolveRefreshPolicy(from, to, LIVE_MS, TODAY);
      expect(p.intervalMs === false || p.intervalMs > 0).toBe(true);
      expect(Number.isFinite(p.staleMs)).toBe(true);
      expect(Number.isInteger(p.windowDays)).toBe(true);
      expect(p.windowDays).toBeGreaterThan(0);
    }
  });
});
