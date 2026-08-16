/**
 * Parity with the PharmacyCRM Desktop product search.
 *
 * PharmacyCRM Desktop (`shams-crm.cloud`, build 2026.07.25.112540) is the client
 * Shams staff actually use, so it — not a written spec — is the definition of
 * "what the agent expects to see". Its search was read out of the shipped
 * PyInstaller archive; the findings are recorded in
 * `docs/shams/api-discovery.md` §10. Two of them shape this file:
 *
 *   1. **Its wildcard is a full-string regex.** `*` becomes `.*` and the pattern
 *      is anchored — `re.compile(f"^{pattern}$", re.IGNORECASE)` — matched
 *      against the item *name* only. `referenceWildcard` below is that rule
 *      transcribed, and it is what "the same practical way as Shams" is measured
 *      against rather than asserted from memory.
 *
 *   2. **It matches over the whole catalog, not over search results.** The
 *      desktop downloads all ~8 500 products once (`GET /products/names`) and
 *      matches locally. Since Phase 4 the portal does the same, through the same
 *      endpoint, so the fixture is simply handed over whole — it no longer has
 *      to stand in for the MIS's 50-row `product/search`, which is out of the
 *      discovery path entirely.
 *
 * The fixture is **real Shams data** — 237 rows lifted from the desktop's own
 * `product_cache_seed.json` — trimmed to the products any query below can reach.
 * Every row that matches one of these queries in the full 8 484-row catalog is
 * present, so the counts asserted here are the counts the real catalog produces.
 *
 * What this file does *not* prove is stated plainly in §10: the portal and the
 * desktop read two different backends, and no live call to either was made from
 * the machine that wrote these tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "./fixtures/shams-catalog-sample.json";

/**
 * A fixture row. Narrower than `RawProductSearchRow`, whose fields are all
 * optional because the MIS may omit them — these rows came out of Shams's own
 * product cache, so all three are present and the tests can rely on it.
 */
interface CatalogRow {
  itemCode: string;
  itemName: string;
  retailPrice: number;
}

const fetchMock = vi.fn();
const crmMock = vi.fn();

// Since Phase 4 the catalog is the CRM's, so the fixture is handed over whole
// rather than filtered through a stand-in for the MIS's 50-row search.
vi.mock("@/lib/shams-crm/products.server", () => ({
  getCrmProducts: () => crmMock(),
}));

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { searchProducts, _clearCaches } = await import("@/lib/shams/catalog.server");

const CATALOG = catalog as CatalogRow[];

/** The whole catalog, as the CRM serves it. */
function respondFromCatalog(): void {
  crmMock.mockResolvedValue(CATALOG);
}

/**
 * PharmacyCRM's `_wildcard_pattern_candidates`, transcribed.
 *
 * `re.escape(query).replace("\*", ".*")`, compiled as `^…$` with `IGNORECASE`
 * and tested against the trimmed item name. Results come back sorted by name
 * then code, which is the desktop's own ordering.
 */
function referenceWildcard(query: string): CatalogRow[] {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.split("\\*").join(".*");
  const regex = new RegExp("^" + pattern + "$", "i");
  return CATALOG.filter((p) => regex.test(p.itemName.trim())).sort(
    (a, b) =>
      a.itemName.toLowerCase().localeCompare(b.itemName.toLowerCase()) ||
      a.itemCode.localeCompare(b.itemCode),
  );
}

const codesOf = (rows: { itemCode: string }[]): string[] => rows.map((r) => r.itemCode).sort();

beforeEach(() => {
  fetchMock.mockReset();
  crmMock.mockReset();
  _clearCaches();
  respondFromCatalog();
});

/* -------------------------------------------------------------------------- */
/* The queries from the report                                                 */
/* -------------------------------------------------------------------------- */

describe("the reported queries, against real catalog rows", () => {
  it("`nan` finds the NAN products, and ranks them above incidental matches", async () => {
    const products = await searchProducts("nan");

    // 53 rows in the full catalog contain "nan" — NAN infant formula, but also
    // BANANA BOAT and CLEANANCE. The MIS matches all of them; ranking is what
    // decides whether the agent has to read past them.
    expect(products).toHaveLength(53);
    expect(products.slice(0, 8).every((p) => p.itemName.toUpperCase().startsWith("NAN"))).toBe(
      true,
    );
  });

  it("`nan*op` returns the NAN OPTIPRO/SCOOP products, not an empty list", async () => {
    const products = await searchProducts("nan*op");

    expect(products.length).toBeGreaterThan(0);
    expect(products.map((p) => p.itemName)).toContain("NAN 2 OPTIPRO 1800 GM");
    // Every hit really does read "nan … op": the fragments in order.
    for (const p of products) {
      const name = p.itemName.toLowerCase();
      expect(name.indexOf("op")).toBeGreaterThan(name.indexOf("nan"));
    }
  });

  it("`nan*op` returns exactly what PharmacyCRM returns for `nan*op*`", async () => {
    // The desktop anchors its pattern, so the trailing `*` is the difference
    // between "starts nan, ends op" and "starts nan, contains op". The portal
    // treats a bare fragment list as the latter, which is the reading agents
    // expect and the one this query was reported against.
    expect(codesOf(await searchProducts("nan*op"))).toEqual(codesOf(referenceWildcard("nan*op*")));
  });

  it("`pana*extr*` matches PharmacyCRM exactly", async () => {
    expect(codesOf(await searchProducts("pana*extr*"))).toEqual(
      codesOf(referenceWildcard("pana*extr*")),
    );
    expect((await searchProducts("pana*extr*")).map((p) => p.itemName)).toEqual([
      "PANADOL EXTRA TAB, 24 'S",
    ]);
  });

  it("`*omega*` matches PharmacyCRM exactly — 45 products", async () => {
    const products = await searchProducts("*omega*");

    expect(products).toHaveLength(45);
    expect(codesOf(products)).toEqual(codesOf(referenceWildcard("*omega*")));
  });

  it("item code `10400746` resolves to its product", async () => {
    const products = await searchProducts("10400746");

    expect(products[0]).toMatchObject({
      itemCode: "10400746",
      itemName: "NAN 2 OPTIPRO 1800 GM",
    });
  });

  it("an item code is answered from the catalog, with no MIS request", async () => {
    await searchProducts("10400746");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Wildcard semantics, checked against the transcribed rule                    */
/* -------------------------------------------------------------------------- */

describe("wildcard semantics agree with PharmacyCRM", () => {
  // PharmacyCRM anchors its pattern, so the two implementations coincide exactly
  // when the query is starred at both ends — or when the leading fragment is a
  // genuine prefix, as in `pana*extr*`. Those are compared row for row.
  //
  // `*extra*` is deliberately absent: it matches 114 products and the portal
  // caps a result set at MAX_SEARCH_RESULTS, so the sets differ by the cap
  // rather than by the matching rule.
  for (const query of ["*omega*", "pana*extr*", "nan*op*", "*nan*", "*panadol*"]) {
    it(`${query} returns the same products`, async () => {
      expect(codesOf(await searchProducts(query))).toEqual(codesOf(referenceWildcard(query)));
    });
  }

  /**
   * Where the portal is deliberately looser, and why.
   *
   * PharmacyCRM compiles `^…$`, so `nan*` means "name *starts* with nan" and
   * `nan*op` means "starts nan, *ends* op" — which is why `nan*op` finds nothing
   * in the desktop and the agent has to know to type `nan*op*`. The portal reads
   * a fragment list as "these pieces, in this order, anywhere", so the trailing
   * star is optional. That is the behaviour this change was asked for; it is a
   * superset of the desktop's, never a different set.
   */
  it("is a superset of PharmacyCRM, not a different answer", async () => {
    for (const [portalQuery, desktopQuery] of [
      ["nan*op", "nan*op*"],
      ["nan", "*nan*"],
      ["omega*3", "*omega*3*"],
    ]) {
      const portal = new Set(codesOf(await searchProducts(portalQuery)));
      for (const code of codesOf(referenceWildcard(desktopQuery))) {
        expect(portal.has(code)).toBe(true);
      }
    }
  });

  it("`nan*` is anchored in PharmacyCRM and unanchored here — both find the NAN range", async () => {
    const portal = await searchProducts("nan*");
    const desktop = referenceWildcard("nan*");

    expect(codesOf(portal)).toEqual(expect.arrayContaining(codesOf(desktop)));
    expect(portal.length).toBeGreaterThan(desktop.length);
  });

  it("no query is sent upstream at all — matching is local to the catalog", async () => {
    await searchProducts("pana*extr*");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("multiple segments narrow rather than widen", async () => {
    const one = await searchProducts("*omega*");
    const many = await searchProducts("*omega*3*");

    expect(many.length).toBeLessThan(one.length);
    expect(many.every((p) => /omega.*3/i.test(p.itemName))).toBe(true);
  });

  it("a numeric fragment is not satisfied by the digits of the item code", async () => {
    // Every item code is digits, so matching the joined "<name> <code>" let
    // `*omega*3*` be answered by a `3` the agent could not see. Each hit must
    // carry the whole pattern in one field.
    for (const product of await searchProducts("*omega*3*")) {
      const inName = /omega.*3/i.test(product.itemName);
      const inCode = /omega.*3/i.test(product.itemCode);
      expect(inName || inCode).toBe(true);
    }
  });

  it("a wildcard written against an item code now resolves", () => {
    // Was impossible while candidates came from `product/search`, which sees
    // names only — no probe ever returned the row for the code to match. With
    // the whole catalog in hand it is just another haystack.
    return expect(searchProducts("104*746")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemCode: "10400746" })]),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Edges                                                                       */
/* -------------------------------------------------------------------------- */

describe("edges", () => {
  it("an empty query costs no request", async () => {
    expect(await searchProducts("")).toEqual([]);
    expect(await searchProducts("   ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a single character costs no request", async () => {
    expect(await searchProducts("n")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asterisks alone are not a search", async () => {
    expect(await searchProducts("***")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a query that matches nothing returns nothing, without throwing", async () => {
    expect(await searchProducts("zzzznotaproduct")).toEqual([]);
    expect(await searchProducts("zzz*qqq*")).toEqual([]);
  });

  it("regex metacharacters in a query are literal, not syntax", async () => {
    // `(2*1800)` appears in a real product name; the parentheses and the `+`
    // must not be compiled as a pattern by either side.
    await expect(searchProducts("nan*(2*1800)")).resolves.toBeInstanceOf(Array);
    await expect(searchProducts("[a-z]+")).resolves.toEqual([]);
    await expect(searchProducts("panadol extra tab, 24 's")).resolves.toHaveLength(1);
  });

  it("repeating a search is answered from cache, not by rescanning the catalog", async () => {
    await searchProducts("nan*op");
    const first = crmMock.mock.calls.length;
    const repeat = await searchProducts("nan*op");

    expect(crmMock.mock.calls).toHaveLength(first);
    expect(repeat.length).toBeGreaterThan(0);
  });

  it("case and spacing do not change the answer", async () => {
    expect(codesOf(await searchProducts("NAN*OP"))).toEqual(
      codesOf(await searchProducts("nan*op")),
    );
    expect(codesOf(await searchProducts("  nan*op  "))).toEqual(
      codesOf(await searchProducts("nan*op")),
    );
  });
});
