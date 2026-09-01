import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

/**
 * Telesales date arithmetic.
 *
 * Date logic decides which customers get called, so every function here is pure,
 * total and expressed over `YYYY-MM-DD` strings rather than `Date` objects.
 *
 * The reason is narrow and worth stating: `new Date("2026-08-01")` parses as
 * midnight **UTC**, `new Date(2026, 7, 1)` as midnight in whatever zone the
 * process happens to run in, and this application renders the same component in
 * a Cloudflare Worker (UTC) and in a Riyadh browser (UTC+3). A window computed
 * with either constructor is a window that changes shape depending on where it
 * was computed, which for a three-day rule means dropping or duplicating a day
 * roughly one time in eight.
 *
 * So: all arithmetic goes through `Date.UTC`, all output is a plain date string,
 * and the only place a wall clock is consulted is `businessToday()`.
 *
 * Asia/Riyadh is UTC+3 all year with no DST, so the fixed offset in
 * `BUSINESS_UTC_OFFSET_MINUTES` is exact rather than an approximation — the same
 * assumption the Yeastar CDR bucketing already makes.
 */

/** `YYYY-MM-DD`. The only date representation this module passes around. */
export type BusinessDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is this a well-formed calendar date? Rejects `2026-02-30`. */
export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Round-trip through UTC: 2026-02-30 normalises to 2026-03-02 and fails.
  const t = Date.UTC(year, month - 1, day);
  const back = new Date(t);
  return (
    back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
  );
}

function assertBusinessDate(value: string, label: string): void {
  if (!isBusinessDate(value)) {
    throw new RangeError(`${label} must be a YYYY-MM-DD calendar date, received ${value}`);
  }
}

/** `YYYY-MM-DD` → epoch milliseconds at UTC midnight. */
function toUtcMs(date: BusinessDate): number {
  assertBusinessDate(date, "date");
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Epoch milliseconds → `YYYY-MM-DD`, read in UTC. */
function fromUtcMs(ms: number): BusinessDate {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_MS = 86_400_000;

/**
 * The Riyadh calendar date at an instant.
 *
 * Shift the instant by the business offset and then read it in UTC. This is
 * exact for a zone without DST and, unlike `Intl.DateTimeFormat`, it cannot be
 * influenced by the host's locale data.
 */
export function businessDateAt(instant: Date | number = Date.now()): BusinessDate {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return fromUtcMs(ms + BUSINESS_UTC_OFFSET_MINUTES * 60_000);
}

/** Today, in Riyadh. The one impure function in this file. */
export function businessToday(): BusinessDate {
  return businessDateAt(Date.now());
}

/** Add days (may be negative). Month and year boundaries fall out of the epoch
 *  arithmetic, so `addDays("2026-07-31", 1)` is `2026-08-01` without a case. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function daysBetween(a: BusinessDate, b: BusinessDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function compareDates(a: BusinessDate, b: BusinessDate): number {
  // Fixed-width ISO strings compare correctly as strings, but going through the
  // parser means a malformed value throws here rather than sorting silently.
  return toUtcMs(a) - toUtcMs(b);
}

/** An inclusive range of calendar dates. */
export interface DateWindow {
  from: BusinessDate;
  to: BusinessDate;
}

/** Is `date` inside the window? Both ends inclusive. */
export function withinWindow(window: DateWindow, date: BusinessDate): boolean {
  return compareDates(date, window.from) >= 0 && compareDates(date, window.to) <= 0;
}

/** Every date in the window, in order. Bounded by the CHECK constraints on
 *  `telesales_settings`, so this can never be asked for a year. */
export function enumerateWindow(window: DateWindow): BusinessDate[] {
  const out: BusinessDate[] = [];
  const span = daysBetween(window.from, window.to);
  for (let i = 0; i <= span; i++) out.push(addDays(window.from, i));
  return out;
}

/* ------------------------------------------------------------------------- */
/* The three business windows                                                */
/* ------------------------------------------------------------------------- */

/**
 * The Cash window: which invoice dates are worked on a given day.
 *
 * ```
 *   anchor = 2026-08-01, days = 3, lag = 1   ->   2026-07-29 .. 2026-07-31
 *   anchor = 2026-08-01, days = 3, lag = 0   ->   2026-07-30 .. 2026-08-01
 *   anchor = 2026-08-02, days = 3, lag = 1   ->   2026-07-30 .. 2026-08-01
 * ```
 *
 * ### Why it is parameterised rather than "the last three days"
 *
 * The brief says that on 1 August the desk checks 1, 2 and 3 July. The workbook
 * says each working sheet covers at most three *consecutive* invoice dates —
 * `3-4`, `5-6`, `8-9`, `10-11`, `13`, `15-17`, `18-20`, `21`, `23`, `24-26`,
 * `27-29`, `30-31`. Both statements are accurate, and they are reconciled by the
 * fact that the extract arrives monthly: through August the team was walking a
 * three-day window across July, one batch per working day, skipping the days
 * they did not work (1-2, 7, 12, 14 and 22 July have no sheet).
 *
 * The invariant is therefore the *shape* — N consecutive days ending some lag
 * before the day being worked — and not the particular month-long lag that a
 * monthly file delivery produced. `cashWindowDays` and `cashWindowLagDays` carry
 * both, and a run may be anchored to any date, which is how the same generator
 * reproduces a backfill of July while running today's window tomorrow.
 *
 * `lag = 1` is the default because an invoice written this morning is not a lead
 * this afternoon; the branch is still holding the item.
 */
export function cashWindow(
  anchor: BusinessDate,
  opts: { days: number; lagDays: number },
): DateWindow {
  const days = Math.max(1, Math.trunc(opts.days));
  const lag = Math.max(0, Math.trunc(opts.lagDays));
  const to = addDays(anchor, -lag);
  return { from: addDays(to, -(days - 1)), to };
}

/**
 * The Wasfaty window: today and tomorrow.
 *
 * ```
 *   anchor = 2026-09-01, days = 2   ->   2026-09-01 .. 2026-09-02
 *   anchor = 2026-08-31, days = 2   ->   2026-08-31 .. 2026-09-01
 * ```
 *
 * Forward, not backward, because the date it is applied to means something
 * different from the Cash one: `Next Dispense Date` is when a prescription
 * *becomes* collectable, so the desk is calling ahead of it, not chasing it. The
 * second day is the pre-opening allowance — a prescription can open a day early,
 * and a customer called on the day it opens has already been to the pharmacy.
 *
 * Confirmed against `Wasfaty Sep`, whose `Next Dispense Date` values run forward
 * from the day the sheet was being worked (2026-09-01) into November, and whose
 * `Days to refill` column reads "4 Days Remaining" against 2026-09-05.
 */
export function wasfatyWindow(anchor: BusinessDate, opts: { days: number }): DateWindow {
  const days = Math.max(1, Math.trunc(opts.days));
  return { from: anchor, to: addDays(anchor, days - 1) };
}

/**
 * The Retention window: follow-ups that have come due.
 *
 * ```
 *   anchor = 2026-09-01, grace = 14   ->   2026-08-18 .. 2026-09-01
 * ```
 *
 * Backward and inclusive of the anchor, because a retention lead becomes
 * workable *on* its due date and stays workable while somebody still intends to
 * call. The workbooks' rule was `Days to refill = 0`, i.e. exactly today —
 * which, applied literally, drops a lead permanently the moment a working day is
 * missed. The three workbooks contain 328 rows carrying a scheduled call date,
 * of which a large share read "N Days Overdue"; those are the leads the literal
 * rule lost.
 *
 * The grace period is where the generator stops re-raising: past it, the
 * follow-up is still shown as overdue on the board, but a person has to decide
 * what to do with it rather than it silently reappearing in the queue forever.
 */
export function retentionWindow(anchor: BusinessDate, opts: { graceDays: number }): DateWindow {
  const grace = Math.max(0, Math.trunc(opts.graceDays));
  return { from: addDays(anchor, -grace), to: anchor };
}

/* ------------------------------------------------------------------------- */
/* Reading dates out of a spreadsheet                                        */
/* ------------------------------------------------------------------------- */

/**
 * Excel serial day → calendar date.
 *
 * Day 1 is 1900-01-01, and Excel believes 1900 was a leap year, so serials from
 * 61 onward are one greater than the true day count. The conventional fix is to
 * treat the epoch as 1899-12-30, which is what this does.
 *
 * Serials below 61 are refused rather than corrected: they are within the
 * fictional-February region where no correct answer exists, and in these
 * workbooks a small number in a date column is a stray quantity or a branch code,
 * not a date in 1900.
 */
export function fromExcelSerial(serial: number): BusinessDate | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < 61 || whole > 60_000) return null; // 60000 ≈ year 2064
  return fromUtcMs(Date.UTC(1899, 11, 30) + whole * DAY_MS);
}

/**
 * Which way round is `03/07/26`?
 *
 * The workbooks answer differently per sheet. `July Leads` sheets `3-4` and
 * `5-6` write `03-07-26` for 3 July; sheets `13` onward write `7/13/26 0:00` for
 * 13 July. `Wasfaty Leads` uses `15/05/2026`, `05/17/2026`, `2026-07-27` and
 * `06/04/26` — the last of which is genuinely ambiguous and appears in a sheet
 * whose neighbours prove day-first.
 *
 * So ambiguity is resolved by an explicit per-sheet preference rather than by a
 * guess, and the parser infers that preference from the whole column before
 * parsing any single cell (see `inferDayFirst`).
 */
export type DateOrder = "dayFirst" | "monthFirst";

/**
 * Parse one cell into a calendar date, or `null`.
 *
 * Handles: ISO (`2026-07-27`), Excel serial (number or numeric string),
 * `Date` objects from `cellDates`, `d/m/y` and `m/d/y` with `/` or `-`
 * separators, two- or four-digit years, and a trailing time (`7/13/26 0:00`).
 *
 * Returns `null` for everything else — including `"no record"`, `"N/A"`,
 * `"زSAR 150.0"` and a bare `" "`, all of which are real values in the date
 * columns of `Wasfaty Leads`. A null is reported to the operator as an issue on
 * a numbered row; it is never silently replaced with today.
 */
export function parseSheetDate(value: unknown, order: DateOrder = "dayFirst"): BusinessDate | null {
  if (value == null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    /*
     * Local components, not UTC ones — and this is a trap worth naming.
     *
     * `xlsx` with `cellDates: true` constructs a Date at **local** midnight for
     * the day the cell holds. Reading it back with `getUTCDate()` therefore
     * returns the previous day for every host east of Greenwich: the Retention
     * workbook's "Thursday, August 20" came back as 2026-08-19 that way, which
     * would have moved all 328 promised callbacks a day earlier.
     *
     * The reader avoids producing these at all (see `parseWorkbookFile`, which
     * asks for serials), so this branch only fires for a Date handed in by some
     * other caller. Reading the local components is right for both.
     */
    return fromUtcMs(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }

  if (typeof value === "number") return fromExcelSerial(value);

  const text = String(value).trim();
  if (!text) return null;

  // ISO first: unambiguous, and the shape `Wasfaty Sep` uses throughout.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isBusinessDate(candidate) ? candidate : null;
  }

  // A bare number that arrived as text — `"46228"` appears 13 times in the
  // Retention sheet's InvDate column.
  if (/^\d+(\.\d+)?$/.test(text)) return fromExcelSerial(Number(text));

  // d/m/y or m/d/y, with an optional trailing time that is discarded: the
  // business rules are day-grained, and `7/13/26 0:00` carries a midnight that
  // means "no time was recorded", not "midnight".
  const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(text);
  if (!parts) return null;

  const a = Number(parts[1]);
  const b = Number(parts[2]);
  let year = Number(parts[3]);
  if (parts[3].length <= 2) year += 2000;

  let day: number;
  let month: number;
  if (order === "dayFirst") {
    day = a;
    month = b;
  } else {
    day = b;
    month = a;
  }

  // One-sided rescue: `15/05/2026` in a month-first sheet, or `05/17/2026` in a
  // day-first one. When only one reading is a valid month, take it — the sheets
  // mix orders within a column often enough (`Jeddah` has both `05/17/2026` and
  // `31/7/2026`) that refusing would lose real rows.
  if (month > 12 && day <= 12) {
    const swap = day;
    day = month;
    month = swap;
  }

  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isBusinessDate(candidate) ? candidate : null;
}

/**
 * Decide a column's date order by looking at all of it.
 *
 * A value with a first component above 12 can only be day-first; one with a
 * second component above 12 can only be month-first. Count both across the
 * column and let the majority decide; a column with no evidence either way
 * defaults to day-first, which is the Saudi convention and what the majority of
 * these sheets use.
 *
 * This is why it is a column-level decision and not a cell-level one: `06/04/26`
 * is unreadable alone and unambiguous beside 200 neighbours.
 */
export function inferDayFirst(values: readonly unknown[]): DateOrder {
  let dayFirstEvidence = 0;
  let monthFirstEvidence = 0;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(value.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirstEvidence++;
    else if (b > 12 && a <= 12) monthFirstEvidence++;
  }
  return monthFirstEvidence > dayFirstEvidence ? "monthFirst" : "dayFirst";
}

/**
 * "12 Aug 2026". Display only.
 *
 * Built from the parsed parts rather than handed to `Intl` with a `Date`,
 * because a `YYYY-MM-DD` given to `new Date()` is UTC midnight and formatting it
 * in Riyadh is fine, while formatting it anywhere west of Greenwich shows the
 * previous day. This module's dates have no time and must not acquire one.
 */
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatBusinessDate(date: BusinessDate | null | undefined): string {
  if (!date || !isBusinessDate(date)) return "—";
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "29–31 Jul 2026" / "31 Jul – 2 Aug 2026" / "3 Jul 2026". For the reason line
 *  on a lead and the header of a generation run. */
export function formatWindow(window: DateWindow): string {
  if (window.from === window.to) return formatBusinessDate(window.from);
  const [fy, fm] = window.from.split("-").map(Number);
  const [ty, tm] = window.to.split("-").map(Number);
  const fd = Number(window.from.split("-")[2]);
  if (fy === ty && fm === tm) return `${fd}–${formatBusinessDate(window.to)}`;
  if (fy === ty) return `${fd} ${MONTHS[fm - 1]} – ${formatBusinessDate(window.to)}`;
  return `${formatBusinessDate(window.from)} – ${formatBusinessDate(window.to)}`;
}

/**
 * How a follow-up date reads on screen.
 *
 * This is the honest replacement for the workbooks' `Days to refill` column. All
 * three compute it as `=TODAY()-<date to be called>` behind a number format that
 * prints "Overdue" for positive results and "Remaining" for negative ones — so
 * the column was never a refill interval, and its ubiquitous `46266 Days
 * Overdue` is that subtraction against an empty cell.
 *
 * Here the empty case is `null` and renders as "Not scheduled", because a lead
 * with no next step is a real state that the desk needs to be able to see rather
 * than a number 127 years wide.
 */
export function describeDue(
  dueOn: BusinessDate | null | undefined,
  today: BusinessDate,
): { label: string; tone: "overdue" | "today" | "upcoming" | "none"; days: number | null } {
  if (!dueOn || !isBusinessDate(dueOn)) {
    return { label: "Not scheduled", tone: "none", days: null };
  }
  const days = daysBetween(today, dueOn);
  if (days === 0) return { label: "Due today", tone: "today", days: 0 };
  if (days < 0) {
    const n = Math.abs(days);
    return { label: `${n} day${n === 1 ? "" : "s"} overdue`, tone: "overdue", days };
  }
  return { label: `In ${days} day${days === 1 ? "" : "s"}`, tone: "upcoming", days };
}
