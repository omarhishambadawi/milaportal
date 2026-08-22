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
 * "Today" is answered in business time, at the fixed +03:00 of
 * `BUSINESS_UTC_OFFSET_MINUTES`, for the same reason `parseScheduleInput` builds
 * its instant that way: an agent in another zone arranging a Riyadh delivery
 * means Riyadh. A zone with daylight saving could not be handled by adding a
 * constant, and this one has none.
 *
 * ## What this module does *not* decide
 *
 * Whether a chosen time is in the past. It used to — `earliestMinutesOn`,
 * `isSelectionPast` and `clampSelection` judged one unit at a time, so at
 * 10:15 PM the hours 01–09 went dead and an agent could not reach *9 PM
 * tomorrow* by touching the hour first. An hour is not in the past; only a whole
 * datetime is.
 *
 * All three are gone. `parseScheduleInput` — the one function that has always
 * decided this, over the complete `{date, time}` pair — is now the only thing
 * that does, and the dialog refuses the action rather than the keystroke. What
 * is left here produces values and formats them; the only thing it still
 * bounds is the *day*, because a day that has ended cannot contain a future
 * minute under any combination.
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
