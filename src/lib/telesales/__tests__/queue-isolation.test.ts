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
