/**
 * How hard the Customer Care dashboard works at keeping a window current.
 *
 * ---------------------------------------------------------------------------
 * The problem this solves
 * ---------------------------------------------------------------------------
 * The page polled every 20 seconds regardless of the selected range. On today's
 * traffic that is correct: the window is still accruing calls and the server
 * answers from a warm cache. On a full month it was the single most expensive
 * thing the page did — every tick re-ran the whole windowed aggregation on the
 * server and shipped the result back, three times a minute, for a window whose
 * numbers are historical and cannot change.
 *
 * So the cadence is derived from the window instead of fixed. Nothing about how
 * a KPI is computed changes — only how often the same answer is asked for.
 *
 * Kept in its own module, free of React and of the query layer, because it is
 * the decision the whole performance fix rests on and it should be assertable
 * without mounting anything.
 */

export interface RefreshPolicy {
  /** Days covered by the window, inclusive. */
  windowDays: number;
  /** Poll interval in ms, or false when the window is not polled at all. */
  intervalMs: number | false;
  /** How long a fetched window stays fresh. */
  staleMs: number;
  /** Human-readable, for the page header. */
  label: string;
}

/** A window ending today can still gain calls; one that ended cannot. */
export const LIVE_WINDOW_MAX_DAYS = 2;
/** Past this many days a window is treated as pure history — fetch once. */
export const HISTORICAL_WINDOW_MIN_DAYS = 8;
/**
 * Matches the server's own CDR cache TTL (`CDR_CACHE_TTL_MS`). Asking sooner
 * than this cannot return newer rows, so a shorter interval buys nothing and
 * costs a full re-aggregation.
 */
export const SERVER_CACHE_TTL_MS = 5 * 60_000;

/** Inclusive day count between two `YYYY-MM-DD` keys. */
export function windowDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/**
 * Three bands, decided by window size and by whether it is still accruing calls.
 *
 * The middle band exists so that "last 7 days" does not fall off a cliff into
 * never refreshing — it refreshes at the only rate the server cache can actually
 * satisfy. The Refresh button forces a fetch in every band, so nothing here can
 * strand a user on stale numbers.
 *
 * @param today `YYYY-MM-DD` in the viewer's own day, passed in rather than read
 *              so the decision stays pure and testable across a date boundary.
 */
export function resolveRefreshPolicy(
  from: string,
  to: string,
  liveRefreshMs: number,
  today: string,
): RefreshPolicy {
  const days = windowDays(from, to);
  // A window that ended in the past is finished: no poll will ever change it.
  const live = to >= today;

  if (live && days <= LIVE_WINDOW_MAX_DAYS) {
    return {
      windowDays: days,
      intervalMs: liveRefreshMs,
      staleMs: liveRefreshMs,
      label: `Live · refreshing every ${Math.round(liveRefreshMs / 1000)}s`,
    };
  }
  if (live && days < HISTORICAL_WINDOW_MIN_DAYS) {
    return {
      windowDays: days,
      intervalMs: SERVER_CACHE_TTL_MS,
      staleMs: SERVER_CACHE_TTL_MS,
      label: "Refreshing every 5 min",
    };
  }
  return {
    windowDays: days,
    intervalMs: false,
    staleMs: SERVER_CACHE_TTL_MS,
    label: live ? "Large window · refresh manually" : "Closed window · refresh manually",
  };
}
