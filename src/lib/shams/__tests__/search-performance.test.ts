/**
 * Search cost at the real catalog size.
 *
 * The other search tests use a 237-row fixture, which says nothing about what a
 * query costs against the 8,484 products production actually holds. This
 * generates a catalog of that size in memory — no fixture file — and measures
 * the four queries Phase 4 was verified with.
 *
 * **There are no timing thresholds.** The project defines none, and a wall-clock
 * assertion on a shared CI runner is a flaky test wearing a performance costume.
 * What is asserted is correctness and *work* at scale: results are non-empty and
 * capped, a repeat query costs nothing, and one search reads the catalogue once.
 * Timings are written to `PERF_OUT` when set, for a human to read.
 *
 * The catalogue is a fake of the Supabase table implementing Postgres `LIKE`, so
 * these numbers measure the matching and ranking work over 8,484 candidate rows
 * — the worst case, where the database narrows nothing. In production the `LIKE`
 * runs against a GIN trigram index and hands back a few hundred rows at most, so
 * the real figure is lower than anything printed here plus one round trip to
 * Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import type { ShamsProduct } from "@/lib/shams/types";

import { fakeCatalogStore } from "./fixtures/fake-catalog-store";

const local: { rows: ShamsProduct[]; calls: number; fail: boolean } = {
  rows: [],
  calls: 0,
  fail: false,
};

vi.mock("@/lib/shams/catalog-store.server", () => fakeCatalogStore(local)());

const { searchProducts, _clearCaches, MAX_SEARCH_RESULTS } =
  await import("@/lib/shams/catalog.server");

/** The real catalog's size, shape and awkwardness — long names, mixed case, punctuation. */
const CATALOG_SIZE = 8_484;

const BRANDS = [
  "PANADOL",
  "NAN OPTIPRO",
  "MOUNJARO",
  "OMEGA FORT",
  "BANANA BOAT",
  "AVENE CLEANANCE",
  "S-26 GOLD",
  "PHARMATON VITALITY",
];
const FORMS = ["TAB", "CAP", "SYRUP", "MILK", "PEN", "CREAM", "GEL", "DROPS"];

function buildCatalog(size = CATALOG_SIZE): ShamsProduct[] {
  const out: ShamsProduct[] = [];
  for (let i = 0; i < size; i++) {
    const brand = BRANDS[i % BRANDS.length];
    const form = FORMS[i % FORMS.length];
    out.push({
      itemCode: String(10_400_000 + i),
      itemName: `${brand} ${form} ${(i % 90) + 1}0 MG, ${(i % 12) + 1}'S`,
      retailPrice: Math.round((i % 500) * 1.37 * 100) / 100,
    });
  }
  // The exact rows the production verification named, so the queries below mean
  // the same thing here as they do against the real catalog.
  out[0] = { itemCode: "10400746", itemName: "NAN 2 OPTIPRO 1800 GM", retailPrice: 100 };
  out[1] = {
    itemCode: "10609670",
    itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
    retailPrice: 1261.4,
  };
  return out;
}

const CATALOG = buildCatalog();

async function timed(query: string): Promise<{ ms: number; count: number }> {
  const started = performance.now();
  const products = await searchProducts(query);
  return { ms: performance.now() - started, count: products.length };
}

beforeEach(() => {
  _clearCaches();
  local.rows = CATALOG;
  local.calls = 0;
  local.fail = false;
});

describe(`search over ${CATALOG_SIZE} products`, () => {
  it("runs the four verified queries and reports their cost", async () => {
    const lines: string[] = [];
    for (const query of ["10400746", "Mounjaro", "nan", "nan*op", "104*746"]) {
      _clearCaches();
      const { ms, count } = await timed(query);
      lines.push(
        `  ${query.padEnd(12)} ${count.toString().padStart(4)} results  ${ms.toFixed(1)} ms`,
      );
      // Correctness at scale, which is the part worth asserting.
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
    }
    if (process.env.PERF_OUT) {
      appendFileSync(process.env.PERF_OUT, lines.join("\n") + "\n");
    }
  });

  it("a repeated query does no work at all", async () => {
    _clearCaches();
    await searchProducts("nan");
    const afterFirst = local.calls;

    const started = performance.now();
    await searchProducts("nan");
    const cachedMs = performance.now() - started;

    expect(local.calls).toBe(afterFirst);
    if (process.env.PERF_OUT) {
      appendFileSync(
        process.env.PERF_OUT,
        `  cached repeat  ${cachedMs.toFixed(2)} ms
`,
      );
    }
  });

  it("each distinct query is one catalogue read, and never a download", async () => {
    _clearCaches();
    const queries = ["panadol", "omega", "gold", "mounjaro", "nan*op", "cap*mg*"];
    for (const q of queries) await searchProducts(q);

    // One indexed read per distinct query, against MilaPortal's own table. The
    // 700 KB CRM download this used to sit in front of is not on this path at
    // all any more; the refresh that does perform it is tested separately.
    expect(local.calls).toBe(queries.length);
  });

  it("caps a broad result set at MAX_SEARCH_RESULTS", async () => {
    _clearCaches();
    // Matches roughly an eighth of the catalog.
    const products = await searchProducts("panadol");

    expect(products).toHaveLength(MAX_SEARCH_RESULTS);
  });

  it("keeps the exact item code first for a code query", async () => {
    _clearCaches();
    const [top] = await searchProducts("10400746");

    expect(top.itemCode).toBe("10400746");
  });
});
