/**
 * Every product on screen may show its offer, however many products there are.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * Branch Stock searches for `nan`, gets dozens of matches, and every row shows
 * the list price with no discount badge. Search for one product and the discount
 * is there. The boundary was **twelve**.
 *
 * `shamsGetOfferSummaries`'s input validator still carried `max(12)` from the
 * design that preceded the offer sweep, when each item was its own ~62 KB CRM
 * request. Under the sweep it is one indexed read of `shams_offer_products`, and
 * the function's own documentation said so — but the validator did not, so a
 * thirteenth product did not truncate the answer, it **rejected the whole
 * request**. The hook saw an error, `byItemCode` came back empty, and every row
 * in the result fell back to its catalogue price. Silently, on a call, about
 * money.
 *
 * ---------------------------------------------------------------------------
 * What is asserted, and why it is not a source-text check
 * ---------------------------------------------------------------------------
 * The bug was a validator disagreeing with its own comment, so a test that read
 * the source could not have caught it. Both halves are exercised for real
 * instead:
 *
 *   * the exact zod object the handler parses with, over set sizes either side
 *     of the old cap, and
 *   * the store read those codes reach, through the same PostgREST stand-in the
 *     rest of `offer-store.server.ts`'s tests use.
 *
 * `globalThis.fetch` is replaced with a throwing stub for the whole file, so the
 * "no runtime CRM request" rule is enforced by the test rather than asserted
 * about it: any code that reached for the network here would fail loudly.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* No network, at all                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The negative claim of the whole offer phase, made unfakeable.
 *
 * Offers are read from MilaPortal's own tables. Nothing on this path may contact
 * `shams-crm.cloud` — not once for the set, and certainly not once per product,
 * which is the fan-out the deleted cap existed to prevent.
 */
const realFetch = globalThis.fetch;
const fetchSpy = vi.fn(() => {
  throw new Error("a network request was made while reading local offer data");
});
globalThis.fetch = fetchSpy as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* A chainable stand-in for the PostgREST client                               */
/* -------------------------------------------------------------------------- */

interface Recorded {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filters: { kind: string; column: string; value: unknown }[];
}

const calls: Recorded[] = [];
const selectResults = new Map<string, { data: unknown; error: unknown }>();

function builder(record: Recorded) {
  const result = () =>
    selectResults.get(record.table) ?? { data: record.op === "select" ? [] : null, error: null };

  const chain: Record<string, unknown> = {
    select() {
      record.op = "select";
      return chain;
    },
    update() {
      record.op = "update";
      return chain;
    },
    eq(column: string, value: unknown) {
      record.filters.push({ kind: "eq", column, value });
      return chain;
    },
    in(column: string, value: unknown) {
      record.filters.push({ kind: "in", column, value });
      return chain;
    },
    maybeSingle: () => Promise.resolve(result()),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const record: Recorded = { table, op: "select", filters: [] };
      calls.push(record);
      return builder(record);
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

const store = await import("@/lib/shams/offer-store.server");
const { MAX_OFFER_SUMMARY_ITEMS, offerScopesInput } = await import("@/lib/shams.functions");

beforeEach(() => {
  calls.length = 0;
  selectResults.clear();
  fetchSpy.mockClear();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const code = (i: number) => `104${String(i).padStart(5, "0")}`;

/** A product whose discount is unanimous across every stocking branch. */
function globalOfferRow(itemCode: string) {
  return {
    item_code: itemCode,
    scope: "all",
    branches_available: 40,
    branches_with_offer: 40,
    offer_display: "20.00%",
    unit_price: "60.62",
    offer_price: "48.50",
  };
}

/** A product on offer at some branches only. Coverage, never a single price. */
function branchVaryingOfferRow(itemCode: string) {
  return {
    item_code: itemCode,
    scope: "some",
    branches_available: 40,
    branches_with_offer: 3,
    offer_display: "20.00%",
    unit_price: null,
    offer_price: null,
  };
}

/** A product the sweep checked and found no promotion on. */
function checkedNoOfferRow(itemCode: string) {
  return {
    item_code: itemCode,
    scope: "none",
    branches_available: 40,
    branches_with_offer: 0,
    offer_display: null,
    unit_price: null,
    offer_price: null,
  };
}

/* -------------------------------------------------------------------------- */
/* The boundary the bug lived on                                               */
/* -------------------------------------------------------------------------- */

describe("the offer lookup accepts a whole result set", () => {
  /**
   * One, twelve, thirteen, twenty, and a full search page.
   *
   * Thirteen is the case that used to fail, and it is the only reason the others
   * are here: a cap is only visible as the difference between the size below it
   * and the size above it.
   */
  for (const size of [1, 12, 13, 20, 100, MAX_OFFER_SUMMARY_ITEMS]) {
    it(`accepts ${size} item code${size === 1 ? "" : "s"}`, () => {
      const itemCodes = Array.from({ length: size }, (_, i) => code(i));
      expect(offerScopesInput.parse({ itemCodes }).itemCodes).toHaveLength(size);
    });
  }

  it("still refuses an empty set and a pathological one", () => {
    // A cap remains, and it bounds a request nobody's search can produce. What
    // it may never do again is reject a set a real search can.
    expect(() => offerScopesInput.parse({ itemCodes: [] })).toThrow();
    expect(() =>
      offerScopesInput.parse({
        itemCodes: Array.from({ length: MAX_OFFER_SUMMARY_ITEMS + 1 }, (_, i) => code(i)),
      }),
    ).toThrow();
  });

  /**
   * The validator's ceiling and the store's must be the same number.
   *
   * `fetchOfferSummaries` slices at `MAX_OFFER_LOOKUP_ITEMS`. A validator that
   * admitted more would hand back a partial map, and an item missing from that
   * map is rendered as *not checked* — which is exactly the silent wrong answer
   * this whole file exists to prevent. They cannot be one constant: this module
   * ships to the browser bundle and the store does not.
   */
  it("caps at the same number the store reads up to", () => {
    expect(MAX_OFFER_SUMMARY_ITEMS).toBe(store.MAX_OFFER_LOOKUP_ITEMS);
  });
});

/* -------------------------------------------------------------------------- */
/* What the store does with those codes                                        */
/* -------------------------------------------------------------------------- */

describe("a large result set costs one local read", () => {
  it("answers 20 products in a single indexed query, and asks Shams nothing", async () => {
    const itemCodes = Array.from({ length: 20 }, (_, i) => code(i));
    selectResults.set("shams_offer_products", {
      data: itemCodes.map(globalOfferRow),
      error: null,
    });

    const summaries = await store.fetchOfferSummaries(itemCodes);

    expect(summaries.size).toBe(20);
    // One query for the set. Twenty would be the N+1 the cap was guarding.
    expect(calls.filter((c) => c.table === "shams_offer_products")).toHaveLength(1);
    expect(calls[0].filters).toEqual([{ kind: "in", column: "item_code", value: itemCodes }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("carries the price pair on every row of a 100-product set", async () => {
    const itemCodes = Array.from({ length: 100 }, (_, i) => code(i));
    selectResults.set("shams_offer_products", {
      data: itemCodes.map(globalOfferRow),
      error: null,
    });

    const summaries = await store.fetchOfferSummaries(itemCodes);

    expect(summaries.size).toBe(100);
    for (const itemCode of itemCodes) {
      const summary = summaries.get(itemCode);
      expect(summary?.unitPrice).toBe(60.62);
      expect(summary?.offerPrice).toBe(48.5);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* A mixed set keeps every distinction                                         */
/* -------------------------------------------------------------------------- */

describe("a mixed result set says a different thing about each product", () => {
  /**
   * Four kinds in one answer, above the old cap, all four still distinct.
   *
   * The one that matters most is the last: an item with **no row** is not "no
   * offer". Collapsing the two would tell an agent a promotion does not exist
   * when the sweep has simply not reached the product yet.
   */
  it("keeps global, branch-varying, checked-and-none, and unswept apart", async () => {
    const global = code(1);
    const varying = code(2);
    const none = code(3);
    const unswept = code(4);
    // Padded past twelve so the set is one the old validator would have refused
    // outright — the mixture has to survive at search scale, not just in miniature.
    const padding = Array.from({ length: 16 }, (_, i) => code(100 + i));

    selectResults.set("shams_offer_products", {
      data: [
        globalOfferRow(global),
        branchVaryingOfferRow(varying),
        checkedNoOfferRow(none),
        ...padding.map(checkedNoOfferRow),
      ],
      error: null,
    });

    const summaries = await store.fetchOfferSummaries([global, varying, none, unswept, ...padding]);

    expect(summaries.get(global)).toMatchObject({
      scope: "all",
      unitPrice: 60.62,
      offerPrice: 48.5,
    });

    /*
     * The correctness rule the cap's removal must not trample.
     *
     * A discount that reaches only 3 of 40 branches has no single price. The
     * badge still renders — an agent should know a promotion exists — but the
     * row shows the catalogue price, because a product-level figure would be
     * wrong at 37 branches.
     */
    expect(summaries.get(varying)).toMatchObject({
      scope: "some",
      branchesWithOffer: 3,
      unitPrice: null,
      offerPrice: null,
    });

    expect(summaries.get(none)).toMatchObject({ scope: "none", offerDisplay: null });

    // Absent, not `none`.
    expect(summaries.has(unswept)).toBe(false);

    expect(calls.filter((c) => c.table === "shams_offer_products")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A dataset that cannot be read is not a dataset with no offers.
   *
   * Unchanged by this fix and asserted beside it, because raising the cap makes
   * this path reachable for far larger sets: a failure that flattened to an
   * empty map would now quote list prices across a hundred rows at once.
   */
  it("raises rather than reporting a hundred products as offer-free", async () => {
    selectResults.set("shams_offer_products", { data: null, error: { code: "PGRST301" } });
    await expect(
      store.fetchOfferSummaries(Array.from({ length: 100 }, (_, i) => code(i))),
    ).rejects.toThrow(store.ShamsOfferStoreError);
  });
});
