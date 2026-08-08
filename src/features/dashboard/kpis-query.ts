import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import type { KpiRow } from "./types";

/**
 * One window + one team of `orders_kpis`, as React Query options.
 *
 * Extracted so the three callers that need it — the Daily report, the Monthly
 * report and the Dashboard's monthly growth series — share a single definition
 * of *which* RPC, with *which* arguments, under *which* key. The key is
 * `queryKeys.dashboard.kpis` with the Dashboard's own `DashboardFilters` shape,
 * which is the load-bearing part: a caller asking for a window the Dashboard has
 * already loaded reads that cache entry rather than issuing a second round trip,
 * and the two surfaces cannot show different numbers for the same month.
 *
 * `_agent: null` / `_mine: false` are fixed here on purpose. Everything built on
 * this asks a team-wide question; RLS still narrows the rows to what the caller
 * is allowed to see.
 *
 * Completed-vs-not is not decided here and must never be: `orders_kpis` filters
 * on `status = 'Completed'` server-side, and that is the only definition of a
 * completed order in the system.
 */
export function orderKpisQuery(args: { from: string; to: string; team: string; enabled: boolean }) {
  const { from, to, team, enabled } = args;

  // Exactly `DashboardFilters`, field for field. An extra field here would be a
  // different cache entry from the Dashboard's, which is the whole point.
  const filters = { from, to, agent: "all", team };

  return {
    queryKey: queryKeys.dashboard.kpis(filters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_kpis" as any, {
        _from: from,
        _to: to,
        _team: team,
        _agent: null,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as KpiRow[];
    },
    enabled,
  };
}
