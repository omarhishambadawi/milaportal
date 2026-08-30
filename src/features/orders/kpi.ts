/**
 * The Orders KPI strip — the question the cards ask, and the reading of the
 * answer.
 *
 * The three cards are not computed from the rows on screen. The table shows one
 * page; the cards total the whole filtered set, so they are a separate
 * server-side aggregation (`public.orders_kpi_summary`) asked with the same
 * filters the list narrows by. That is the arrangement `_fulfillment`,
 * `_starred` and `_verification` were each appended to preserve: a predicate
 * that reaches only one of the two puts a list and a total on the same screen
 * describing different sets of orders.
 *
 * Both halves of that exchange live here, out of the hook and free of React, for
 * one reason: the argument list is a contract with a SQL function, and nothing
 * in TypeScript checks it. `supabase.rpc()` is called through `as any` because
 * the RPC is absent from the generated types, so an argument the deployed
 * function does not declare type-checks, builds, deploys, and then fails at
 * runtime with PGRST202 — every card reading zero, which is a number an
 * operations page is entitled to believe. Keeping `buildKpiArgs` pure lets
 * `__tests__/kpi-summary.test.ts` hold its keys against the parameters the
 * migration actually declares, which is the only place that mismatch can be
 * caught before an agent sees it.
 *
 * The SQL mirror is `supabase/migrations/20260830140000_orders_invoice_verification_filter.sql`.
 */

/** The filter state the summary is asked for — the list's, unchanged. */
export interface OrdersKpiRequest {
  /** Inclusive `order_date` bounds, ISO `yyyy-MM-dd`. */
  from: string;
  to: string;
  team: string;
  agent: string;
  status: string;
  /** See `./fulfillment`. */
  fulfillment: string;
  /** See `./verification`. */
  verification: string;
  mineOnly: boolean;
  starredOnly: boolean;
  userId: string | undefined;
  /** Mirrors `OrderFilterState.canFilterAgents` — see the note there. */
  canFilterAgents: boolean;
  term: string;
  searching: boolean;
}

/**
 * The named arguments for `orders_kpi_summary`.
 *
 * Three of them are narrowings rather than passthroughs, and each is the client
 * half of a rule the SQL cannot enforce on its own:
 *
 *   * `_agent` is sent only when the caller may filter by agent at all, so a
 *     stale selection cannot survive the permission being taken away;
 *   * `_mine` needs a signed-in id to mean anything — `auth.uid()` is what the
 *     function compares against;
 *   * `_q` is null unless there is actually a term, because a search term and a
 *     date range are alternatives in the predicate, not companions.
 */
export function buildKpiArgs(s: OrdersKpiRequest): Record<string, unknown> {
  return {
    _from: s.from,
    _to: s.to,
    _team: s.team,
    _agent: s.canFilterAgents && s.agent !== "all" ? s.agent : null,
    _status: s.status,
    _mine: s.mineOnly && !!s.userId,
    _q: s.searching ? s.term : null,
    _fulfillment: s.fulfillment,
    _starred: s.starredOnly,
    _verification: s.verification,
  };
}

/** The twelve figures the three cards are built from. */
export interface OrdersKpiSummary {
  cashSales: number;
  cashCompletedSales: number;
  cashCount: number;
  cashCompletedCount: number;
  wasSales: number;
  wasCompletedSales: number;
  wasCount: number;
  wasCompletedCount: number;
  totalSales: number;
  totalCompletedSales: number;
  totalCount: number;
  completedCount: number;
}

/**
 * Zeros — for the moment before the first answer arrives, and nothing else.
 *
 * Never a substitute for an answer that failed to arrive: see `readKpiSummary`.
 */
export const EMPTY_KPI_SUMMARY: OrdersKpiSummary = {
  cashSales: 0,
  cashCompletedSales: 0,
  cashCount: 0,
  cashCompletedCount: 0,
  wasSales: 0,
  wasCompletedSales: 0,
  wasCount: 0,
  wasCompletedCount: 0,
  totalSales: 0,
  totalCompletedSales: 0,
  totalCount: 0,
  completedCount: 0,
};

/** `numeric` crosses the wire as a string; `jsonb` counts arrive as numbers. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Read the RPC's `jsonb` into the cards' figures — or `null` if there is nothing
 * to read.
 *
 * The null is the point. A day with no orders and a summary that never arrived
 * are both "no numbers", and mapping them to the same twelve zeros makes a
 * failed query indistinguishable from a quiet Friday — a KPI strip that reports
 * 0 SAR with total confidence while the query behind it is erroring. The caller
 * gets `null` and has to decide, which is how the strip can say *unavailable*
 * instead of *zero*.
 */
export function readKpiSummary(
  payload: Record<string, unknown> | null | undefined,
): OrdersKpiSummary | null {
  if (!payload) return null;
  return {
    cashSales: num(payload.cash_sales),
    cashCompletedSales: num(payload.cash_completed_sales),
    cashCount: num(payload.cash_count),
    cashCompletedCount: num(payload.cash_completed_count),
    wasSales: num(payload.was_sales),
    wasCompletedSales: num(payload.was_completed_sales),
    wasCount: num(payload.was_count),
    wasCompletedCount: num(payload.was_completed_count),
    totalSales: num(payload.total_sales),
    totalCompletedSales: num(payload.total_completed_sales),
    totalCount: num(payload.total_count),
    completedCount: num(payload.completed_count),
  };
}
