/**
 * The Invoice Verification filter.
 *
 * Three implementations have to agree about what "verified" selects — the row's
 * Call Centre column (`callCentreState`), the PostgREST predicate the table and
 * the export narrow with (`applyOrderFilters`), and the SQL the KPI cards
 * aggregate through (`orders_kpi_summary`). This suite is what keeps them
 * agreeing: a table of orders, the state each one is in, and the assertion that
 * every layer puts it in the same bucket.
 *
 * The thing most worth pinning is the **null** handling. `invoices_verified` is
 * nullable and `NOT NULL` is NULL, not true, so the natural spelling of *Not
 * verified* silently drops every order the MIS has never answered for — which is
 * the majority of them, and exactly the set the filter is being asked for. That
 * is the same three-valued-logic trap the fulfillment filter carries a
 * paragraph about; it is stated once per layer here so it cannot come back in
 * only one of them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { callCentreState } from "../components/call-centre-cell";
import {
  VERIFICATION_OPTIONS,
  isVerificationFilter,
  matchesVerification,
  verificationLabel,
} from "../verification";
import { applyOrderFilters, type OrderFilterState } from "../utils";

const sql = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../supabase/migrations/20260830120000_orders_invoice_verification_filter.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

/** Every state an order's two flags can be in, and what each one means. */
const ORDERS = {
  /** The MIS has not answered yet. Ordinary — most orders are here for hours. */
  pending: { invoices_verified: false, call_center_verified: false },
  /** Never written at all, which has to mean the same as `false`. */
  neverTouched: { invoices_verified: null, call_center_verified: null },
  /** Verified, and the document was raised through the call centre. */
  callCentre: { invoices_verified: true, call_center_verified: true },
  /** Verified, and it was not. The one worth noticing. */
  walkIn: { invoices_verified: true, call_center_verified: false },
} as const;

describe("matchesVerification", () => {
  it("passes everything when the filter is off", () => {
    for (const order of Object.values(ORDERS)) {
      expect(matchesVerification("all", order)).toBe(true);
    }
  });

  it("splits verified from not verified", () => {
    expect(matchesVerification("verified", ORDERS.callCentre)).toBe(true);
    expect(matchesVerification("verified", ORDERS.walkIn)).toBe(true);
    expect(matchesVerification("verified", ORDERS.pending)).toBe(false);
    expect(matchesVerification("verified", ORDERS.neverTouched)).toBe(false);

    expect(matchesVerification("pending", ORDERS.pending)).toBe(true);
    // The case the SQL spelling gets wrong: a NULL flag is "not verified", not
    // "excluded from both answers".
    expect(matchesVerification("pending", ORDERS.neverTouched)).toBe(true);
    expect(matchesVerification("pending", ORDERS.callCentre)).toBe(false);
    expect(matchesVerification("pending", ORDERS.walkIn)).toBe(false);
  });

  it("splits the verified half by channel", () => {
    expect(matchesVerification("call_centre", ORDERS.callCentre)).toBe(true);
    expect(matchesVerification("call_centre", ORDERS.walkIn)).toBe(false);
    expect(matchesVerification("call_centre", ORDERS.neverTouched)).toBe(false);

    expect(matchesVerification("non_call_centre", ORDERS.walkIn)).toBe(true);
    expect(matchesVerification("non_call_centre", ORDERS.callCentre)).toBe(false);
    // Not-yet-verified is not "not a call centre order" — it is no answer at
    // all. Without the `invoices_verified` half of the predicate this option
    // would return the whole unverified backlog.
    expect(matchesVerification("non_call_centre", ORDERS.pending)).toBe(false);
    expect(matchesVerification("non_call_centre", ORDERS.neverTouched)).toBe(false);
  });

  it("selects the same orders the row's column paints", () => {
    // The filter and the column are the same reading of the same two flags. If
    // they ever diverge, an agent filtering to "Non Call Centre" gets rows whose
    // own glyph says something else.
    expect(callCentreState(ORDERS.callCentre)).toBe("verified");
    expect(callCentreState(ORDERS.walkIn)).toBe("walk_in");
    expect(callCentreState(ORDERS.pending)).toBe("pending");
    expect(callCentreState(ORDERS.neverTouched)).toBe("pending");

    const bucket = (o: Record<string, unknown>) =>
      (["verified", "pending", "call_centre", "non_call_centre"] as const).filter((v) =>
        matchesVerification(v, o),
      );
    expect(bucket(ORDERS.callCentre)).toEqual(["verified", "call_centre"]);
    expect(bucket(ORDERS.walkIn)).toEqual(["verified", "non_call_centre"]);
    expect(bucket(ORDERS.pending)).toEqual(["pending"]);
    expect(bucket(ORDERS.neverTouched)).toEqual(["pending"]);
  });
});

describe("VERIFICATION_OPTIONS", () => {
  it("offers exactly the values the predicate answers for", () => {
    expect(VERIFICATION_OPTIONS.map((o) => o.value)).toEqual([
      "all",
      "verified",
      "pending",
      "call_centre",
      "non_call_centre",
    ]);
    for (const option of VERIFICATION_OPTIONS) {
      expect(isVerificationFilter(option.value)).toBe(true);
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
    expect(isVerificationFilter("cancelled")).toBe(false);
  });

  it("names the active selection", () => {
    expect(verificationLabel("non_call_centre")).toBe("Non Call Centre");
    // An unknown value is the unfiltered label rather than a blank trigger.
    expect(verificationLabel("nonsense")).toBe("Any verification");
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
    searchAgentIds: [],
    ...overrides,
  };
}

describe("applyOrderFilters — Invoice Verification", () => {
  const verificationCalls = (verification: string) => {
    const { qb, calls } = recorder();
    applyOrderFilters(qb, filterState({ verification }));
    return calls.filter((c) => c.includes("verified"));
  };

  it("does not touch the flags when the filter is off", () => {
    expect(verificationCalls("all")).toEqual([]);
  });

  it("selects verified and unverified as complements", () => {
    expect(verificationCalls("verified")).toEqual(['is("invoices_verified",true)']);
    // `not(col, is, true)` rather than `eq(col, false)` or `neq(col, true)`:
    // only this spelling keeps the NULL rows, and they are most of the answer.
    expect(verificationCalls("pending")).toEqual(['not("invoices_verified","is",true)']);
  });

  it("selects the channel split", () => {
    expect(verificationCalls("call_centre")).toEqual(['is("call_center_verified",true)']);
    expect(verificationCalls("non_call_centre")).toEqual([
      'is("invoices_verified",true)',
      'not("call_center_verified","is",true)',
    ]);
  });

  it("composes with every other filter rather than replacing them", () => {
    // The guarantee the feature is judged on: Status + Branch-ish + Delivery +
    // Starred + Verification is all of them, ANDed, not the last one to win.
    const { qb, calls } = recorder();
    applyOrderFilters(
      qb,
      filterState({
        status: "Completed",
        team: "telesales",
        fulfillment: "pickup",
        verification: "non_call_centre",
        starredOnly: true,
        starredIds: ["a"],
        mineOnly: true,
        userId: "u",
      }),
    );
    expect(calls).toEqual([
      'gte("order_date","2026-08-01")',
      'lte("order_date","2026-08-08")',
      'eq("team","telesales")',
      'eq("status","Completed")',
      'eq("agent_id","u")',
      'in("id",["a"])',
      'ilike("delivery_type","%pickup%")',
      'is("invoices_verified",true)',
      'not("call_center_verified","is",true)',
    ]);
  });

  it("still applies while searching, where the date range is dropped", () => {
    // Search and filters work together: typing a customer's name widens the
    // window to every date, and the verification filter still narrows it.
    const { qb, calls } = recorder();
    applyOrderFilters(
      qb,
      filterState({ searching: true, term: "ahmed", verification: "verified" }),
    );
    expect(calls.some((c) => c.startsWith("gte("))).toBe(false);
    expect(calls).toContain('is("invoices_verified",true)');
    expect(calls.some((c) => c.startsWith("or("))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The SQL mirror                                                              */
/* -------------------------------------------------------------------------- */

describe("orders_kpi_summary — the verification branch", () => {
  it("takes the filter as a parameter with a default, so old callers still work", () => {
    expect(sql).toMatch(/_verification\s+text\s+DEFAULT\s+'all'/);
    expect(sql).toMatch(/_agent_ids\s+uuid\[\]\s+DEFAULT\s+NULL/);
  });

  it("answers the same four cases as matchesVerification", () => {
    expect(sql).toContain("_verification = 'all'");
    expect(sql).toContain("_verification = 'verified'        AND o.invoices_verified IS TRUE");
    expect(sql).toContain("_verification = 'pending'         AND o.invoices_verified IS NOT TRUE");
    expect(sql).toContain("_verification = 'call_centre'     AND o.call_center_verified IS TRUE");
    expect(sql).toContain("_verification = 'non_call_centre' AND o.invoices_verified IS TRUE");
    expect(sql).toContain("AND o.call_center_verified IS NOT TRUE");
  });

  it("never writes a negative that a NULL flag would fall out of", () => {
    // `NOT o.invoices_verified` and `o.invoices_verified = false` both drop the
    // never-verified rows. Neither may appear.
    expect(sql).not.toMatch(/NOT\s+o\.invoices_verified\b/);
    expect(sql).not.toMatch(/o\.invoices_verified\s*=\s*false/i);
    expect(sql).not.toMatch(/o\.call_center_verified\s*<>\s*true/i);
  });

  it("runs the agent branch of the search the table runs", () => {
    expect(sql).toContain("_agent_ids IS NOT NULL AND o.agent_id = ANY(_agent_ids)");
  });

  it("drops the old signature so a call cannot be ambiguous between the two", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.orders_kpi_summary(");
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.orders_kpi_summary\(/);
    expect(sql).toContain(
      "date, date, text, uuid, text, boolean, text, text, boolean, text, uuid[]",
    );
  });
});
