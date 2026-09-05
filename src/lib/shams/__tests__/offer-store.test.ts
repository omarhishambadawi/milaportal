/**
 * The local offer dataset's contract with Postgres.
 *
 * Two halves, and both are worth pinning without a database.
 *
 * **Reads.** What comes back over PostgREST is not quite what the application
 * uses: `numeric` arrives as a string when it will not fit a double, a scope is
 * a bare text column, and a price pair is meaningless unless both halves are
 * present. The mapping is small and the failure it prevents is not — a row that
 * lost half its price pair on the way out would put a discounted figure on a
 * screen with nothing to compare it against.
 *
 * **Writes.** The staging shape and the promotion's arguments are the interface
 * between this module and `shams_promote_offers`. A test cannot run the RPC, but
 * it can assert that the rows handed to it carry the columns the function reads
 * and that the cursor and completion flag it is told about are the ones the
 * sweep decided — which is where a partial sweep would go wrong silently.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* A chainable stand-in for the PostgREST client                               */
/* -------------------------------------------------------------------------- */

interface Recorded {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  columns?: string;
  rows?: Record<string, unknown>[];
  values?: Record<string, unknown>;
  filters: { kind: string; column: string; value: unknown }[];
}

const calls: Recorded[] = [];
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

/** What the next `select` resolves to, keyed by table. */
const selectResults = new Map<string, { data: unknown; error: unknown }>();
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };

function builder(record: Recorded) {
  const result = () =>
    selectResults.get(record.table) ?? { data: record.op === "select" ? [] : null, error: null };

  const chain: Record<string, unknown> = {
    select(columns: string) {
      record.op = "select";
      record.columns = columns;
      return chain;
    },
    insert(rows: Record<string, unknown>[]) {
      record.op = "insert";
      record.rows = rows;
      return chain;
    },
    update(values: Record<string, unknown>) {
      record.op = "update";
      record.values = values;
      return chain;
    },
    delete() {
      record.op = "delete";
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
    // The builder is awaited directly in most call sites, and `.then(a, b)` is
    // used for the best-effort staging cleanup.
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
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  },
}));

const store = await import("@/lib/shams/offer-store.server");

const find = (table: string, op?: Recorded["op"]) =>
  calls.find((c) => c.table === table && (op === undefined || c.op === op));

beforeEach(() => {
  calls.length = 0;
  rpcCalls.length = 0;
  selectResults.clear();
  rpcResult = { data: null, error: null };
});

/* -------------------------------------------------------------------------- */
/* Looking an item up                                                          */
/* -------------------------------------------------------------------------- */

describe("offer lookup by item code", () => {
  it("reads a whole result set in one indexed query", async () => {
    selectResults.set("shams_offer_products", { data: [], error: null });

    await store.fetchOfferSummaries(["1", "2", "3"]);

    const read = find("shams_offer_products", "select");
    expect(read?.filters).toEqual([{ kind: "in", column: "item_code", value: ["1", "2", "3"] }]);
    // One query, not one per code — the whole point of the phase.
    expect(calls.filter((c) => c.table === "shams_offer_products")).toHaveLength(1);
  });

  it("deduplicates, trims and bounds the codes it asks about", async () => {
    selectResults.set("shams_offer_products", { data: [], error: null });

    await store.fetchOfferSummaries([" 1 ", "1", "", "2"]);

    expect(find("shams_offer_products")?.filters[0].value).toEqual(["1", "2"]);
  });

  it("asks nothing at all for an empty set", async () => {
    expect((await store.fetchOfferSummaries([])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("returns a global offer with its product-level price pair", async () => {
    selectResults.set("shams_offer_products", {
      data: [
        {
          item_code: "1",
          scope: "all",
          branches_available: 40,
          branches_with_offer: 40,
          offer_display: "20.00%",
          // PostgREST hands `numeric` back as a string when it will not fit a
          // double; both shapes have to survive the mapping.
          unit_price: "60.62",
          offer_price: 48.5,
        },
      ],
      error: null,
    });

    const summary = (await store.fetchOfferSummaries(["1"])).get("1");

    expect(summary).toEqual({
      itemCode: "1",
      scope: "all",
      branchesAvailable: 40,
      branchesWithOffer: 40,
      offerDisplay: "20.00%",
      unitPrice: 60.62,
      offerPrice: 48.5,
    });
  });

  it("returns a branch-specific offer with no product-level price", async () => {
    selectResults.set("shams_offer_products", {
      data: [
        {
          item_code: "1",
          scope: "some",
          branches_available: 40,
          branches_with_offer: 3,
          offer_display: "20.00%",
          unit_price: null,
          offer_price: null,
        },
      ],
      error: null,
    });

    const summary = (await store.fetchOfferSummaries(["1"])).get("1");

    expect(summary?.scope).toBe("some");
    expect(summary?.offerPrice).toBeNull();
    expect(summary?.unitPrice).toBeNull();
  });

  it("never returns half a price pair", async () => {
    // The table's own CHECK enforces this; the mapping restates it so a row
    // written before the constraint existed cannot reach a browser as half a
    // pair and invite the wrong subtraction.
    selectResults.set("shams_offer_products", {
      data: [
        {
          item_code: "1",
          scope: "all",
          branches_available: 1,
          branches_with_offer: 1,
          offer_display: "20.00%",
          unit_price: "60.62",
          offer_price: null,
        },
      ],
      error: null,
    });

    const summary = (await store.fetchOfferSummaries(["1"])).get("1");
    expect(summary?.unitPrice).toBeNull();
    expect(summary?.offerPrice).toBeNull();
  });

  it("leaves an unswept item out of the map entirely", async () => {
    selectResults.set("shams_offer_products", { data: [], error: null });
    const summaries = await store.fetchOfferSummaries(["1"]);
    // Absent, not `none`. The caller renders that as `unknown`, and the two must
    // never be collapsed.
    expect(summaries.has("1")).toBe(false);
  });

  it("raises rather than reporting no offers when the table cannot be read", async () => {
    selectResults.set("shams_offer_products", { data: null, error: { code: "PGRST301" } });
    // "No offers on these products" and "the dataset is unreachable" lead to
    // opposite decisions, and an agent shown the first during an incident quotes
    // full price on a discounted item.
    await expect(store.fetchOfferSummaries(["1"])).rejects.toThrow(store.ShamsOfferStoreError);
  });
});

/* -------------------------------------------------------------------------- */
/* Branch rows                                                                 */
/* -------------------------------------------------------------------------- */

describe("branch offer lookup", () => {
  it("reads one item's branches by item code", async () => {
    selectResults.set("shams_offers", { data: [], error: null });
    await store.fetchBranchOffers("10400746");
    expect(find("shams_offers")?.filters).toEqual([
      { kind: "eq", column: "item_code", value: "10400746" },
    ]);
  });

  it("maps a branch row to the shape the table renders", async () => {
    selectResults.set("shams_offers", {
      data: [
        {
          item_code: "1",
          branch_code: "P0221",
          price: "60.620",
          offer_percent: "20.000",
          offer_display: "20.00%",
          after_offer_price: "48.500",
        },
      ],
      error: null,
    });

    expect(await store.fetchBranchOffers("1")).toEqual([
      {
        itemCode: "1",
        branchCode: "P0221",
        price: 60.62,
        offerPercent: 20,
        offerDisplay: "20.00%",
        afterOfferPrice: 48.5,
      },
    ]);
  });

  it("drops a row that cannot state a real discount", async () => {
    // The same rule `normalizeOffers` applies at the CRM boundary. Nothing the
    // UI could render as "0% off" may reach it.
    selectResults.set("shams_offers", {
      data: [
        {
          item_code: "1",
          branch_code: "P0001",
          price: 10,
          offer_percent: 0,
          offer_display: "0%",
          after_offer_price: 10,
        },
        {
          item_code: "1",
          branch_code: "P0002",
          price: 10,
          offer_percent: null,
          offer_display: "x",
          after_offer_price: 9,
        },
        {
          item_code: "1",
          branch_code: "P0003",
          price: null,
          offer_percent: 5,
          offer_display: "5%",
          after_offer_price: 9,
        },
      ],
      error: null,
    });

    expect(await store.fetchBranchOffers("1")).toEqual([]);
  });

  it("asks nothing for a blank item code", async () => {
    expect(await store.fetchBranchOffers("  ")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("raises when the table cannot be read", async () => {
    selectResults.set("shams_offers", { data: null, error: { code: "PGRST301" } });
    await expect(store.fetchBranchOffers("1")).rejects.toThrow(store.ShamsOfferStoreError);
  });
});

/* -------------------------------------------------------------------------- */
/* Staging and promotion                                                       */
/* -------------------------------------------------------------------------- */

const item = (itemCode: string, overrides: Record<string, unknown> = {}) => ({
  summary: {
    itemCode,
    scope: "all" as const,
    branchesAvailable: 2,
    branchesWithOffer: 2,
    offerDisplay: "20.00%",
    unitPrice: 60.62,
    offerPrice: 48.5,
    ...overrides,
  },
  offers: [
    {
      itemCode,
      branchCode: "P0221",
      price: 60.62,
      offerPercent: 20,
      offerDisplay: "20.00%",
      afterOfferPrice: 48.5,
    },
  ],
});

describe("promoting a slice", () => {
  beforeEach(() => {
    rpcResult = {
      data: {
        items: 1,
        inserted: 1,
        updated: 0,
        deleted: 0,
        summariesChanged: 1,
        changed: 2,
        offerRows: 1,
        productRows: 1,
        itemsWithOffers: 1,
        sweepComplete: false,
      },
      error: null,
    };
  });

  it("stages a verdict for every covered item and a row for every offer", async () => {
    await store.promoteOfferSlice([item("1"), item("2")], {
      cursor: "2",
      sweepComplete: false,
    });

    const verdicts = find("shams_offer_products_staging", "insert");
    const branchRows = find("shams_offers_staging", "insert");

    expect(verdicts?.rows).toHaveLength(2);
    expect(branchRows?.rows).toHaveLength(2);
    // Every staged row carries the batch, which is the only thing the promotion
    // uses to decide what this slice covered.
    const batch = verdicts?.rows?.[0].batch_id;
    expect(batch).toEqual(expect.any(String));
    expect(branchRows?.rows?.every((r) => r.batch_id === batch)).toBe(true);
  });

  it("stages a covered item that has no offer at all", async () => {
    // The row that makes "no offer" sayable. Without it the dataset could not
    // tell "asked, nothing found" from "not asked yet".
    const none = {
      summary: {
        itemCode: "9",
        scope: "none" as const,
        branchesAvailable: 40,
        branchesWithOffer: 0,
        offerDisplay: null,
        unitPrice: null,
        offerPrice: null,
      },
      offers: [],
    };

    await store.promoteOfferSlice([none], { cursor: "9", sweepComplete: false });

    expect(find("shams_offer_products_staging", "insert")?.rows).toHaveLength(1);
    expect(find("shams_offers_staging", "insert")).toBeUndefined();
  });

  it("never stages `unknown` as a verdict", async () => {
    // A staged verdict exists because the CRM answered. `unknown` means nobody
    // asked, and storing it would make the absence indistinguishable from a
    // real "none" on the way back out.
    await store.promoteOfferSlice([item("1", { scope: "unknown" })], {
      cursor: "1",
      sweepComplete: false,
    });
    expect(find("shams_offer_products_staging", "insert")?.rows?.[0].scope).toBe("none");
  });

  it("hands the promotion the cursor and completion flag the sweep decided", async () => {
    await store.promoteOfferSlice([item("1")], {
      cursor: "4200",
      sweepComplete: true,
      sourceMarker: "2026-09-06T08:30:00.000Z",
    });

    const rpc = rpcCalls.find((c) => c.name === "shams_promote_offers");
    expect(rpc?.args.p_cursor).toBe("4200");
    expect(rpc?.args.p_sweep_complete).toBe(true);
    expect(rpc?.args.p_source_marker).toBe("2026-09-06T08:30:00.000Z");
  });

  it("returns the promotion's own metrics rather than recomputing them", async () => {
    const promotion = await store.promoteOfferSlice([item("1")], {
      cursor: "1",
      sweepComplete: false,
    });
    expect(promotion.inserted).toBe(1);
    expect(promotion.changed).toBe(2);
    expect(promotion.itemsWithOffers).toBe(1);
  });

  /**
   * The refusal the RPC also makes, raised before a slice's worth of rows is
   * staged for nothing. A slice that covered no items must not advance the
   * cursor past products nobody looked at.
   */
  it("refuses an empty slice without touching the database", async () => {
    await expect(
      store.promoteOfferSlice([], { cursor: "1", sweepComplete: false }),
    ).rejects.toThrow(store.ShamsOfferStoreError);
    expect(calls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("clears its scratch rows even when the promotion fails", async () => {
    rpcResult = { data: null, error: { code: "P0001" } };

    await expect(
      store.promoteOfferSlice([item("1")], { cursor: "1", sweepComplete: false }),
    ).rejects.toThrow(store.ShamsOfferStoreError);

    // Both staging tables, both scoped to this batch. Without it an abandoned
    // batch would sit there until somebody noticed.
    expect(find("shams_offer_products_staging", "delete")).toBeDefined();
    expect(find("shams_offers_staging", "delete")).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The state row                                                               */
/* -------------------------------------------------------------------------- */

describe("sync state", () => {
  it("reports an unsynced dataset when the row cannot be read", async () => {
    selectResults.set("shams_offer_sync_state", { data: null, error: { code: "PGRST301" } });

    // Never throws: a diagnostic that fails when the thing it diagnoses fails is
    // worse than useless, and "unsynced" is the reading that makes the UI say
    // "offers unavailable" rather than "no offer".
    const health = await store.readOfferSyncHealth();
    expect(health.synced).toBe(false);
    expect(health.productRowCount).toBe(0);
  });

  it("is synced only once a promotion has landed and left rows", async () => {
    selectResults.set("shams_offer_sync_state", {
      data: { last_success_at: "2026-09-06T08:00:00Z", product_row_count: 0 },
      error: null,
    });
    expect((await store.readOfferSyncHealth()).synced).toBe(false);

    selectResults.set("shams_offer_sync_state", {
      data: { last_success_at: "2026-09-06T08:00:00Z", product_row_count: 8484 },
      error: null,
    });
    expect((await store.readOfferSyncHealth()).synced).toBe(true);
  });

  it("reports a sweep as in progress exactly when a cursor is parked", async () => {
    selectResults.set("shams_offer_sync_state", {
      data: {
        last_success_at: "2026-09-06T08:00:00Z",
        product_row_count: 10,
        cursor_item_code: "4200",
      },
      error: null,
    });
    const health = await store.readOfferSyncHealth();
    expect(health.sweepInProgress).toBe(true);
    expect(health.cursorItemCode).toBe("4200");
  });

  it("moves the next check forward on a failure, and can abandon the sweep", async () => {
    const at = new Date("2026-09-06T09:00:00Z");
    const due = new Date("2026-09-06T09:15:00Z");

    await store.recordOfferAttempt({
      outcome: "failed",
      error: "nope",
      attemptedAt: at,
      nextRefreshDueAt: due,
      resetCursor: true,
    });

    const write = find("shams_offer_sync_state", "update");
    expect(write?.values?.last_outcome).toBe("failed");
    expect(write?.values?.next_refresh_due_at).toBe(due.toISOString());
    expect(write?.values?.cursor_item_code).toBeNull();
    // Only the one state row, ever.
    expect(write?.filters).toEqual([{ kind: "eq", column: "id", value: 1 }]);
  });

  it("does not touch the cursor on an ordinary failure", async () => {
    await store.recordOfferAttempt({
      outcome: "failed",
      attemptedAt: new Date(),
      nextRefreshDueAt: new Date(),
    });
    // A failed slice must resume, not restart: the cursor is the sweep's memory.
    expect(find("shams_offer_sync_state", "update")?.values).not.toHaveProperty("cursor_item_code");
  });

  it("resets progress only when a fresh sweep is being started", async () => {
    const at = new Date("2026-09-06T09:00:00Z");

    await store.beginOfferAttempt(at, new Date(), { startingSweep: true });
    let write = find("shams_offer_sync_state", "update");
    expect(write?.values?.cursor_item_code).toBeNull();
    expect(write?.values?.sweep_items_done).toBe(0);
    expect(write?.values?.sweep_started_at).toBe(at.toISOString());

    calls.length = 0;
    await store.beginOfferAttempt(at, new Date());
    write = find("shams_offer_sync_state", "update");
    expect(write?.values).not.toHaveProperty("cursor_item_code");
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep cursor                                                            */
/* -------------------------------------------------------------------------- */

describe("choosing the next slice", () => {
  it("asks the catalogue for a bounded page after the cursor", async () => {
    rpcResult = { data: [{ item_code: "1" }, { item_code: "2" }], error: null };

    expect(await store.nextSweepItemCodes("0", 150)).toEqual(["1", "2"]);

    const rpc = rpcCalls.find((c) => c.name === "shams_offer_sweep_slice");
    expect(rpc?.args).toEqual({ p_after: "0", p_limit: 150 });
  });

  it("raises rather than reporting an empty catalogue when the read fails", async () => {
    // An empty result means "the sweep has finished"; a failed read must not be
    // allowed to say that, or a sweep would mark itself complete having looked
    // at nothing.
    rpcResult = { data: null, error: { code: "PGRST301" } };
    await expect(store.nextSweepItemCodes(null, 150)).rejects.toThrow(store.ShamsOfferStoreError);
  });
});
