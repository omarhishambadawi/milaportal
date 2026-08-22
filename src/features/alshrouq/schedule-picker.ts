/**
 * The values behind the delivery date and time controls. Pure, no clock of its
 * own, no React.
 *
 * ## Why this replaced the slot list
 *
 * The dialog used to offer five generated whole hours — "Today 9:00 PM",
 * "Today 10:00 PM", … — which is a long list to render, cannot express 7:30,
 * and grew the confirmation into the tallest thing on the screen. It is now a
 * date and a time the agent actually picks: a calendar, and an hour / minute /
 * AM-PM triple.
 *
 * ## The wire format is unchanged
 *
 * Everything here produces the two strings `parseScheduleInput` has always
 * taken — `"2026-08-23"` and `"07:30 PM"` — and that function, untouched, is
 * still what turns them into the UTC instant `scheduled_for` stores. Nothing in
 * this file computes an instant, and nothing decides whether a dispatch is
 * immediate or scheduled: the server does that against its own clock.
 *
 * ## Riyadh, not the browser
 *
 * "Today" and "already past" are answered in business time, at the fixed +03:00
 * of `BUSINESS_UTC_OFFSET_MINUTES`, for the same reason `parseScheduleInput`
 * builds its instant that way: an agent in another zone arranging a Riyadh
 * delivery means Riyadh. A zone with daylight saving could not be handled by
 * adding a constant, and this one has none.
 */

import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

const MINUTE_MS = 60_000;

/** Morning or afternoon, as the picker and `parseScheduleInput` both spell it. */
export type Meridiem = "AM" | "PM";

/**
 * How far ahead the default selection sits.
 *
 * The same reasoning the slot list had: a time chosen while the dialog is open
 * must not fall behind `now()` while the agent reads it, which is the case
 * `parseScheduleInput` would then reject as `past` after they had picked it.
 */
export const LEAD_MINUTES = 30;

/** The step the default lands on. A courier slot is not accurate to the minute. */
const DEFAULT_STEP_MINUTES = 15;

const MINUTES_PER_DAY = 24 * 60;

export interface ScheduleSelection {
  /** `"2026-08-23"` — exactly what `parseScheduleInput` takes. */
  date: string;
  /** `"01"`–`"12"`. Padded, because that is the form the parser is given. */
  hour: string;
  /** `"00"`–`"59"`. */
  minute: string;
  meridiem: Meridiem;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The wall clock in Riyadh, as a `Date` whose UTC parts *are* the local parts. */
function businessClock(now: Date): Date {
  return new Date(now.getTime() + BUSINESS_UTC_OFFSET_MINUTES * MINUTE_MS);
}

/** `"2026-08-23"` for the Riyadh day `now` falls in. */
export function businessDate(now: Date): string {
  const local = businessClock(now);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

/** Minutes past midnight, Riyadh. */
export function businessMinutes(now: Date): number {
  const local = businessClock(now);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** The hours a person picks from. 12-hour, and never 13:00. */
export const HOUR_OPTIONS: readonly string[] = Array.from({ length: 12 }, (_, i) => pad(i + 1));

/** Every minute, so 7:47 is expressible. Not a list of quarters. */
export const MINUTE_OPTIONS: readonly string[] = Array.from({ length: 60 }, (_, i) => pad(i));

export const MERIDIEM_OPTIONS: readonly Meridiem[] = ["AM", "PM"];

/**
 * A 12-hour selection as minutes past midnight.
 *
 * 12 AM is midnight and 12 PM is noon — the two the naive formula gets wrong,
 * and the same pair `parse12Hour` singles out.
 */
export function minutesOfDay(hour: string, minute: string, meridiem: Meridiem): number {
  const hour12 = Number(hour);
  const hour24 =
    hour12 === 12 ? (meridiem === "PM" ? 12 : 0) : meridiem === "PM" ? hour12 + 12 : hour12;
  return hour24 * 60 + Number(minute);
}

/** Minutes past midnight → the padded 12-hour parts. */
function partsOf(minutes: number): { hour: string; minute: string; meridiem: Meridiem } {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(wrapped / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    hour: pad(hour12),
    minute: pad(wrapped % 60),
    meridiem: hour24 < 12 ? "AM" : "PM",
  };
}

/** `("07", "30", "PM")` → `"07:30 PM"`, the exact shape `parseScheduleInput` parses. */
export function formatTime12(hour: string, minute: string, meridiem: Meridiem): string {
  return `${hour}:${minute} ${meridiem}`;
}

/** The whole selection as the `{date, time}` pair the parser takes. */
export function scheduleInputFor(selection: ScheduleSelection): { date: string; time: string } {
  return {
    date: selection.date,
    time: formatTime12(selection.hour, selection.minute, selection.meridiem),
  };
}

/** `"2026-08-23"` → the day after, without touching the host zone. */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + 24 * 60 * MINUTE_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * The earliest minute-of-day still selectable on `date`.
 *
 * `0` for any future day — the whole day is open. For today it is the lead time
 * ahead of now, which is what stops the controls offering a minute that has
 * gone. A date already behind today returns `MINUTES_PER_DAY`, so nothing on it
 * is selectable at all; the calendar refuses those dates anyway, and agreeing
 * here means the two cannot contradict each other.
 */
export function earliestMinutesOn(date: string, now: Date): number {
  const today = businessDate(now);
  if (date > today) return 0;
  if (date < today) return MINUTES_PER_DAY;
  return businessMinutes(now) + LEAD_MINUTES;
}

/** Is this selection behind the earliest the day allows? */
export function isSelectionPast(selection: ScheduleSelection, now: Date): boolean {
  return (
    minutesOfDay(selection.hour, selection.minute, selection.meridiem) <
    earliestMinutesOn(selection.date, now)
  );
}

/**
 * Where the controls start when the agent chooses *Schedule delivery*.
 *
 * The lead time ahead of now, rounded up to a quarter hour, and rolled into
 * tomorrow rather than past midnight — so the first thing shown is always a
 * time the parser accepts as scheduled, and the agent adjusts from a sensible
 * value instead of correcting an invalid one.
 */
export function defaultScheduleSelection(now: Date): ScheduleSelection {
  const target = businessMinutes(now) + LEAD_MINUTES;
  const rounded = Math.ceil(target / DEFAULT_STEP_MINUTES) * DEFAULT_STEP_MINUTES;
  const date = rounded >= MINUTES_PER_DAY ? nextDay(businessDate(now)) : businessDate(now);
  return { date, ...partsOf(rounded) };
}

/**
 * Move a selection forward to the earliest the day allows, if it is behind it.
 *
 * Changing the date from tomorrow to today can strand a time that was fine and
 * no longer is. Leaving it stranded would show a selected value the controls
 * themselves mark as unavailable, so it is pulled forward instead — and a day
 * with nothing left on it rolls to the next one rather than becoming
 * unschedulable.
 */
export function clampSelection(selection: ScheduleSelection, now: Date): ScheduleSelection {
  const earliest = earliestMinutesOn(selection.date, now);
  if (earliest >= MINUTES_PER_DAY) return defaultScheduleSelection(now);
  const chosen = minutesOfDay(selection.hour, selection.minute, selection.meridiem);
  if (chosen >= earliest) return selection;
  return { date: selection.date, ...partsOf(earliest) };
}

/**
 * `"2026-08-23"` → the `Date` the calendar means by that day.
 *
 * Built from **local** parts, not `Date.UTC`, and that is the whole point:
 * `react-day-picker` compares days by their local parts, so a UTC-midnight
 * `Date` is the previous day for every viewer west of UTC — the selected day
 * would highlight one cell early and `disabled: { before }` would cut a day
 * short. The two conversions here are exact inverses in every zone.
 *
 * Business time still decides *which* day is today; this only decides how a day
 * is handed to and read back from the calendar.
 */
export function calendarDate(date: string): Date | undefined {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

/** A calendar day → `"2026-08-23"`, reading the same local parts. */
export function dateFromCalendar(day: Date): string {
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** `"2026-08-23"` → `"Sat, Aug 23, 2026"`, on the picker's own trigger. */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
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

export function formatPickedDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${DAYS[at.getUTCDay()]}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${y}`;
}
