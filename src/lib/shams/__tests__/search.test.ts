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
  looksLikeItemCode,
  matchesBranchQuery,
  matchesProductWildcard,
  matchesWildcard,
  mergeInvoiceBranchMatches,
  normalizeForSearch,
  parseWildcardQuery,
  rankProducts,
  sortInvoiceBranchMatches,
  summariseStock,
  wildcardProbe,
  wildcardProbes,
} from "@/lib/shams/search";
import type { InvoiceBranchMatch, ShamsBranchStock, ShamsProduct } from "@/lib/shams/types";

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

describe("wildcardProbes", () => {
  /**
   * One probe is logically sufficient but only if the API returns everything it
   * matched — and it exposes no limit/page/offset, so a server-side cap cannot
   * be ruled out. Several probes mean a product has to survive only one of them.
   */
  it("returns several probes, most selective first", () => {
    expect(wildcardProbes(["26", "golden", "3", "1800"], 2, 3)).toEqual([
      "golden",
      "1800",
      "26",
      "26 golden 3 1800",
    ]);
  });

  it("is bounded by max", () => {
    expect(wildcardProbes(["mounjaro", "kwikpen", "12.5", "0.6"], 2, 2)).toEqual([
      "mounjaro",
      "kwikpen",
      "mounjaro kwikpen 12.5 0.6",
    ]);
  });

  it("skips fragments nested inside a probe already chosen", () => {
    // "gold" inside "golden" retrieves a superset of the same rows.
    expect(wildcardProbes(["golden", "gold"], 2, 3)).toEqual(["golden", "golden gold"]);
  });

  it("skips fragments too short to search with", () => {
    expect(wildcardProbes(["a", "b", "gold"], 2, 3)).toEqual(["gold", "a b gold"]);
  });

  /**
   * A secondary probe may be held to a higher floor than the first. `2.5` is a
   * fine thing to *match* on and a ruinous thing to *search* on — it retrieves
   * every 2.5 mg product in the catalog.
   */
  it("holds probes after the first to a higher floor", () => {
    expect(wildcardProbes(["moun", "2.5"], 2, 3, 4)).toEqual(["moun", "moun 2.5"]);
    expect(wildcardProbes(["gold", "1800", "26"], 2, 3, 4)).toEqual([
      "gold",
      "1800",
      "gold 1800 26",
    ]);
  });

  it("still takes the first probe at the lower floor, since it is the search", () => {
    // Nothing here reaches the secondary floor; refusing the first probe too
    // would mean declining to search at all.
    expect(wildcardProbes(["mou", "2.5"], 2, 3, 4)).toEqual(["mou", "mou 2.5"]);
  });

  it("leaves the floors equal when no secondary floor is given", () => {
    expect(wildcardProbes(["moun", "2.5"], 2, 3)).toEqual(["moun", "2.5", "moun 2.5"]);
  });

  it("returns nothing when no fragment is long enough", () => {
    expect(wildcardProbes(["a", "b"], 2, 3)).toEqual([]);
  });

  it("agrees with the single-probe helper on its first choice", () => {
    const fragments = ["mou", "n", "j", "2.5"];
    expect(wildcardProbe(fragments, 2)).toBe(wildcardProbes(fragments, 2, 3)[0]);
  });
});

describe("rankProducts", () => {
  const EXACT = product("MOUNJARO", "1");
  const PREFIX = product("MOUNJARO 2.5 MG 0.5ML PEN, 4'S", "2");
  const CONTAINS = product("PEN NEEDLE FOR MOUNJARO", "3");
  const UNRELATED = product("PANADOL 500MG", "4");

  it("puts an exact name match first, then prefix, then contains", () => {
    const ranked = rankProducts([UNRELATED, CONTAINS, PREFIX, EXACT], "mounjaro", []);
    expect(ranked.map((p) => p.itemName)).toEqual([
      "MOUNJARO",
      "MOUNJARO 2.5 MG 0.5ML PEN, 4'S",
      "PEN NEEDLE FOR MOUNJARO",
      "PANADOL 500MG",
    ]);
  });

  it("ranks an item-code match highly when the code was typed", () => {
    const ranked = rankProducts([UNRELATED, PREFIX], "2", []);
    expect(ranked[0].itemCode).toBe("2");
  });

  it("ranks by the first fragment for a wildcard query", () => {
    const fragments = parseWildcardQuery("mounjaro*2.5");
    const ranked = rankProducts([CONTAINS, PREFIX], "mounjaro*2.5", fragments);
    expect(ranked[0].itemName).toBe("MOUNJARO 2.5 MG 0.5ML PEN, 4'S");
  });

  it("is stable: equal scores keep their original order", () => {
    const a = product("SAME NAME", "a");
    const b = product("SAME NAME", "b");
    expect(rankProducts([a, b], "zzz", []).map((p) => p.itemCode)).toEqual(["a", "b"]);
    expect(rankProducts([b, a], "zzz", []).map((p) => p.itemCode)).toEqual(["b", "a"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Invoice branch ordering                                                     */
/* -------------------------------------------------------------------------- */

const match = (branchCode: string, isCallCentre: boolean): InvoiceBranchMatch => ({
  branchCode,
  docDate: "2026-08-13T00:00:00",
  grandTotal: 230,
  cancelled: false,
  isCallCentre,
  customer: isCallCentre ? "HOME DELIVERY-Call Centre" : "CASH SALES",
});

describe("sortInvoiceBranchMatches", () => {
  it("puts the Call Centre branch first", () => {
    const sorted = sortInvoiceBranchMatches([
      match("P0100", false),
      match("P0221", true),
      match("P0505", false),
    ]);
    expect(sorted.map((m) => m.branchCode)).toEqual(["P0221", "P0100", "P0505"]);
  });

  it("orders within each group by branch code, not by arrival", () => {
    const sorted = sortInvoiceBranchMatches([
      match("P0505", false),
      match("P0100", false),
      match("P0900", true),
      match("P0221", true),
    ]);
    expect(sorted.map((m) => m.branchCode)).toEqual(["P0221", "P0900", "P0100", "P0505"]);
  });

  it("is deterministic whatever order the branches answered in", () => {
    const rows = [match("P0505", false), match("P0221", true), match("P0100", false)];
    const forwards = sortInvoiceBranchMatches(rows).map((m) => m.branchCode);
    const backwards = sortInvoiceBranchMatches([...rows].reverse()).map((m) => m.branchCode);
    expect(forwards).toEqual(backwards);
  });

  it("does not order by total or city", () => {
    const cheapCallCentre = { ...match("P0900", true), grandTotal: 1 };
    const dearWalkIn = { ...match("P0100", false), grandTotal: 9999 };
    expect(sortInvoiceBranchMatches([dearWalkIn, cheapCallCentre])[0].branchCode).toBe("P0900");
  });

  it("leaves the input array untouched", () => {
    const rows = [match("P0505", false), match("P0221", true)];
    sortInvoiceBranchMatches(rows);
    expect(rows.map((m) => m.branchCode)).toEqual(["P0505", "P0221"]);
  });
});

describe("mergeInvoiceBranchMatches", () => {
  it("merges partial sweep results and sorts the union", () => {
    const merged = mergeInvoiceBranchMatches([
      [match("P0505", false)],
      undefined, // a part that has not answered yet
      [match("P0221", true)],
    ]);
    expect(merged.map((m) => m.branchCode)).toEqual(["P0221", "P0505"]);
  });

  it("keeps earlier results when a later part arrives", () => {
    // The regression progressive rendering invites: a row must not vanish
    // because another part resolved after it.
    const first = mergeInvoiceBranchMatches([[match("P0100", false)], undefined]);
    const second = mergeInvoiceBranchMatches([[match("P0100", false)], [match("P0221", true)]]);
    expect(first.map((m) => m.branchCode)).toEqual(["P0100"]);
    expect(second.map((m) => m.branchCode)).toEqual(["P0221", "P0100"]);
  });

  it("promotes a late Call Centre match to the top rather than appending it", () => {
    const merged = mergeInvoiceBranchMatches([
      [match("P0100", false), match("P0505", false)],
      [match("P0900", true)],
    ]);
    expect(merged[0].branchCode).toBe("P0900");
  });

  it("keeps one row per branch", () => {
    const merged = mergeInvoiceBranchMatches([[match("P0221", true)], [match("P0221", true)]]);
    expect(merged).toHaveLength(1);
  });

  it("returns nothing when no part has answered", () => {
    expect(mergeInvoiceBranchMatches([undefined, undefined])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Branch filtering                                                            */
/* -------------------------------------------------------------------------- */

const ROW = {
  branchCode: "P0221",
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

  /**
   * Area is not a search criterion. It is a coarse MIS region label that
   * duplicates the city for most branches and disagrees with it for others, so
   * searching it matched rows whose visible text had nothing to do with the
   * query. It is no longer displayed either.
   */
  it("does not match on the MIS area", () => {
    expect(matchesBranchQuery({ branchCode: "P0304", cityEnglish: "Buraydah" }, "QASIM")).toBe(
      false,
    );
  });

  it("has no area field to search at all", () => {
    // Passing one is a type error; this pins the runtime behaviour too.
    const withArea = { ...ROW, areaName: "MAKKAH" } as never;
    expect(matchesBranchQuery(withArea, "MAKKAH")).toBe(false);
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

  it("ignores the area on the row", () => {
    // P0304's area is QASIM; its city is Buraydah. Searching the area finds
    // nothing, searching the city finds it.
    expect(filterBranchStock(STOCK, "QASIM", labelsFor)).toEqual([]);
    expect(filterBranchStock(STOCK, "Buraydah", labelsFor).map((r) => r.branchCode)).toEqual([
      "P0304",
    ]);
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

/* -------------------------------------------------------------------------- */
/* Item codes                                                                  */
/* -------------------------------------------------------------------------- */

describe("looksLikeItemCode", () => {
  it("accepts a full Shams item code", () => {
    expect(looksLikeItemCode("10400746")).toBe(true);
  });

  it("accepts a partial code long enough to mean something", () => {
    expect(looksLikeItemCode("10400")).toBe(true);
  });

  it("refuses a number short enough to be part of a name", () => {
    // `400 G`, `2.5`, `800` — pack sizes and strengths, not identifiers.
    expect(looksLikeItemCode("400")).toBe(false);
    expect(looksLikeItemCode("2.5")).toBe(false);
  });

  it("refuses anything that is not purely digits", () => {
    expect(looksLikeItemCode("nan")).toBe(false);
    expect(looksLikeItemCode("104007460 g")).toBe(false);
    expect(looksLikeItemCode("nan*op")).toBe(false);
  });

  it("ignores surrounding whitespace, as a pasted code carries", () => {
    expect(looksLikeItemCode("  10400746  ")).toBe(true);
  });
});

/**
 * The exact names from the MIS, as a regression guard.
 *
 * `nan*op` was reported as finding nothing on this page. The matcher is not the
 * reason — it accepts every one of these — so this pins that down: a future
 * change to fragment parsing or ordering that broke it would show up here
 * rather than in a support message.
 */
describe("nan*op against the real catalog names", () => {
  const rows = [
    ["10400746", "NAN 2 OPTIPRO 1800 GM"],
    ["10400817", "NAN NO.3 OPTIPRO, 1800 G (2*1800)"],
    ["10400741", "NAN OPTIPRO KIDS MILK, 400 G"],
    ["10400395", "NAN OPTIPRO NO 1 400GM"],
    ["10400396", "NAN OPTIPRO NO 1 MILK  800G"],
    ["10400393", "NAN OPTIPRO NO 2  MILK, 400GM"],
  ].map(([itemCode, itemName]) => ({ itemCode, itemName, retailPrice: 1 }));

  it("parses into two ordered fragments", () => {
    expect(parseWildcardQuery("nan*op")).toEqual(["nan", "op"]);
  });

  it("matches every one of them", () => {
    const fragments = parseWildcardQuery("nan*op");
    for (const row of rows) {
      expect(matchesProductWildcard(row, fragments)).toBe(true);
    }
  });

  it("sends both fragments upstream, so either can retrieve the set", () => {
    expect(wildcardProbes(parseWildcardQuery("nan*op"), 2, 3)).toEqual(["nan", "op", "nan op"]);
  });
});
