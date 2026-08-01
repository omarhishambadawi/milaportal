/**
 * Call Report request-contract tests.
 *
 * The date format is the single most expensive thing in this integration to get
 * wrong, because a malformed value does not fail loudly — `openapi/v1.0` accepts
 * it, ignores the window and returns `errcode 0` with `total_number: 0`. That
 * looked like "the PBX has no report data" for two sprints. These tests pin the
 * format so it cannot drift back.
 *
 * The expected format came from the PBX's own v2.0 validator, verbatim:
 *   "start_time format invalid, valid format: 02/01/2006 03:04:05 PM"
 * which is Go's reference-time layout — DD/MM/YYYY hh:mm:ss AM|PM.
 */
import { describe, expect, it } from "vitest";
import { formatCallReportTime, callReportWindow } from "../call-report.server";

/**
 * Go's reference instant: 2 January 2006, 15:04:05.
 *
 * Formatting THIS instant must reproduce the PBX's own layout string exactly.
 * If it does, the format is right by construction rather than by transcription.
 */
const GO_REFERENCE_EPOCH = Date.UTC(2006, 0, 2, 15, 4, 5) / 1000;

describe("formatCallReportTime", () => {
  it("reproduces the PBX's own layout string for Go's reference instant", () => {
    expect(formatCallReportTime(GO_REFERENCE_EPOCH, 0)).toBe("02/01/2006 03:04:05 PM");
  });

  it("puts the DAY first, not the year — the documented example is wrong here", () => {
    // 2026-07-29 00:00:00 UTC
    const t = Date.UTC(2026, 6, 29, 0, 0, 0) / 1000;
    expect(formatCallReportTime(t, 0)).toBe("29/07/2026 12:00:00 AM");
    expect(formatCallReportTime(t, 0)).not.toContain("2026/07/29");
  });

  it("renders midnight as 12 AM and noon as 12 PM, never 00 or 24", () => {
    const midnight = Date.UTC(2026, 6, 29, 0, 0, 0) / 1000;
    const noon = Date.UTC(2026, 6, 29, 12, 0, 0) / 1000;
    expect(formatCallReportTime(midnight, 0)).toBe("29/07/2026 12:00:00 AM");
    expect(formatCallReportTime(noon, 0)).toBe("29/07/2026 12:00:00 PM");
  });

  it("zero-pads every field", () => {
    const t = Date.UTC(2026, 0, 5, 9, 8, 7) / 1000;
    expect(formatCallReportTime(t, 0)).toBe("05/01/2026 09:08:07 AM");
  });

  it("renders the last second of the day as 11:59:59 PM", () => {
    const t = Date.UTC(2026, 6, 29, 23, 59, 59) / 1000;
    expect(formatCallReportTime(t, 0)).toBe("29/07/2026 11:59:59 PM");
  });

  it("shifts into the business timezone", () => {
    // 21:00 UTC is 00:00 the NEXT day at UTC+3 — the report must be asked for
    // the PBX's local day, not ours.
    const t = Date.UTC(2026, 6, 28, 21, 0, 0) / 1000;
    expect(formatCallReportTime(t, 180)).toBe("29/07/2026 12:00:00 AM");
    expect(formatCallReportTime(t, 0)).toBe("28/07/2026 09:00:00 PM");
  });
});

describe("callReportWindow", () => {
  it("spans local midnight to 23:59:59 inclusive", () => {
    const w = callReportWindow("2026-07-29", "2026-07-29", 180);
    expect(w.start).toBe("29/07/2026 12:00:00 AM");
    expect(w.end).toBe("29/07/2026 11:59:59 PM");
  });

  it("uses the same epoch bounds as the CDR fetcher, so both sources agree", () => {
    // Mirrors `dayBounds` in cdr.server.ts. A disagreement here would surface
    // as a KPI mismatch and be blamed on the metric rather than the window.
    const offMs = 180 * 60_000;
    const w = callReportWindow("2026-07-01", "2026-07-31", 180);
    expect(w.startEpoch).toBe(Math.floor((Date.parse("2026-07-01T00:00:00Z") - offMs) / 1000));
    expect(w.endEpoch).toBe(Math.floor((Date.parse("2026-07-31T23:59:59Z") - offMs) / 1000));
    expect(w.endEpoch - w.startEpoch).toBe(31 * 86_400 - 1);
  });

  it("handles a multi-day range", () => {
    const w = callReportWindow("2026-07-01", "2026-08-01", 180);
    expect(w.start).toBe("01/07/2026 12:00:00 AM");
    expect(w.end).toBe("01/08/2026 11:59:59 PM");
  });
});
