/**
 * Shams search and filter tests.
 *
 * The wildcard cases are the ones agents actually type. `mou*n*j*2.5` and
 * `*26*gold*3*1800` are taken from the brief verbatim, because the point of the
 * syntax is that someone who remembers fragments of a name in the right order
 * finds the product without knowing how it is spelled.
 */

import { describe, expect, it } from "vitest";
import {
  filterBranchStock,
  isWildcardQuery,
  matchesBranchQuery,
  matchesProductWildcard,
  matchesWildcard,
  normalizeForSearch,
  parseWildcardQuery,
  summariseStock,
  wildcardProbe,
} from "@/lib/shams/search";
import type { ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";

const product = (itemName: string, itemCode = "10609670"): ShamsProduct => ({
  itemCode,
  itemName,
  retailPrice: 1261.4,
});

const MOUNJARO = product("MOUNJARO 2.5 MG 0.5ML PEN, 4'S", "10609670");
const S26 = product("S-26 GOLD 3 1800 GM", "10501234");

/* -------------------------------------------------------------------------- */
/* Wildcard parsing                                                            */
/* -------------------------------------------------------------------------- */

describe("parseWildcardQuery", () => {
  it("splits an expression into its ordered fragments", () => {
    expect(parseWildcardQuery("mou*n*j*2.5")).toEqual(["mou", "n", "j", "2.5"]);
  });

  it("treats a leading asterisk as 'may start anywhere' rather than a fragment", () => {
    expect(parseWildcardQuery("*26*gold*3*1800")).toEqual(["26", "gold", "3", "1800"]);
  });

  it("ignores empty, doubled and trailing separators", () => {
    expect(parseWildcardQuery("**mou**jaro**")).toEqual(["mou", "jaro"]);
  });

  it("lowercases and collapses whitespace", () => {
    expect(parseWildcardQuery("  MOU  N *  2.5 ")).toEqual(["mou n", "2.5"]);
  });

  it("yields nothing for a query of only separators", () => {
    expect(parseWildcardQuery("***")).toEqual([]);
    expect(matchesWildcard("anything", [])).toBe(false);
  });
});

describe("isWildcardQuery", () => {
  it("is what decides whether the expression path runs at all", () => {
    expect(isWildcardQuery("mou*n")).toBe(true);
    expect(isWildcardQuery("mounjaro")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Wildcard matching                                                           */
/* -------------------------------------------------------------------------- */

describe("matchesProductWildcard", () => {
  it("matches Mounjaro 2.5 from mou*n*j*2.5", () => {
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("mou*n*j*2.5"))).toBe(true);
  });

  it("matches S-26 Gold 3 1800 from *26*gold*3*1800", () => {
    expect(matchesProductWildcard(S26, parseWildcardQuery("*26*gold*3*1800"))).toBe(true);
  });

  it("is case-insensitive in both directions", () => {
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("MOU*JARO"))).toBe(true);
    expect(matchesProductWildcard(product("mounjaro 5 mg"), parseWildcardQuery("MOUN*5"))).toBe(
      true,
    );
  });

  it("tolerates the agent's spacing", () => {
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("  mou * 2.5  "))).toBe(true);
    expect(matchesProductWildcard(product("S-26  GOLD   3"), parseWildcardQuery("s-26*gold"))).toBe(
      true,
    );
  });

  it("allows arbitrary text between fragments", () => {
    expect(matchesWildcard("MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR", ["mou", "0.6"])).toBe(true);
  });

  it("requires every fragment", () => {
    // "3000" is not in the name; the other three are.
    expect(matchesProductWildcard(S26, parseWildcardQuery("*26*gold*3000"))).toBe(false);
  });

  it("requires the fragments in the order given", () => {
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("2.5*mou"))).toBe(false);
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("mou*2.5"))).toBe(true);
  });

  it("does not let one occurrence satisfy two fragments", () => {
    expect(matchesWildcard("gold", ["gold", "gold"])).toBe(false);
    expect(matchesWildcard("gold gold", ["gold", "gold"])).toBe(true);
  });

  it("matches on the item code too", () => {
    expect(matchesProductWildcard(MOUNJARO, parseWildcardQuery("106*670"))).toBe(true);
  });

  it("rejects a product that matches nothing", () => {
    expect(matchesProductWildcard(product("PANADOL 500MG"), parseWildcardQuery("mou*n*j"))).toBe(
      false,
    );
  });
});

describe("wildcardProbe", () => {
  it("sends the longest fragment upstream, since it is the most selective", () => {
    expect(wildcardProbe(["26", "golden", "3", "1800"], 2)).toBe("golden");
  });

  it("breaks ties towards the fragment the agent typed first", () => {
    // `gold` and `1800` are both four characters.
    expect(wildcardProbe(["26", "gold", "3", "1800"], 2)).toBe("gold");
    expect(wildcardProbe(["mou", "n", "j", "2.5"], 2)).toBe("mou");
  });

  it("skips fragments too short to search with", () => {
    expect(wildcardProbe(["a", "b", "gold"], 2)).toBe("gold");
  });

  it("declines rather than sweeping the catalog with one character", () => {
    expect(wildcardProbe(["a", "b", "c"], 2)).toBeNull();
    expect(wildcardProbe([], 2)).toBeNull();
  });
});

describe("normalizeForSearch", () => {
  it("is the single reason matching survives case and spacing", () => {
    expect(normalizeForSearch("  MOUNJARO   2.5  ")).toBe("mounjaro 2.5");
  });
});

/* -------------------------------------------------------------------------- */
/* Branch filtering                                                            */
/* -------------------------------------------------------------------------- */

const ROW = {
  branchCode: "P0221",
  areaName: "JEDDAH",
  city: "جدة",
  cityEnglish: "Jeddah",
};

describe("matchesBranchQuery", () => {
  it("matches the full branch code", () => {
    expect(matchesBranchQuery(ROW, "P0221")).toBe(true);
  });

  it("matches the bare branch number", () => {
    expect(matchesBranchQuery(ROW, "0221")).toBe(true);
  });

  it("matches the English city", () => {
    expect(matchesBranchQuery(ROW, "Jeddah")).toBe(true);
  });

  it("matches the Arabic city", () => {
    expect(matchesBranchQuery(ROW, "جدة")).toBe(true);
  });

  it("matches the MIS area", () => {
    expect(matchesBranchQuery({ ...ROW, city: null, cityEnglish: null }, "jeddah")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesBranchQuery(ROW, "jEdDaH")).toBe(true);
    expect(matchesBranchQuery(ROW, "p0221")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(matchesBranchQuery(ROW, "Riyadh")).toBe(false);
  });

  it("treats an empty query as no filter", () => {
    expect(matchesBranchQuery(ROW, "   ")).toBe(true);
  });
});

const stockRow = (branchCode: string, areaName: string, quantity: number): ShamsBranchStock => ({
  branchCode,
  branchName: branchCode,
  areaName,
  quantity,
  lzQuantity: 0,
});

const STOCK = [
  stockRow("P0001", "RIYADH", 5),
  stockRow("P0221", "JEDDAH", 3),
  stockRow("P0222", "JEDDAH", 0),
  stockRow("P0304", "QASIM", 7),
];

const LABELS: Record<string, { city: string; cityEnglish: string }> = {
  P0001: { city: "الرياض", cityEnglish: "Riyadh" },
  P0221: { city: "جدة", cityEnglish: "Jeddah" },
  P0222: { city: "جدة", cityEnglish: "Jeddah" },
  P0304: { city: "بريدة", cityEnglish: "Buraydah" },
};

const labelsFor = (code: string) => LABELS[code];

describe("filterBranchStock", () => {
  it("narrows the rows to one city", () => {
    const rows = filterBranchStock(STOCK, "Jeddah", labelsFor);
    expect(rows.map((r) => r.branchCode)).toEqual(["P0221", "P0222"]);
  });

  it("narrows to a single branch by code", () => {
    expect(filterBranchStock(STOCK, "0304", labelsFor).map((r) => r.branchCode)).toEqual(["P0304"]);
  });

  it("returns every row when the query is empty", () => {
    expect(filterBranchStock(STOCK, "", labelsFor)).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

describe("summariseStock", () => {
  it("counts branches, availability and units across the whole result", () => {
    expect(summariseStock(STOCK)).toEqual({
      branches: 4,
      withStock: 3,
      without: 1,
      units: 15,
    });
  });

  /**
   * The reason the summary takes an array rather than reading the unfiltered
   * result: a total that disagrees with the table under it is worse than none.
   */
  it("recalculates from the filtered rows, not the original set", () => {
    const filtered = filterBranchStock(STOCK, "Jeddah", labelsFor);
    expect(summariseStock(filtered)).toEqual({
      branches: 2,
      withStock: 1,
      without: 1,
      units: 3,
    });
  });

  it("reports zeroes for an empty filter result", () => {
    expect(summariseStock([])).toEqual({ branches: 0, withStock: 0, without: 0, units: 0 });
  });
});
