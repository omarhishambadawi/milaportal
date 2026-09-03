import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The queue must not touch the Shams MIS.
 *
 * A structural guard rather than a behavioural one, and deliberately so: the
 * failure it prevents is not a wrong answer but a hundred upstream requests, and
 * that only shows up under load — long after the import that caused it was
 * reviewed. Reading the source is the cheapest way to make the rule enforceable.
 *
 * The rule: the queue's read path and its row component render from Postgres
 * alone. Customer intelligence, invoice verification and branch stock are
 * detail-page concerns, fetched once per lead when one is opened.
 *
 * The same technique the permission-parity guard uses — parse the text, assert
 * a property, add no dependency and run no application code.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Anything that would reach the MIS. */
const MIS_IMPORTS = [
  "@/lib/shams.functions",
  "@/lib/shams/client.server",
  "@/lib/shams/crm.server",
  "@/lib/shams/sales.server",
  "@/lib/shams/catalog.server",
  "use-customer-intelligence",
  "use-lead-verification",
];

describe("the telesales queue makes no MIS requests", () => {
  const queueFiles = [
    "features/telesales/hooks/use-telesales-queue.ts",
    "features/telesales/components/lead-row.tsx",
    "routes/_app.telesales.index.tsx",
  ];

  for (const file of queueFiles) {
    it(`${file} imports nothing that reaches Shams`, () => {
      const text = source(file);
      for (const forbidden of MIS_IMPORTS) {
        expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  it("the queue's select list asks Postgres for no MIS-derived column", () => {
    // Every column the queue reads is one Postgres already holds. A column
    // populated from the MIS would mean either an N+1 or a sync job, and this
    // phase introduced neither.
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    expect(text).toContain("QUEUE_COLUMNS");
    for (const misField of ["loyalty", "purchase", "mis_", "stock"]) {
      expect(text.toLowerCase()).not.toContain(`,${misField}`);
    }
  });
});

describe("the detail pages fetch through the existing integration", () => {
  it("verification reuses the Shams module's own server functions", () => {
    const text = source("features/telesales/hooks/use-lead-verification.ts");
    // Not a second client, not a fetch: the same server functions the /shams
    // Invoices and Stock tabs call.
    expect(text).toContain("shamsGetInvoices");
    expect(text).toContain("shamsGetProduct");
    expect(text).not.toContain("shamsFetch");
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("verification reuses the Shams module's own stock rule", () => {
    const text = source("features/telesales/hooks/use-lead-verification.ts");
    expect(text).toContain("branchStockState");
  });

  it("verification stores under the Shams query keys, so the cache is shared", () => {
    /*
     * The point of this one: an agent who looks a document up on the Shams page
     * and then opens the telesales lead for it should pay for one request, and
     * the two screens must never disagree about the same document. A
     * `telesales`-prefixed key would have produced a second cache entry for
     * identical data.
     */
    const text = source("features/telesales/hooks/use-lead-verification.ts");
    expect(text).toContain("queryKeys.shams.invoices(");
    expect(text).toContain("queryKeys.shams.product(");
  });

  it("customer intelligence reuses the existing history server function", () => {
    const text = source("features/telesales/hooks/use-customer-intelligence.ts");
    expect(text).toContain("shamsGetCustomerHistory");
    expect(text).not.toContain("shamsFetch");
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("no telesales module re-implements the MIS mobile conversion", () => {
    // `normalizeCrmMobile` is the integration's own conversion and stays the
    // only one. A second algorithm here is how two screens end up disagreeing
    // about which customer a number belongs to.
    for (const file of [
      "features/telesales/hooks/use-customer-intelligence.ts",
      "lib/telesales/customer-intelligence.ts",
    ]) {
      expect(source(file)).not.toContain("mobileno");
    }
  });
});

describe("the recommendation engine makes no MIS request per lead", () => {
  /*
   * Phase 3's version of the same guarantee. The Recommended page ranks the
   * whole open queue, so a per-lead upstream call here would be several hundred
   * requests on one page load -- the failure the brief is most explicit about.
   *
   * The defence is architectural: the engine is pure and reads local Postgres
   * data, and the only MIS call on the page is stock, which is per *product* on
   * the visible page rather than per lead.
   */

  it("the engine imports no Shams client, function or hook at all", () => {
    const text = source("lib/telesales/recommendations.ts");
    for (const forbidden of MIS_IMPORTS) {
      expect(text, `recommendations.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
    // A call, not a mention: the prose above the module names the customer-history
    // function to explain what this one deliberately does not do.
    expect(text).not.toMatch(/shamsGetw*\(/);
    expect(text).not.toMatch(/\bfetch\(/);
    // The one thing it may take from the Shams module is a type, which is
    // erased at build time and cannot issue a request.
    expect(text).toContain("import type { StockState }");
  });

  it("the recommendation read asks the MIS for stock and nothing else", () => {
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    // Customer history and invoices would each be one call per lead. Both are
    // answered locally instead -- history from telesales_source_records, the
    // invoice verdict from the column Phase 2 persisted.
    expect(text).not.toContain("shamsGetCustomerHistory");
    expect(text).not.toContain("shamsGetInvoices");
    expect(text).toContain("telesales_source_records");
    expect(text).toContain("invoice_match_status");
  });

  it("stock is fetched per product under the Shams key, so the cache is shared", () => {
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    expect(text).toContain("queryKeys.shams.product(");
    expect(text).toContain("branchStockState");
    expect(text).not.toContain("shamsFetch");
  });

  it("the candidate read is bounded rather than unbounded", () => {
    // A recommendation page that selected the whole table would be a different
    // kind of N+1 -- one enormous query instead of many small ones.
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    expect(text).toContain("CANDIDATE_LIMIT");
    expect(text).toMatch(/\.limit\(CANDIDATE_LIMIT\)/);
  });

  it("the Recommended page pulls in no per-lead MIS hook", () => {
    const text = source("routes/_app.telesales.recommended.tsx");
    expect(text).not.toContain("use-customer-intelligence");
    expect(text).not.toContain("use-lead-verification");
    expect(text).not.toContain("shams.functions");
  });
});

describe("the lead lifecycle costs no request per lead", () => {
  /*
   * Staleness is derived, and the derivation has to stay cheap. The rule is a
   * pure function of three values the lead already carries, and the filtering
   * happens in Postgres -- so adding a lifecycle to the queue adds no round
   * trip, and certainly no MIS call.
   */

  it("the rule imports nothing that could make a request", () => {
    const text = source("lib/telesales/lifecycle.ts");
    for (const forbidden of MIS_IMPORTS) {
      expect(text, `lifecycle.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/shamsGet\w*\(/);
    expect(text).not.toMatch(/\bfetch\(/);
    // Pure: dates in, verdict out. No client, no supabase, no I/O.
    expect(text).not.toContain("supabase");
  });

  it("the queue filters lifecycle in Postgres, not in the browser", () => {
    /*
     * The whole point of the view. Filtering 712 rows client-side would work
     * today and break the moment an import lands 173,008 -- and it would make
     * the pager disagree with the rows, because `count` would still describe
     * the unfiltered set.
     */
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    expect(text).toContain("telesales_lead_lifecycle");
    expect(text).toMatch(/\.eq\("lifecycle", "stale"\)/);
    expect(text).toMatch(/\.in\("lifecycle", \["active", "none"\]\)/);
    // Still paged and counted server-side, exactly as before.
    expect(text).toContain('count: "exact"');
    expect(text).toContain(".range(");
  });

  it("the queue still reaches no MIS module", () => {
    // The read moved from a table to a view; nothing else about it changed.
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    for (const forbidden of MIS_IMPORTS) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("the stale count is a head-only query, not a page of rows", () => {
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    expect(text).toContain("head: true");
  });

  it("the row renders the lifecycle from data it was already given", () => {
    // No lookup per row: the view supplied the columns with the page.
    const text = source("features/telesales/components/lead-row.tsx");
    expect(text).toContain("lead.lifecycle");
    expect(text).toContain("leadLifecycle(");
    expect(text).not.toContain("useQuery");
    for (const forbidden of MIS_IMPORTS) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("archived leads stay out of operational views", () => {
  /*
   * Archiving is the backlog's cleanup path, so the exclusions it relies on are
   * worth pinning. All three are one-line filters that would be easy to drop in
   * a refactor and impossible to notice: the failure is an archived lead
   * quietly reappearing as work.
   */

  it("Recommended Leads never considers an archived lead", () => {
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    // On the candidate read, before the engine ever sees the row.
    expect(text).toMatch(/\.is\("archived_at", null\)/);
  });

  it("the recommendation engine is never handed archived leads to judge", () => {
    // Belt and braces: the engine has no notion of archiving, which is only
    // safe because the read above excludes them.
    const text = source("lib/telesales/recommendations.ts");
    expect(text).not.toContain("archived");
  });

  it("the queue hides archived leads unless they are explicitly asked for", () => {
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    expect(text).toMatch(/if \(filters\.lifecycle === "archived"\)/);
    // The else branch is what keeps every other view clean.
    expect(text).toMatch(/else q = q\.is\("archived_at", null\)/);
  });

  it("archived is never the default view", () => {
    // An agent must not arrive at archived rows without choosing to.
    const text = source("features/telesales/types.ts");
    expect(text).toMatch(/lifecycle: "active"/);
  });

  it("the stale backlog count measures live leads, not archived ones", () => {
    const text = source("features/telesales/hooks/use-telesales-queue.ts");
    expect(text).toContain("staleUnassigned");
    expect(text).toContain("head: true");
  });

  it("bulk operations are one server call, not one per lead", () => {
    /*
     * The performance rule for this phase. The hook hands an array of ids to a
     * single server function; a `map` over ids calling a mutation would be 500
     * requests for one supervisor gesture.
     */
    const text = source("features/telesales/hooks/use-bulk-actions.ts");
    expect(text).toContain("leadIds");
    expect(text).not.toMatch(/for \(const .* of .*leadIds/);
    expect(text).not.toMatch(/leadIds\.map\(/);
    for (const forbidden of MIS_IMPORTS) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("archiving is soft everywhere — no lead is ever deleted", () => {
    // The whole module: archive is the only cleanup, and it is a timestamp.
    for (const file of [
      "lib/telesales/manage.server.ts",
      "features/telesales/hooks/use-bulk-actions.ts",
    ]) {
      expect(source(file)).not.toMatch(/\.delete\(\)/);
    }
    expect(source("lib/telesales/manage.server.ts")).toContain("archived_at");
  });
});

describe("cross-sell configuration is gated and cheap", () => {
  /*
   * Configuration that decides what an agent offers a patient is worth guarding
   * structurally: who may write it, and what evaluating it costs.
   */

  it("both writes require manage_telesales, not view", () => {
    const text = source("lib/telesales.functions.ts");
    const save = text.slice(text.indexOf("telesalesSaveProductRelation"));
    const toggle = text.slice(text.indexOf("telesalesSetProductRelationActive"));
    // An agent calling either server function directly is refused before
    // anything is read.
    expect(save.slice(0, 2500)).toContain('resolveActor(supabase, userId, "manage")');
    expect(toggle.slice(0, 1500)).toContain('resolveActor(supabase, userId, "manage")');
  });

  it("the database grants no write path at all", () => {
    /*
     * RLS carries a SELECT policy and nothing else, so PostgREST refuses every
     * write from the browser regardless of grants. Hiding the buttons is a
     * convenience; this is the boundary.
     */
    const sql = readFileSync(
      join(ROOT, "..", "supabase", "migrations", "20260905120000_telesales_product_relations.sql"),
      "utf8",
    );
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toMatch(/FOR SELECT/);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);

    const followUp = readFileSync(
      join(
        ROOT,
        "..",
        "supabase",
        "migrations",
        "20260907120000_telesales_relation_management.sql",
      ),
      "utf8",
    );
    expect(followUp).toContain("REVOKE ALL ON public.telesales_product_relations FROM anon");
    expect(followUp).not.toMatch(/CREATE POLICY[\s\S]*FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("relations load once per page, never once per lead", () => {
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    // One bounded read inside the single gathering query, filtered to active.
    expect(text).toContain("telesales_product_relations");
    expect(text).toMatch(/\.eq\("active", true\)/);
    // Not inside any per-lead loop.
    expect(text).not.toMatch(/for \([^)]*leads[^)]*\)[\s\S]{0,400}telesales_product_relations/);
  });

  it("evaluating a relationship reaches no MIS module", () => {
    for (const file of ["lib/telesales/relations.ts", "lib/telesales/recommendations.ts"]) {
      const text = source(file);
      for (const forbidden of MIS_IMPORTS) {
        expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
      expect(text).not.toMatch(/\bfetch\(/);
    }
  });

  it("the validator is pure — no client, no I/O", () => {
    const text = source("lib/telesales/relations.ts");
    expect(text).not.toContain("supabase");
    expect(text).not.toContain("createServerFn");
  });

  it("the configuration screen never writes through the browser client", () => {
    // Reads go direct under RLS; every write goes through a server function.
    const text = source("features/telesales/hooks/use-product-relations.ts");
    expect(text).toContain("telesalesSaveProductRelation");
    expect(text).toContain("telesalesSetProductRelationActive");
    expect(text).not.toMatch(
      /\.from\("telesales_product_relations"\)[\s\S]{0,200}\.(insert|update|delete)\(/,
    );
  });

  it("nothing seeds a relationship", () => {
    /*
     * The table is empty in production and must stay that way until a person
     * configures a pair. A seeded example would be indistinguishable from a
     * real commercial decision once it was saved.
     */
    for (const file of [
      "lib/telesales/relations.ts",
      "features/telesales/hooks/use-product-relations.ts",
      "routes/_app.telesales.relations.tsx",
    ]) {
      const text = source(file);
      // A seed would be relation-shaped data written into the source: a literal
      // carrying a target product. Prose about there being no examples is not
      // that, so the pattern looks for the shape rather than for words.
      expect(text).not.toMatch(/toItemCode\s*:\s*["'`]/);
      expect(text).not.toMatch(/to_item_code\s*:\s*["'`]/);
      expect(text).not.toMatch(/insert\(\s*\[/);
    }
  });
});

describe("the queue and the engine resolve a refill cycle the same way", () => {
  /*
   * Phase 7 found the source workbook using two code systems for the same
   * medicines, which left 88 leads with no refill cycle. Both the view and the
   * engine were fixed, and they have to stay fixed together: a lead that is
   * stale on the queue and cycle-less in Recommended Leads is precisely the
   * disagreement the lifecycle view exists to prevent.
   */

  it("the engine resolves identity only through the shared resolver", () => {
    /*
     * Phase 8 removed the engine's own name-matching. There is one resolver and
     * every identity question goes through it -- a second implementation is
     * exactly how the queue and the engine came to disagree in the first place.
     */
    const text = source("lib/telesales/recommendations.ts");
    expect(text).toContain("buildCycleIndex");
    expect(text).toContain("resolveTelesalesProductIdentity");
    expect(text).toContain("productMatchKey");
    // The duplicate that used to live here is gone.
    expect(text).not.toContain("normalizeProductName");
    // And no ad-hoc name compare has grown back in its place.
    expect(text).not.toMatch(/toUpperCase\(\)\s*===/);
  });

  it("the view resolves the same three ways, in the same order", () => {
    const sql = identitySql();
    // Three joins, in the resolver's order: code, alias, then normalised name.
    expect(sql).toMatch(/pc\.item_code = l\.item_code/);
    expect(sql).toMatch(/al\.alias_item_code = l\.item_code/);
    expect(sql).toMatch(/regexp_replace\(pn\.item_name/);
    // The code match wins whenever it matched at all, so a catalogued product
    // with no cycle cannot inherit one from a name twin.
    expect(sql).toMatch(/WHEN pc\.item_code IS NOT NULL THEN pc\.refill_days/);
    // Every side filters inactive products and inactive mappings, as the
    // resolver does.
    expect(sql).toMatch(/pc\.active/);
    expect(sql).toMatch(/pa\.active/);
    expect(sql).toMatch(/pn\.active/);
    expect(sql).toMatch(/al\.active/);
  });

  it("the view matches purchases on identity, not on the raw code", () => {
    const sql = identityStatements();
    // The defect this phase closed: `s.item_code = l.item_code` hid a repeat
    // purchase for 13 customers.
    expect(sql).not.toMatch(/s\.item_code = l\.item_code/);
    expect(sql).toMatch(/s\.item_code = ANY\(/);
    // Falls back to the lead's own code, so nothing that matched can stop.
    expect(sql).toMatch(/ARRAY\[l\.item_code\]/);
  });

  it("the recommendation read passes its leads and history to the resolver", () => {
    // Without both sides, a purchase under the other code system cannot be
    // recognised as the lead's product.
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    expect(text).toMatch(/buildCycleIndex\(identity,[\s\S]{0,120}candidates/);
    expect(text).toContain("item_code,item_name,refill_days");
    expect(text).toContain("buildProductIdentityIndex");
  });
});

/** The Phase 8 migration, read once for the guards below. */
function identitySql(): string {
  return readFileSync(
    join(ROOT, "..", "supabase", "migrations", "20260909120000_telesales_product_identity.sql"),
    "utf8",
  );
}

/**
 * The same migration with its `--` comments removed.
 *
 * A guard that asserts a statement is absent has to read statements. These
 * migrations explain themselves at length and quote the very code they replaced
 * -- the comment naming `s.item_code = l.item_code` as the defect being fixed is
 * the clearest example -- so matching the raw file would fail on the
 * explanation rather than on the SQL.
 */
function identityStatements(): string {
  return identitySql()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("product identity is configuration, and it is not cross-sell", () => {
  it("the mapping table is readable but never writable from the browser", () => {
    const sql = identitySql();
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON public.telesales_product_aliases FROM anon");
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE[\s\S]{0,120}telesales_product_aliases FROM authenticated/,
    );
    // A SELECT policy and nothing else: every write goes through a server
    // function that checks manage_telesales itself.
    expect(sql).toMatch(/CREATE POLICY telesales_product_aliases_select/);
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).toContain("view_telesales");
  });

  it("the schema makes a chain and a self-map impossible", () => {
    const sql = identitySql();
    // One code means one product.
    expect(sql).toMatch(/UNIQUE \(alias_item_code\)/);
    // A code is not an alias of itself.
    expect(sql).toMatch(/CHECK \(alias_item_code <> canonical_item_code\)/);
    // The canonical must be a real product...
    expect(sql).toMatch(/REFERENCES public\.telesales_products\(item_code\)/);
    // ...and the alias must not be, guarded from both directions.
    expect(sql).toContain("telesales_product_alias_guard");
    expect(sql).toMatch(/CREATE TRIGGER telesales_products_alias_guard/);
  });

  it("no source record, lead or catalogue row is rewritten", () => {
    /*
     * The mandatory rule. Canonical identity is an interpretation computed on
     * read; the migration must not carry an UPDATE against the data it
     * reinterprets, or the mapping could not be reversed by switching it off.
     */
    const sql = identityStatements();
    for (const table of [
      "telesales_source_records",
      "telesales_leads",
      "telesales_products",
      "telesales_customers",
    ]) {
      expect(sql, `${table} must not be updated`).not.toMatch(
        new RegExp(String.raw`UPDATE\s+(public\.)?` + table, "i"),
      );
    }
    // Nothing is deleted anywhere, including from the mapping table itself:
    // deactivation only, so the decision stays auditable.
    expect(sql).not.toMatch(/DELETE FROM/i);
    // The one INSERT is into the mapping table.
    expect(sql).toMatch(/INSERT INTO public\.telesales_product_aliases/);
  });

  it("identity never becomes a cross-sell", () => {
    /*
     * The two concepts stay apart. A mapping says two codes are one product; a
     * relation says one product is worth mentioning beside another. Deriving
     * either from the other would put a medication recommendation in front of a
     * patient on the strength of a numbering accident.
     */
    for (const file of [
      "lib/telesales/identity.ts",
      "lib/telesales/aliases.ts",
      "features/telesales/hooks/use-product-aliases.ts",
    ]) {
      const text = source(file);
      expect(text, `${file} must not write a relation`).not.toContain(
        "telesalesSaveProductRelation",
      );
      expect(text).not.toMatch(/to_item_code\s*:/);
    }
    // The migration touches no cross-sell object.
    expect(identityStatements()).not.toContain("telesales_product_relations");
  });

  it("the resolver and the validator are pure — no client, no I/O", () => {
    for (const file of ["lib/telesales/identity.ts", "lib/telesales/aliases.ts"]) {
      const text = source(file);
      expect(text).not.toContain("supabase");
      expect(text).not.toContain("createServerFn");
      expect(text).not.toMatch(/\bfetch\(/);
      for (const forbidden of MIS_IMPORTS) {
        expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the identity screen never writes through the browser client", () => {
    const text = source("features/telesales/hooks/use-product-aliases.ts");
    expect(text).toContain("telesalesSaveProductAlias");
    expect(text).toContain("telesalesSetProductAliasActive");
    expect(text).not.toMatch(
      /\.from\("telesales_product_aliases"\)[\s\S]{0,200}\.(insert|update|delete)\(/,
    );
  });

  it("mappings load once per page, never once per lead or per customer", () => {
    const text = source("features/telesales/hooks/use-recommended-leads.ts");
    expect(text).toContain("telesales_product_aliases");
    // Not inside any per-lead or per-customer loop.
    expect(text).not.toMatch(
      /for \([^)]*(leads|phones|customers)[^)]*\)[\s\S]{0,400}telesales_product_aliases/,
    );
    // The read is bounded, like every other read on this page.
    expect(text).toMatch(/\.limit\(ALIAS_LIMIT\)/);
    // And the index is compiled once, before the per-lead walk.
    expect(text).toMatch(
      /buildProductIdentityIndex\([\s\S]{0,120}\);[\s\S]{0,400}recommendLeads\(/,
    );
  });

  it("the identity layer reaches no MIS module", () => {
    for (const file of [
      "lib/telesales/identity.ts",
      "lib/telesales/aliases.ts",
      "features/telesales/hooks/use-product-aliases.ts",
      "routes/_app.telesales.identity.tsx",
    ]) {
      const text = source(file);
      for (const forbidden of MIS_IMPORTS) {
        expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("import is not generation", () => {
  /*
   * The workflow the desk needs: a file arrives, its rows are stored, somebody
   * reviews them, and *then* leads are created. Uploading must never mean
   * "create every possible lead now" — a structural guard, because the failure
   * is silent and only visible as a queue full of work nobody chose to raise.
   */
  it("the import server function creates no leads", () => {
    const text = source("lib/telesales/import.server.ts");
    expect(text).not.toContain("telesales_leads");
    expect(text).not.toContain("generateCashLeads");
    expect(text).not.toContain("generateWasfatyLeads");
    expect(text).not.toContain("runGeneration");
  });

  it("the import write path is separate from the generation write path", () => {
    const text = source("lib/telesales.functions.ts");
    // Two entry points, each with its own authorization check.
    expect(text).toContain("telesalesImportWorkbook");
    expect(text).toContain("telesalesGenerate");
    // Importing must not call generation on the way out. The retention backlog
    // is the one deliberate exception and it is its own named function the
    // operator invokes, not a side effect of storing rows.
    const importFn = text.slice(
      text.indexOf("export const telesalesImportWorkbook"),
      text.indexOf("export const telesalesImportHistory"),
    );
    expect(importFn).not.toContain("runGeneration");
    expect(importFn).not.toContain("runDailyGeneration");
    expect(importFn).not.toContain("telesalesGenerate");
  });

  it("generation reads only live source rows", () => {
    /*
     * Archiving an import takes its leads out of the queue. A generator that
     * then re-created them from the same rows would undo the archive on the
     * next run, silently.
     */
    const text = source("lib/telesales/generate.server.ts");
    expect(text).toMatch(/\.is\("archived_at", null\)/);
  });

  it("the diagnostic is read-only", () => {
    // A report that mutates what it reports on is not a report.
    const text = source("lib/telesales/diagnose.server.ts");
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(text, `diagnose.server.ts must not ${write}`).not.toContain(write);
    }
  });

  it("the diagnostic asks the generator's own rules", () => {
    // Not a second reading of the same list of rules: a diagnostic that
    // reasoned independently would eventually explain a run that did not happen.
    const text = source("lib/telesales/diagnostics.ts");
    expect(text).toContain("judgeCashRecord");
    expect(text).toContain("judgeWasfatyRecord");
    expect(text).toContain("judgeRetentionBacklogRecord");
    // And it re-implements none of them.
    expect(text).not.toContain("withinWindow(");
    expect(text).not.toContain("matchProduct(");
  });

  it("the pure import modules reach no client and no MIS", () => {
    for (const file of ["lib/telesales/diagnostics.ts", "lib/telesales/templates.ts"]) {
      const text = source(file);
      expect(text).not.toContain("supabase");
      expect(text).not.toContain("createServerFn");
      expect(text).not.toMatch(/\bfetch\(/);
      for (const forbidden of MIS_IMPORTS) {
        expect(text, `${file} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the diagnostic reads bounded pages, never one query per row", () => {
    const text = source("lib/telesales/diagnose.server.ts");
    expect(text).toContain("DIAGNOSIS_ROW_LIMIT");
    expect(text).toMatch(/\.range\(/);
    /*
     * No I/O inside the row loop. Scoped to the loop's own statement rather
     * than to the next few hundred characters -- the paging `await` on the line
     * below is the *next page*, which is the bounded read this is defending.
     */
    for (const line of text.split("\n")) {
      if (line.includes("for (const row of rows)")) {
        expect(line, "the row loop must not await").not.toContain("await");
      }
    }
  });

  it("generation filters are applied in the database, not in JavaScript", () => {
    /*
     * A filter that reads every row and then discards most of them is a slower
     * way to run the same generation.
     */
    const text = source("lib/telesales/generate.server.ts");
    expect(text).toContain("applyFilters");
    expect(text).toMatch(/q\.in\("branch_no"/);
    expect(text).toMatch(/q\.eq\("import_id"/);
    // And a filter may never widen the window it runs in.
    expect(text).toContain("narrowWindow");
  });

  it("the upload progress reports stages, never an invented percentage", () => {
    /*
     * There is no byte-level progress to report: parsing is synchronous browser
     * work, `fetch` exposes no upload progress, and storing happens server-side
     * after the request lands. A moving number would be driven by a timer.
     */
    const text = source("features/telesales/components/upload-progress.tsx");
    expect(text).not.toMatch(/setInterval|setTimeout/);
    expect(text).not.toMatch(/\bpercent\b|\bprogress\s*=\s*\d/);
    // Every stage the machine can be in is rendered.
    for (const stage of ["reading", "uploading", "storing", "done", "failed"]) {
      expect(text, `stage ${stage} must be handled`).toContain(stage);
    }
  });
});

describe("the suite does not assert on wall-clock time", () => {
  /*
   * A timing threshold in a unit test measures the machine, not the code. One
   * such assertion (`Date.now() - before < 1000` over 500 leads) was the only
   * unexplained failure in the project's history -- it failed once, under load,
   * in a Phase 5 run and could not be reproduced. It cannot distinguish a
   * genuine regression from a busy CI box, so it was removed and this keeps it
   * from coming back.
   */
  it("no test measures elapsed milliseconds and asserts a bound", () => {
    const files = [
      "lib/telesales/__tests__/recommendations.test.ts",
      "lib/telesales/__tests__/lifecycle.test.ts",
      "lib/telesales/__tests__/relations.test.ts",
      "lib/telesales/__tests__/manage-bulk.test.ts",
      "lib/telesales/__tests__/reconciliation.test.ts",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, `${file} must not assert on elapsed time`).not.toMatch(
        /expect\(\s*Date\.now\(\)\s*-/,
      );
      expect(text).not.toMatch(/performance\.now\(\)/);
    }
  });
});
