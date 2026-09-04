import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSearchIndex,
  groupBySource,
  planBulkAssign,
  queuedSources,
  scoreProduct,
  searchProducts,
  type RelationRow,
} from "../relation-search";
import { buildRelationCatalog, planSave, validateRelation } from "../relations";

/**
 * Cross-sell management: finding a product, and applying one target to a family.
 *
 * The screen's job used to be two dropdowns of 28 products. What changed is how
 * a supervisor gets to a product and how many pairs one action configures —
 * not what a pair is, and not what the server will accept. So these tests are
 * mostly about the two new pure rules, plus a set that pins the safeguards as
 * still being the ones `relations.ts` already enforced.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const M25 = "10611027";
const M5 = "10611028";
const M75 = "10611029";
const M15 = "10611032";
const LIBRE = "99001";
const DEXCOM = "99002";
const RETIRED = "88000";

const PRODUCTS = [
  { itemCode: M25, itemName: "MOUNJARO KWIKPEN 2.5 MG", active: true },
  { itemCode: M5, itemName: "MOUNJARO KWIKPEN 5 MG", active: true },
  { itemCode: M75, itemName: "MOUNJARO KWIKPEN 7.5 MG", active: true },
  { itemCode: M15, itemName: "MOUNJARO KWIKPEN 15 MG", active: true },
  { itemCode: LIBRE, itemName: "FREESTYLE LIBRE 3 SENSOR", active: true },
  { itemCode: DEXCOM, itemName: "DEXCOM G7 SENSOR", active: true },
  { itemCode: RETIRED, itemName: "DISCONTINUED METER", active: false },
];

/** One of the real alias codes for the 5 MG pen, from the retention workbook. */
const ALIAS_5 = "519914";

const ALIASES = [
  { alias_item_code: ALIAS_5, canonical_item_code: M5, active: true },
  { alias_item_code: "999999", canonical_item_code: M15, active: false },
];

const index = buildSearchIndex(PRODUCTS, ALIASES);
const catalog = buildRelationCatalog(PRODUCTS);

const codes = (q: string, opts = {}) =>
  searchProducts(index, q, opts).map((r) => r.product.itemCode);

function relation(over: Partial<RelationRow> & { from_item_code: string; to_item_code: string }) {
  return {
    id: `${over.from_item_code}-${over.to_item_code}`,
    to_item_name: "TARGET",
    note: null,
    active: true,
    ...over,
  } as RelationRow;
}

/* ===================================================================== */
/* A. Searching                                                          */
/* ===================================================================== */

describe("searching the catalogue", () => {
  it("finds a product by name", () => {
    expect(codes("freestyle")).toEqual([LIBRE]);
    expect(codes("dexcom")).toEqual([DEXCOM]);
  });

  it("finds a product by item code", () => {
    expect(codes(M5)).toEqual([M5]);
  });

  it("finds a product by a partial item code", () => {
    // A supervisor pasting the first digits of a code they are reading off a
    // sheet. All the Mounjaro codes share a prefix, so this must not be exact.
    expect(codes("106110").sort()).toEqual([M25, M5, M75, M15].sort());
  });

  it("finds a whole family by the words they share", () => {
    // The bulk case begins here: type "mounjaro", tick four.
    expect(codes("mounjaro").sort()).toEqual([M25, M5, M75, M15].sort());
  });

  it("finds a product by an alias code", () => {
    /*
     * The retention source uses two code systems for the same medicines, so a
     * supervisor holding the workbook is as likely to have `519914` as the
     * catalogue code.
     */
    const hits = searchProducts(index, ALIAS_5);
    expect(hits.map((h) => h.product.itemCode)).toEqual([M5]);
    // And says why it is in the list, or the row looks unrelated to the query.
    expect(hits[0].viaAlias).toBe(ALIAS_5);
  });

  it("ignores an alias that is switched off", () => {
    expect(codes("999999")).toEqual([]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(codes("  MoUnJaRo   KwIkPeN  ").sort()).toEqual([M25, M5, M75, M15].sort());
  });

  it("matches across a gap with a wildcard, as the Stock tab does", () => {
    /*
     * "mounjaro 5" is not a substring of "MOUNJARO KWIKPEN 5 MG", and a plain
     * contains-match says so. That is the Shams search's own behaviour and the
     * reason it has wildcards; reusing its matcher means the same expression
     * works on both screens.
     */
    expect(codes("mounjaro 5")).toEqual([]);
    expect(codes("*mounjaro*5*").sort()).toEqual([M25, M5, M75, M15].sort());
    expect(codes("*kwikpen*15*")).toEqual([M15]);
  });

  it("ranks the product they typed above one that merely contains it", () => {
    const ranked = codes("MOUNJARO KWIKPEN 5 MG");
    expect(ranked[0]).toBe(M5);
  });

  it("ranks a catalogue code above an alias that contains the same digits", () => {
    // The product's own identity beats a synonym.
    const withCollision = buildSearchIndex(PRODUCTS, [
      { alias_item_code: `${M15}0`, canonical_item_code: M5, active: true },
    ]);
    expect(searchProducts(withCollision, M15)[0].product.itemCode).toBe(M15);
  });

  it("returns everything for an empty query, in name order", () => {
    // The screen opens showing what is available, which is what the dropdown
    // did well and is worth keeping.
    const all = searchProducts(index, "");
    expect(all).toHaveLength(PRODUCTS.length - 1); // the inactive one is excluded
    expect(all.map((r) => r.product.itemName)).toEqual(
      [...all.map((r) => r.product.itemName)].sort(),
    );
  });

  it("hides switched-off products unless asked for them", () => {
    expect(codes("discontinued")).toEqual([]);
    expect(codes("discontinued", { includeInactive: true })).toEqual([RETIRED]);
  });

  it("returns nothing rather than everything for a query that matches nothing", () => {
    expect(codes("aspirin")).toEqual([]);
  });

  it("is deterministic", () => {
    const once = codes("mounjaro");
    for (let i = 0; i < 20; i++) expect(codes("mounjaro")).toEqual(once);
  });

  it("scores a non-match as null so the caller can filter in one pass", () => {
    expect(scoreProduct(index[0], "aspirin")).toBeNull();
    expect(scoreProduct(index[0], "")).toBe(0);
  });
});

/* ===================================================================== */
/* B. One target, many sources                                           */
/* ===================================================================== */

describe("applying one target to several sources", () => {
  it("queues every selected strength", () => {
    // The task the feature exists for: four strengths, one sensor, one action.
    const plan = planBulkAssign({ sources: [M25, M5, M75, M15], target: LIBRE, existing: [] });
    expect(queuedSources(plan)).toEqual([M25, M5, M75, M15].sort());
  });

  it("refuses a source that is the target, without refusing the rest", () => {
    /*
     * Selecting a family and a companion that is in it is an ordinary slip. The
     * one impossible pair is dropped and the other three still go.
     */
    const plan = planBulkAssign({ sources: [M25, M5, LIBRE], target: LIBRE, existing: [] });
    expect(queuedSources(plan)).toEqual([M25, M5].sort());
    expect(plan.find((p) => p.source === LIBRE)?.status).toBe("self");
  });

  it("leaves an already-configured pair alone", () => {
    // Requirement: existing relations are unchanged unless explicitly acted on.
    const existing = [relation({ from_item_code: M5, to_item_code: LIBRE })];
    const plan = planBulkAssign({ sources: [M25, M5], target: LIBRE, existing });
    expect(queuedSources(plan)).toEqual([M25]);
    expect(plan.find((p) => p.source === M5)?.status).toBe("exists");
  });

  it("offers a switched-off pair as a re-application", () => {
    /*
     * That is how reactivation happens: `planSave` turns a save over an
     * inactive row into a reactivation rather than a duplicate, so the pair
     * must reach the server rather than be filtered out here.
     */
    const existing = [relation({ from_item_code: M5, to_item_code: LIBRE, active: false })];
    expect(queuedSources(planBulkAssign({ sources: [M5], target: LIBRE, existing }))).toEqual([M5]);
    expect(
      planSave(
        { active: false, note: null, toItemName: "x" },
        {
          fromItemCode: M5,
          toItemCode: LIBRE,
          toItemName: "x",
          note: null,
        },
      ),
    ).toBe("reactivated");
  });

  it("ignores a pair configured against a different target", () => {
    const existing = [relation({ from_item_code: M5, to_item_code: DEXCOM })];
    expect(queuedSources(planBulkAssign({ sources: [M5], target: LIBRE, existing }))).toEqual([M5]);
  });

  it("de-duplicates a source selected twice", () => {
    const plan = planBulkAssign({ sources: [M5, M5, " " + M5 + " "], target: LIBRE, existing: [] });
    expect(queuedSources(plan)).toEqual([M5]);
  });

  it("plans nothing from an empty selection", () => {
    expect(planBulkAssign({ sources: [], target: LIBRE, existing: [] })).toEqual([]);
  });

  it("is deterministic in the order it will write", () => {
    // A supervisor reading the preview should see the same list they get.
    const a = queuedSources(
      planBulkAssign({ sources: [M75, M25, M5], target: LIBRE, existing: [] }),
    );
    const b = queuedSources(
      planBulkAssign({ sources: [M5, M75, M25], target: LIBRE, existing: [] }),
    );
    expect(a).toEqual(b);
  });
});

/* ===================================================================== */
/* C. The safeguards are the ones that already existed                   */
/* ===================================================================== */

describe("the existing safeguards still decide", () => {
  it("the server validator still refuses a self-relation", () => {
    expect(validateRelation({ fromItemCode: LIBRE, toItemCode: LIBRE }, catalog)).toEqual({
      ok: false,
      reason: "same_product",
    });
  });

  it("the server validator still refuses a product that is not in the catalogue", () => {
    expect(validateRelation({ fromItemCode: M5, toItemCode: "999" }, catalog)).toEqual({
      ok: false,
      reason: "unknown_target",
    });
    // An alias code is a way to *find* a product, never a thing to store: it is
    // not a catalogue code and the validator says so.
    expect(validateRelation({ fromItemCode: M5, toItemCode: ALIAS_5 }, catalog)).toEqual({
      ok: false,
      reason: "unknown_target",
    });
  });

  it("the server validator still refuses a switched-off target", () => {
    expect(validateRelation({ fromItemCode: M5, toItemCode: RETIRED }, catalog)).toEqual({
      ok: false,
      reason: "inactive_target",
    });
  });

  it("still allows a switched-off source", () => {
    // A customer may have bought something the desk has stopped selling, and
    // that purchase is still a real fact to recommend from.
    expect(validateRelation({ fromItemCode: RETIRED, toItemCode: LIBRE }, catalog).ok).toBe(true);
  });

  it("saving an unchanged pair is still a no-op", () => {
    expect(
      planSave(
        { active: true, note: "why", toItemName: "FREESTYLE LIBRE 3 SENSOR" },
        {
          fromItemCode: M5,
          toItemCode: LIBRE,
          toItemName: "FREESTYLE LIBRE 3 SENSOR",
          note: "why",
        },
      ),
    ).toBe("unchanged");
  });

  it("the bulk plan never relaxes what the server checks", () => {
    /*
     * The preview is a courtesy. Every queued pair still goes through
     * `telesalesSaveProductRelation`, which re-runs `validateRelation` and
     * lets the unique key arbitrate.
     */
    const page = source("routes/_app.telesales.relations.tsx");
    expect(page).toContain("mutations.save.mutateAsync");
    expect(page).not.toMatch(
      /\.from\("telesales_product_relations"\)[\s\S]{0,200}\.(insert|update)/,
    );
  });
});

/* ===================================================================== */
/* D. Grouping                                                           */
/* ===================================================================== */

describe("grouping the configured pairs by source", () => {
  const rows = [
    relation({ from_item_code: M5, to_item_code: LIBRE, to_item_name: "LIBRE" }),
    relation({ from_item_code: M5, to_item_code: DEXCOM, to_item_name: "DEXCOM" }),
    relation({ from_item_code: M25, to_item_code: LIBRE, to_item_name: "LIBRE", active: false }),
  ];

  it("gathers every target under its source", () => {
    const groups = groupBySource(rows, catalog);
    expect(groups).toHaveLength(2);
    const five = groups.find((g) => g.fromItemCode === M5)!;
    expect(five.targets).toHaveLength(2);
    expect(five.activeCount).toBe(2);
  });

  it("names the source from the catalogue", () => {
    expect(groupBySource(rows, catalog)[0].fromItemName).toContain("MOUNJARO");
  });

  it("falls back to the code for a source the catalogue no longer carries", () => {
    const orphan = [relation({ from_item_code: "77777", to_item_code: LIBRE })];
    expect(groupBySource(orphan, catalog)[0].fromItemName).toBe("77777");
  });

  it("counts active separately from configured", () => {
    const group = groupBySource(rows, catalog).find((g) => g.fromItemCode === M25)!;
    expect(group.targets).toHaveLength(1);
    expect(group.activeCount).toBe(0);
  });

  it("orders sources by name and puts active targets first", () => {
    const groups = groupBySource(
      [...rows, relation({ from_item_code: M25, to_item_code: DEXCOM, to_item_name: "DEXCOM" })],
      catalog,
    );
    expect(groups.map((g) => g.fromItemName)).toEqual(
      [...groups.map((g) => g.fromItemName)].sort(),
    );
    const first = groups[0];
    expect(first.targets[0].active).toBe(true);
  });

  it("preserves the row's own columns, so the list can still show who added it", () => {
    const withAudit = [{ ...rows[0], created_by: "u1", created_at: "2026-09-01" }];
    const out = groupBySource(withAudit, catalog);
    expect(out[0].targets[0].created_by).toBe("u1");
  });

  it("returns nothing for no relations", () => {
    expect(groupBySource([], catalog)).toEqual([]);
  });
});

/* ===================================================================== */
/* E. Nothing was duplicated                                             */
/* ===================================================================== */

describe("no second catalogue and no second search API", () => {
  it("the search is a filter over the products the screen already loaded", () => {
    const mod = source("lib/telesales/relation-search.ts");
    expect(mod).not.toContain("supabase");
    expect(mod).not.toMatch(/\bfetch\(/);
    expect(mod).not.toContain("useQuery");
    // And no MIS lookup: a cross-sell can only be a telesales_products row, so
    // offering MIS results would fill the list with refusals.
    expect(mod).not.toContain("shamsSearchProducts");
    expect(mod).not.toContain("@/lib/shams.functions");
  });

  it("reuses the Shams module's own string matching rather than restating it", () => {
    const mod = source("lib/telesales/relation-search.ts");
    expect(mod).toContain('from "@/lib/shams/search"');
    expect(mod).toContain("normalizeForSearch");
    expect(mod).toContain("looksLikeItemCode");
  });

  it("the picker holds no data of its own", () => {
    const picker = source("features/telesales/components/product-picker.tsx");
    expect(picker).not.toContain("useQuery");
    expect(picker).not.toContain("supabase");
    expect(picker).toContain("searchProducts");
  });

  it("the screen writes through the existing server function only", () => {
    const page = source("routes/_app.telesales.relations.tsx");
    expect(page).toContain("useRelationMutations");
    expect(page).not.toContain("supabaseAdmin");
    // The catalogue and the aliases are the reads the other product screens make.
    expect(page).toContain("useRelationProducts");
    expect(page).toContain("useProductAliases");
  });

  it("the recommendation engine and the lead panel are untouched", () => {
    const engine = source("lib/telesales/recommendations.ts");
    expect(engine).toContain("function findRelation");
    const lead = source("lib/telesales/relations.ts");
    expect(lead).toContain("applicableCrossSell");
  });
});
