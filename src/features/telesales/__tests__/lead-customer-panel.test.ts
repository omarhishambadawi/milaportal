import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { INTELLIGENCE_MESSAGES } from "@/lib/telesales/customer-intelligence";

/**
 * The lead page's customer section, after invoice verification came off it.
 *
 * Structural assertions, the technique `queue-isolation` established: what this
 * change is *about* is which module the page depends on and which request it no
 * longer makes, and neither is a value a render test could read.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(join(ROOT, rel));

const LEAD_PAGE = "routes/_app.telesales.$id.tsx";
const PANEL = "features/telesales/components/mis-customer-panel.tsx";
const STOCK_PANEL = "features/telesales/components/lead-stock-panel.tsx";
const QUEUE_FILES = [
  "features/telesales/hooks/use-telesales-queue.ts",
  "features/telesales/components/lead-row.tsx",
  "routes/_app.telesales.index.tsx",
];

/* ===================================================================== */
/* A. Invoice verification is off the lead page                          */
/* ===================================================================== */

describe("invoice verification is no longer on the lead", () => {
  const page = source(LEAD_PAGE);

  it("renders no verification panel", () => {
    expect(page).not.toContain("LeadVerificationPanel");
    expect(exists("features/telesales/components/lead-verification-panel.tsx")).toBe(false);
  });

  it("runs no invoice reconciliation query", () => {
    /*
     * The point of the removal, not a cosmetic one: this was a second Shams MIS
     * request on every lead open, to render a verdict an agent mid-call does
     * not act on.
     */
    expect(page).not.toContain("useInvoiceVerification");
    expect(page).not.toContain("reconcilableLead");
    expect(page).not.toContain("historyDocuments");
  });

  it("writes no invoice verdict", () => {
    expect(page).not.toContain("telesalesRecordInvoiceMatch");
  });

  it("shows no invoice status, badge or control", () => {
    for (const token of ["MATCH_STATUS_LABELS", "DISCREPANCY_LABELS", "InvoiceMatchStatus"]) {
      expect(page, `${token} must not appear on the lead page`).not.toContain(token);
    }
    expect(page.toLowerCase()).not.toContain("invoice verified");
  });
});

/* ===================================================================== */
/* B. Everything outside the lead page survives                          */
/* ===================================================================== */

describe("invoice functionality outside the lead is intact", () => {
  it("keeps the reconciliation module and its server function", () => {
    /*
     * Explicitly not deleted. The brief allows removing backend only if it is
     * unused elsewhere, and it is not: the column still carries the verdicts
     * already recorded, and the recommendation engine still reads them.
     */
    expect(exists("lib/telesales/reconciliation.ts")).toBe(true);
    expect(source("lib/telesales.functions.ts")).toContain("telesalesRecordInvoiceMatch");
  });

  it("keeps the recommendation engine's invoice_verified badge", () => {
    const engine = source("lib/telesales/recommendations.ts");
    expect(engine).toContain("invoice_verified");
    expect(engine).toContain("invoiceMatchStatus");
    const read = source("features/telesales/hooks/use-recommended-leads.ts");
    expect(read).toContain("invoice_match_status");
  });

  it("keeps the Orders module's own invoice verification untouched", () => {
    // A different feature that happens to share the word.
    expect(exists("features/orders/invoice-verification.ts")).toBe(true);
    expect(exists("features/orders/hooks/use-order-invoices.ts")).toBe(true);
  });

  it("keeps the stock half of the old panel, unchanged in behaviour", () => {
    // Availability is a different question and was not asked about.
    const page = source(LEAD_PAGE);
    expect(page).toContain("LeadStockPanel");
    expect(page).toContain("useLeadStock");
    const stock = source(STOCK_PANEL);
    // The same vocabulary the availability half always used.
    expect(stock).toContain("StockState");
    expect(stock).toContain("STOCK_LABELS");
    // And it carries none of the invoice vocabulary it used to sit beside.
    expect(stock).not.toContain("InvoiceMatchStatus");
    expect(stock).not.toContain("verifyInvoice");
  });
});

/* ===================================================================== */
/* C. Shams customer information is the primary section                  */
/* ===================================================================== */

describe("the customer section", () => {
  const page = source(LEAD_PAGE);
  const panel = source(PANEL);

  it("still renders through the existing Shams integration", () => {
    expect(page).toContain("MisCustomerPanel");
    expect(page).toContain("useCustomerIntelligence");
    // One client, one lookup: the panel itself fetches nothing.
    expect(panel).not.toMatch(/\bfetch\(/);
    expect(panel).not.toContain("shamsGetCustomerHistory");
    expect(panel).not.toContain("useQuery");
  });

  it("presents customer identity separately from purchase intelligence", () => {
    expect(panel).toContain("Purchase intelligence");
    expect(panel).toContain("Shams customer");
    expect(panel).toContain("Shams customer ID");
  });

  it("shows every field the integration already supplies", () => {
    for (const field of [
      "Loyalty points",
      "Loyalty value",
      "Last purchase",
      "Previously purchased",
      "Purchase history",
    ]) {
      expect(panel, `${field} must be presented`).toContain(field);
    }
    // The phone is on the identity line.
    expect(panel).toContain("formatSaudiPhone(phone)");
  });

  it("invents no fields", () => {
    for (const invented of ["creditScore", "segment", "tier", "churn", "lifetimeValue"]) {
      expect(panel).not.toContain(invented);
    }
  });

  it("shows a bounded purchase history on the lead and the ledger on the profile", () => {
    /*
     * The lead gets the recent lines an agent needs mid-call; the full history
     * stays where it already lived. One component answers both.
     */
    expect(page).toContain("historyLimit={5}");
    const profile = source("routes/_app.telesales.customers.$id.tsx");
    expect(profile).toContain("MisCustomerPanel");
    expect(profile).not.toContain("historyLimit");
  });
});

/* ===================================================================== */
/* D. States                                                             */
/* ===================================================================== */

describe("the Shams states are preserved", () => {
  const panel = source(PANEL);

  it("still distinguishes every non-ready state", () => {
    /*
     * The dangerous failure of this feature is showing "no purchase history"
     * for a customer whose lookup simply failed, so each state keeps its own
     * message.
     */
    for (const state of ["not_configured", "forbidden", "error", "no_customer"]) {
      expect(INTELLIGENCE_MESSAGES, `${state} needs a message`).toHaveProperty(state);
    }
    expect(panel).toContain("NonReady");
    expect(panel).toContain("INTELLIGENCE_MESSAGES");
  });

  it("has a loading state and a retry", () => {
    expect(panel).toContain('state === "loading"');
    expect(panel).toContain("onRetry");
  });

  it("says so when a known customer has never bought", () => {
    expect(panel).toContain("No purchases on record.");
    expect(panel).toContain("No dated purchase on record.");
  });

  it("does not block the rest of the lead page", () => {
    // Rendered as one card among several; the page never awaits it.
    const page = source(LEAD_PAGE);
    expect(page).toContain("<MisCustomerPanel");
    expect(page).not.toMatch(/await[\s\S]{0,40}MisCustomerPanel/);
    expect(page).not.toMatch(/intel\.(isLoading|isPending)[\s\S]{0,40}return/);
  });
});

/* ===================================================================== */
/* E. View profile                                                       */
/* ===================================================================== */

describe("the View profile action", () => {
  const page = source(LEAD_PAGE);

  it("is still available and still goes to the customer profile", () => {
    expect(page).toContain("View profile");
    expect(page).toContain('to="/telesales/customers/$id"');
    expect(page).toContain("params={{ id: l.customer_id }}");
  });

  it("is a button rather than a bare text link", () => {
    // The one navigation an agent makes from this page; it read as prose
    // beside four static fields.
    expect(page).toMatch(/<Button asChild[\s\S]{0,200}View profile/);
  });

  it("still says so when the lead has no consolidated customer", () => {
    expect(page).toContain("Not linked");
  });
});

/* ===================================================================== */
/* F. No new MIS traffic                                                 */
/* ===================================================================== */

describe("MIS request volume", () => {
  it("the lead page makes strictly fewer MIS requests than before", () => {
    /*
     * Two per open became one: customer intelligence stayed, invoice
     * verification went. Stock is unchanged.
     */
    const page = source(LEAD_PAGE);
    expect(page).toContain("useCustomerIntelligence");
    expect(page).toContain("useLeadStock");
    expect(page).not.toContain("useInvoiceVerification");
  });

  it("the queue still makes none", () => {
    for (const file of QUEUE_FILES) {
      const text = source(file);
      for (const forbidden of [
        "useCustomerIntelligence",
        "useLeadStock",
        "MisCustomerPanel",
        "shamsGetCustomerHistory",
      ]) {
        expect(text, `${file} must not reach the MIS via ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the customer panel adds no query of its own", () => {
    // It renders what the hook already fetched; a query here would be a second
    // request for data the page holds.
    const panel = source(PANEL);
    expect(panel).not.toContain("useQuery");
    expect(panel).not.toContain("queryKeys");
  });
});
