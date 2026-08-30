import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import type { OrdersFilters } from "@/lib/query-keys";
import { ORDER_LIST_COLUMNS } from "../constants";

interface UseOrdersListDataArgs {
  from: string;
  to: string;
  team: string;
  agent: string;
  status: string;
  fulfillment: string;
  /** The Invoice Verification filter — see `features/orders/verification.ts`. */
  verification: string;
  mineOnly: boolean;
  /**
   * Narrow to the caller's starred orders. The page fetch gets this through
   * `applyFilters` as an `id IN (…)`; the KPI RPC resolves it server-side from
   * `auth.uid()`, so the cards and the table narrow to the same set without the
   * client having to send the ids twice.
   */
  starredOnly: boolean;
  userId: string | undefined;
  /** Mirrors `OrderFilterState.canFilterAgents` — see the note there. */
  canFilterAgents: boolean;
  term: string;
  searching: boolean;
  /**
   * Ids of the agents whose name matches `term`, so the KPI aggregation can run
   * the same seven-branch search the table does. Without it the cards would
   * total the six-column match while the table listed the seven-column one.
   */
  searchAgentIds: readonly string[];
  filterKey: OrdersFilters;
  page: number;
  pageSize: number;
  applyFilters: (qb: any) => any;
  namesById: Map<any, any>;
  cities: Map<any, any> | undefined;
}

/**
 * Orders list data: the paginated page fetch, the server-side KPI summary, the
 * per-row enrichment, and the derived pagination figures. A faithful move of the
 * route's two queries plus their memos — same query keys, same PostgREST/RPC
 * calls, same enrichment and summary shapes.
 */
export function useOrdersListData({
  from,
  to,
  team,
  agent,
  status,
  fulfillment,
  verification,
  mineOnly,
  starredOnly,
  userId,
  canFilterAgents,
  term,
  searching,
  searchAgentIds,
  filterKey,
  page,
  pageSize,
  applyFilters,
  namesById,
  cities,
}: UseOrdersListDataArgs) {
  // Paginated page fetch (server-side range + count).
  const {
    data: pageData,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: queryKeys.orders.page(filterKey, page, pageSize),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const offset = page * pageSize;
      // Named columns, not `*` — see ORDER_LIST_COLUMNS. The count stays exact
      // because the pager prints "Showing 26–50 of 431" and an estimate would
      // make that sentence a guess.
      let qb = supabase.from("orders").select(ORDER_LIST_COLUMNS, { count: "exact" });
      qb = applyFilters(qb);
      qb = qb.order("order_date", { ascending: false }).order("created_at", { ascending: false });
      qb = qb.range(offset, offset + pageSize - 1);
      const { data, count, error } = await qb;
      if (error) throw error;
      return { rows: (data ?? []) as any[], total: count ?? 0 };
    },
  });

  // KPI totals across the entire filtered set (server-side aggregation).
  const { data: kpi } = useQuery({
    queryKey: queryKeys.orders.kpi(filterKey),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_kpi_summary" as any, {
        _from: from,
        _to: to,
        _team: team,
        _agent: canFilterAgents && agent !== "all" ? agent : null,
        _status: status,
        _mine: mineOnly && !!userId,
        _q: searching ? term : null,
        _fulfillment: fulfillment,
        _starred: starredOnly,
        // Both appended with SQL-side defaults, so the MCP tools that call this
        // function with the older argument list are unaffected.
        _verification: verification,
        // The seventh branch of the table's search OR. Sent as ids rather than a
        // name, because the join the RPC would otherwise need is the join the
        // client already has in memory.
        _agent_ids: searching && searchAgentIds.length > 0 ? searchAgentIds : null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });

  const enrichedRows = useMemo(() => {
    const rowsRaw = pageData?.rows ?? [];
    return rowsRaw.map((o: any) => ({
      ...o,
      agent_name: namesById.get(o.agent_id)?.full_name ?? "—",
      agent_code: namesById.get(o.agent_id)?.agent_code ?? "",
      city: cities?.get(o.branch_no) ?? "",
    }));
  }, [pageData, namesById, cities]);

  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const rangeStart = total === 0 ? 0 : currentPage * pageSize + 1;
  const rangeEnd = Math.min(total, (currentPage + 1) * pageSize);
  const pageRows = enrichedRows;

  const summary = {
    cashSales: Number(kpi?.cash_sales ?? 0),
    cashCompletedSales: Number(kpi?.cash_completed_sales ?? 0),
    cashCount: Number(kpi?.cash_count ?? 0),
    cashCompletedCount: Number(kpi?.cash_completed_count ?? 0),
    wasSales: Number(kpi?.was_sales ?? 0),
    wasCompletedSales: Number(kpi?.was_completed_sales ?? 0),
    wasCount: Number(kpi?.was_count ?? 0),
    wasCompletedCount: Number(kpi?.was_completed_count ?? 0),
    totalSales: Number(kpi?.total_sales ?? 0),
    totalCompletedSales: Number(kpi?.total_completed_sales ?? 0),
    totalCount: Number(kpi?.total_count ?? 0),
    completedCount: Number(kpi?.completed_count ?? 0),
  };

  return {
    isLoading,
    isFetching,
    pageRows,
    summary,
    total,
    totalPages,
    currentPage,
    rangeStart,
    rangeEnd,
  };
}
