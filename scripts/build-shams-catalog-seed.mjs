#!/usr/bin/env node
/**
 * Turn PharmacyCRM Desktop's cold-start product seed into a Supabase migration.
 *
 * The Desktop ships `_internal/_internal/product_cache_seed.json` — the complete
 * `GET /products/names` catalogue as `[{code, name, price}]`, verified in
 * `docs/shams/api-discovery.md` §10.6 to hold the same 8,484 item codes as the
 * live endpoint — and uses it until its first fetch lands. MilaPortal wants the
 * same property for the same reason: a database that has never spoken to
 * `shams-crm.cloud` must still be able to answer a product search.
 *
 * So the seed is committed as a migration rather than fetched at deploy time.
 *
 * ## Why this script exists rather than the JSON
 *
 * The source file is 700 KB of third-party build output that is not in this
 * repository and should not be. What is committed is its *product*: a migration
 * whose provenance is this script plus the version string below. Re-running it
 * against a newer Desktop build regenerates the file deterministically — rows
 * are emitted in item-code order, so a diff shows what actually changed in the
 * catalogue rather than a reshuffle.
 *
 * ## Usage
 *
 *   node scripts/build-shams-catalog-seed.mjs <path-to-product_cache_seed.json> \
 *        [--out supabase/migrations/<timestamp>_shams_product_catalog_seed.sql] \
 *        [--source-date 2026-07-25T11:40:00Z]
 *
 * It writes SQL and nothing else: no network, no credentials, no database.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const input = positional[0];
if (!input) {
  console.error(
    "usage: node scripts/build-shams-catalog-seed.mjs <product_cache_seed.json> [--out FILE] [--source-date ISO]",
  );
  process.exit(2);
}

const output = flag("out", "supabase/migrations/20260915120100_shams_product_catalog_seed.sql");
/**
 * When the seed was built, recorded as every row's `source_updated_at`.
 *
 * Honest provenance beats a flattering one: these prices are as old as the
 * Desktop build they came from, roughly 0.3 % of rows drift a day, and the first
 * successful CRM refresh replaces every row that has moved. Writing `now()`
 * instead would make a months-old price look like it was checked this morning.
 */
const sourceDate = flag("source-date", null);

/* -------------------------------------------------------------------------- */
/* The rows                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The same transformation `normalizeForSearch` applies in
 * `src/lib/shams/search.ts`.
 *
 * Duplicated here rather than imported because this is a standalone Node script
 * with no TypeScript pipeline, and the whole file is three operations. The
 * catalogue refresh path in the application *does* import the real one; if these
 * two ever disagree the symptom is a seeded row that a search fails to retrieve
 * until the first refresh rewrites it, which is why the test suite asserts the
 * committed migration's `search_name` values against the real function.
 */
const normalizeForSearch = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();

/** Postgres string literal. Doubling the quote is the whole of the escaping. */
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

const raw = JSON.parse(readFileSync(input, "utf8"));
if (!Array.isArray(raw)) {
  console.error(`${basename(input)} is not a JSON array; this is not a product seed.`);
  process.exit(1);
}

/**
 * Drop rows that cannot be searched, and keep the last of any duplicate code.
 *
 * Exactly `normalize()` in `src/lib/shams-crm/catalog.server.ts`: a row without
 * a code or a name is not a product anyone can find or select. A missing price
 * defaults to 0 rather than removing an otherwise findable product.
 */
const byCode = new Map();
for (const row of raw) {
  const itemCode = typeof row?.code === "string" ? row.code.trim() : "";
  const itemName = typeof row?.name === "string" ? row.name.trim() : "";
  if (!itemCode || !itemName) continue;
  const price = typeof row?.price === "number" && Number.isFinite(row.price) ? row.price : 0;
  byCode.set(itemCode, { itemCode, itemName, price });
}

const rows = [...byCode.values()].sort((a, b) => a.itemCode.localeCompare(b.itemCode));
if (rows.length === 0) {
  console.error("No usable rows in the seed; refusing to write an empty migration.");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* The migration                                                               */
/* -------------------------------------------------------------------------- */

/** Rows per INSERT. Large enough to keep the file compact, small enough to read. */
const CHUNK = 250;

const stamp = sourceDate ? lit(sourceDate) : "now()";

const header = `-- The Shams product catalogue, seeded so a cold database can search offline.
--
-- ===========================================================================
-- Generated. Do not hand-edit.
-- ===========================================================================
--   scripts/build-shams-catalog-seed.mjs ${basename(input)}
--   ${rows.length} products, ordered by item code.
--
-- These rows come from PharmacyCRM Desktop's own cold-start seed
-- (\`_internal/_internal/product_cache_seed.json\`), which
-- \`docs/shams/api-discovery.md\` §10.6 verified holds the same 8,484 item codes
-- as the live \`GET /products/names\` endpoint.
--
-- ===========================================================================
-- Why seed at all
-- ===========================================================================
-- The acceptance criterion for this work is that a cold MilaPortal server can
-- search the Shams catalogue without contacting \`shams-crm.cloud\`. A refresh job
-- alone cannot deliver that: it has to run once first, and it needs CRM
-- credentials that a given deployment may not hold. A shipped seed makes search
-- work from the first migration onward, on every environment, with no network at
-- all — which is exactly why the Desktop ships one.
--
-- \`ON CONFLICT DO NOTHING\`: this seeds, it never overwrites. On a database whose
-- catalogue has already been refreshed from the CRM, every row here loses to the
-- fresher one and the migration is a no-op.
--
-- The prices are as old as the build they came from. \`source_updated_at\` says so
-- rather than claiming freshness, and the first successful refresh replaces
-- every row that has moved since.

BEGIN;

INSERT INTO public.shams_product_catalog
  (item_code, item_name, search_name, retail_price, source_updated_at)
VALUES
`;

const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  const values = slice
    .map(
      (r) =>
        `  (${lit(r.itemCode)}, ${lit(r.itemName)}, ${lit(normalizeForSearch(r.itemName))}, ${r.price}, ${stamp})`,
    )
    .join(",\n");
  chunks.push(
    i === 0
      ? `${values}\nON CONFLICT (item_code) DO NOTHING;\n`
      : `INSERT INTO public.shams_product_catalog\n  (item_code, item_name, search_name, retail_price, source_updated_at)\nVALUES\n${values}\nON CONFLICT (item_code) DO NOTHING;\n`,
  );
}

const footer = `
-- The health signal's row count, brought in line with what was just seeded.
--
-- \`next_refresh_due_at\` is left NULL — "due now" — so the first scheduler tick
-- after this migration replaces the seed with live rows wherever CRM credentials
-- exist. \`source_marker\` stays NULL for the same reason: nothing here was
-- fetched against a stock-sync marker, so the first refresh cannot mistake the
-- seed for an up-to-date pull.
UPDATE public.shams_catalog_state
   SET row_count  = (SELECT count(*) FROM public.shams_product_catalog),
       updated_at = now()
 WHERE id = 1;

COMMIT;
`;

writeFileSync(output, header + chunks.join("\n") + footer, "utf8");
console.log(`${output}: ${rows.length} products`);
