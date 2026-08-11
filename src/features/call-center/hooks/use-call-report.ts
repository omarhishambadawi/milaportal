/**
 * Yeastar's own queue report for a window — one query, shared by every page
 * that needs it.
 *
 * The report is the authority on TWO things and nothing else: per-agent missed
 * calls, and the Missed / Abandoned split of unanswered queue calls. Customer
 * Care reads both; the Calls Overview reads the split, so that its Missed and
 * Abandoned cards state the same thing Customer Care's do. A second copy of
 * this query would be a second cache entry, a second poll against a PBX that
 * rate-limits its token endpoint hard, and eventually a second set of options
 * that quietly diverged.
 *
 * Deliberately a SEPARATE query from analytics, not folded into that server
 * function. Call Report is queue-scoped and inbound by construction, so its
 * response is identical across the direction and agent filters — giving it its
 * own key means toggling those re-renders from cache instead of re-querying the
 * PBX. It also keeps a Call Report outage off the analytics path.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { yeastarCallReport } from "@/lib/yeastar.functions";
import type { CallReportSnapshot } from "@/lib/yeastar/call-report.server";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshPolicy } from "../refresh-policy";

export interface UseCallReportArgs {
  from: string;
  to: string;
  /** Queue number, or "all". */
  queue: string;
  enabled: boolean;
  /** The page's own cadence, so the report never polls harder than its page. */
  policy: RefreshPolicy;
}

export function useCallReportQuery({
  from,
  to,
  queue,
  enabled,
  policy,
}: UseCallReportArgs): UseQueryResult<CallReportSnapshot> {
  const callReportFn = useServerFn(yeastarCallReport);

  return useQuery({
    queryKey: queryKeys.callCenter.callReport({ from, to, queue }),
    queryFn: () =>
      callReportFn({ data: { from, to, ...(queue && queue !== "all" ? { queue } : {}) } }),
    enabled,
    staleTime: policy.staleMs,
    // Follows the analytics query's retention for the same reason: the two are
    // fetched together and rendered together, so evicting one of them on its own
    // just re-loads half a page.
    gcTime: policy.gcMs,
    placeholderData: keepPreviousData,
    // Two live PBX requests per miss, against a box that rate-limits its token
    // endpoint hard. It follows the same policy as the analytics query for the
    // same reason, and more strictly: it has no cheap path at all.
    refetchInterval: policy.intervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // A missing report must never surface as a page error — the consumer
    // reports it as an unavailable source and falls back to the CDR split.
    retry: 1,
    throwOnError: false,
  });
}
