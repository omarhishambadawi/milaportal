import { useMemo } from "react";
import {
  buildDailyReport,
  type DailyReport,
  type ReportBasis,
  type TeamOrderTotals,
} from "../daily";
import { bucket, type OrderBuckets } from "../monthly";
import { useReportCalls } from "./use-report-calls";
import { useReportOrderKpis } from "./use-report-orders";

/**
 * The daily report's data, in four queries.
 *
 * Two `orders_kpis` calls and two call-analytics calls — one of each per team —
 * and every one of them is an endpoint the Dashboard or the Calls pages already
 * own, keyed identically, so nothing here is a new source of numbers. Four is
 * also the floor: the order RPC takes a single team, and the two teams'
 * telephony is genuinely two different questions of the PBX.
 *
 * What it deliberately does not do is fetch orders. The report needs six figures
 * per team and `orders_kpis` returns all six pre-aggregated; pulling the day's
 * rows to the browser and counting them would be slower, would need its own
 * classification of Cash and Wasfaty, and would be the second source of truth
 * this whole feature exists to avoid.
 */
export function useDailyReport(args: {
  date: string;
  basis: ReportBasis;
  canView: boolean;
  authLoading: boolean;
  /**
   * False while the Monthly tab is the one on screen.
   *
   * Both reports are declared by the route, so both used to fetch on mount and
   * opening the page cost nineteen requests for a tab showing four figures. The
   * hooks stay mounted — their memos, their state and the cache entry they will
   * read are all preserved — and only the network work waits for the tab.
   */
  active?: boolean;
}): {
  report: DailyReport;
  isLoading: boolean;
  callsUnavailable: boolean;
} {
  const { date, basis, canView, authLoading, active = true } = args;
  const wanted = canView && active;
  const enabled = wanted && !authLoading;

  // One day: the window is the same date on both ends.
  const telesalesOrders = useReportOrderKpis({ from: date, to: date, team: "telesales", enabled });
  const careOrders = useReportOrderKpis({ from: date, to: date, team: "customer_care", enabled });

  const telesalesCalls = useReportCalls({
    from: date,
    to: date,
    team: "telesales",
    canView: wanted,
    authLoading,
  });
  const careCalls = useReportCalls({
    from: date,
    to: date,
    team: "customer_care",
    canView: wanted,
    authLoading,
  });

  const report = useMemo(() => {
    /**
     * Sales on the chosen basis.
     *
     * The default is every order logged that day, which is what the manual
     * report has always counted — it goes out the same evening, when most of the
     * day's orders have not been marked complete yet, and counting only the
     * completed ones would report a fraction of the day's trading as the day's
     * trading. Completed-only is offered because it is the right basis for a
     * report re-run later against a closed day.
     */
    const orders = (buckets: OrderBuckets): TeamOrderTotals => {
      const total = bucket(buckets.total);
      const cash = bucket(buckets.cash);
      const wasfaty = bucket(buckets.wasfaty);
      return basis === "completed"
        ? {
            orders: total.completedOrders,
            cashSales: cash.completedSales,
            wasfatySales: wasfaty.completedSales,
          }
        : {
            orders: total.totalOrders,
            cashSales: cash.totalSales,
            wasfatySales: wasfaty.totalSales,
          };
    };

    return buildDailyReport({
      date,
      basis,
      telesales: {
        orders: orders(telesalesOrders.buckets),
        calls: {
          total: telesalesCalls.totals?.total ?? 0,
          inbound: telesalesCalls.totals?.inbound ?? 0,
        },
      },
      customerCare: {
        orders: orders(careOrders.buckets),
        calls: {
          total: careCalls.totals?.total ?? 0,
          inbound: careCalls.totals?.inbound ?? 0,
        },
      },
    });
  }, [
    date,
    basis,
    telesalesOrders.buckets,
    careOrders.buckets,
    telesalesCalls.totals,
    careCalls.totals,
  ]);

  return {
    report,
    isLoading:
      telesalesOrders.isLoading ||
      careOrders.isLoading ||
      telesalesCalls.isLoading ||
      careCalls.isLoading,
    /**
     * The PBX did not answer, but the orders did.
     *
     * Surfaced rather than thrown, and the asymmetry is the same one the Calls
     * pages make: a report whose call lines read zero because Yeastar is down,
     * sent as though they were real, is worse than a report that says so. The
     * sales half is Supabase-derived and still correct.
     */
    callsUnavailable: !telesalesCalls.ok || !careCalls.ok,
  };
}
