import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import type { OrdersFilters } from "@/lib/query-keys";
import { ORDER_LIST_COLUMNS } from "../constants";
import { EMPTY_KPI_SUMMARY, buildKpiArgs, readKpiSummary } from "../kpi";

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

  // KPI totals across the entire filtered set (server-side aggregation). The
  // argument list is built by `buildKpiArgs` and is a contract with the SQL
  // function that nothing type-checks — see the note in ../kpi.
  const { data: kpi, error: kpiError } = useQuery({
    queryKey: queryKeys.orders.kpi(filterKey),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "orders_kpi_summary" as any,
        buildKpiArgs({
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
        }),
      );
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

  const summary = readKpiSummary(kpi) ?? EMPTY_KPI_SUMMARY;
  /**
   * The summary was asked for and the answer did not come back.
   *
   * Reported separately because the twelve figures above cannot carry it: the
   * fallback that keeps the cards renderable while the first answer is in flight
   * is twelve zeros, and twelve zeros is also a legitimate answer for a filter
   * that matches nothing. Without this flag the strip states a total of 0 SAR
   * with the same confidence either way — which is exactly how a `PGRST202` from
   * a function signature the database had not been migrated to yet reached the
   * floor looking like a quiet day.
   */
  const summaryUnavailable = kpiError != null;

  return {
    isLoading,
    isFetching,
    pageRows,
    summary,
    summaryUnavailable,
    total,
    totalPages,
    currentPage,
    rangeStart,
    rangeEnd,
  };
}
