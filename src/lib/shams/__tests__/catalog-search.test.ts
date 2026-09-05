/**
 * Catalog search — the source, and what it does with it.
 *
 * `search.ts` covers the matching rules in isolation. What is tested here is the
 * part that decides *which products ever get matched*: since the catalogue moved
 * into Supabase that is `shams_product_catalog`, read through
 * `fetchCatalogCandidates` — **not** the MIS, and no longer Shams CRM either.
 *
 * Both of those are stubbed so that any request to either would be visible:
 * `shamsFetch` for the MIS, `getCrmProducts` for the CRM. Neither may be touched
 * by a search, and a regression that quietly reinstated either would otherwise
 * look like a passing test — a CRM read in particular, because it would still
 * return the right products while putting a 700 KB download back on the agent's
 * path.
 *
 * The catalogue itself is a fake that implements Postgres `LIKE`
 * (`fixtures/fake-catalog-store.ts`), so the `LIKE` patterns `searchProducts`
 * builds are exercised rather than bypassed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";
import { fakeCatalogStore } from "./fixtures/fake-catalog-store";

const catalog: { rows: ShamsProduct[]; calls: number; fail: boolean } = {
  rows: [],
  calls: 0,
  fail: false,
};
const crmMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/shams/catalog-store.server", () => fakeCatalogStore(catalog)());

vi.mock("@/lib/shams-crm/products.server", () => ({
  getCrmProducts: () => crmMock(),
}));

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { searchProducts, _clearCaches, MAX_SEARCH_RESULTS } =
  await import("@/lib/shams/catalog.server");

const product = (itemCode: string, itemName: string, retailPrice = 10): ShamsProduct => ({
  itemCode,
  itemName,
  retailPrice,
});

const MOUNJARO = product("10609670", "MOUNJARO 2.5 MG 0.5ML PEN, 4'S", 1261.4);
const S26 = product("10501234", "S-26 GOLD 3 1800 GM");
const PANADOL = product("10999999", "PANADOL 500MG");
const NAN_OPTIPRO = product("10400746", "NAN 2 OPTIPRO 1800 GM");

const CATALOG = [MOUNJARO, S26, PANADOL, NAN_OPTIPRO];

beforeEach(() => {
  crmMock.mockReset();
  fetchMock.mockReset();
  _clearCaches();
  catalog.rows = CATALOG;
  catalog.calls = 0;
  catalog.fail = false;
});

/* -------------------------------------------------------------------------- */
/* The source                                                                  */
/* -------------------------------------------------------------------------- */

describe("search source", () => {
  it("reads the local catalogue and contacts neither the MIS nor Shams CRM", async () => {
    const products = await searchProducts("mounjaro");

    expect(catalog.calls).toBe(1);
    expect(products.map((p) => p.itemCode)).toEqual(["10609670"]);

    /*
     * The acceptance criterion, asserted directly: a cold worker answers a
     * search without contacting shams-crm.cloud. `getCrmProducts` is the only
     * route to that host for product discovery, so an untouched mock is the
     * whole proof.
     */
    expect(crmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to either upstream when the local catalogue fails", async () => {
    catalog.fail = true;

    // An outage must surface, not quietly become a CRM download or an empty list.
    await expect(searchProducts("mounjaro")).rejects.toThrow();
    expect(crmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a local catalogue failure as its own kind, not as a Shams outage", async () => {
    catalog.fail = true;

    await expect(searchProducts("mounjaro")).rejects.toHaveProperty("kind", "catalog_unavailable");
  });

  it("reuses the per-query result cache rather than re-reading the catalogue", async () => {
    await searchProducts("mounjaro");
    await searchProducts("mounjaro");

    expect(catalog.calls).toBe(1);
  });

  it("a short or empty query costs nothing at all", async () => {
    expect(await searchProducts("")).toEqual([]);
    expect(await searchProducts("   ")).toEqual([]);
    expect(await searchProducts("m")).toEqual([]);
    expect(await searchProducts("***")).toEqual([]);

    expect(catalog.calls).toBe(0);
    expect(crmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Matching — unchanged rules, over the local catalogue                        */
/* -------------------------------------------------------------------------- */

describe("matching", () => {
  it("matches a substring of the item name, case- and space-insensitively", async () => {
    expect((await searchProducts("MOUNJ")).map((p) => p.itemCode)).toEqual(["10609670"]);
    expect((await searchProducts("  gold 3  ")).map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  it("finds an exact item code without a separate MIS lookup", async () => {
    const products = await searchProducts("10400746");

    expect(products[0]).toMatchObject({
      itemCode: "10400746",
      itemName: "NAN 2 OPTIPRO 1800 GM",
    });
    // `product/info` used to answer this; the catalogue already holds it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds a product from the first digits of its item code", async () => {
    /*
     * New, and the one behaviour this phase adds rather than preserves. An agent
     * reading a code off a message often has only its start, and neither the MIS
     * search nor the in-memory CRM catalogue could retrieve on it — the first
     * because `product/search` sees names only, the second because a plain query
     * compared the code for equality. An indexed prefix scan makes it free.
     */
    expect((await searchProducts("104007")).map((p) => p.itemCode)).toEqual(["10400746"]);
    expect((await searchProducts("1050")).map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  it("does not read short or non-numeric text as an item code prefix", async () => {
    // `looksLikeItemCode` is the gate: four digits, digits only. `105` is a
    // strength or a pack size far more often than it is an identifier.
    expect(await searchProducts("105")).toEqual([]);
    expect((await searchProducts("nan")).every((p) => /nan/i.test(p.itemName))).toBe(true);
  });

  it("applies wildcards over the whole catalogue", async () => {
    expect((await searchProducts("nan*op")).map((p) => p.itemCode)).toEqual(["10400746"]);
    expect((await searchProducts("*gold*1800*")).map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  it("applies a wildcard written against an item code", async () => {
    expect((await searchProducts("104*746")).map((p) => p.itemCode)).toEqual(["10400746"]);
  });

  it("returns nothing for a query that matches nothing", async () => {
    expect(await searchProducts("zzzznotaproduct")).toEqual([]);
    expect(await searchProducts("zzz*qqq*")).toEqual([]);
  });

  it("treats LIKE metacharacters in a query as literal text", async () => {
    /*
     * `%` and `_` are Postgres syntax and are nothing at all in this search's
     * grammar, where the only metacharacter is `*`. An agent typing `50% CREAM`
     * must not silently get a wildcard, and — more to the point — must not get a
     * different answer than they would have got before the catalogue moved into
     * SQL.
     */
    catalog.rows = [...CATALOG, product("10777777", "HYDROCORTISONE 1% CREAM 30 GM")];

    expect((await searchProducts("1% cream")).map((p) => p.itemCode)).toEqual(["10777777"]);
    expect(await searchProducts("panad_l")).toEqual([]);
  });

  it("caps the result set however large the catalogue is", async () => {
    catalog.rows = Array.from({ length: MAX_SEARCH_RESULTS + 25 }, (_, i) =>
      product(`2010${String(i).padStart(4, "0")}`, `PARACETAMOL VARIANT ${i}`),
    );

    expect(await searchProducts("paracetamol")).toHaveLength(MAX_SEARCH_RESULTS);
  });

  it("preserves the product identity the MIS flows need", async () => {
    const [hit] = await searchProducts("mounjaro");

    expect(hit).toEqual({
      itemCode: "10609670",
      itemName: "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
      retailPrice: 1261.4,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

describe("abandoned searches", () => {
  it("does no work for a query the caller has already given up on", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await searchProducts("mounjaro", { signal: controller.signal })).toEqual([]);
    expect(catalog.calls).toBe(0);
  });

  it("forwards the signal to the catalogue read", async () => {
    const controller = new AbortController();
    await searchProducts("mounjaro", { signal: controller.signal });

    expect((catalog as { lastSignal?: AbortSignal }).lastSignal).toBe(controller.signal);
  });

  it("never caches the empty result of a cancelled search", async () => {
    /*
     * The failure this prevents is nastier than a wasted request: a cancelled
     * read resolves as "no candidates", and caching that under the term would
     * tell the agent who retypes it a second later that the product does not
     * exist — for the next five minutes.
     */
    const controller = new AbortController();
    controller.abort();
    expect(await searchProducts("mounjaro", { signal: controller.signal })).toEqual([]);

    // The same term, not cancelled, still finds the product.
    expect((await searchProducts("mounjaro")).map((p) => p.itemCode)).toEqual(["10609670"]);
  });
});
