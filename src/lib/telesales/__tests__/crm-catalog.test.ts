import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELATION_KINDS,
  RELATION_KIND_LABELS,
  buildRelationCatalog,
  isRelationKind,
  planSave,
  validateRelation,
  type RelationProduct,
} from "../relations";
import { proposeFamily } from "@/features/telesales/components/product-catalog-panel";

/**
 * One page for the catalogue, cross-sell and up-sell — and a delete that
 * deletes.
 *
 * ===========================================================================
 * The two things most worth pinning
 * ===========================================================================
 * **Identity comes from Branch Stock.** The whole reason imported item codes
 * resolve without anybody mapping them is that the catalogue's codes are the
 * pharmacy's own. A form with a name field would undo that quietly — two people
 * typing "Mounjaro 5mg" produce two rows and neither matches the import.
 *
 * **Delete removes the file and keeps the work.** The append-only trigger on
 * the activity log exists so that a tidy-up cannot erase the record of somebody
 * having spoken to a customer. Narrowing it is the riskiest thing in this
 * phase, so the narrowing itself is asserted: still no UPDATE, and DELETE only
 * for the generator's own bookkeeping rows, only inside the purge.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO = join(ROOT, "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const migration = (name: string) =>
  readFileSync(join(REPO, "supabase", "migrations", name), "utf8");

const CATALOG_PAGE = "routes/_app.telesales.catalog.tsx";
const CATALOG_PANEL = "features/telesales/components/product-catalog-panel.tsx";
const MANAGER = "features/telesales/components/relation-manager.tsx";
const FUNCTIONS = "lib/telesales.functions.ts";
const HISTORY = "features/telesales/components/import-history.tsx";
const MANAGE = "lib/telesales/manage.server.ts";
const MIGRATION = "20260912120000_telesales_crm_domains.sql";

/* ===================================================================== */
/* A. One page, not three                                                */
/* ===================================================================== */

describe("Cross & Up-sell is one screen", () => {
  it("the two screens it replaces are gone", () => {
    for (const gone of [
      "routes/_app.telesales.identity.tsx",
      "routes/_app.telesales.relations.tsx",
    ]) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
    expect(existsSync(join(ROOT, CATALOG_PAGE))).toBe(true);
  });

  it("nothing links to them any more", () => {
    // Two competing workflows visible to users is the failure mode; a dead link
    // is the other one.
    for (const file of [
      "routes/_app.telesales.index.tsx",
      "routes/_app.telesales.management.tsx",
      "routes/_app.telesales.recommended.tsx",
      CATALOG_PAGE,
    ]) {
      const text = source(file);
      expect(text, file).not.toContain('to="/telesales/identity"');
      expect(text, file).not.toContain('to="/telesales/relations"');
    }
  });

  it("the Cash page offers it as one button", () => {
    const page = source("routes/_app.telesales.index.tsx");
    expect(page).toContain('to="/telesales/catalog"');
    expect(page).toContain("Cross &amp; Up-sell");
    // And no longer as two links, which required visiting them in the right
    // order without saying so. Asserted on the link, not on the words: the
    // comment above the button explains the change and would match either way.
    expect(page).not.toMatch(/<Link to="\/telesales\/(identity|relations)"/);
  });

  it("carries the three things the brief asks for", () => {
    const page = source(CATALOG_PAGE);
    expect(page).toContain("<ProductCatalogPanel");
    expect(page).toMatch(/RelationManager kind="cross_sell"/);
    expect(page).toMatch(/RelationManager kind="up_sell"/);
  });
});

/* ===================================================================== */
/* B. Cross-sell and up-sell are one table                               */
/* ===================================================================== */

describe("up-sell is a kind, not a second table", () => {
  const catalog = buildRelationCatalog([
    { itemCode: "10611028", itemName: "MOUNJARO 5 MG", active: true },
    { itemCode: "10611030", itemName: "MOUNJARO 10 MG", active: true },
    { itemCode: "10520093", itemName: "FREESTYLE LIBRE 3 SENSOR", active: true },
  ] satisfies RelationProduct[]);

  it("has exactly two kinds and both are labelled", () => {
    expect([...RELATION_KINDS]).toEqual(["cross_sell", "up_sell"]);
    for (const k of RELATION_KINDS) expect(RELATION_KIND_LABELS[k].length).toBeGreaterThan(0);
    expect(isRelationKind("up_sell")).toBe(true);
    expect(isRelationKind("upsell")).toBe(false);
  });

  it("defaults to cross-sell rather than refusing an unknown kind", () => {
    // Every pair configured before the field existed is a cross-sell, and so is
    // a request that omits it.
    const v = validateRelation({ fromItemCode: "10611028", toItemCode: "10520093" }, catalog);
    expect(v.ok && v.value.kind).toBe("cross_sell");
    const w = validateRelation(
      { fromItemCode: "10611028", toItemCode: "10520093", kind: "nonsense" },
      catalog,
    );
    expect(w.ok && w.value.kind).toBe("cross_sell");
  });

  it("keeps the kind when it is given", () => {
    const v = validateRelation(
      { fromItemCode: "10611028", toItemCode: "10611030", kind: "up_sell" },
      catalog,
    );
    expect(v.ok && v.value.kind).toBe("up_sell");
  });

  it("changing only the kind of an existing pair is an update, not a duplicate", () => {
    /*
     * The unique key is on the pair alone, so a pair cannot be both. Saving the
     * same pair as an up-sell edits the row that is there — which is why the
     * bulk plan checks against *every* configured pair rather than only the
     * kind on screen.
     */
    const next = {
      fromItemCode: "10611028",
      toItemCode: "10611030",
      kind: "up_sell" as const,
      toItemName: "MOUNJARO 10 MG",
      note: null,
    };
    expect(
      planSave(
        { active: true, kind: "cross_sell", note: null, toItemName: "MOUNJARO 10 MG" },
        next,
      ),
    ).toBe("updated");
    expect(
      planSave({ active: true, kind: "up_sell", note: null, toItemName: "MOUNJARO 10 MG" }, next),
    ).toBe("unchanged");
  });

  it("the schema keeps one pair key and constrains the kind", () => {
    const sql = migration(MIGRATION);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cross_sell'");
    expect(sql).toContain("CHECK (kind IN ('cross_sell', 'up_sell'))");
    // No second table, and the pair key is untouched.
    expect(sql).not.toMatch(/CREATE TABLE[\s\S]{0,80}up_sell/);
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS telesales_product_relations_pair_key");
  });

  it("still infers nothing", () => {
    /*
     * "Up-sell" is exactly the word that invites breaking the Phase 8 rule.
     * Mounjaro 5 MG to 10 MG is a prescribing decision; being able to express it
     * does not make it one the software may propose.
     */
    for (const file of [MANAGER, "lib/telesales/relations.ts"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/toItemCode\s*:\s*["'`]/);
      expect(text, file).not.toMatch(/to_item_code\s*:\s*["'`]/);
    }
    expect(migration(MIGRATION)).not.toMatch(/INSERT INTO public\.telesales_product_relations/);
  });

  it("one component renders both, so they cannot drift", () => {
    const page = source(CATALOG_PAGE);
    const managers = page.match(/<RelationManager/g) ?? [];
    expect(managers).toHaveLength(2);
    // And it writes through the one existing server function.
    expect(source(MANAGER)).toContain("mutations.save.mutateAsync");
    expect(source(MANAGER)).not.toContain("supabaseAdmin");
  });
});

/* ===================================================================== */
/* C. Products come from Branch Stock                                    */
/* ===================================================================== */

describe("Add Product", () => {
  it("takes the name and code from the MIS, never from the request", () => {
    const fns = source(FUNCTIONS);
    const handler = fns.slice(
      fns.indexOf("export const telesalesAddCatalogProduct"),
      fns.indexOf("export const telesalesDeleteImpact"),
    );
    expect(handler).toContain("getProductDetail(data.itemCode)");
    expect(handler).toContain("item_code: detail.itemCode");
    expect(handler).toContain("item_name: detail.itemName");
    // The operator is never asked for a name, so there is none to accept.
    expect(handler).not.toMatch(/itemName:\s*z\./);
  });

  it("refuses a code Branch Stock does not know", () => {
    const fns = source(FUNCTIONS);
    expect(fns).toContain("Shams Branch Stock has no product with item code");
  });

  it("cannot produce a duplicate, because the code is the key", () => {
    const fns = source(FUNCTIONS);
    expect(fns).toContain('{ onConflict: "item_code" }');
    /*
     * And no "does it already exist" read anywhere: the primary key answers it,
     * and a check-then-insert would be a race two supervisors could lose.
     */
    const handler = fns.slice(
      fns.indexOf("export const telesalesAddCatalogProduct"),
      fns.indexOf("export const telesalesDeleteImpact"),
    );
    expect(handler).not.toMatch(/\.from\("telesales_products"\)[\s\S]{0,120}\.select\(/);
  });

  it("asks only for what the MIS has no opinion about", () => {
    const fns = source(FUNCTIONS);
    const validator = fns.slice(
      fns.indexOf("export const telesalesAddCatalogProduct"),
      fns.indexOf(".handler", fns.indexOf("export const telesalesAddCatalogProduct")),
    );
    for (const field of ["family", "eligibleCash", "eligibleRetention", "refillDays"]) {
      expect(validator, field).toContain(field);
    }
  });

  it("searches under manage_telesales rather than requiring the MIS page", () => {
    /*
     * A telesales supervisor curating the CRM's catalogue is not necessarily
     * granted `/shams`. This checks the permission the write on the other side
     * of the search already requires, and returns an item code and a name —
     * both of which the caller can already read on every lead.
     */
    const fns = source(FUNCTIONS);
    const handler = fns.slice(
      fns.indexOf("export const telesalesSearchCatalogSource"),
      fns.indexOf("export const telesalesAddCatalogProduct"),
    );
    expect(handler).toContain('resolveActor(supabase, userId, "manage")');
    expect(handler).toContain("searchProducts");
    // Read-only: nothing is written back to the MIS.
    expect(handler).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it("proposes a family from the name and never from a resemblance", () => {
    expect(proposeFamily("MOUNJARO KWIKPEN 5 MG")).toBe("mounjaro");
    expect(proposeFamily("FREESTYLE LIBRE 3 SENSOR")).toBe("freestyle_libre");
    /*
     * The case the pattern table was built for. FreeStyle Optium is a
     * fingerstick product and FreeStyle Libre is a continuous monitor; matching
     * on "FREESTYLE" would be wrong 81 times a month in the expensive direction.
     */
    expect(proposeFamily("FREESTYLE OPTIUM STRIPS 50's")).toBe("other");
    expect(proposeFamily("SOMETHING ELSE")).toBe("other");
  });

  it("records where a catalogue row came from", () => {
    const sql = migration(MIGRATION);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed'");
    expect(sql).toContain("CHECK (source IN ('seed', 'branch_stock', 'manual'))");
    // Provenance, not behaviour: nothing branches on it.
    expect(source(FUNCTIONS)).toContain('source: "branch_stock"');
  });
});

/* ===================================================================== */
/* D. No manual mapping, and no lost mappings either                     */
/* ===================================================================== */

describe("imported item codes resolve on their own", () => {
  it("the catalogue is matched by code, deterministically", () => {
    // `matchProduct` asks the code table first and only then the name patterns.
    const products = source("lib/telesales/products.ts");
    expect(products).toContain("catalog.byCode.get(code)");
    expect(products).toContain("normalizeItemCode(input.itemCode)");
    // Code shapes, not words: a comment explaining why fuzzy matching is wrong
    // would otherwise fail this.
    expect(products).not.toMatch(/\blevenshtein\s*\(/i);
    expect(products).not.toMatch(/\bsimilarityScore\s*\(/i);
  });

  it("the historical mappings are kept, and shown against the product", () => {
    /*
     * The retention source carries rows under an older numbering system.
     * Deleting the mapping with the screen would stop a customer who bought
     * under the old code reading as a repeat buyer — a silent regression in
     * exactly the data the recommendation engine rests on.
     */
    const panel = source(CATALOG_PANEL);
    expect(panel).toContain("useProductAliases");
    expect(panel).toContain("aliasesByCanonical");
    expect(panel).toContain("Other item codes in the source files that mean this product");
  });

  it("and can still be added, without a screen of their own", () => {
    const panel = source(CATALOG_PANEL);
    expect(panel).toContain("Link an item code");
    // Through the same validator the server runs, not a second rule.
    expect(panel).toContain("validateAlias");
    expect(panel).toContain("useAliasMutations");
  });

  it("nothing here merges two products by name", () => {
    // Mounjaro 5 MG / 7.5 MG / 10 MG stay separate products. Resemblance is not
    // evidence, and no screen in this module treats it as any.
    const panel = source(CATALOG_PANEL);
    /*
     * Asserted on what the screen can *do*, not on what it says. The dialog's
     * own comment names fuzzy similarity in order to rule it out, so a word
     * search here would fail on the prose that documents the rule.
     */
    expect(panel).toContain("validateAlias");
    expect(panel).not.toMatch(/scoreProduct|findAliasCandidates|useAliasCandidates/);
    // The canonical end is chosen from the catalogue, never typed.
    expect(panel).toContain("<Select value={canonical}");
  });
});

/* ===================================================================== */
/* E. Delete means delete                                                */
/* ===================================================================== */

describe("deleting an import", () => {
  const sql = migration(MIGRATION);

  it("removes the import, its rows and the leads nobody worked", () => {
    expect(sql).toContain("DELETE FROM public.telesales_imports WHERE id = _import_id");
    expect(sql).toContain(
      "DELETE FROM public.telesales_leads WHERE id IN (SELECT id FROM _doomed)",
    );
  });

  it("keeps a lead that has become independent CRM activity", () => {
    const doomed = sql.slice(
      sql.indexOf("CREATE TEMP TABLE _doomed"),
      sql.indexOf("SELECT count(*) INTO _kept"),
    );
    expect(doomed).toContain("l.last_outcome IS NULL");
    expect(doomed).toContain("l.order_id IS NULL");
    expect(doomed).toContain("l.converted_at IS NULL");
    expect(doomed).toContain("a.activity_type <> 'created'");
    // A parent of a retention cycle is kept too: deleting it would strand the
    // child in the queue with a parent nobody can open.
    expect(doomed).toContain("c.parent_lead_id = l.id");
  });

  it("narrows the append-only trigger rather than removing it", () => {
    /*
     * The riskiest line in the phase. UPDATE stays refused unconditionally;
     * DELETE is permitted only inside the purge AND only for a 'created' row,
     * which is generator bookkeeping rather than an interaction. A mistake in
     * the selection above therefore aborts the transaction instead of
     * destroying a call log.
     */
    const trigger = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.telesales_activity_is_immutable"),
      sql.indexOf("telesales_delete_impact"),
    );
    expect(trigger).toContain("IF TG_OP = 'DELETE'");
    expect(trigger).toContain("current_setting('telesales.purge_import', true)");
    expect(trigger).toContain("OLD.activity_type = 'created'");
    expect(trigger).toContain("RAISE EXCEPTION");
    // No path lets an UPDATE through.
    expect(trigger).not.toContain("TG_OP = 'UPDATE'");
  });

  it("sets the purge flag transaction-locally and only in the delete", () => {
    expect(sql).toContain("set_config('telesales.purge_import', 'on', true)");
    // Set once, read once. `SET LOCAL` unwinds on commit or rollback, so
    // nothing outside the delete's own transaction ever sees the flag.
    expect(sql.match(/set_config\('telesales\.purge_import'/g)?.length).toBe(1);
    expect(sql.match(/current_setting\('telesales\.purge_import'/g)?.length).toBe(1);
  });

  it("counts what it will take before it takes it", () => {
    // After the RPC there is nothing left to count, and the audit entry is the
    // only record that the file existed.
    const manage = source(MANAGE);
    expect(manage).toContain("const impact = await describeDeleteImpact(supabase, input.importId)");
    expect(source(FUNCTIONS)).toContain("AUDIT_ACTIONS.telesalesImportDeleted");
  });

  it("leaves no archive workflow beside it", () => {
    const history = source(HISTORY);
    expect(history).toContain("Delete import");
    expect(history).toContain("This cannot be undone.");
    expect(history).not.toContain("telesalesArchiveImport");
    expect(history).not.toContain("telesalesRestoreImport");
    // The badge stays: a handful of production imports carry the old state and
    // should not be mysterious.
    expect(history).toContain("Archived");
  });

  it("keeps the guard that stops an archived import re-generating", () => {
    // Production carries imports archived under the old behaviour, and the QA
    // pass proved this guard is load-bearing: without it a deliberately
    // archived Wasfaty file would have re-created 47 leads.
    expect(source("lib/telesales/generate.server.ts")).toContain('.is("archived_at", null)');
  });

  it("indexes the two new Wasfaty predicates", () => {
    expect(sql).toContain("telesales_leads_type_date_idx");
    expect(sql).toContain("telesales_leads_worked_idx");
    // Partial on the same condition every working read applies.
    expect(sql.match(/WHERE archived_at IS NULL/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
