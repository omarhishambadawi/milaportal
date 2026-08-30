/**
 * The Invoice Verification filter, and the order-number search.
 *
 * Both are small, and both have one case that is easy to get wrong and silent
 * when you do:
 *
 *   * `orders.invoices_verified` is **nullable**. An order the MIS has not
 *     answered for holds NULL, not false, so `NOT invoices_verified` and
 *     `invoices_verified = false` both evaluate to NULL — and *Non verified*
 *     would return none of the orders it exists to show. Every layer has to
 *     spell the negative as "is not true".
 *   * `display_no` stores `3853` while the app prints `CC-3853`, so the string
 *     an agent copies out of the app is not the string the column holds.
 *
 * Three implementations have to agree about the first: the predicate here, the
 * PostgREST filter the table and the export narrow with, and the SQL the KPI
 * cards aggregate through. This suite is what keeps them agreeing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatOrderNo } from "@/lib/branches";
import { VERIFICATION_OPTIONS, matchesVerification } from "../verification";
import { applyOrderFilters, toSearchTerm, type OrderFilterState } from "../utils";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260830140000_orders_invoice_verification_filter.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** The three states the column can be in. */
const VERIFIED = { invoices_verified: true };
const NOT_VERIFIED = { invoices_verified: false };
/** Never written — the majority of a fresh day's orders. */
const NEVER_ANSWERED = { invoices_verified: null };

describe("VERIFICATION_OPTIONS", () => {
  it("offers exactly the three options the page asks for, in order", () => {
    expect(VERIFICATION_OPTIONS.map((o) => o.value)).toEqual(["all", "verified", "unverified"]);
    expect(VERIFICATION_OPTIONS.map((o) => o.label)).toEqual([
      "All invoices",
      "Verified",
      "Non verified",
    ]);
  });
});

describe("matchesVerification", () => {
  it("passes everything when the filter is off", () => {
    for (const order of [VERIFIED, NOT_VERIFIED, NEVER_ANSWERED]) {
      expect(matchesVerification("all", order)).toBe(true);
    }
  });

  it("selects only verified invoices", () => {
    expect(matchesVerification("verified", VERIFIED)).toBe(true);
    expect(matchesVerification("verified", NOT_VERIFIED)).toBe(false);
    expect(matchesVerification("verified", NEVER_ANSWERED)).toBe(false);
  });

  it("treats a never-written flag as not verified", () => {
    // The case that makes the whole filter useful, and the one a `= false`
    // implementation drops.
    expect(matchesVerification("unverified", NEVER_ANSWERED)).toBe(true);
    expect(matchesVerification("unverified", NOT_VERIFIED)).toBe(true);
    expect(matchesVerification("unverified", VERIFIED)).toBe(false);
  });

  it("splits every order into exactly one of the two states", () => {
    for (const order of [VERIFIED, NOT_VERIFIED, NEVER_ANSWERED]) {
      const hits = ["verified", "unverified"].filter((v) => matchesVerification(v, order));
      expect(hits).toHaveLength(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The PostgREST predicate                                                     */
/* -------------------------------------------------------------------------- */

/** Records the PostgREST calls a filter makes, in order. */
function recorder() {
  const calls: string[] = [];
  const qb: any = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push(`${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
          return qb;
        },
    },
  );
  return { qb, calls };
}

function filterState(overrides: Partial<OrderFilterState> = {}): OrderFilterState {
  return {
    searching: false,
    from: "2026-08-01",
    to: "2026-08-08",
    team: "all",
    status: "all",
    mineOnly: false,
    userId: undefined,
    canFilterAgents: false,
    agent: "all",
    term: "",
    fulfillment: "all",
    verification: "all",
    starredOnly: false,
    starredIds: [],
    ...overrides,
  };
}

describe("applyOrderFilters — Invoice Verification", () => {
  const verificationCalls = (verification: string) => {
    const { qb, calls } = recorder();
    applyOrderFilters(qb, filterState({ verification }));
    return calls.filter((c) => c.includes("invoices_verified"));
  };

  it("does not touch the column when the filter is off", () => {
    expect(verificationCalls("all")).toEqual([]);
  });

  it("selects verified and non-verified as true complements", () => {
    expect(verificationCalls("verified")).toEqual(['is("invoices_verified",true)']);
    // `not(col, is, true)` rather than `eq(col, false)` or `neq(col, true)`:
    // only this spelling keeps the NULL rows, and they are most of the answer.
    expect(verificationCalls("unverified")).toEqual(['not("invoices_verified","is",true)']);
  });

  it("composes with every other filter rather than replacing them", () => {
    // The guarantee the feature is judged on: status + team + agent + date +
    // fulfillment + starred + verification is all of them, ANDed.
    const { qb, calls } = recorder();
    applyOrderFilters(
      qb,
      filterState({
        team: "telesales",
        status: "Completed",
        canFilterAgents: true,
        agent: "agent-1",
        fulfillment: "pickup",
        verification: "verified",
        starredOnly: true,
        starredIds: ["a"],
      }),
    );
    expect(calls).toEqual([
      'gte("order_date","2026-08-01")',
      'lte("order_date","2026-08-08")',
      'eq("team","telesales")',
      'eq("status","Completed")',
      'eq("agent_id","agent-1")',
      'in("id",["a"])',
      'ilike("delivery_type","%pickup%")',
      'is("invoices_verified",true)',
    ]);
  });

  it("still applies while searching, where the date range is dropped", () => {
    // Search and filters work together: a search widens the window to every
    // date, and the verification filter still narrows it.
    const { qb, calls } = recorder();
    applyOrderFilters(
      qb,
      filterState({ searching: true, term: "3853", verification: "unverified" }),
    );
    expect(calls.some((c) => c.startsWith("gte("))).toBe(false);
    expect(calls).toContain('not("invoices_verified","is",true)');
    expect(calls.some((c) => c.startsWith("or("))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The order-number search                                                     */
/* -------------------------------------------------------------------------- */

describe("toSearchTerm", () => {
  it("finds an order from either spelling of its number", () => {
    // The requirement, in one assertion: all three reach the same query.
    expect(toSearchTerm("3853")).toBe("3853");
    expect(toSearchTerm("cc-3853")).toBe("3853");
    expect(toSearchTerm("CC-3853")).toBe("3853");
  });

  it("round-trips whatever formatOrderNo prints", () => {
    // Anything the app displays as an order number can be pasted straight back
    // into the search box. Both teams, both prefixes.
    for (const team of ["customer_care", "telesales"]) {
      expect(toSearchTerm(formatOrderNo(team, "3853"))).toBe("3853");
    }
  });

  it("accepts the other spellings the same helper already strips", () => {
    expect(toSearchTerm("ts-3853")).toBe("3853");
    expect(toSearchTerm("TS-3853")).toBe("3853");
    expect(toSearchTerm("#3853")).toBe("3853");
    expect(toSearchTerm("  CC-3853  ")).toBe("3853");
  });

  it("leaves every other search exactly as it was", () => {
    // The narrowness is the point: only a prefix followed by digits is
    // rewritten, so no existing search changes behaviour.
    expect(toSearchTerm("Ahmed")).toBe("Ahmed");
    expect(toSearchTerm("0551234567")).toBe("0551234567");
    expect(toSearchTerm("CC Pharmacy")).toBe("CC Pharmacy");
    // A prefix on something that is not a number is a customer, not an order.
    expect(toSearchTerm("cc-pharmacy")).toBe("cc-pharmacy");
    // And the existing normalisation still runs.
    expect(toSearchTerm("  ahmed   ali  ")).toBe("ahmed ali");
    expect(toSearchTerm("a,b")).toBe("a b");
  });
});

/* -------------------------------------------------------------------------- */
/* The SQL mirror                                                              */
/* -------------------------------------------------------------------------- */

describe("orders_kpi_summary — the verification branch", () => {
  it("takes the filter as a parameter with a default, so older callers still work", () => {
    expect(sql).toMatch(/_verification\s+text\s+DEFAULT\s+'all'/);
  });

  it("answers the same three cases as matchesVerification", () => {
    expect(sql).toContain("_verification = 'all'");
    expect(sql).toContain("_verification = 'verified'   AND o.invoices_verified IS TRUE");
    expect(sql).toContain("_verification = 'unverified' AND o.invoices_verified IS NOT TRUE");
  });

  it("never writes a negative a NULL flag would fall out of", () => {
    // `NOT o.invoices_verified` and `o.invoices_verified = false` both drop the
    // never-answered rows. Neither may appear.
    expect(sql).not.toMatch(/NOT\s+o\.invoices_verified\b/);
    expect(sql).not.toMatch(/o\.invoices_verified\s*=\s*false/i);
    expect(sql).not.toMatch(/o\.invoices_verified\s*<>\s*true/i);
  });

  it("drops both superseded signatures, so no call can be ambiguous", () => {
    // The 9-argument original, and the 11-argument one a reverted attempt at
    // this feature may already have applied to a database.
    expect(sql).toContain("date, date, text, uuid, text, boolean, text, text, boolean)");
    expect(sql).toContain(
      "date, date, text, uuid, text, boolean, text, text, boolean, text, uuid[])",
    );
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.orders_kpi_summary\(/);
  });
});
