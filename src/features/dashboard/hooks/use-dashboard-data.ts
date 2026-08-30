import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import type { DashboardFilters } from "@/lib/query-keys";
import type { KpiRow, DashKpiStats } from "../types";
import { summarizeFulfillment } from "@/features/orders/fulfillment";
import { teamLabel } from "../utils";

/**
 * The eleven aggregations this hook owns, as switchable names.
 *
 * A consumer that reads six of them was still paying for all eleven, because
 * `enabled` was one flag for the whole set. The Dashboard reads every one and
 * passes nothing; the Monthly Report reads five and says so.
 */
export type DashboardSection =
  | "kpis"
  | "daily"
  | "status"
  | "teams"
  | "agentSales"
  | "locations"
  | "delivery"
  | "deliveryMatrix"
  | "verification"
  | "complaints";

interface UseDashboardDataArgs {
  from: string;
  to: string;
  effectiveTeam: string;
  effectiveAgent: string;
  dashFilters: DashboardFilters;
  cmpFilters: Omit<DashboardFilters, "team">;
  enabled: boolean;
  /** The signed-in user, used to recognise their own rows. */
  viewerId?: string;
  /**
   * True for agent roles (no `view_all_agents`). Invoice verification is then
   * narrowed to the viewer's own records, and every other agent's name in the
   * "Top agents by sales" ranking is anonymised while the ranking, the values
   * and the chart layout stay exactly as they are.
   */
  restrictAgentIdentity?: boolean;
  /**
   * Which aggregations to actually fetch. Omitted means all of them, which is
   * what the Dashboard wants and what this hook did before the option existed.
   *
   * Listing a subset gates the others' `enabled` only — the keys, the RPCs and
   * every derived shape are untouched, so a section a caller switched off still
   * reads from cache if some other surface has already fetched it, and the
   * derived value is simply the empty one until then.
   */
  sections?: readonly DashboardSection[];
}

/**
 * Every on-screen Dashboard aggregation query plus its client-side transform.
 *
 * Each query is a faithful move of the route's original `useQuery` + `useMemo`
 * pair: identical query keys, RPC names, params, `enabled` gate and derived
 * shapes. No calculation or API is altered — the route now consumes the derived
 * datasets instead of declaring the queries inline.
 */
export function useDashboardData({
  from,
  to,
  effectiveTeam,
  effectiveAgent,
  dashFilters,
  cmpFilters,
  enabled,
  viewerId,
  restrictAgentIdentity = false,
  sections,
}: UseDashboardDataArgs) {
  // `undefined` is "everything", not "nothing": the Dashboard never passes this
  // and must keep fetching all eleven.
  const wants = (section: DashboardSection) => enabled && (!sections || sections.includes(section));
  // Headline KPI cards now come from the orders_kpis RPC (server-side
  // aggregation) instead of the client-side cash/wasfaty/total reduction.
  // Scoped by the same effective team/agent filters; RLS applies.
  // `isLoading` and not `isPending`: with `enabled: false` a query is pending
  // forever, and a viewer whose sections list omits "kpis" would sit under a
  // permanent skeleton. This is true only while the first fetch is actually in
  // flight.
  const { data: kpiRows, isLoading: kpiLoading } = useQuery({
    queryKey: queryKeys.dashboard.kpis(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_kpis" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as KpiRow[];
    },
    enabled: wants("kpis"),
  });

  const kpiByBucket = useMemo(() => {
    const m = new Map((kpiRows ?? []).map((r) => [r.bucket, r]));
    const toStats = (b?: KpiRow): DashKpiStats | undefined =>
      b
        ? {
            totalSales: Number(b.total_sales),
            completedSales: Number(b.completed_sales),
            totalOrders: Number(b.order_count),
            completedOrders: Number(b.completed_count),
            pending: Number(b.pending_count),
            cancelled: Number(b.cancelled_count),
            completionRate: Number(b.completion_rate),
          }
        : undefined;
    return {
      cash: toStats(m.get("cash")),
      wasfaty: toStats(m.get("wasfaty")),
      total: toStats(m.get("total")),
    };
  }, [kpiRows]);

  // Daily sales trend from orders_daily RPC. Rows arrive ordered by full date
  // (fixes the year-boundary ordering); the label is formatted client-side.
  const { data: dailyRows } = useQuery({
    queryKey: queryKeys.dashboard.daily(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_daily" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ day: string; total_sales: number; completed_sales: number }>;
    },
    enabled: wants("daily"),
  });
  const dailyData = useMemo(
    () =>
      (dailyRows ?? []).map((r) => ({
        date: r.day.slice(5),
        total: Number(r.total_sales),
        completed: Number(r.completed_sales),
      })),
    [dailyRows],
  );

  // Orders-by-status distribution from orders_status RPC.
  const { data: statusRows } = useQuery({
    queryKey: queryKeys.dashboard.status(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_status" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ status: string; order_count: number }>;
    },
    enabled: wants("status"),
  });
  const statusData = useMemo(
    () => (statusRows ?? []).map((r) => ({ name: r.status, value: Number(r.order_count) })),
    [statusRows],
  );

  // Sales by team from orders_teams RPC.
  const { data: teamRows } = useQuery({
    queryKey: queryKeys.dashboard.teams(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_teams" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        team: string;
        order_count: number;
        completed_sales: number;
        completion_rate: number;
      }>;
    },
    enabled: wants("teams"),
  });
  const teamData = useMemo(
    () =>
      (teamRows ?? []).map((r) => ({ name: teamLabel(r.team), sales: Number(r.completed_sales) })),
    [teamRows],
  );

  // Top agents by sales from orders_agents RPC (top 10 for the chart).
  const { data: agentRows } = useQuery({
    queryKey: queryKeys.dashboard.agentSales(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_agents" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        agent_id: string;
        agent_name: string;
        completed_sales: number;
      }>;
    },
    enabled: wants("agentSales"),
  });
  const agentSalesData = useMemo(
    () =>
      (agentRows ?? []).slice(0, 10).map((r, i) => ({
        name: !restrictAgentIdentity || r.agent_id === viewerId ? r.agent_name : `Agent ${i + 1}`,
        sales: Number(r.completed_sales),
      })),
    [agentRows, restrictAgentIdentity, viewerId],
  );

  // Sales by branch / city + heat map from orders_locations RPC.
  const { data: locationRows } = useQuery({
    queryKey: queryKeys.dashboard.locations(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_locations" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        location_type: string;
        location: string;
        order_count: number;
        completed_sales: number;
        completed_count: number;
        total_sales: number;
        completion_rate: number;
      }>;
    },
    enabled: wants("locations"),
  });
  const branchData = useMemo(
    () =>
      (locationRows ?? [])
        .filter((r) => r.location_type === "branch")
        .map((r) => ({ name: r.location, sales: Number(r.completed_sales) }))
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 10),
    [locationRows],
  );
  const cityData = useMemo(
    () =>
      (locationRows ?? [])
        .filter((r) => r.location_type === "city")
        .map((r) => ({ name: r.location, sales: Number(r.completed_sales) }))
        .sort((a, b) => b.sales - a.sales),
    [locationRows],
  );
  const cityMapData = useMemo(
    () =>
      (locationRows ?? [])
        .filter((r) => r.location_type === "city")
        .map((r) => ({
          name: r.location,
          sales: Number(r.completed_sales),
          count: Number(r.order_count),
          total: Number(r.total_sales),
          completed: Number(r.completed_count),
        })),
    [locationRows],
  );

  // Delivery method performance from orders_delivery RPC.
  const { data: deliveryRows } = useQuery({
    queryKey: queryKeys.dashboard.delivery(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_delivery" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        delivery_type: string;
        order_count: number;
        completed_sales: number;
        completion_rate: number;
        /**
         * Added by 20260808120000_orders_fulfillment.sql, so optional here.
         *
         * Not defensive habit: between a client deploy and its migration these
         * three are genuinely absent, and `Number(undefined)` is NaN — which
         * renders as "NaN" across a dashboard rather than as a column that is not
         * ready yet. Absent is handled as absent instead.
         */
        completed_count?: number;
        completed_cash_count?: number;
        completed_wasfaty_count?: number;
      }>;
    },
    enabled: wants("delivery"),
  });
  const deliveryData = useMemo(
    () =>
      (deliveryRows ?? []).map((r) => ({
        name: r.delivery_type,
        count: Number(r.order_count),
        // The table's first numeric column is headed "Completed orders" and was
        // showing `order_count`, which is every order on that method whatever its
        // status. Now that the RPC returns the completed figure, the column can
        // mean what it says — and renders an em dash rather than a wrong number
        // if it is asked before the migration lands.
        completed: r.completed_count == null ? null : Number(r.completed_count),
        sales: Number(r.completed_sales),
        rate: Number(r.completion_rate),
      })),
    [deliveryRows],
  );

  /**
   * Completed orders, delivery vs store pickup, with the Cash/Wasfaty split.
   *
   * Derived from `deliveryRows` rather than fetched: those are already on the
   * page, there are four of them, and the classification is the shared one every
   * other surface uses. No query, no second definition.
   */
  const fulfillmentMix = useMemo(
    () =>
      summarizeFulfillment(
        (deliveryRows ?? []).map((r) => ({
          name: r.delivery_type,
          completedCount: Number(r.completed_count ?? 0),
          completedCash: Number(r.completed_cash_count ?? 0),
          completedWasfaty: Number(r.completed_wasfaty_count ?? 0),
          completedSales: Number(r.completed_sales),
        })),
      ),
    [deliveryRows],
  );

  // Branch x method / city x method crosstabs from orders_delivery_matrix RPC.
  const { data: matrixRows } = useQuery({
    queryKey: queryKeys.dashboard.deliveryMatrix(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_delivery_matrix" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        location_type: string;
        location: string;
        delivery_type: string;
        completed_sales: number;
      }>;
    },
    enabled: wants("deliveryMatrix"),
  });
  const pivotMatrix = (type: "branch" | "city") => {
    const m: Record<string, Record<string, number>> = {};
    for (const r of matrixRows ?? []) {
      if (r.location_type !== type) continue;
      (m[r.location] ??= {})[r.delivery_type] = Number(r.completed_sales);
    }
    return m;
  };
  const deliveryBranchMatrix = useMemo(() => pivotMatrix("branch"), [matrixRows]);
  const deliveryCityMatrix = useMemo(() => pivotMatrix("city"), [matrixRows]);

  // CC invoice verification per agent from orders_verification RPC (top 12).
  const { data: verificationRows } = useQuery({
    queryKey: queryKeys.dashboard.verification(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_verification" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        agent_id: string;
        agent_name: string;
        total_orders: number;
        verified: number;
        non_verified: number;
        verified_value: number;
        rate: number;
      }>;
    },
    enabled: wants("verification"),
  });
  const verifData = useMemo(
    () =>
      (verificationRows ?? [])
        .filter((r) => !restrictAgentIdentity || r.agent_id === viewerId)
        .slice(0, 12)
        .map((r) => ({
          name: r.agent_name,
          total: Number(r.total_orders),
          verified: Number(r.verified),
          nonVerified: Number(r.non_verified),
          rate: Number(r.rate),
          verifiedValue: Number(r.verified_value),
        })),
    [verificationRows, restrictAgentIdentity, viewerId],
  );

  // Complaints analytics (scoped by date + agent only; complaints have no team).
  const cmpAgent = effectiveAgent === "all" ? null : effectiveAgent;
  const { data: cmpKpiRows } = useQuery({
    queryKey: queryKeys.dashboard.complaintsKpis(cmpFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("complaints_kpis" as any, {
        _from: from,
        _to: to,
        _agent: cmpAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        total: number;
        in_progress: number;
        resolved: number;
        resolution_rate: number;
      }>;
    },
    enabled: wants("complaints"),
  });
  const cmpKpi = cmpKpiRows?.[0];
  const { data: cmpLocRows } = useQuery({
    queryKey: queryKeys.dashboard.complaintsLocations(cmpFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("complaints_locations" as any, {
        _from: from,
        _to: to,
        _agent: cmpAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        location_type: string;
        location: string;
        total: number;
        resolved: number;
        open: number;
        rate: number;
      }>;
    },
    enabled: wants("complaints"),
  });
  const cmpBranchData = useMemo(
    () =>
      (cmpLocRows ?? [])
        .filter((r) => r.location_type === "branch")
        .map((r) => ({
          name: r.location,
          total: Number(r.total),
          resolved: Number(r.resolved),
          open: Number(r.open),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 10),
    [cmpLocRows],
  );
  const cmpCityData = useMemo(
    () =>
      (cmpLocRows ?? [])
        .filter((r) => r.location_type === "city")
        .map((r) => ({ name: r.location, total: Number(r.total), rate: Number(r.rate) }))
        .sort((a, b) => b.total - a.total),
    [cmpLocRows],
  );

  const deliveryMethods = useMemo(
    () => Array.from(new Set(deliveryData.map((d) => d.name))),
    [deliveryData],
  );

  return {
    kpiByBucket,
    /** First load of `orders_kpis`. The headline cards render placeholders on it
     *  rather than three cards of zeroes, which a reader cannot tell from a
     *  period that genuinely had no sales. */
    kpiLoading,
    dailyData,
    statusData,
    teamData,
    agentSalesData,
    branchData,
    cityData,
    cityMapData,
    deliveryData,
    fulfillmentMix,
    deliveryMethods,
    deliveryBranchMatrix,
    deliveryCityMatrix,
    verifData,
    cmpKpi,
    cmpBranchData,
    cmpCityData,
  };
}
