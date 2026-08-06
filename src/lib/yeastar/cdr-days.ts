/**
 * Business-day arithmetic for the CDR pipeline.
 *
 * A "day" is the cache unit of the in-memory window store, the coverage unit of
 * the Supabase mirror and the scheduling unit of the background sync — so all
 * three have to agree on exactly which instants belong to which day, in the
 * business timezone rather than UTC. That agreement is this module, extracted so
 * the three server tiers can share it without importing one another.
 *
 * Pure and dependency-free (beyond the centralized timezone constant), so it is
 * unit-testable and safe to import from anywhere.
 */
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

export function tzOffsetMinutes(): number {
  const raw = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES);
  return Number.isFinite(raw) ? raw : BUSINESS_UTC_OFFSET_MINUTES;
}

/** `YYYY-MM-DD` for an epoch-ms instant, in the business timezone. */
export function businessDayOf(atMs: number, offsetMin = tzOffsetMinutes()): string {
  return new Date(atMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Every day in `[from, to]`, inclusive. */
export function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end) || end < t) return out;
  // A month is 31 iterations; the guard is only to stop a malformed range from
  // spinning forever.
  for (let i = 0; t <= end && i < 400; i++, t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Collapse a sorted day list into contiguous `[from,to]` ranges. */
export function contiguousRanges(days: string[]): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const day of days) {
    const last = out[out.length - 1];
    if (
      last &&
      Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last.to}T00:00:00Z`) === 86_400_000
    ) {
      last.to = day;
    } else {
      out.push({ from: day, to: day });
    }
  }
  return out;
}

/** `n` days before `day`, as a day string. Calendar arithmetic, not clock. */
export function shiftDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
