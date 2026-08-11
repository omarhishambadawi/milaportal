/**
 * The Customer Care dashboard's single data entry point.
 *
 * Two queries in, one `CustomerCareMetrics` out:
 *
 *   CDR analytics  → every historical KPI          (`getCallCenterAnalytics`)
 *   Call Report    → per-agent missed calls only   (`yeastarCallReport`, v2.0)
 *
 * The route renders `metrics.*` and nothing else. It does not read the raw
 * query payloads, and it does not compute — see the contract on
 * `buildCustomerCareMetrics`.
 *
 * Failure behaviour is deliberately asymmetric, because the sources are not
 * equally important. A CDR failure is a page failure. A Call Report failure
 * degrades one column of the page and is reported through `metrics.callReport`,
 * never by throwing — the KPIs that already match Yeastar are CDR-derived and
 * must keep rendering.
 *
 * ---------------------------------------------------------------------------
 * Refresh cadence scales with the window
 * ---------------------------------------------------------------------------
 * This page used to poll every 20 seconds regardless of range. On today's
 * traffic that is right: the window is live and the server answers from a warm
 * cache. On a full month it is the single most expensive thing the page does —
 * each poll re-runs the whole windowed aggregation server-side and ships the
 * result back, three times a minute, for a window whose numbers are historical
 * and cannot change.
 *
 * So the cadence is derived from the window instead of fixed: a live window
 * polls, a historical one does not, and everything in between backs off
 * proportionally. Nothing about how a KPI is computed changes — only how often
 * the same answer is asked for. The Refresh button always forces a fetch.
 */
import { useDeferredValue, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { buildCustomerCareMetrics, type CustomerCareMetrics } from "@/lib/yeastar/metrics-engine";
import type { CallReportSnapshot } from "@/lib/yeastar/call-report.server";
import { resolveRefreshPolicy, type RefreshPolicy } from "../refresh-policy";
import { useCallReportQuery } from "./use-call-report";
import type { Direction } from "../types";

export type { RefreshPolicy };

interface UseCustomerCareMetricsArgs {
  from: string;
  to: string;
  agentId: string;
  direction: Direction;
  /** Queue number, or "all". */
  queue: string;
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
  search: string;
  /** Background refresh cadence for a live window, in ms. */
  refreshMs: number;
}

export interface UseCustomerCareMetricsResult {
  metrics: CustomerCareMetrics;
  /** True only when there is genuinely nothing to show yet. */
  isLoading: boolean;
  /** A background refresh is in flight while data is already on screen. */
  isRefreshing: boolean;
  /** A refresh failed but the last good analytics are still displayed. */
  refreshFailed: boolean;
  errMsg: string | null;
  /** True when the CDR analytics query has usable data. */
  ok: boolean;
  /** How this window is being kept up to date, for the UI to state plainly. */
  refreshPolicy: RefreshPolicy;
  refresh: () => void;
}

export function useCustomerCareMetrics({
  from,
  to,
  agentId,
  direction,
  queue,
  canAll,
  canView,
  authLoading,
  search,
  refreshMs,
}: UseCustomerCareMetricsArgs): UseCustomerCareMetricsResult {
  const analyticsFn = useServerFn(getCallCenterAnalytics);

  // Recomputed per render, but only from three strings — and `today` is read
  // once per render rather than per query so both queries agree on the policy.
  const policy = useMemo(
    () => resolveRefreshPolicy(from, to, refreshMs, new Date().toISOString().slice(0, 10)),
    [from, to, refreshMs],
  );

  const analyticsQuery = useQuery({
    queryKey: queryKeys.callCenter.analytics({
      from,
      to,
      team: "customer_care",
      agentId,
      direction,
      queue,
    }),
    queryFn: () =>
      analyticsFn({
        data: {
          from,
          to,
          team: "customer_care" as const,
          agentId: canAll && agentId !== "all" ? agentId : null,
          direction,
          status: "all" as const,
          ...(queue && queue !== "all" ? { queue } : {}),
          includeOrders: false,
        },
      }),
    enabled: !authLoading && canView,
    staleTime: policy.staleMs,
    // Retention, not freshness — see `RefreshPolicy.gcMs`. A month left for the
    // app-wide ten minutes was evicted and rebuilt from scratch on return.
    gcTime: policy.gcMs,
    placeholderData: keepPreviousData,
    refetchInterval: policy.intervalMs,
    refetchIntervalInBackground: false,
    // Only a live window gains calls while the tab is in the background, so only
    // a live window has anything to gain from re-fetching on focus. On a month
    // this was a full re-aggregation every time the user came back to the tab.
    refetchOnWindowFocus: policy.intervalMs !== false,
    refetchOnMount: false,
    refetchOnReconnect: true,
  });

  // Shared with the Calls Overview through `useCallReportQuery`, so both pages
  // read one snapshot under one cache entry and their Missed / Abandoned cards
  // cannot follow different definitions.
  const callReportQuery = useCallReportQuery({
    from,
    to,
    queue,
    enabled: !authLoading && canView,
    policy,
  });

  const data = analyticsQuery.data;
  const ok = !!data && data.ok === true;
  const configured = !data || (data as { configured?: boolean }).configured !== false;

  const isLoading = authLoading || (!data && analyticsQuery.isPending);
  const isRefreshing = !!data && analyticsQuery.isFetching;
  const refreshFailed = !!data && !!analyticsQuery.error;

  const errored = (data && data.ok === false) || (!data && !!analyticsQuery.error);
  const errMsg =
    !data && analyticsQuery.error instanceof Error
      ? analyticsQuery.error.message
      : errored
        ? configured
          ? "Call analytics are temporarily unavailable."
          : "Call analytics are not configured yet."
        : null;

  // The agent search re-runs the whole engine, which on a month-wide window is
  // the one derivation big enough to feel. Deferring it lets the keystroke paint
  // immediately and the filtered table follow, instead of the input lagging the
  // typing. The value itself is unchanged — only when it lands.
  const deferredSearch = useDeferredValue(search);

  // Keyed on the four arrays the engine actually reads, not on `data`.
  //
  // Every successful fetch returns a fresh envelope carrying `cdr.elapsedMs`,
  // which differs every time — so a memo keyed on `data` rebuilt every chart
  // series on every refresh even when not one number had moved. React Query's
  // structural sharing preserves the identity of the parts that did not change,
  // and depending on those directly is what lets it do any good here.
  const totals = ok ? data.totals : null;
  const agentStats = ok ? data.agents : null;
  const byDay = ok ? data.byDay : null;
  const byHour = ok ? data.byHour : null;

  const analytics = useMemo(
    () =>
      totals && agentStats && byDay && byHour
        ? { totals, agents: agentStats, byDay, byHour }
        : null,
    [totals, agentStats, byDay, byHour],
  );

  // The Call Report envelope has the SAME flaw the analytics one has, and it was
  // never addressed: it carries `elapsedMs`, which differs on every fetch. On a
  // live window that polls every 20 seconds, depending on the whole snapshot
  // handed the engine a new object three times a minute and rebuilt every metric
  // and every chart series below it — including the day and hour arrays, which
  // makes Recharts replay its enter animation — for numbers that had not moved.
  //
  // Rebuilt from the parts the engine actually reads instead. React Query's
  // structural sharing keeps those identities stable across a poll that returned
  // the same report, so the memo holds. `elapsedMs` is a diagnostic on the
  // envelope, not an input to any metric, so it is not carried through.
  const report = callReportQuery.data ?? null;
  const reportAvailable = report?.available ?? null;
  const reportError = report?.error ?? null;
  const reportWindow = report?.window;
  const reportQueue = report?.queue;
  const reportAgents = report?.agents;

  const callReport = useMemo<CallReportSnapshot | null>(
    () =>
      reportAvailable == null || reportWindow == null || reportAgents == null
        ? null
        : {
            available: reportAvailable,
            error: reportError,
            window: reportWindow,
            queue: reportQueue ?? null,
            agents: reportAgents,
            elapsedMs: 0,
          },
    [reportAvailable, reportError, reportWindow, reportQueue, reportAgents],
  );

  const metrics = useMemo(
    () =>
      buildCustomerCareMetrics({
        analytics,
        // An errored Call Report query yields no snapshot at all, which the
        // engine reports as `attempted: false` rather than inventing zeros.
        callReport,
        filters: { direction, queue, agentId, search: deferredSearch },
      }),
    [analytics, callReport, direction, queue, agentId, deferredSearch],
  );

  return {
    metrics,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    ok,
    refreshPolicy: policy,
    refresh: () => {
      void analyticsQuery.refetch();
      void callReportQuery.refetch();
    },
  };
}
