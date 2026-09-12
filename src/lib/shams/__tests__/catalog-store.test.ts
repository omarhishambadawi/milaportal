/**
 * The local catalogue's data access — escaping, staging, and the health signal.
 *
 * `catalog-search.test.ts` covers what a search means; this covers the layer
 * underneath it, where the failures are of a different kind: a `%` an agent
 * typed being read as SQL syntax, a short download reaching the promotion, a
 * diagnostic that fails during the outage it exists to describe.
 *
 * Supabase is faked at the client, so every query this module builds is visible
 * as data and can be asserted on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";

/* -------------------------------------------------------------------------- */
/* A fake Supabase                                                             */
/* -------------------------------------------------------------------------- */

interface Recorded {
  rpc: { fn: string; args: Record<string, unknown>; signal?: AbortSignal }[];
  inserted: Record<string, unknown>[][];
  deleted: { table: string; batchId: unknown }[];
  updated: { table: string; patch: Record<string, unknown> }[];
}

const recorded: Recorded = { rpc: [], inserted: [], deleted: [], updated: [] };

const responses: {
  rpc: Record<string, { data: unknown; error: unknown }>;
  state: { data: unknown; error: unknown };
  insertError: unknown;
} = {
  rpc: {},
  state: { data: null, error: null },
  insertError: null,
};

const supabaseAdmin = {
  rpc(fn: string, args: Record<string, unknown>) {
    const entry: Recorded["rpc"][number] = { fn, args };
    recorded.rpc.push(entry);
    const result = responses.rpc[fn] ?? { data: [], error: null };
    const builder = {
      abortSignal(signal: AbortSignal) {
        entry.signal = signal;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  },
  from(table: string) {
    return {
      select() {
        return {
          eq() {
            return { maybeSingle: async () => responses.state };
          },
        };
      },
      async insert(rows: Record<string, unknown>[]) {
        recorded.inserted.push(rows);
        return { error: responses.insertError };
      },
      update(patch: Record<string, unknown>) {
        return {
          async eq() {
            recorded.updated.push({ table, patch });
            return { error: null };
          },
        };
      },
      delete() {
        return {
          eq(_col: string, batchId: unknown) {
            recorded.deleted.push({ table, batchId });
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin }));

const {
  escapeLikePattern,
  fetchCatalogCandidates,
  readCatalogHealth,
  replaceCatalog,
  recordCatalogAttempt,
  MIN_CATALOG_ROWS,
  MAX_CATALOG_CANDIDATES,
  ShamsCatalogError,
} = await import("@/lib/shams/catalog-store.server");

const product = (i: number): ShamsProduct => ({
  itemCode: String(10_400_000 + i),
  itemName: `PRODUCT  ${i}`,
  retailPrice: i,
});

beforeEach(() => {
  recorded.rpc = [];
  recorded.inserted = [];
  recorded.deleted = [];
  recorded.updated = [];
  responses.rpc = {};
  responses.state = { data: null, error: null };
  responses.insertError = null;
});

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

describe("LIKE escaping", () => {
  it("neutralises every character LIKE reads as syntax", () => {
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
    expect(escapeLikePattern("vitamin_d")).toBe("vitamin\\_d");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes the backslash first, so the escapes it adds are not re-escaped", () => {
    // `\%` must come out as an escaped backslash followed by an escaped percent,
    // not as a percent that escaped its own escape.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary product text alone", () => {
    expect(escapeLikePattern("MOUNJARO 2.5 MG")).toBe("MOUNJARO 2.5 MG");
  });
});

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

describe("candidate retrieval", () => {
  it("asks the database, bounded, and normalises the rows it gets back", async () => {
    responses.rpc.shams_search_product_catalog = {
      data: [{ item_code: "10400746", item_name: "NAN 2 OPTIPRO", retail_price: "129.500" }],
      error: null,
    };

    const rows = await fetchCatalogCandidates({ namePattern: "%nan%", codePattern: null });

    expect(recorded.rpc[0].fn).toBe("shams_search_product_catalog");
    /*
     * What actually crosses the wire, not what the argument object looks like
     * in memory.
     *
     * An absent pattern is passed as `undefined`, which `JSON.stringify` drops
     * from the body entirely, so PostgREST calls the function without that
     * named argument and the SQL default supplies it. Verified against the
     * deployed signature:
     *
     *   shams_search_product_catalog(
     *     p_name_pattern text DEFAULT NULL,
     *     p_code_pattern text DEFAULT NULL,
     *     p_max_rows integer DEFAULT 2000)
     *
     * so omitting `p_code_pattern` and sending it as NULL are the same call.
     * Asserting the serialised body is what makes that equivalence a property of
     * the request rather than of the object literal — an argument that lost its
     * SQL default would still be omitted here, and this is where that would have
     * to be noticed.
     */
    const sent = JSON.parse(JSON.stringify(recorded.rpc[0].args));
    expect(sent).toEqual({
      p_name_pattern: "%nan%",
      p_max_rows: MAX_CATALOG_CANDIDATES,
    });
    expect("p_code_pattern" in sent).toBe(false);
    // `numeric` arrives as a string from PostgREST; a price that stayed one
    // would render as text and break every comparison downstream.
    expect(rows).toEqual([{ itemCode: "10400746", itemName: "NAN 2 OPTIPRO", retailPrice: 129.5 }]);
  });

  it("asks for nothing when there is nothing to match on", async () => {
    expect(await fetchCatalogCandidates({ namePattern: null, codePattern: null })).toEqual([]);
    expect(recorded.rpc).toHaveLength(0);
  });

  it("forwards the caller's abort signal to the query", async () => {
    const controller = new AbortController();
    await fetchCatalogCandidates(
      { namePattern: "%nan%", codePattern: null },
      {
        signal: controller.signal,
      },
    );

    expect(recorded.rpc[0].signal).toBe(controller.signal);
  });

  it("starts nothing for a query already abandoned", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      await fetchCatalogCandidates(
        { namePattern: "%nan%", codePattern: null },
        { signal: controller.signal },
      ),
    ).toEqual([]);
    expect(recorded.rpc).toHaveLength(0);
  });

  it("raises rather than reporting an unreadable catalogue as no results", async () => {
    /*
     * The distinction that matters on a call: an agent shown "no products found"
     * during a database incident will tell a customer the product does not
     * exist.
     */
    responses.rpc.shams_search_product_catalog = { data: null, error: { code: "57014" } };

    await expect(
      fetchCatalogCandidates({ namePattern: "%nan%", codePattern: null }),
    ).rejects.toBeInstanceOf(ShamsCatalogError);
  });

  it("treats a cancelled read as no candidates, not as a fault", async () => {
    const controller = new AbortController();
    responses.rpc.shams_search_product_catalog = { data: null, error: { code: "20" } };

    const promise = fetchCatalogCandidates(
      { namePattern: "%nan%", codePattern: null },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(promise).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Replacement                                                                 */
/* -------------------------------------------------------------------------- */

describe("replacing the catalogue", () => {
  const full = Array.from({ length: MIN_CATALOG_ROWS + 500 }, (_, i) => product(i));

  it("refuses a short catalogue before staging a single row", async () => {
    await expect(replaceCatalog(full.slice(0, 40))).rejects.toBeInstanceOf(ShamsCatalogError);
    expect(recorded.inserted).toHaveLength(0);
    expect(recorded.rpc).toHaveLength(0);
  });

  it("stages in chunks and then promotes once", async () => {
    responses.rpc.shams_promote_product_catalog = {
      data: { staged: full.length, changed: 3, removed: 1, total: full.length },
      error: null,
    };

    const result = await replaceCatalog(full, { sourceMarker: "m1" });

    expect(recorded.inserted.length).toBeGreaterThan(1);
    expect(recorded.inserted.flat()).toHaveLength(full.length);
    expect(recorded.rpc.filter((c) => c.fn === "shams_promote_product_catalog")).toHaveLength(1);
    expect(result).toEqual({ staged: full.length, changed: 3, removed: 1, total: full.length });
  });

  it("computes search_name with the matcher's own normaliser", async () => {
    responses.rpc.shams_promote_product_catalog = { data: { total: full.length }, error: null };

    await replaceCatalog(full);

    const [first] = recorded.inserted[0];
    // `PRODUCT  0` — two spaces — collapses, exactly as `normalizeForSearch`
    // does to the other side of every comparison.
    expect(first.search_name).toBe("product 0");
    expect(first.item_name).toBe("PRODUCT  0");
  });

  it("carries the floor down to the database, which enforces it inside the swap", async () => {
    responses.rpc.shams_promote_product_catalog = { data: { total: full.length }, error: null };

    await replaceCatalog(full);

    const promote = recorded.rpc.find((c) => c.fn === "shams_promote_product_catalog");
    expect(promote?.args.p_min_rows).toBe(MIN_CATALOG_ROWS);
  });

  it("promotes nothing when staging fails part way through", async () => {
    responses.insertError = { code: "53100" };

    await expect(replaceCatalog(full)).rejects.toBeInstanceOf(ShamsCatalogError);
    expect(recorded.rpc.filter((c) => c.fn === "shams_promote_product_catalog")).toHaveLength(0);
  });

  it("clears its scratch rows whether it succeeded or failed", async () => {
    responses.insertError = { code: "53100" };
    await expect(replaceCatalog(full)).rejects.toThrow();

    expect(recorded.deleted.map((d) => d.table)).toContain("shams_product_catalog_staging");
  });
});

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

describe("the health signal", () => {
  it("reports size and freshness without touching a product row", async () => {
    responses.state = {
      data: {
        row_count: 8484,
        source_marker: "2026-09-05T02:14:00Z",
        last_attempt_at: "2026-09-05T08:00:00Z",
        last_success_at: "2026-09-05T08:00:00Z",
        last_outcome: "success",
        last_error: null,
        next_refresh_due_at: "2026-09-05T09:00:00Z",
      },
      error: null,
    };

    const health = await readCatalogHealth(Date.parse("2026-09-05T09:00:00Z"));

    expect(health).toMatchObject({ rowCount: 8484, usable: true, lastOutcome: "success" });
    expect(health.ageMs).toBe(60 * 60_000);
    expect(recorded.rpc).toHaveLength(0);
  });

  it("survives the outage it exists to describe", async () => {
    // A diagnostic that throws when the database is unwell is worse than
    // useless: it is consulted precisely then.
    responses.state = { data: null, error: { code: "08006" } };

    await expect(readCatalogHealth()).resolves.toMatchObject({ rowCount: 0, usable: false });
  });

  it("says how old it is only when there has been a successful refresh", async () => {
    responses.state = { data: { row_count: 8484, last_success_at: null }, error: null };

    const health = await readCatalogHealth();
    expect(health.ageMs).toBeNull();
    // Seeded rows are usable even though nothing has ever been refreshed.
    expect(health.usable).toBe(true);
  });
});

describe("recording an attempt", () => {
  it("cannot claim a success it did not perform", async () => {
    /*
     * `success` is written only by `shams_promote_product_catalog`, inside the
     * transaction that actually swapped the rows. The type here does not offer
     * it, which is what stops a caller recording one on a path that changed
     * nothing.
     */
    await recordCatalogAttempt({
      outcome: "failed",
      error: "nope",
      attemptedAt: new Date("2026-09-05T09:00:00Z"),
      nextRefreshDueAt: new Date("2026-09-05T09:15:00Z"),
    });

    expect(recorded.updated[0].table).toBe("shams_catalog_state");
    expect(recorded.updated[0].patch).toMatchObject({ last_outcome: "failed" });
    expect(Object.keys(recorded.updated[0].patch)).not.toContain("last_success_at");
    expect(Object.keys(recorded.updated[0].patch)).not.toContain("row_count");
  });
});
