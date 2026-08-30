/**
 * The Orders KPI strip.
 *
 * This suite exists because of a regression it would have caught. The Invoice
 * Verification filter appended `_verification` to the `orders_kpi_summary` call
 * and to the migration that declares it — correctly, on both sides — but the
 * migration had not been applied to the database the deployed client was talking
 * to. PostgREST resolves an RPC by its argument names, found no 10-argument
 * function, and returned `PGRST202`. The query errored, `data` stayed undefined,
 * and every figure fell through `?? 0`: three cards reading 0 SAR and 0 orders
 * over a month with 3,611 orders in it, with nothing on the page saying
 * otherwise.
 *
 * Two things have to be true for that to be impossible rather than unlucky:
 *
 *   1. every argument the client sends is one the SQL declares — the mismatch
 *      itself, which nothing type-checks because the RPC is called through
 *      `as any` and is absent from the generated Supabase types;
 *   2. a summary that failed to arrive is distinguishable from one that is
 *      legitimately zero, so the next mismatch — whatever causes it — shows up
 *      as *unavailable* rather than as a quiet day.
 *
 * The aggregation itself runs in Postgres and cannot be executed here, so the
 * counting rules are pinned as the clauses that carry them, the way
 * `invoice-verification-sql.test.ts` pins its function.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EMPTY_KPI_SUMMARY, buildKpiArgs, readKpiSummary, type OrdersKpiRequest } from "../kpi";

/** The migration that declares the function the client calls today. */
const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260830140000_orders_invoice_verification_filter.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The parameter names of the `CREATE ... FUNCTION orders_kpi_summary(...)` body. */
function declaredParameters(): string[] {
  const create = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.orders_kpi_summary"));
  const params = create.slice(create.indexOf("(") + 1, create.indexOf(") RETURNS"));
  return params
    .split(",")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name.startsWith("_"));
}

/** A fully unfiltered request — the page's opening state. */
const BASE: OrdersKpiRequest = {
  from: "2026-08-01",
  to: "2026-08-31",
  team: "all",
  agent: "all",
  status: "all",
  fulfillment: "all",
  verification: "all",
  mineOnly: false,
  starredOnly: false,
  userId: "1f0a5a3e-0000-4000-8000-000000000001",
  canFilterAgents: true,
  term: "",
  searching: false,
};

describe("buildKpiArgs — the contract with the SQL function", () => {
  it("sends only arguments the migration declares", () => {
    const declared = declaredParameters();
    // Sanity: the parse found a real signature, not an empty list that would
    // make the assertion below vacuously true.
    expect(declared).toContain("_from");
    expect(declared.length).toBe(10);

    for (const key of Object.keys(buildKpiArgs(BASE))) {
      expect(declared).toContain(key);
    }
  });

  it("sends every argument the migration declares", () => {
    // The other direction. A parameter with a SQL-side default that the client
    // stops sending is a filter silently dropped from the cards while the table
    // still applies it — a list and a total describing different sets of orders.
    expect(Object.keys(buildKpiArgs(BASE)).sort()).toEqual(declaredParameters().sort());
  });

  it("grants execute on the signature it declares", () => {
    // Ten argument types, or `authenticated` calls a function it may not run and
    // the cards go to zero for a different reason.
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.orders_kpi_summary\(\s*date, date, text, uuid, text, boolean, text, text, boolean, text\) TO authenticated;/,
    );
  });

  it("drops the superseded signature so the call cannot be ambiguous", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.orders_kpi_summary(");
    expect(sql).toContain("date, date, text, uuid, text, boolean, text, text, boolean);");
  });
});

describe("buildKpiArgs — the filters the cards narrow by", () => {
  it("passes the date range through as the list's own bounds", () => {
    const args = buildKpiArgs({ ...BASE, from: "2026-07-01", to: "2026-07-31" });
    expect(args._from).toBe("2026-07-01");
    expect(args._to).toBe("2026-07-31");
  });

  it("carries team, status, fulfillment, verification and starred", () => {
    const args = buildKpiArgs({
      ...BASE,
      team: "telesales",
      status: "Completed",
      fulfillment: "delivery",
      verification: "unverified",
      starredOnly: true,
    });
    expect(args._team).toBe("telesales");
    expect(args._status).toBe("Completed");
    expect(args._fulfillment).toBe("delivery");
    expect(args._verification).toBe("unverified");
    expect(args._starred).toBe(true);
  });

  it("sends an agent only when the caller may filter by agent", () => {
    const agent = "1f0a5a3e-0000-4000-8000-0000000000aa";
    expect(buildKpiArgs({ ...BASE, agent })._agent).toBe(agent);
    expect(buildKpiArgs({ ...BASE, agent, canFilterAgents: false })._agent).toBeNull();
    // "all" is not an id.
    expect(buildKpiArgs(BASE)._agent).toBeNull();
  });

  it("only claims 'mine' when there is a signed-in id to mean it", () => {
    expect(buildKpiArgs({ ...BASE, mineOnly: true })._mine).toBe(true);
    expect(buildKpiArgs({ ...BASE, mineOnly: true, userId: undefined })._mine).toBe(false);
    expect(buildKpiArgs(BASE)._mine).toBe(false);
  });

  it("sends the search term only while searching", () => {
    // The predicate treats a term and a date range as alternatives, so a term
    // left in place while not searching would silently widen the totals past the
    // selected day.
    expect(buildKpiArgs({ ...BASE, term: "3853", searching: true })._q).toBe("3853");
    expect(buildKpiArgs({ ...BASE, term: "3853", searching: false })._q).toBeNull();
  });
});

describe("readKpiSummary", () => {
  /** One filtered set, as the RPC returns it — `numeric` sums arrive as strings. */
  const payload = {
    cash_sales: "239355.62",
    cash_completed_sales: "211470.16",
    cash_count: 1111,
    cash_completed_count: 1030,
    was_sales: "775803.33",
    was_completed_sales: "768859.56",
    was_count: 2500,
    was_completed_count: 2445,
    total_sales: "1015158.95",
    total_completed_sales: "980329.72",
    total_count: 3611,
    completed_count: 3475,
  };

  it("reads the Cash card", () => {
    const s = readKpiSummary(payload)!;
    expect(s.cashCount).toBe(1111);
    expect(s.cashCompletedCount).toBe(1030);
    expect(s.cashSales).toBeCloseTo(239355.62, 2);
    expect(s.cashCompletedSales).toBeCloseTo(211470.16, 2);
  });

  it("reads the Wasfaty card", () => {
    const s = readKpiSummary(payload)!;
    expect(s.wasCount).toBe(2500);
    expect(s.wasCompletedCount).toBe(2445);
    expect(s.wasSales).toBeCloseTo(775803.33, 2);
    expect(s.wasCompletedSales).toBeCloseTo(768859.56, 2);
  });

  it("reads the Total card, which is the whole set and not Cash + Wasfaty", () => {
    const s = readKpiSummary(payload)!;
    expect(s.totalCount).toBe(3611);
    expect(s.completedCount).toBe(3475);
    expect(s.totalSales).toBeCloseTo(1015158.95, 2);
    expect(s.totalCompletedSales).toBeCloseTo(980329.72, 2);
    expect(s.totalCount).toBeGreaterThanOrEqual(s.cashCount + s.wasCount);
  });

  it("takes Total from the whole set rather than adding the two cards beside it", () => {
    // Every order in the payload above happens to be Cash or Wasfaty, so the two
    // readings agree there and the distinction would go unpinned. `order_type`
    // is a free `text` column: an order that is neither is still an order, still
    // in the list, and still owed a place in the Total card.
    const s = readKpiSummary({
      cash_count: 2,
      cash_sales: "100",
      was_count: 3,
      was_sales: "200",
      total_count: 6,
      total_sales: "350",
      completed_count: 4,
      total_completed_sales: "250",
    })!;
    expect(s.totalCount).toBe(6);
    expect(s.totalSales).toBeCloseTo(350, 2);
    expect(s.totalCount).toBeGreaterThan(s.cashCount + s.wasCount);
  });

  it("keeps completed a subset of total on every card", () => {
    const s = readKpiSummary(payload)!;
    expect(s.cashCompletedCount).toBeLessThanOrEqual(s.cashCount);
    expect(s.wasCompletedCount).toBeLessThanOrEqual(s.wasCount);
    expect(s.completedCount).toBeLessThanOrEqual(s.totalCount);
    expect(s.totalCompletedSales).toBeLessThanOrEqual(s.totalSales);
  });

  it("reads a genuinely empty filtered set as zeros", () => {
    // A day with no orders. COALESCE makes the sums 0 rather than NULL, and this
    // is the one case in which the cards are entitled to print 0.
    const empty = readKpiSummary({
      cash_sales: 0,
      cash_completed_sales: 0,
      cash_count: 0,
      cash_completed_count: 0,
      was_sales: 0,
      was_completed_sales: 0,
      was_count: 0,
      was_completed_count: 0,
      total_sales: 0,
      total_completed_sales: 0,
      total_count: 0,
      completed_count: 0,
    });
    expect(empty).toEqual(EMPTY_KPI_SUMMARY);
  });

  it("returns null for an answer that never arrived, rather than zeros", () => {
    // The regression, in one assertion. `undefined` is what react-query holds
    // while the RPC is erroring; turning it into zeros is what made a failed
    // query indistinguishable from an empty day.
    expect(readKpiSummary(undefined)).toBeNull();
    expect(readKpiSummary(null)).toBeNull();
  });

  it("does not let a value it cannot read become a plausible number", () => {
    const s = readKpiSummary({ ...payload, total_sales: "not a number" })!;
    expect(s.totalSales).toBe(0);
    expect(Number.isNaN(s.totalSales)).toBe(false);
  });
});

describe("orders_kpi_summary — the counting rules, as the SQL states them", () => {
  it("splits Cash and Wasfaty on order_type", () => {
    expect(sql).toContain("COUNT(*) FILTER (WHERE order_type = 'Cash')");
    expect(sql).toContain("COUNT(*) FILTER (WHERE order_type = 'Wasfaty')");
    expect(sql).toContain("SUM(invoice_value) FILTER (WHERE order_type = 'Cash')");
    expect(sql).toContain("SUM(invoice_value) FILTER (WHERE order_type = 'Wasfaty')");
  });

  it("counts Completed by status, per card and overall", () => {
    expect(sql).toContain("WHERE order_type = 'Cash' AND status = 'Completed'");
    expect(sql).toContain("WHERE order_type = 'Wasfaty' AND status = 'Completed'");
    expect(sql).toContain("COUNT(*) FILTER (WHERE status = 'Completed')");
    expect(sql).toContain("SUM(invoice_value) FILTER (WHERE status = 'Completed')");
  });

  it("sums invoice_value, and never reports NULL as an absent total", () => {
    expect(sql).toMatch(/'total_sales',\s+COALESCE\(SUM\(invoice_value\), 0\)/);
  });

  it("bounds the set by order_date unless a search term replaces the range", () => {
    expect(sql).toContain("o.order_date >= _from AND o.order_date <= _to");
  });

  it("returns the twelve keys the cards read, under the names they read them by", () => {
    for (const key of [
      "cash_sales",
      "cash_completed_sales",
      "cash_count",
      "cash_completed_count",
      "was_sales",
      "was_completed_sales",
      "was_count",
      "was_completed_count",
      "total_sales",
      "total_completed_sales",
      "total_count",
      "completed_count",
    ]) {
      expect(sql).toContain(`'${key}',`);
    }
  });
});
