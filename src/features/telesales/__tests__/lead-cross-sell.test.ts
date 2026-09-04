import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { applicableCrossSell } from "@/lib/telesales/relations";
import { groupRelationsByItem, type ProductRelation } from "@/lib/telesales/recommendations";
import { buildProductIdentityIndex, type IdentityAlias } from "@/lib/telesales/identity";

/**
 * Cross-sell, on the lead page.
 *
 * The rule is pure and is tested by calling it. The "reuses the existing
 * configuration and makes no per-relation request" requirements are structural,
 * so they are pinned by reading the source — the technique `queue-isolation`
 * established, and the only kind of assertion that can tell a shared read from
 * a faithful copy of one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const HOOK = "features/telesales/hooks/use-lead-cross-sell.ts";
const PANEL = "features/telesales/components/lead-cross-sell-panel.tsx";
const LEAD_PAGE = "routes/_app.telesales.$id.tsx";
const QUEUE_FILES = [
  "features/telesales/hooks/use-telesales-queue.ts",
  "features/telesales/components/lead-row.tsx",
  "routes/_app.telesales.index.tsx",
];

/* ===================================================================== */
/* Fixtures — the live codes                                             */
/* ===================================================================== */

const MOUNJARO_5 = "10611028";
const MOUNJARO_15 = "10611032";
const LIBRE = "99001";
const DEXCOM = "99002";
/** One of the real alias codes for the 5 MG pen, from the source workbook. */
const ALIAS_5 = "519914";

const CATALOGUE = [
  { itemCode: MOUNJARO_5, itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA" },
  { itemCode: MOUNJARO_15, itemName: "MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR" },
  { itemCode: LIBRE, itemName: "FREESTYLE LIBRE 3 SENSOR" },
  { itemCode: DEXCOM, itemName: "DEXCOM G7 SENSOR" },
];

const ALIASES: IdentityAlias[] = [
  { aliasItemCode: ALIAS_5, canonicalItemCode: MOUNJARO_5, active: true },
];

const identity = buildProductIdentityIndex(CATALOGUE, ALIASES);

function relation(from: string, to: string, toName: string, note: string | null = null) {
  return { fromItemCode: from, toItemCode: to, toItemName: toName, note };
}

/** Active relations only, exactly as the hook loads them. */
function grouped(rows: ProductRelation[]) {
  return groupRelationsByItem(rows);
}

function apply(
  product: { itemCode: string | null; itemName: string | null },
  rows: ProductRelation[],
) {
  return applicableCrossSell({ product, identity, relationsByItem: grouped(rows) });
}

/* ===================================================================== */
/* A. The rule                                                           */
/* ===================================================================== */

describe("applicableCrossSell", () => {
  it("returns the configured companion for the lead's product", () => {
    const out = apply({ itemCode: MOUNJARO_5, itemName: null }, [
      relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR", "Patients on GLP-1 monitor glucose"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].toItemCode).toBe(LIBRE);
    // The desk's own words travel with the pair.
    expect(out[0].note).toBe("Patients on GLP-1 monitor glucose");
  });

  it("returns every configured companion, not just the first", () => {
    /*
     * The recommendation engine picks one, because a lead carries one headline
     * recommendation. This panel is showing the configuration, so it shows all
     * of it.
     */
    const out = apply({ itemCode: MOUNJARO_5, itemName: null }, [
      relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR"),
      relation(MOUNJARO_5, DEXCOM, "DEXCOM G7 SENSOR"),
    ]);
    expect(out.map((r) => r.toItemCode)).toEqual([LIBRE, DEXCOM].sort());
  });

  it("returns nothing when the desk has configured nothing", () => {
    expect(apply({ itemCode: MOUNJARO_5, itemName: null }, [])).toEqual([]);
  });

  it("shows no relation configured for a different product", () => {
    // The 15 MG pen's lead must not inherit the 5 MG pen's companions.
    const rows = [relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR")];
    expect(apply({ itemCode: MOUNJARO_15, itemName: null }, rows)).toEqual([]);
  });

  it("resolves an alias code to the catalogue product the relation is against", () => {
    /*
     * The reason identity is involved at all. A relation can only be configured
     * against a `telesales_products` code, and 88 live leads carry the source
     * workbook's other numbering — matching on the raw code alone would show
     * them nothing.
     */
    const rows = [relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR")];
    const out = apply({ itemCode: ALIAS_5, itemName: null }, rows);
    expect(out.map((r) => r.toItemCode)).toEqual([LIBRE]);
  });

  it("resolves by exact product name when the lead carries no code", () => {
    const rows = [relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR")];
    const out = apply({ itemCode: null, itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA" }, rows);
    expect(out.map((r) => r.toItemCode)).toEqual([LIBRE]);
  });

  it("never equates two strengths of the same medicine", () => {
    // The rule the whole identity layer exists to protect.
    const rows = [relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR")];
    expect(
      apply({ itemCode: null, itemName: "MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR" }, rows),
    ).toEqual([]);
  });

  it("lists a companion once even when raw and canonical are both configured", () => {
    // Otherwise the same decision reads as two recommendations.
    const rows = [
      relation(ALIAS_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR"),
      relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR"),
    ];
    expect(apply({ itemCode: ALIAS_5, itemName: null }, rows)).toHaveLength(1);
  });

  it("is deterministic across calls", () => {
    const rows = [
      relation(MOUNJARO_5, DEXCOM, "DEXCOM G7 SENSOR"),
      relation(MOUNJARO_5, LIBRE, "FREESTYLE LIBRE 3 SENSOR"),
    ];
    const once = apply({ itemCode: MOUNJARO_5, itemName: null }, rows).map((r) => r.toItemCode);
    for (let i = 0; i < 20; i++) {
      expect(
        apply({ itemCode: MOUNJARO_5, itemName: null }, rows).map((r) => r.toItemCode),
      ).toEqual(once);
    }
  });

  it("returns nothing for a lead with no product at all", () => {
    expect(apply({ itemCode: null, itemName: null }, [])).toEqual([]);
  });
});

/* ===================================================================== */
/* B. Inactive relations                                                 */
/* ===================================================================== */

describe("an inactive relation is not shown", () => {
  it("is filtered at the read, matching the recommendation engine", () => {
    /*
     * The filter lives in the hook, on the same `active` flag the engine loads
     * with. Duplicating it inside the pure rule as well is how two filters come
     * to disagree, so the rule takes what it is given.
     */
    const hook = source(HOOK);
    expect(hook).toMatch(/\.filter\(\(r\) => r\.active\)/);
  });

  it("and a switched-off pair therefore reaches the rule as nothing", () => {
    // What the hook hands over once the filter has run.
    expect(apply({ itemCode: MOUNJARO_5, itemName: null }, [])).toEqual([]);
  });
});

/* ===================================================================== */
/* C. It reuses the existing configuration and resolver                  */
/* ===================================================================== */

describe("the lead panel reuses what already exists", () => {
  const hook = source(HOOK);

  it("reads the configured relations through the existing hook", () => {
    expect(hook).toContain("useProductRelations");
    // Not a fourth query against the table.
    expect(hook).not.toContain("telesales_product_relations");
    expect(hook).not.toContain("supabase");
  });

  it("resolves identity through the module's one resolver", () => {
    expect(hook).toContain("useIdentityIndex");
    const rules = source("lib/telesales/relations.ts");
    expect(rules).toContain("resolveTelesalesProductIdentity");
  });

  it("groups relations with the engine's own helper", () => {
    expect(hook).toContain("groupRelationsByItem");
  });

  it("leaves the recommendation engine's own rule untouched", () => {
    /*
     * `findRelation` picks the single headline cross-sell and excludes what the
     * customer already owns. That is a different question and this phase did
     * not change it.
     */
    const engine = source("lib/telesales/recommendations.ts");
    expect(engine).toContain("function findRelation");
    expect(engine).toContain("Never recommend something the customer has already bought");
  });

  it("creates no relationship and infers none", () => {
    for (const file of [HOOK, PANEL]) {
      const text = source(file);
      expect(text, `${file} must not write a relation`).not.toContain(
        "telesalesSaveProductRelation",
      );
      expect(text).not.toContain("telesalesSetProductRelationActive");
      expect(text).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    }
  });

  it("does not change the management screen", () => {
    /*
     * The screen moved into the unified Cross & Up-sell page and became a
     * component rendered once per kind. What it does is unchanged, which is
     * what this asserts: the same form, and the same server-side validator
     * behind it.
     */
    const page = source("features/telesales/components/relation-manager.tsx");
    expect(page).toContain("Add {label.toLowerCase()}");
    expect(page).toContain("telesalesSaveProductRelation");
  });
});

/* ===================================================================== */
/* D. Performance                                                        */
/* ===================================================================== */

describe("performance", () => {
  it("makes no request per cross-sell product", () => {
    const hook = source(HOOK);
    // Three fixed hooks, whatever the number of relations.
    expect(hook).toContain("useAliasProducts");
    expect(hook).toContain("useProductAliases");
    expect(hook).toContain("useProductRelations");
    // Nothing per-relation.
    expect(hook).not.toMatch(/useQueries/);
    expect(hook).not.toMatch(/relations\.(data|map)[\s\S]{0,200}useQuery/);
  });

  it("adds no Shams MIS request", () => {
    /*
     * Stock is per product per branch and would be one upstream call per
     * companion on every lead open. Deliberately not shown.
     */
    for (const file of [HOOK, PANEL]) {
      const text = source(file);
      for (const forbidden of [
        "shamsGetProduct",
        "@/lib/shams.functions",
        "branchStockState",
        "useLeadStock",
      ]) {
        expect(text, `${file} must not reach the MIS via ${forbidden}`).not.toContain(forbidden);
      }
      expect(text).not.toMatch(/\bfetch\(/);
    }
  });

  it("keeps the queue free of cross-sell data", () => {
    for (const file of QUEUE_FILES) {
      const text = source(file);
      expect(text, `${file} must not load cross-sell data`).not.toContain("useLeadCrossSell");
      expect(text).not.toContain("LeadCrossSellPanel");
      expect(text).not.toContain("useProductRelations");
    }
  });

  it("is rendered once, by the lead detail page", () => {
    const page = source(LEAD_PAGE);
    expect(page).toContain("useLeadCrossSell");
    expect(page).toContain("<LeadCrossSellPanel");
  });
});

/* ===================================================================== */
/* E. States                                                             */
/* ===================================================================== */

describe("the panel states", () => {
  const panel = source(PANEL);

  it("has a loading state", () => {
    expect(panel).toContain("isLoading");
  });

  it("distinguishes 'none configured' from 'could not be read'", () => {
    /*
     * The difference between a decision nobody has made and a read that failed.
     * Showing the second as the first would tell an agent there is nothing to
     * offer when there might be.
     */
    expect(panel).toContain("No cross-sell configured");
    expect(panel).toContain("could not be loaded");
    // Fragment rather than the whole sentence: the copy is prose and prettier
    // wraps it, so asserting the full string would fail on a reflow.
    expect(panel).toContain("not a statement that none");
  });

  it("says the pairs are configured rather than suggested", () => {
    expect(panel).toContain("Configured by a team lead, not inferred");
  });

  it("shows the catalogue information each target carries", () => {
    expect(panel).toContain("r.toItemName");
    expect(panel).toContain("r.toItemCode");
    expect(panel).toContain("r.note");
  });

  it("does not block the rest of the lead page", () => {
    const page = source(LEAD_PAGE);
    expect(page).not.toMatch(/await[\s\S]{0,40}LeadCrossSellPanel/);
    expect(page).not.toMatch(/crossSell\.isLoading[\s\S]{0,40}return/);
  });
});
