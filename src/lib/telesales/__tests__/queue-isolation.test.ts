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
