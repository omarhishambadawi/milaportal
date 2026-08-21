/**
 * When an AlShrouq delivery is due, in one canonical form. Pure, no I/O.
 *
 * ## One source of truth, and it is not a display string
 *
 * An agent picks a date and a time in 12-hour form — "21/08/2026", "03:30 PM" —
 * because that is how a delivery slot is spoken about. What gets stored is a UTC
 * instant, because that is the only form `scheduled_for` can be compared against
 * `now()` inside a Postgres worker. The pretty string is derived from the
 * instant, never the other way round: nothing in this file reads a formatted
 * value back.
 *
 * ## Timezone
 *
 * `Asia/Riyadh`, from `BUSINESS_TIMEZONE`, at a fixed +03:00 with no daylight
 * saving. That is what makes this arithmetic honest rather than approximate: a
 * zone with DST could not be converted by subtracting a constant, and "03:30 PM"
 * would mean two different instants twice a year. The browser's own zone is
 * deliberately not consulted — an agent in another zone scheduling a Riyadh
 * delivery means Riyadh time.
 *
 * ## What this file will not do
 *
 * It does not dispatch, schedule, or touch a timer. `describeRemaining` is
 * arithmetic on two numbers; the countdown that uses it is presentation. The
 * courier is sent by `pg_cron` → the worker → the safety gate, and by nothing in
 * a browser.
 */

import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How a dispatch will be performed, decided only by the time chosen. */
export type DispatchTiming = "immediate" | "scheduled";

/**
 * A dispatch whose time is within this of now is treated as immediate.
 *
 * Without it, "send now" would depend on how long the agent spent reading the
 * confirmation — the clock passes the chosen minute while they decide, and an
 * order meant to go straight out becomes a scheduled one waiting for a minute
 * that has already gone.
 */
export const IMMEDIATE_WINDOW_MS = 2 * MINUTE_MS;

export type ScheduleParse =
  | { ok: true; iso: string; timing: DispatchTiming }
  | { ok: false; reason: "incomplete" | "unparseable" | "past" };

/** `"03:30 PM"` / `"3:30 pm"` / `"12:05 AM"` → minutes past midnight. */
function parse12Hour(value: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$/.exec(value);
  if (!m) return null;
  const hour12 = Number(m[1]);
  const minutes = Number(m[2]);
  const isPm = m[3]!.toLowerCase() === "p";
  if (hour12 < 1 || hour12 > 12 || minutes > 59) return null;
  // 12 AM is midnight, 12 PM is noon — the two the naive formula gets wrong.
  const hour24 = hour12 === 12 ? (isPm ? 12 : 0) : isPm ? hour12 + 12 : hour12;
  return hour24 * 60 + minutes;
}

/** `"2026-08-21"` → the three numbers, or null. No `Date` parsing: it guesses. */
function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/**
 * Turn what the agent chose into the instant the worker will compare against.
 *
 * Rejects the past outright rather than quietly scheduling something already
 * overdue: a row whose `scheduled_for` is behind `now()` is dispatched on the
 * very next cron tick, which is not what "3:30 PM yesterday" meant.
 */
export function parseScheduleInput(
  date: string,
  time12h: string,
  now: Date = new Date(),
): ScheduleParse {
  if (!date.trim() || !time12h.trim()) return { ok: false, reason: "incomplete" };

  const d = parseIsoDate(date);
  const minutes = parse12Hour(time12h);
  if (!d || minutes === null) return { ok: false, reason: "unparseable" };

  // Built in UTC from the wall-clock parts, then shifted back by the business
  // offset. `Date.UTC` avoids the host zone entirely.
  const wallClockUtc = Date.UTC(d.y, d.m - 1, d.d, Math.floor(minutes / 60), minutes % 60, 0, 0);
  const instant = wallClockUtc - BUSINESS_UTC_OFFSET_MINUTES * MINUTE_MS;

  const delta = instant - now.getTime();
  if (delta < -IMMEDIATE_WINDOW_MS) return { ok: false, reason: "past" };

  return {
    ok: true,
    iso: new Date(instant).toISOString(),
    timing: delta <= IMMEDIATE_WINDOW_MS ? "immediate" : "scheduled",
  };
}

/** Two-digit, zone-free. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

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

/**
 * `"2026-08-21T12:30:00.000Z"` → `"Aug 21, 2026 · 03:30 PM"`, in Riyadh.
 *
 * Formatted by hand rather than through `toLocaleString`, so the output does not
 * change with the host's locale or zone — an agent and a supervisor on different
 * machines must read the same delivery time off the same row.
 */
export function formatScheduledFor(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;

  const local = new Date(t + BUSINESS_UTC_OFFSET_MINUTES * MINUTE_MS);
  const hour24 = local.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "AM" : "PM";

  return (
    `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}, ${local.getUTCFullYear()}` +
    ` · ${pad(hour12)}:${pad(local.getUTCMinutes())} ${suffix}`
  );
}

/**
 * How long is left, in words an agent would use.
 *
 * Two units at most: "2 hours 3 minutes" is useful, "2 hours 3 minutes 7
 * seconds" is noise on something an hour away. Seconds only appear under a
 * minute, which is the only time they matter.
 */
export function describeRemaining(ms: number): string {
  if (ms <= 0) return "now";

  if (ms < MINUTE_MS) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    const head = `${hours} hour${hours === 1 ? "" : "s"}`;
    return minutes === 0 ? head : `${head} ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const head = `${days} day${days === 1 ? "" : "s"}`;
  return hours === 0 ? head : `${head} ${hours} hour${hours === 1 ? "" : "s"}`;
}
