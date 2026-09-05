/**
 * The guarantees the catalogue migration has to keep.
 *
 * The SQL cannot be executed here — it needs a database — so what is asserted is
 * that the clauses carrying its invariants are still in the file. Each one is
 * there because removing it breaks something silently:
 *
 *   * RLS with no read policy, or the full 8,484-row catalogue becomes something
 *     any signed-in browser can `select *` — the 700 KB download this work
 *     removed, served from a different host;
 *   * an index per branch of the search's OR, or the planner drops the BitmapOr
 *     and every keystroke becomes a sequential scan;
 *   * the promotion floor, or a truncated download replaces a good catalogue
 *     with a broken one and product search stops working mid-shift;
 *   * the tick's catalogue gate, or the refresh never runs at all.
 *
 * The seed is checked too, against the real `normalizeForSearch`: its
 * `search_name` values were computed by a standalone Node script with its own
 * copy of that transformation, and a divergence would show up as products that
 * exist but cannot be found.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeForSearch } from "../search";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../supabase/migrations/${name}`, import.meta.url)),
    "utf8",
  );

const sql = read("20260915120000_shams_product_catalog.sql");
const seed = read("20260915120100_shams_product_catalog_seed.sql");

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

describe("the catalogue table", () => {
  it("keys on the item code, which is what makes a refresh an upsert", () => {
    expect(sql).toMatch(/item_code\s+text PRIMARY KEY/);
  });

  it("carries exactly the fields the source can fill, and the two timestamps", () => {
    for (const column of [
      "item_code",
      "item_name",
      "search_name",
      "retail_price",
      "source_updated_at",
      "updated_at",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("refuses a row that cannot be searched or selected", () => {
    expect(sql).toContain("CHECK (btrim(item_code) <> '')");
    expect(sql).toContain("CHECK (btrim(item_name) <> '')");
  });
});

describe("access", () => {
  it("enables RLS on the catalogue and its staging table", () => {
    expect(sql).toContain("ALTER TABLE public.shams_product_catalog ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain(
      "ALTER TABLE public.shams_product_catalog_staging ENABLE ROW LEVEL SECURITY",
    );
  });

  it("grants no policy on the catalogue, so no browser session can read it", () => {
    /*
     * The load-bearing negative. A policy here would look like a reasonable
     * convenience for `view_shams_mis` holders and would quietly reinstate the
     * whole-catalogue download the search change exists to remove.
     */
    const catalogSection = sql.slice(
      sql.indexOf("ALTER TABLE public.shams_product_catalog ENABLE"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS public.shams_catalog_state"),
    );
    expect(catalogSection).not.toMatch(/CREATE POLICY[\s\S]*ON public\.shams_product_catalog\b/);
  });

  it("lets administrators read the state row, which is telemetry rather than data", () => {
    expect(sql).toContain('CREATE POLICY "Administrators can read Shams catalogue state"');
    expect(sql).toContain("USING (public.is_administrator(auth.uid()))");
  });

  it("revokes both functions from every browser-reachable role", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.shams_search_product_catalog\(text, text, integer\)\s*\n\s*FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.shams_promote_product_catalog\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("keeps the search function SECURITY INVOKER", () => {
    // SECURITY DEFINER would turn it into a way around the table's RLS for a
    // session that could not read the table directly.
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.shams_search_product_catalog"),
      sql.indexOf("REVOKE ALL ON FUNCTION public.shams_search_product_catalog"),
    );
    expect(fn).not.toContain("SECURITY DEFINER");
  });
});

/* -------------------------------------------------------------------------- */
/* Indexes                                                                     */
/* -------------------------------------------------------------------------- */

describe("indexes", () => {
  it("indexes the name for substring and ordered-fragment matching", () => {
    expect(sql).toContain("ON public.shams_product_catalog USING gin (search_name gin_trgm_ops)");
  });

  it("indexes the item code both ways the search reaches for it", () => {
    // A wildcard written against a code has no anchored prefix, so it needs
    // trigrams; a partial code is a prefix, so it needs text_pattern_ops. The
    // primary key answers neither.
    expect(sql).toContain("ON public.shams_product_catalog USING gin (item_code gin_trgm_ops)");
    expect(sql).toContain("ON public.shams_product_catalog (item_code text_pattern_ops)");
  });

  it("installs pg_trgm in the same schema the rest of the project uses", () => {
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions");
  });

  it("resolves gin_trgm_ops through the search path rather than hardcoding its schema", () => {
    /*
     * `WITH SCHEMA extensions` only places the extension when that statement is
     * the one installing it. Where pg_trgm already exists elsewhere — `public`,
     * as PostGIS does on this deployment — `IF NOT EXISTS` is a no-op and a
     * hardcoded `extensions.gin_trgm_ops` would fail to resolve and take the
     * whole migration down with it. Every other object stays qualified, so
     * widening the path costs nothing.
     */
    expect(sql).toContain("SET LOCAL search_path = public, extensions;");
    // The statements, not the prose: the comment above them names the schema
    // precisely to explain why the indexes must not.
    for (const line of sql.split("\n").filter((l) => l.includes("gin_trgm_ops"))) {
      if (line.trim().startsWith("--")) continue;
      expect(line).not.toContain("extensions.gin_trgm_ops");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Promotion                                                                   */
/* -------------------------------------------------------------------------- */

describe("promotion", () => {
  it("raises rather than promoting a batch below the floor", () => {
    expect(sql).toContain("IF staged_rows < floor_rows THEN");
    expect(sql).toContain("RAISE EXCEPTION");
    // Raising, not returning a verdict: an exception is what guarantees the swap
    // below cannot have half happened.
    expect(sql).toContain("USING ERRCODE = 'data_exception'");
  });

  it("does the swap in one statement, so there is no empty window", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.shams_promote"));
    expect(fn).toMatch(/WITH incoming AS \([\s\S]*upserted AS \([\s\S]*removed AS \(/);
    expect(fn).toContain("ON CONFLICT (item_code) DO UPDATE");
  });

  it("leaves a row alone when nothing about it changed", () => {
    // Without this every refresh rewrites 8,484 rows and both GIN indexes, and
    // `source_updated_at` decays into a copy of the refresh time.
    expect(sql).toContain("WHERE c.item_name    IS DISTINCT FROM EXCLUDED.item_name");
    expect(sql).toContain("OR c.retail_price IS DISTINCT FROM EXCLUDED.retail_price");
  });

  it("deletes only products the incoming catalogue does not list", () => {
    expect(sql).toContain(
      "WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE i.item_code = c.item_code)",
    );
  });

  it("records success from inside the swap, where it cannot be claimed falsely", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.shams_promote"));
    expect(fn).toContain("UPDATE public.shams_catalog_state");
    expect(fn).toContain("last_outcome    = 'success'");
  });
});

/* -------------------------------------------------------------------------- */
/* The tick                                                                    */
/* -------------------------------------------------------------------------- */

describe("shams_sync_tick", () => {
  it("wakes the application when the catalogue is due", () => {
    expect(sql).toContain("SELECT count(*) INTO catalog_due");
    expect(sql).toContain("c.next_refresh_due_at IS NULL OR c.next_refresh_due_at <= now()");
    expect(sql).toContain("IF open_count = 0 AND due_count = 0 AND catalog_due = 0 THEN");
  });

  it("does not gate the catalogue on the automation switch", () => {
    /*
     * That switch governs queueing runs on Shams' own infrastructure. The
     * catalogue refresh starts nothing there, and tying agents' product search
     * to it would mean an operator pausing the nightly sync silently froze what
     * everyone can find.
     */
    const gate = sql.slice(
      sql.indexOf("SELECT count(*) INTO catalog_due"),
      sql.indexOf("Read the previous tick's reply"),
    );
    expect(gate).not.toContain("automation_enabled");
  });

  it("keeps the schedule gate it already had", () => {
    expect(sql).toContain("WHERE g.id = 1 AND g.automation_enabled");
  });

  it("stays revoked from browser-reachable roles", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.shams_sync_tick() FROM PUBLIC, anon, authenticated;",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The seed                                                                    */
/* -------------------------------------------------------------------------- */

describe("the shipped seed", () => {
  /**
   * Every `(code, name, search_name, price, stamp)` tuple in the seed.
   *
   * Parsed rather than eyeballed, because the file is a megabyte of generated
   * SQL and the thing worth checking about it — that `search_name` really is
   * `normalizeForSearch(item_name)` — is invisible at a glance and fatal when
   * wrong: a mismatched row is a product that exists and cannot be found.
   */
  const rows = [
    ...seed.matchAll(/^ {2}\('([^']*(?:''[^']*)*)', '((?:[^']|'')*)', '((?:[^']|'')*)', /gm),
  ].map((m) => ({
    itemCode: m[1].replace(/''/g, "'"),
    itemName: m[2].replace(/''/g, "'"),
    searchName: m[3].replace(/''/g, "'"),
  }));

  it("carries the whole catalogue PharmacyCRM Desktop ships", () => {
    // 8,484 is the figure `docs/shams/api-discovery.md` §10.6 verified against
    // both the seed and the live endpoint.
    expect(rows).toHaveLength(8484);
  });

  it("computes search_name exactly as the matcher does", () => {
    const wrong = rows.filter((r) => r.searchName !== normalizeForSearch(r.itemName));
    expect(wrong).toEqual([]);
  });

  it("has one row per item code", () => {
    expect(new Set(rows.map((r) => r.itemCode)).size).toBe(rows.length);
  });

  it("seeds without overwriting a catalogue that has already been refreshed", () => {
    expect(seed).toContain("ON CONFLICT (item_code) DO NOTHING");
    expect(seed).not.toContain("DELETE FROM public.shams_product_catalog");
    expect(seed).not.toContain("TRUNCATE");
  });

  it("does not claim the seeded rows were fetched against a marker", () => {
    // Leaving `source_marker` and `next_refresh_due_at` null is what makes the
    // first real refresh run rather than mistake the seed for an up-to-date
    // pull. The state row is touched only to tell the health signal how many
    // products exist.
    const update = seed.slice(seed.indexOf("UPDATE public.shams_catalog_state"));
    expect(update).toContain(
      "SET row_count  = (SELECT count(*) FROM public.shams_product_catalog)",
    );
    expect(update).not.toMatch(/source_marker\s*=/);
    expect(update).not.toMatch(/next_refresh_due_at\s*=/);
    expect(update).not.toMatch(/last_success_at\s*=/);
  });

  it("contains the products the search tests are written against", () => {
    const codes = new Set(rows.map((r) => r.itemCode));
    expect(codes.has("10400746")).toBe(true);
    expect(rows.find((r) => r.itemCode === "10400746")?.itemName).toMatch(/NAN/i);
  });
});
