/**
 * Day-partitioned CDR window store.
 *
 * ---------------------------------------------------------------------------
 * The problem this replaces
 * ---------------------------------------------------------------------------
 * The dashboards cached CDR by exact window — one entry per `from|to` string,
 * five-minute TTL. That is the wrong unit in three ways, and all three of them
 * hurt most on the widest window:
 *
 *   1. **Nothing is shared.** A month and a week inside that month have no
 *      overlap as cache keys, so re-slicing a range someone was just looking at
 *      re-swept the PBX from scratch. Customer Care and Telesales on ranges that
 *      differ by a single day shared nothing either.
 *   2. **Everything expires together.** After five minutes the whole month was
 *      cold again — including the twenty-nine days that had already ended and
 *      could not possibly have gained a call. A user filtering around for ten
 *      minutes paid for two or three complete month sweeps.
 *   3. **Extending a range re-fetches all of it.** Moving "to" forward by a day
 *      threw away the thirty days already in memory.
 *
 * ---------------------------------------------------------------------------
 * The unit that is actually right
 * ---------------------------------------------------------------------------
 * A business DAY. Once a day has ended its CDR is immutable — the PBX will never
 * add a call to last Tuesday — so a closed day can be held for hours, and only
 * today needs a short TTL. A window is then composed from its days, and the only
 * thing ever fetched is the days that are genuinely missing.
 *
 *   month, cold          → one sweep (exactly what it cost before)
 *   month, next filter   → zero PBX calls
 *   month → week inside  → zero PBX calls
 *   month, tomorrow      → one day fetched, twenty-nine reused
 *   Care ↔ Telesales     → zero PBX calls, whatever each page's range is
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does NOT do
 * ---------------------------------------------------------------------------
 * It does not normalize per day. A call is a set of legs sharing `call_id`, and
 * a call that starts at 23:58 and is answered at 00:02 has legs either side of a
 * day boundary — grouping per day would split it into two half-calls and report
 * that nobody answered. So days partition the FETCH and the CACHE only; rows are
 * concatenated back into one array and normalized over the whole window exactly
 * as before. Phase 1 is cheap (~14k rows a month); re-fetching is what was
 * expensive.
 *
 * Missing days are fetched as CONTIGUOUS RANGES rather than one request each, so
 * a cold month is still a single sweep and never thirty round-trips.
 */
import { fetchCdrRange, type CdrRecord, type FetchCdrResult } from "./cdr.server";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

function tzOffsetMinutes(): number {
  const raw = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES);
  return Number.isFinite(raw) ? raw : BUSINESS_UTC_OFFSET_MINUTES;
}

/**
 * A day that has ended cannot gain a call, so it is held long enough to survive
 * a whole working session of filtering.
 */
const CLOSED_DAY_TTL_MS = 12 * 60 * 60_000;
/**
 * Today is still being written to. Matches the dashboards' own `staleTime`, so
 * the client never asks for anything fresher than this anyway.
 */
const LIVE_DAY_TTL_MS = 5 * 60_000;
/** ~6 months of days. Entries hold row references, not copies. */
const MAX_CACHED_DAYS = 200;

interface DayEntry {
  /** When this day was fetched. */
  at: number;
  /** Was it still the current day when fetched? Decides which TTL applies. */
  live: boolean;
  rows: CdrRecord[];
}

const dayCache = new Map<string, DayEntry>();

/**
 * Composed windows, so that asking for the same window twice returns the SAME
 * array instance.
 *
 * This matters more than it looks: the normalization cache upstream is
 * identity-checked against the records array it was built from, so handing back
 * a freshly concatenated array every time would defeat it and re-normalize the
 * window on every request.
 */
const windowCache = new Map<string, { stamp: string; records: CdrRecord[] }>();

/** `YYYY-MM-DD` for an epoch-ms instant, in the business timezone. */
export function businessDayOf(atMs: number, offsetMin = tzOffsetMinutes()): string {
  return new Date(atMs + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for a CDR row's epoch-seconds timestamp. */
function dayOfRow(r: CdrRecord, offsetMin: number): string | null {
  if (typeof r.timestamp !== "number") return null;
  return businessDayOf(r.timestamp * 1000, offsetMin);
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

function isFresh(entry: DayEntry, now: number): boolean {
  return now - entry.at < (entry.live ? LIVE_DAY_TTL_MS : CLOSED_DAY_TTL_MS);
}

/** Drop expired days, then the oldest ones if still over the cap. */
function evict(now: number) {
  for (const [k, v] of dayCache) if (!isFresh(v, now)) dayCache.delete(k);
  while (dayCache.size > MAX_CACHED_DAYS) {
    const oldest = dayCache.keys().next().value;
    if (oldest === undefined) break;
    dayCache.delete(oldest);
  }
  if (windowCache.size > 40) windowCache.clear();
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

export interface CdrWindow extends Omit<FetchCdrResult, "fetchedRows" | "droppedOutOfWindow"> {
  /** Days answered from the day cache without touching the PBX. */
  daysFromCache: number;
  /** Days that had to be fetched. */
  daysFetched: number;
  /** How many PBX sweeps this window cost. Zero on a full cache hit. */
  sweeps: number;
}

/**
 * The CDR rows for `[from, to]`, fetching only the days not already held.
 *
 * `jobId` is forwarded to the first sweep only — progress reporting describes a
 * fetch, and a window served from cache has no fetch to describe.
 */
export async function getCdrWindow(from: string, to: string, jobId?: string): Promise<CdrWindow> {
  const started = Date.now();
  const offsetMin = tzOffsetMinutes();
  const now = Date.now();
  evict(now);

  const today = businessDayOf(now, offsetMin);
  const days = enumerateDays(from, to);
  const missing = days.filter((d) => {
    const hit = dayCache.get(d);
    return !hit || !isFresh(hit, now);
  });

  let totalReported: number | null = null;
  let truncated = false;
  let path: FetchCdrResult["path"] = "search";
  let sweeps = 0;

  if (missing.length > 0) {
    // Contiguous ranges, so a cold month is ONE sweep — the same request the
    // old code made — while a warm month that only lost today is one small one.
    const ranges = contiguousRanges(missing);
    const results = await Promise.all(
      ranges.map((r, i) =>
        fetchCdrRange({ from: r.from, to: r.to, jobId: i === 0 ? jobId : undefined }),
      ),
    );
    sweeps = results.length;

    for (let i = 0; i < results.length; i++) {
      const res = results[i]!;
      const range = ranges[i]!;
      if (res.totalReported != null) totalReported = (totalReported ?? 0) + res.totalReported;
      truncated = truncated || res.truncated;
      path = res.path;

      // Bucket what came back...
      const buckets = new Map<string, CdrRecord[]>();
      for (const row of res.records) {
        const d = dayOfRow(row, offsetMin);
        if (!d) continue;
        let bucket = buckets.get(d);
        if (!bucket) {
          bucket = [];
          buckets.set(d, bucket);
        }
        bucket.push(row);
      }
      // ...and record EVERY day in the range, including the ones with no calls.
      // Without this a quiet day would count as missing forever and be re-swept
      // on every single request.
      for (const day of enumerateDays(range.from, range.to)) {
        dayCache.set(day, {
          at: now,
          live: day >= today,
          rows: buckets.get(day) ?? [],
        });
      }
    }
  }

  // Compose. The stamp is the identity of the constituent days, so an unchanged
  // window hands back the array it handed back last time.
  const stamp = days.map((d) => `${d}:${dayCache.get(d)?.at ?? 0}`).join("|");
  const windowKey = `${from}|${to}`;
  const cachedWindow = windowCache.get(windowKey);
  let records: CdrRecord[];
  if (cachedWindow && cachedWindow.stamp === stamp) {
    records = cachedWindow.records;
  } else {
    records = [];
    for (const d of days) {
      const entry = dayCache.get(d);
      if (entry) for (const row of entry.rows) records.push(row);
    }
    windowCache.set(windowKey, { stamp, records });
  }

  return {
    // Only meaningful when this call fetched the ENTIRE window. On a partial
    // fetch the PBX only reported on the days we asked for, and presenting that
    // as the window's total would understate it — null says "not known here"
    // rather than stating a number that is wrong.
    totalReported: missing.length === days.length ? totalReported : null,
    records,
    pagesFetched: sweeps,
    path,
    startEpoch: 0,
    endEpoch: 0,
    elapsedMs: Date.now() - started,
    truncated,
    daysFromCache: days.length - missing.length,
    daysFetched: missing.length,
    sweeps,
  };
}

/** Warmth of a window, for diagnostics. Never triggers a fetch. */
export function windowCacheState(
  from: string,
  to: string,
): { status: "warm" | "partial" | "cold"; ageMs: number | null; daysCached: number; days: number } {
  const now = Date.now();
  const days = enumerateDays(from, to);
  let cached = 0;
  let oldest: number | null = null;
  for (const d of days) {
    const hit = dayCache.get(d);
    if (hit && isFresh(hit, now)) {
      cached++;
      const age = now - hit.at;
      if (oldest == null || age > oldest) oldest = age;
    }
  }
  return {
    status: cached === 0 ? "cold" : cached === days.length ? "warm" : "partial",
    ageMs: oldest,
    daysCached: cached,
    days: days.length,
  };
}

/** Global cache stats for the configuration page. */
export function cdrCacheStats(): { days: number; freshDays: number; newestAgeMs: number | null } {
  const now = Date.now();
  let fresh = 0;
  let newest: number | null = null;
  for (const v of dayCache.values()) {
    if (!isFresh(v, now)) continue;
    fresh++;
    const age = now - v.at;
    if (newest == null || age < newest) newest = age;
  }
  return { days: dayCache.size, freshDays: fresh, newestAgeMs: newest };
}

/** Test seam — drops everything. */
export function __resetCdrWindowCache() {
  dayCache.clear();
  windowCache.clear();
}

export const __ttls = { CLOSED_DAY_TTL_MS, LIVE_DAY_TTL_MS };
