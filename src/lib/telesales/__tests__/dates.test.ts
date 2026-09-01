import { describe, expect, it } from "vitest";
import {
  addDays,
  businessDateAt,
  cashWindow,
  compareDates,
  daysBetween,
  describeDue,
  enumerateWindow,
  formatWindow,
  fromExcelSerial,
  inferDayFirst,
  isBusinessDate,
  parseSheetDate,
  retentionWindow,
  wasfatyWindow,
  withinWindow,
} from "../dates";

describe("business date primitives", () => {
  it("rejects dates that do not exist", () => {
    expect(isBusinessDate("2026-02-30")).toBe(false);
    expect(isBusinessDate("2026-13-01")).toBe(false);
    expect(isBusinessDate("2026-2-1")).toBe(false);
    expect(isBusinessDate("2026-02-28")).toBe(true);
    // 2026 is not a leap year.
    expect(isBusinessDate("2026-02-29")).toBe(false);
    expect(isBusinessDate("2028-02-29")).toBe(true);
  });

  it("crosses month and year boundaries without a special case", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-07-29", "2026-08-01")).toBe(3);
    expect(daysBetween("2026-08-01", "2026-07-29")).toBe(-3);
  });

  it("reads the Riyadh calendar date, not the host's", () => {
    // 2026-08-01T22:30:00Z is 2026-08-02 01:30 in Riyadh (UTC+3).
    expect(businessDateAt(Date.UTC(2026, 7, 1, 22, 30))).toBe("2026-08-02");
    // 2026-08-01T00:30:00Z is still 2026-08-01 03:30 in Riyadh.
    expect(businessDateAt(Date.UTC(2026, 7, 1, 0, 30))).toBe("2026-08-01");
    // The boundary itself: 21:00Z is exactly midnight in Riyadh.
    expect(businessDateAt(Date.UTC(2026, 7, 1, 21, 0))).toBe("2026-08-02");
    expect(businessDateAt(Date.UTC(2026, 7, 1, 20, 59, 59))).toBe("2026-08-01");
  });
});

describe("the Cash window", () => {
  it("is exactly three previous days by default", () => {
    const w = cashWindow("2026-08-01", { days: 3, lagDays: 1 });
    expect(w).toEqual({ from: "2026-07-29", to: "2026-07-31" });
    expect(enumerateWindow(w)).toEqual(["2026-07-29", "2026-07-30", "2026-07-31"]);
  });

  it("crosses a month boundary intact", () => {
    // Anchored to 2 August, the window straddles the month end.
    expect(cashWindow("2026-08-02", { days: 3, lagDays: 1 })).toEqual({
      from: "2026-07-30",
      to: "2026-08-01",
    });
    // And a year boundary.
    expect(cashWindow("2027-01-02", { days: 3, lagDays: 1 })).toEqual({
      from: "2026-12-30",
      to: "2027-01-01",
    });
  });

  it("includes the anchor day only when the lag is zero", () => {
    expect(cashWindow("2026-08-01", { days: 3, lagDays: 0 })).toEqual({
      from: "2026-07-30",
      to: "2026-08-01",
    });
  });

  it("reproduces the working sheets' shape", () => {
    // The July workbook's sheets are named for the invoice dates they cover, and
    // the widest of them span exactly three consecutive days: `15-17`, `24-26`,
    // `27-29`. A three-day window anchored the day after each sheet's last date
    // reproduces it.
    expect(enumerateWindow(cashWindow("2026-07-18", { days: 3, lagDays: 1 }))).toEqual([
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
    ]);
    expect(enumerateWindow(cashWindow("2026-07-27", { days: 3, lagDays: 1 }))).toEqual([
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
  });

  it("degenerates safely to a single day", () => {
    expect(cashWindow("2026-08-01", { days: 1, lagDays: 1 })).toEqual({
      from: "2026-07-31",
      to: "2026-07-31",
    });
    // Nonsense input is clamped rather than producing an inverted window.
    expect(cashWindow("2026-08-01", { days: 0, lagDays: -5 })).toEqual({
      from: "2026-08-01",
      to: "2026-08-01",
    });
  });

  it("excludes a date one day outside either edge", () => {
    const w = cashWindow("2026-08-01", { days: 3, lagDays: 1 });
    expect(withinWindow(w, "2026-07-28")).toBe(false);
    expect(withinWindow(w, "2026-07-29")).toBe(true);
    expect(withinWindow(w, "2026-07-31")).toBe(true);
    expect(withinWindow(w, "2026-08-01")).toBe(false);
  });
});

describe("the Wasfaty window", () => {
  it("is today and tomorrow", () => {
    expect(wasfatyWindow("2026-09-01", { days: 2 })).toEqual({
      from: "2026-09-01",
      to: "2026-09-02",
    });
  });

  it("crosses a month boundary forward", () => {
    expect(wasfatyWindow("2026-08-31", { days: 2 })).toEqual({
      from: "2026-08-31",
      to: "2026-09-01",
    });
  });

  it("excludes yesterday", () => {
    const w = wasfatyWindow("2026-09-01", { days: 2 });
    expect(withinWindow(w, "2026-08-31")).toBe(false);
    expect(withinWindow(w, "2026-09-01")).toBe(true);
    expect(withinWindow(w, "2026-09-02")).toBe(true);
    expect(withinWindow(w, "2026-09-03")).toBe(false);
  });
});

describe("the Retention window", () => {
  it("runs backward from the anchor and includes it", () => {
    expect(retentionWindow("2026-09-01", { graceDays: 14 })).toEqual({
      from: "2026-08-18",
      to: "2026-09-01",
    });
  });

  it("with no grace, is exactly today", () => {
    const w = retentionWindow("2026-09-01", { graceDays: 0 });
    expect(w).toEqual({ from: "2026-09-01", to: "2026-09-01" });
    expect(withinWindow(w, "2026-08-31")).toBe(false);
    expect(withinWindow(w, "2026-09-01")).toBe(true);
  });

  it("does not raise a follow-up that is due in the future", () => {
    const w = retentionWindow("2026-09-01", { graceDays: 14 });
    expect(withinWindow(w, "2026-09-05")).toBe(false);
  });

  it("stops raising past the grace period", () => {
    const w = retentionWindow("2026-09-01", { graceDays: 14 });
    expect(withinWindow(w, "2026-08-18")).toBe(true);
    expect(withinWindow(w, "2026-08-17")).toBe(false);
  });
});

describe("reading dates out of a spreadsheet", () => {
  it("reads every format the three workbooks actually contain", () => {
    // July Leads, sheets 3-4 and 5-6: dd-mm-yy.
    expect(parseSheetDate("03-07-26", "dayFirst")).toBe("2026-07-03");
    expect(parseSheetDate("05-07-26", "dayFirst")).toBe("2026-07-05");
    // July Leads, sheet 13 onward: m/d/yy with a trailing midnight.
    expect(parseSheetDate("7/13/26 0:00", "monthFirst")).toBe("2026-07-13");
    expect(parseSheetDate("7/21/26 0:00", "monthFirst")).toBe("2026-07-21");
    // Wasfaty Sep and Riyadh: ISO.
    expect(parseSheetDate("2026-09-05")).toBe("2026-09-05");
    expect(parseSheetDate("2026-07-27")).toBe("2026-07-27");
    // Wasfaty Riyadh|Al-Kharj|Rafha: dd/mm/yyyy.
    expect(parseSheetDate("15/05/2026", "dayFirst")).toBe("2026-05-15");
    // Wasfaty Jeddah: mm/dd/yyyy.
    expect(parseSheetDate("05/17/2026", "monthFirst")).toBe("2026-05-17");
    // Retention InvDate: a bare Excel serial that arrived as text.
    expect(parseSheetDate("46228")).toBe("2026-07-25");
  });

  it("refuses the junk that shares those columns", () => {
    // Every one of these is a real value in a date column of Wasfaty Leads.
    expect(parseSheetDate("no record")).toBeNull();
    expect(parseSheetDate("N/A")).toBeNull();
    expect(parseSheetDate("زSAR 150.0")).toBeNull();
    expect(parseSheetDate(" ")).toBeNull();
    expect(parseSheetDate(null)).toBeNull();
    expect(parseSheetDate("")).toBeNull();
    // A truncated cell from the Retention sheet.
    expect(parseSheetDate("29-06-26 0", "dayFirst")).toBe("2026-06-29");
  });

  it("rescues a one-sided reading when the stated order is wrong", () => {
    // A day-first sheet containing an American date. 17 cannot be a month, so
    // there is exactly one valid reading and it is taken.
    expect(parseSheetDate("05/17/2026", "dayFirst")).toBe("2026-05-17");
    // And the converse.
    expect(parseSheetDate("31/7/2026", "monthFirst")).toBe("2026-07-31");
  });

  it("refuses a genuinely impossible date rather than rolling it over", () => {
    expect(parseSheetDate("32/07/2026", "dayFirst")).toBeNull();
    expect(parseSheetDate("30/02/2026", "dayFirst")).toBeNull();
  });

  it("handles the Excel leap-year bug at the epoch", () => {
    // Serial 61 is 1 March 1900 — the first day after Excel's fictional
    // 29 February.
    expect(fromExcelSerial(61)).toBe("1900-03-01");
    /*
     * 46266 is the number this whole module was named after.
     *
     * Every workbook shows `46266 Days Overdue` in its "Days to refill" column,
     * which is `=TODAY()-<blank>` — Excel reading an empty cell as day zero. The
     * serial that equals that difference is today's own serial, and it decodes
     * to 2026-09-01: the day the files were last saved. The bug and the epoch
     * agree, which is the confirmation that the column is a subtraction against
     * nothing rather than a data point.
     */
    expect(fromExcelSerial(46266)).toBe("2026-09-01");
    // Below 61 there is no correct answer, so there is no answer.
    expect(fromExcelSerial(60)).toBeNull();
    expect(fromExcelSerial(1)).toBeNull();
    expect(fromExcelSerial(0)).toBeNull();
  });

  it("infers a column's order from the whole column", () => {
    // Only a day-first reading explains 31 in the first position.
    expect(inferDayFirst(["03/07/26", "31/07/2026", "15/05/2026"])).toBe("dayFirst");
    // Only a month-first reading explains 13 in the second.
    expect(inferDayFirst(["7/13/26 0:00", "7/21/26 0:00", "6/4/26"])).toBe("monthFirst");
    // No evidence either way defaults to the Saudi convention.
    expect(inferDayFirst(["06/04/26", "01/02/26"])).toBe("dayFirst");
    expect(inferDayFirst([])).toBe("dayFirst");
    // Non-strings are ignored rather than throwing.
    expect(inferDayFirst([null, 46228, new Date()])).toBe("dayFirst");
  });
});

describe("how a due date reads", () => {
  it("replaces the workbook's 46266-day bug with an honest empty state", () => {
    expect(describeDue(null, "2026-09-01")).toEqual({
      label: "Not scheduled",
      tone: "none",
      days: null,
    });
  });

  it("says today, overdue and upcoming", () => {
    expect(describeDue("2026-09-01", "2026-09-01").label).toBe("Due today");
    expect(describeDue("2026-08-30", "2026-09-01").label).toBe("2 days overdue");
    expect(describeDue("2026-08-31", "2026-09-01").label).toBe("1 day overdue");
    expect(describeDue("2026-09-03", "2026-09-01").label).toBe("In 2 days");
    expect(describeDue("2026-09-02", "2026-09-01").label).toBe("In 1 day");
  });

  it("matches the arithmetic the workbooks displayed", () => {
    // Retention Leads row 4: "Thursday, August 20" reading "12 Days Overdue" as
    // of 2026-09-01.
    expect(describeDue("2026-08-20", "2026-09-01").days).toBe(-12);
    // Wasfaty Sep row 2: next dispense 2026-09-05, "4 Days Remaining".
    expect(describeDue("2026-09-05", "2026-09-01").days).toBe(4);
  });
});

describe("window labels", () => {
  it("collapses a same-month range and spells out a crossing one", () => {
    expect(formatWindow({ from: "2026-07-29", to: "2026-07-31" })).toBe("29–31 Jul 2026");
    expect(formatWindow({ from: "2026-07-31", to: "2026-08-02" })).toBe("31 Jul – 2 Aug 2026");
    expect(formatWindow({ from: "2026-07-13", to: "2026-07-13" })).toBe("13 Jul 2026");
    expect(formatWindow({ from: "2026-12-31", to: "2027-01-01" })).toBe("31 Dec 2026 – 1 Jan 2027");
  });
});

describe("ordering", () => {
  it("compares dates numerically", () => {
    expect(compareDates("2026-08-01", "2026-08-02")).toBeLessThan(0);
    expect(compareDates("2026-08-02", "2026-08-01")).toBeGreaterThan(0);
    expect(compareDates("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("throws on a malformed date rather than sorting it", () => {
    expect(() => compareDates("2026-8-1", "2026-08-02")).toThrow(RangeError);
  });
});
