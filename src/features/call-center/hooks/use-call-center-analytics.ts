import { useDeferredValue, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { hourLabel, resolvePeakHour } from "@/lib/yeastar/metrics-engine";
import { resolveRefreshPolicy, type RefreshPolicy } from "../refresh-policy";
import type { Team, Direction } from "../types";

interface UseCallCenterAnalyticsArgs {
  from: string;
  to: string;
  team: Team;
  agentId: string;
  direction: Direction;
  /** Customer Care only. "all" (or omitted) means every queue. */
  queue?: string;
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
  search: string;
  /**
   * Background refresh cadence for a LIVE window, in ms. Customer Care watches
   * a live queue and wants ~20s; Telesales reviews a day's outbound work and
   * 60s is plenty. Larger and closed windows back off automatically — see
   * `resolveRefreshPolicy`.
   */
  refreshMs: number;
  /** Orders join, for the Telesales conversion metrics. Off elsewhere. */
  includeOrders?: boolean;
}

/**
 * The single analytics query behind the Telesales and Overview dashboards, plus
 * every derived slice.
 *
 * Stale-while-revalidate, deliberately:
 *
 *   - `placeholderData: keepPreviousData` keeps the previous window's numbers
 *     on screen while a new one loads, so a filter change never blanks the page.
 *   - React Query only swaps `data` on a SUCCESSFUL response, so a failed
 *     refresh leaves the last good analytics visible and merely raises `isError`
 *     — surfaced as a small non-blocking warning rather than an empty page.
 *   - `isLoading` is true only when there is genuinely nothing to show. Every
 *     other fetch is a background refresh and reports through `isRefreshing`.
 *
 * There is deliberately NO progress polling. The previous version polled a
 * progress endpoint every 800ms during any fetch — a `getSession()` call, an
 * HTTP request and a full re-render three times over per two seconds, which
 * rebuilt every chart's data array and made Recharts replay its enter
 * animation. That is what made the dashboards appear to load, clear and reload
 * on a loop. A CDR sweep has no measurable progress to report anyway, so the
 * bar was inventing precision it never had.
 *
 * ---------------------------------------------------------------------------
 * Cadence scales with the window
 * ---------------------------------------------------------------------------
 * Same policy Customer Care runs on, from the same module. A fixed interval is
 * right for today and ruinous for a month: every tick re-runs the whole
 * windowed aggregation server-side for numbers that are historical and cannot
 * change. See `refresh-policy.ts`.
 */
export function useCallCenterAnalytics({
  from,
  to,
  team,
  agentId,
  direction,
  queue = "all",
  canAll,
  canView,
  authLoading,
  search,
  refreshMs,
  includeOrders = true,
}: UseCallCenterAnalyticsArgs) {
  const analyticsFn = useServerFn(getCallCenterAnalytics);

  const policy: RefreshPolicy = useMemo(
    () => resolveRefreshPolicy(from, to, refreshMs, new Date().toISOString().slice(0, 10)),
    [from, to, refreshMs],
  );

  const q = useQuery({
    queryKey: queryKeys.callCenter.analytics({ from, to, team, agentId, direction, queue }),
    queryFn: () =>
      analyticsFn({
        data: {
          from,
          to,
          team,
          agentId: canAll && agentId !== "all" ? agentId : null,
          direction,
          status: "all",
          // Omitted entirely when no queue is selected, so the request is
          // byte-identical to what it was before the queue filter existed.
          ...(queue && queue !== "all" ? { queue } : {}),
          includeOrders,
        },
      }),
    enabled: !authLoading && canView,
    // The window's data is considered fresh until the next scheduled refresh,
    // so a remount inside that window reuses the cache instead of refetching.
    staleTime: policy.staleMs,
    // Retention, not freshness — see `RefreshPolicy.gcMs`. A month left for the
    // app-wide ten minutes was evicted and rebuilt from scratch on return.
    gcTime: policy.gcMs,
    placeholderData: keepPreviousData,
    refetchInterval: policy.intervalMs,
    // Hidden tabs are not watching, so polling them is pure cost. Coming back
    // to the tab triggers one refresh, which is the moment it actually matters
    // — but only for a window that can still gain calls.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: policy.intervalMs !== false,
    refetchOnMount: false,
    refetchOnReconnect: true,
  });

  const data = q.data;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;

  // Skeletons are for having nothing to show. Any fetch with data already on
  // screen is a background refresh and must not clear the page.
  const isLoading = authLoading || (!data && q.isPending);
  const isRefreshing = !!data && q.isFetching;
  /** A refresh failed but the last good analytics are still displayed. */
  const refreshFailed = !!data && !!q.error;

  const errored = (data && data.ok === false) || (!data && !!q.error);
  const errMsg =
    !data && q.error instanceof Error
      ? q.error.message
      : errored
        ? configured
          ? "Call analytics are temporarily unavailable."
          : "Call analytics are not configured yet."
        : null;

  // Every slice below is keyed on the specific array it reads rather than on
  // `data`. The response envelope carries `cdr.elapsedMs`, which differs on
  // every fetch, so a memo keyed on `data` rebuilt every chart series on every
  // background refresh even when not one number had moved. React Query's
  // structural sharing preserves the identity of the parts that did not change,
  // and depending on those directly is what lets it do any good.
  const totals = ok ? data.totals : null;
  const rawRows = ok ? data.agents : null;
  const rawByDay = ok ? data.byDay : null;
  const rawByHour = ok ? data.byHour : null;
  const rawTeamCompare = ok ? data.teamCompare : null;
  const conv = ok ? data.conversion : null;

  const rows = useMemo(() => rawRows ?? [], [rawRows]);
  const byDay = useMemo(() => rawByDay ?? [], [rawByDay]);
  const byHour = useMemo(() => rawByHour ?? [], [rawByHour]);
  const teamCompare = useMemo(() => rawTeamCompare ?? [], [rawTeamCompare]);

  // Memoised so the array identity only changes when the data does. Recharts
  // re-runs its enter animation whenever its `data` prop is a new reference, so
  // rebuilding these per render is what made charts visibly redraw.
  const hourly12 = useMemo(() => byHour.map((h) => ({ ...h, label: hourLabel(h.hour) })), [byHour]);

  /** Busiest DIALLING hour — the question a telesales manager actually asks. */
  const peakOutboundHour = useMemo(() => resolvePeakHour(hourly12, (h) => h.outbound), [hourly12]);
  /** Busiest hour by total volume, for surfaces that show both directions. */
  const peakHour = useMemo(() => resolvePeakHour(hourly12), [hourly12]);

  // Deferred: the search re-filters the agent list on every keystroke, and on a
  // month-wide window that is the one derivation here big enough to feel. This
  // lets the keystroke paint immediately and the table follow.
  const deferredSearch = useDeferredValue(search);
  const searchedAgents = useMemo(() => {
    if (!deferredSearch.trim()) return rows;
    const s = deferredSearch.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.ext.toLowerCase().includes(s));
  }, [rows, deferredSearch]);

  /**
   * True when the window resolved successfully and produced no calls at all.
   *
   * Distinct from `!ok`: a zero-call day is a valid, complete answer and the
   * page must render every section around it. Conflating the two is what turned
   * a quiet day into an error state.
   */
  const isEmpty = !!ok && (totals?.total ?? 0) === 0;

  return {
    q,
    ok,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    isEmpty,
    refreshPolicy: policy,
    totals,
    rows,
    byDay,
    byHour,
    teamCompare,
    conv,
    hourly12,
    peakHour,
    peakOutboundHour,
    searchedAgents,
    refresh: q.refetch,
  };
}
