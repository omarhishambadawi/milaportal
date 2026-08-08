import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { orderKpisQuery } from "../kpis-query";
import type { KpiRow } from "../types";
import {
  GROWTH_TEAMS,
  HISTORICAL_MONTHLY,
  LIVE_DATA_START,
  buildInsights,
  buildMonthlyGrowth,
  monthKey,
  monthWindow,
  monthsBetween,
  type GrowthTeam,
  type Insight,
  type MonthRow,
  type MonthlyTeamEntry,
} from "../monthly-growth";

/** One month + team the live half asks `orders_kpis` for. */
interface LiveRequest {
  month: string;
  team: GrowthTeam;
  window: { from: string; to: string };
}

/**
 * One team-month of `orders_kpis` rows, as a growth entry — or nothing.
 *
 * Reads `completed_sales` and `completed_count` only. The `total_sales` /
 * `order_count` columns on the same rows include Pending, Cancelled and every
 * other status, and this section is completed orders by definition.
 *
 * A team-month with no completed orders at all yields no entry rather than a row
 * of zeroes. Telesales did not exist before April 2026, and a team that was not
 * there must not be drawn as a team that sold nothing — that would put a -100%
 * in the growth column and a point on the floor of the chart for a month that
 * should simply be absent.
 */
function toLiveEntry(
  request: LiveRequest | undefined,
  rows: KpiRow[] | undefined,
): MonthlyTeamEntry[] {
  if (!request || !rows) return [];

  const bucket = (name: string) => rows.find((row) => row.bucket === name);
  const cash = bucket("cash");
  const wasfaty = bucket("wasfaty");

  if (Number(bucket("total")?.completed_count ?? 0) === 0) return [];

  return [
    {
      month: request.month,
      team: request.team,
      source: "live",
      totals: {
        cashRevenue: Number(cash?.completed_sales ?? 0),
        cashOrders: Number(cash?.completed_count ?? 0),
        wasfatyRevenue: Number(wasfaty?.completed_sales ?? 0),
        wasfatyOrders: Number(wasfaty?.completed_count ?? 0),
      },
    },
  ];
}

/**
 * The monthly growth timeline: a fixed historical baseline, then live months.
 *
 * The live half is one `orders_kpis` call per month per team — the Dashboard's
 * own RPC through `orderKpisQuery`, so these are the Dashboard's cache entries
 * and its completed-order definition, not a second pipeline. Two teams times the
 * months since July 2026, all in flight together; the alternative was a new
 * grouped-by-month RPC, and a migration is not worth owning for an aggregation
 * the existing one already answers a month at a time.
 *
 * Deliberately **not** wired to the Dashboard's date picker. The baseline months
 * are whole-month, team-wide figures with no agent dimension; slicing the live
 * half by an arbitrary window or by one agent while the historical half stayed
 * whole would put two different questions in one table. This section always
 * shows the full timeline, and says so on screen.
 */
export function useMonthlyGrowth({ enabled }: { enabled: boolean }): {
  rows: MonthRow[];
  insights: Insight[];
  isLoading: boolean;
  /** The month still in progress, so the UI can mark its row partial. */
  currentMonth: string;
} {
  // Recomputed per render but stable within a day; `monthsBetween` is a handful
  // of string comparisons and this avoids a stale list at midnight.
  const currentMonth = monthKey(new Date());
  const liveMonths = useMemo(() => monthsBetween(LIVE_DATA_START, currentMonth), [currentMonth]);

  const requests: LiveRequest[] = useMemo(
    () =>
      liveMonths.flatMap((month) =>
        GROWTH_TEAMS.map((team) => ({ month, team, window: monthWindow(month) })),
      ),
    [liveMonths],
  );

  // `combine` rather than a `useMemo` over the results array: React Query owns
  // the memoisation, and the results array is a fresh reference every render, so
  // a dependency array over it would either never hit or need a hand-rolled
  // fingerprint of its contents.
  const { liveEntries, isLoading } = useQueries({
    queries: requests.map((r) =>
      orderKpisQuery({ from: r.window.from, to: r.window.to, team: r.team, enabled }),
    ),
    combine: (results) => ({
      isLoading: results.some((r) => r.isLoading),
      liveEntries: results.flatMap((result, index) =>
        toLiveEntry(requests[index], result.data as KpiRow[] | undefined),
      ),
    }),
  });

  const rows = useMemo(
    () => buildMonthlyGrowth([...HISTORICAL_MONTHLY, ...liveEntries], { currentMonth }),
    [liveEntries, currentMonth],
  );

  const insights = useMemo(() => buildInsights(rows), [rows]);

  return { rows, insights, isLoading, currentMonth };
}
