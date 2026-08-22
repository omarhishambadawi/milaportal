/**
 * The delivery slots an agent may choose from. Pure, no clock of its own.
 *
 * ## Why a list instead of a text box
 *
 * The dialog used to ask for a date and a free-typed `03:30 PM`. Three things
 * are wrong with that at a counter: it is two fields to answer one question, it
 * accepts "3.30pm" and "15:30" and rejects them after the fact, and it lets an
 * agent name a minute that means nothing to a courier. A delivery is arranged in
 * slots, so the control is a list of slots.
 *
 * ## The semantics are unchanged
 *
 * Every option is nothing but a `{ date, time }` pair in exactly the shape
 * `parseScheduleInput` already takes — `"2026-08-22"` and `"03:00 PM"` — and it
 * is that function, unchanged, which turns the choice into the UTC instant
 * `scheduled_for` stores. Nothing here computes an instant, and nothing here
 * decides whether a dispatch is immediate or scheduled: the server still does
 * that by comparing the time to its own clock.
 *
 * ## Riyadh, not the browser
 *
 * The slots are named in business time for the same reason `formatScheduledFor`
 * renders in it: an agent in another zone arranging a Riyadh delivery means
 * Riyadh. `BUSINESS_UTC_OFFSET_MINUTES` is a fixed +03:00 with no daylight
 * saving, which is what makes shifting by a constant exact rather than a
 * near-enough.
 */

import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How many slots to offer. Enough to cover a shift, few enough to scan. */
export const SCHEDULE_OPTION_COUNT = 5;

/** The first slot is at least this far out, so a chosen time is never already gone. */
const LEAD_MS = 30 * MINUTE_MS;

export interface AlShrouqScheduleOption {
  /** Stable across a render; the radio's value. */
  id: string;
  /** `"2026-08-22"` — exactly what `parseScheduleInput` takes. */
  date: string;
  /** `"03:00 PM"` — exactly what `parseScheduleInput` takes. */
  time: string;
  /** `"Today"` / `"Tomorrow"`, the part that changes across midnight. */
  day: string;
  /** `"3:00 PM"`, for the option's own line. Never 24-hour. */
  clock: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The wall clock in Riyadh, as a `Date` whose UTC parts *are* the local parts. */
function businessClock(now: Date): Date {
  return new Date(now.getTime() + BUSINESS_UTC_OFFSET_MINUTES * MINUTE_MS);
}

/** `15` → `"03:00 PM"`, the padded form `parseScheduleInput` parses. */
function to12Hour(hour24: number): string {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${pad(hour12)}:00 ${hour24 < 12 ? "AM" : "PM"}`;
}

/** `15` → `"3:00 PM"`, the form a person reads. No leading zero. */
function toClockLabel(hour24: number): string {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:00 ${hour24 < 12 ? "AM" : "PM"}`;
}

/**
 * The next few whole hours, in Riyadh.
 *
 * Whole hours only: a courier slot is an hour, and offering 3:17 PM would be
 * precision the delivery does not have. The first is at least `LEAD_MS` away so
 * that reading the confirmation cannot make the chosen time fall behind `now()`
 * — the case `parseScheduleInput` would otherwise reject as `past` after the
 * agent had already picked it.
 *
 * Rolling past midnight is handled by letting the hour run past 23 and adding
 * the days back in, so no option is ever generated for a time that has gone.
 */
export function scheduleOptionsAt(now: Date): AlShrouqScheduleOption[] {
  const local = businessClock(now);
  const earliest = new Date(local.getTime() + LEAD_MS);

  // The first whole hour at or after the lead time.
  let hour = earliest.getUTCHours() + (earliest.getUTCMinutes() > 0 ? 1 : 0);
  const startOfDay = Date.UTC(
    earliest.getUTCFullYear(),
    earliest.getUTCMonth(),
    earliest.getUTCDate(),
  );
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());

  const options: AlShrouqScheduleOption[] = [];
  for (let i = 0; i < SCHEDULE_OPTION_COUNT; i += 1, hour += 1) {
    const slot = new Date(startOfDay + hour * HOUR_MS);
    const hour24 = slot.getUTCHours();
    const date = `${slot.getUTCFullYear()}-${pad(slot.getUTCMonth() + 1)}-${pad(slot.getUTCDate())}`;
    const slotDay = Date.UTC(slot.getUTCFullYear(), slot.getUTCMonth(), slot.getUTCDate());
    const dayOffset = Math.round((slotDay - today) / (24 * HOUR_MS));

    options.push({
      id: `${date}T${pad(hour24)}`,
      date,
      time: to12Hour(hour24),
      day: dayOffset === 0 ? "Today" : dayOffset === 1 ? "Tomorrow" : date,
      clock: toClockLabel(hour24),
    });
  }
  return options;
}

/** One line for a slot: `"Today · 3:00 PM"`. */
export function describeScheduleOption(option: AlShrouqScheduleOption): string {
  return `${option.day} · ${option.clock}`;
}
