import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";
import type { Team } from "@/features/call-center/types";

/**
 * A team's call totals for a window, through the Calls module's own analytics.
 *
 * A thin adapter, not a second pipeline: `useCallCenterAnalytics` is the query
 * the Telesales and Overview dashboards run, keyed the same way, so asking for a
 * window one of those pages has already loaded costs nothing. The report reads
 * `totals` and nothing else — the agent table, the hourly buckets and the
 * conversion join are all still computed server-side for those pages, and none
 * of them belong in a management report.
 *
 * `includeOrders: false` is the one deliberate difference. The orders join
 * exists for Telesales' conversion metrics; a report that already has the
 * authoritative order figures from `orders_kpis` would be paying for a second,
 * differently-scoped count of the same thing — and then have two numbers for
 * "orders" that could disagree.
 */
export function useReportCalls(args: {
  from: string;
  to: string;
  team: Team;
  canView: boolean;
  authLoading: boolean;
}) {
  const analytics = useCallCenterAnalytics({
    from: args.from,
    to: args.to,
    team: args.team,
    // A management report is never scoped to one agent or one direction: it is
    // the whole team's day. Fixed rather than exposed as a filter, which keeps
    // the query key stable and shared with the Calls pages' unfiltered view.
    agentId: "all",
    direction: "all",
    canAll: true,
    canView: args.canView,
    authLoading: args.authLoading,
    search: "",
    // Reports are read, not watched. `resolveRefreshPolicy` already stops
    // polling a closed window; this is the cadence for the one case that is
    // still live — today's report, open on a screen.
    refreshMs: 60_000,
    includeOrders: false,
  });

  return analytics;
}
