/**
 * When a scheduled sync is due. PURE: no I/O, no imports, no clock of its own.
 *
 * The business schedule is a set of **daily slots** — "15:00 Riyadh, stock and
 * promotions" — not a frequency. That distinction is the whole model:
 *
 *   * Three slots at 15:00 / 21:00 / 00:00 are three independent daily times,
 *     not "every eight hours". Moving one does not move the others, and the gaps
 *     between them are deliberately uneven.
 *   * An administrator adds, edits or removes slots as rows. `pg_cron` is never
 *     touched: it wakes every minute and asks one indexed question.
 *
 * ## The contract with the database
 *
 * `next_due_at` — a UTC instant stored on each slot. The cron tick compares it
 * to `now()` and nothing else; this module is what computes it. That keeps the
 * scheduling rules in TypeScript, where they are testable, and leaves plpgsql
 * with a timestamp comparison.
 *
 * ## Times are local, storage is UTC
 *
 * A slot stores `15:00` and `Asia/Riyadh`. Administrators never see or enter a
 * UTC time. The conversion goes through the named zone rather than a hardcoded
 * `+03:00`: Saudi Arabia observes no daylight saving today, but a schedule that
 * silently breaks if that ever changed would be a poor thing to have written on
 * purpose.
 */

import type { ShamsSyncKind } from "./sync-status";

/**
 * How late a slot may be and still run.
 *
 * Two hours. Inside it, last night's 00:00 sync arriving at 01:30 after a deploy
 * is still the sync you wanted. Outside it, it is not: firing a midnight refresh
 * at nine in the morning would put a full catalogue reload into trading hours,
 * which is worse than skipping it. A skipped occurrence is recorded rather than
 * discarded, so the gap is visible.
 */
export const CATCH_UP_GRACE_MS = 2 * 60 * 60 * 1000;

/** A configured daily slot, as stored. */
export interface ScheduleSlot {
  id: string;
  enabled: boolean;
  /** `HH:MM` or `HH:MM:SS`, in `timeZone`. */
  localTime: string;
  /** IANA zone name. `Asia/Riyadh` throughout, but never assumed. */
  timeZone: string;
  syncStock: boolean;
  syncPromotions: boolean;
  /** The next UTC instant this slot is due, or null before it is first computed. */
  nextDueAt: string | null;
}

/** Which kinds a slot targets, in the fixed order the scheduler uses. */
export function slotKinds(slot: ScheduleSlot): ShamsSyncKind[] {
  const kinds: ShamsSyncKind[] = [];
  if (slot.syncStock) kinds.push("stock");
  if (slot.syncPromotions) kinds.push("promotions");
  return kinds;
}

/* -------------------------------------------------------------------------- */
/* Time zone arithmetic                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The offset of `timeZone` from UTC, in milliseconds, at a given instant.
 *
 * Derived by formatting the instant in the zone and reading the wall-clock back,
 * because that is the only thing the platform will tell us. `hourCycle: "h23"`
 * matters: without it midnight formats as hour `24` in some locales and the
 * arithmetic silently lands a day out.
 */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    at("hour"),
    at("minute"),
    at("second"),
  );
  return asIfUtc - utcMs;
}

/**
 * The UTC instant of a wall-clock time in a zone.
 *
 * Two passes. The first guesses using the offset that applies at the naive
 * instant; the second re-reads the offset at the answer and corrects it. That
 * second pass only matters on a DST boundary — irrelevant for Riyadh, and
 * exactly what stops this from being wrong for an hour twice a year if the zone
 * is ever something else.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - zoneOffsetMs(timeZone, naive);
  const second_ = naive - zoneOffsetMs(timeZone, first);
  return second_;
}

/** The calendar date in `timeZone` at a given instant. */
function zonedDateParts(timeZone: string, utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcMs));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: at("year"), month: at("month"), day: at("day") };
}

/** `HH:MM[:SS]` → components. Returns null for anything unparseable. */
export function parseLocalTime(
  value: string | null | undefined,
): { hour: number; minute: number; second: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * The first occurrence of this slot's local time strictly after `after`.
 *
 * "Strictly" is what stops a slot re-firing against the instant it just ran at.
 * Midnight is the case worth naming: `00:00` resolves to the *next* day's
 * midnight whenever `after` is at or past today's, which is why a 00:00 slot
 * behaves like any other rather than being a special case.
 */
export function nextOccurrence(slot: ScheduleSlot, after: Date): Date | null {
  const time = parseLocalTime(slot.localTime);
  if (!time) return null;

  const afterMs = after.getTime();
  const today = zonedDateParts(slot.timeZone, afterMs);

  for (let addDays = 0; addDays <= 2; addDays++) {
    // Day arithmetic on the *local* calendar date, then converted — so a slot
    // never drifts across a month or year boundary.
    const base = Date.UTC(today.year, today.month - 1, today.day + addDays);
    const d = new Date(base);
    const candidate = zonedTimeToUtc(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      time.hour,
      time.minute,
      time.second,
      slot.timeZone,
    );
    if (candidate > afterMs) return new Date(candidate);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What to do about one slot on this tick.
 *
 * `missed` carries the occurrence it gave up on so the skip can be recorded
 * against the time it should have run, not the time we noticed.
 */
export type SlotDecision =
  | { verdict: "not_due"; slot: ScheduleSlot; nextDueAt: Date | null }
  | {
      verdict: "due";
      slot: ScheduleSlot;
      occurrence: Date;
      kinds: ShamsSyncKind[];
      nextDueAt: Date | null;
    }
  | {
      verdict: "missed";
      slot: ScheduleSlot;
      occurrence: Date;
      kinds: ShamsSyncKind[];
      lateMs: number;
      nextDueAt: Date | null;
    };

/**
 * Decide one slot.
 *
 * `automationEnabled` is passed in rather than read, and a disabled slot or a
 * slot targeting nothing is `not_due` — but its `nextDueAt` is still computed,
 * so the Control Center can show an administrator when a slot *would* run before
 * they switch it on.
 *
 * The advance is always to the next occurrence after **now**, never after the
 * missed occurrence. That is the whole burst defence: a scheduler that was down
 * for three days comes back, records one skipped occurrence, and resumes at the
 * next real time — rather than working through seventy-two hours of arrears.
 */
export function evaluateSlot(
  slot: ScheduleSlot,
  automationEnabled: boolean,
  now: Date,
): SlotDecision {
  const kinds = slotKinds(slot);

  if (!automationEnabled || !slot.enabled || kinds.length === 0) {
    return { verdict: "not_due", slot, nextDueAt: nextOccurrence(slot, now) };
  }

  // A slot that has never been evaluated has nothing to be late for; it simply
  // acquires its first due time.
  if (!slot.nextDueAt) {
    return { verdict: "not_due", slot, nextDueAt: nextOccurrence(slot, now) };
  }

  const dueMs = Date.parse(slot.nextDueAt);
  if (!Number.isFinite(dueMs)) {
    return { verdict: "not_due", slot, nextDueAt: nextOccurrence(slot, now) };
  }

  if (dueMs > now.getTime()) {
    // Not yet. Left exactly as stored — recomputing here would let a clock
    // difference walk the schedule.
    return { verdict: "not_due", slot, nextDueAt: new Date(dueMs) };
  }

  const occurrence = new Date(dueMs);
  const lateMs = now.getTime() - dueMs;
  const nextDueAt = nextOccurrence(slot, now);

  if (lateMs > CATCH_UP_GRACE_MS) {
    return { verdict: "missed", slot, occurrence, kinds, lateMs, nextDueAt };
  }
  return { verdict: "due", slot, occurrence, kinds, nextDueAt };
}

/** Decide every slot. Order is preserved so a run's log reads predictably. */
export function evaluateSlots(
  slots: ScheduleSlot[],
  automationEnabled: boolean,
  now: Date,
): SlotDecision[] {
  return slots.map((slot) => evaluateSlot(slot, automationEnabled, now));
}

/**
 * The soonest upcoming occurrence that would actually run one kind.
 *
 * What the Control Center shows as "next scheduled Stock update". Returns null
 * when automation is off or nothing targets that kind — the caller renders that
 * as "not scheduled" rather than inventing a time that will not happen.
 */
export function nextRunFor(
  kind: ShamsSyncKind,
  slots: ScheduleSlot[],
  automationEnabled: boolean,
  now: Date,
): Date | null {
  if (!automationEnabled) return null;

  let soonest: number | null = null;
  for (const slot of slots) {
    if (!slot.enabled) continue;
    if (!slotKinds(slot).includes(kind)) continue;
    const next = nextOccurrence(slot, now);
    if (!next) continue;
    if (soonest === null || next.getTime() < soonest) soonest = next.getTime();
  }
  return soonest === null ? null : new Date(soonest);
}

/**
 * Format a slot's local time for display: `15:00` → `03:00 PM`.
 *
 * Administrators asked for the schedule in the form they think in, and every
 * time on the Control Center is a Riyadh wall-clock time. Nothing here converts
 * anything; it only reformats what the slot already stores.
 */
export function formatLocalTime(value: string): string {
  const time = parseLocalTime(value);
  if (!time) return value;
  const suffix = time.hour < 12 ? "AM" : "PM";
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${String(hour12).padStart(2, "0")}:${String(time.minute).padStart(2, "0")} ${suffix}`;
}
