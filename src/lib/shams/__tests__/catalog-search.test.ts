/**
 * Catalog search — the source, and what it does with it.
 *
 * `search.ts` covers the matching rules in isolation. What is tested here is the
 * part that decides *which products ever get matched*: since Phase 4 that is the
 * **Shams CRM catalog**, not the MIS.
 *
 * The MIS `product/search` returned at most 50 rows with no pagination, so a
 * broad query was truncated before the wanted product was seen. It is no longer
 * consulted for product discovery at all, and these tests assert that — a
 * regression that quietly reinstated it would otherwise look like a passing
 * search.
 *
 * `getCrmProducts` is stubbed and `shamsFetch` is stubbed separately, so a
 * search costs no network and any MIS call would be visible.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShamsProduct } from "@/lib/shams/types";

const crmMock = vi.fn();
const fetchMock = vi.fn();

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
  crmMock.mockResolvedValue(CATALOG);
});

/* -------------------------------------------------------------------------- */
/* The source                                                                  */
/* -------------------------------------------------------------------------- */

describe("search source", () => {
  it("reads the CRM catalog and never asks the MIS for product discovery", async () => {
    const products = await searchProducts("mounjaro");

    expect(crmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(products.map((p) => p.itemCode)).toEqual(["10609670"]);
  });

  it("does not fall back to the MIS when the CRM catalog fails", async () => {
    crmMock.mockRejectedValue(Object.assign(new Error("crm down"), { kind: "unavailable" }));

    // An outage must surface, not quietly become an MIS search or an empty list.
    await expect(searchProducts("mounjaro")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses the per-query result cache rather than rescanning the catalog", async () => {
    await searchProducts("mounjaro");
    await searchProducts("mounjaro");

    expect(crmMock).toHaveBeenCalledTimes(1);
  });

  it("a short or empty query costs nothing at all", async () => {
    expect(await searchProducts("")).toEqual([]);
    expect(await searchProducts("   ")).toEqual([]);
    expect(await searchProducts("m")).toEqual([]);
    expect(await searchProducts("***")).toEqual([]);

    expect(crmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Matching — unchanged rules, wider catalog                                   */
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
    // `product/info` used to answer this; the catalog already holds it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies wildcards over the whole catalog", async () => {
    expect((await searchProducts("nan*op")).map((p) => p.itemCode)).toEqual(["10400746"]);
    expect((await searchProducts("*gold*1800*")).map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  it("returns nothing for a query that matches nothing", async () => {
    expect(await searchProducts("zzzznotaproduct")).toEqual([]);
    expect(await searchProducts("zzz*qqq*")).toEqual([]);
  });

  it("caps the result set however large the catalog is", async () => {
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 25 }, (_, i) =>
      product(`2010${String(i).padStart(4, "0")}`, `PARACETAMOL VARIANT ${i}`),
    );
    crmMock.mockResolvedValue(many);

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
