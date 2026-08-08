import { useQuery } from "@tanstack/react-query";
import { orderKpisQuery } from "@/features/dashboard/kpis-query";
import type { OrderBuckets } from "../monthly";

/**
 * One team's order KPIs for a window — the Dashboard's own RPC, its own key.
 *
 * `orders_kpis` is what the Dashboard's headline cards already read, and the key
 * is built by `queryKeys.dashboard.kpis` with the same filter shape, so a report
 * asking for the same window and team as a dashboard the user already opened is
 * a cache hit rather than a second round trip. That sharing is the entire reason
 * this does not have a key namespace of its own.
 *
 * Called once per team rather than once per KPI: the RPC returns the cash,
 * wasfaty and total buckets in a single response, so a whole team's section of a
 * report is one query.
 */
export function useReportOrderKpis(args: {
  from: string;
  to: string;
  team: string;
  enabled: boolean;
}): { buckets: OrderBuckets; isLoading: boolean } {
  // The RPC, its arguments and its key all come from `orderKpisQuery`, which is
  // the Dashboard's own definition — see the note there on why the key shape
  // matters. This hook adds only the bucket mapping a report reads.
  const { data, isLoading } = useQuery(orderKpisQuery(args));

  const rows = data ?? [];
  const find = (name: string) => {
    const row = rows.find((r) => r.bucket === name);
    if (!row) return undefined;
    return {
      totalSales: Number(row.total_sales),
      completedSales: Number(row.completed_sales),
      totalOrders: Number(row.order_count),
      completedOrders: Number(row.completed_count),
      completionRate: Number(row.completion_rate),
    };
  };

  return {
    buckets: { cash: find("cash"), wasfaty: find("wasfaty"), total: find("total") },
    isLoading,
  };
}
