/**
 * Saving an order records what its invoices actually are.
 *
 * Nothing renders here — `submit` is a hook with I/O, so what is asserted is the
 * *source*, in the same spirit as `new-order-layout.test.ts`: one decision that
 * is invisible to a type check and breaks silently.
 *
 * The decision: **both** branches of `submit` call
 * `recordInvoiceVerification`. `create` always did. `edit` did not, and that
 * asymmetry is what let the Orders list contradict the order page.
 *
 * An invoice number does not identify a document on its own — the branch
 * identifies it too. Invoice `0064714` is a March walk-in worth 18.40 at P0127
 * and today's Call Centre document worth 110.00 at P0217. Order CC-8984 was
 * raised against the wrong branch, so it recorded a real but wrong document
 * (`is_call_centre: false`); the agent corrected the branch and saved; and
 * nothing re-recorded it, because `trg_sync_order_invoice_flags` fires on
 * `invoice_no` alone and the page's own reconciliation is deliberately withheld
 * while the form disagrees with the stored row. The order page showed Call
 * Centre from the live lookup while the list, reading the persisted flag, showed
 * Non Call Centre — and stayed wrong until somebody happened to reopen the
 * order, 17 seconds later in the reported case.
 *
 * Delete the call this test pins and that divergence comes straight back.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../hooks/use-order-form.ts", import.meta.url)),
  "utf8",
);

describe("submit records the invoices it just saved", () => {
  it("records on create and on edit, not only on create", () => {
    const calls = source.split("recordInvoiceVerification(").length - 1;
    // One import + one call per branch.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(source).toContain("recordInvoiceVerification(createdId,");
    expect(source).toContain("recordInvoiceVerification(id!,");
  });

  it("records after the row is written, so the order already names the documents", () => {
    // The server reconciles against `orders.invoice_no` / `branch_no` as stored,
    // so recording before the update would reconcile against the old ones.
    const editUpdate = source.indexOf('.update(parsed as any)');
    const editRecord = source.indexOf("recordInvoiceVerification(id!,");
    expect(editUpdate).toBeGreaterThan(-1);
    expect(editRecord).toBeGreaterThan(editUpdate);
  });

  it("never lets a failed recording lose the save", () => {
    // The order is valid either way; the next open reconciles it. A throw here
    // would surface as "failed to save" over a row that was written.
    const after = source.slice(source.indexOf("recordInvoiceVerification(id!,"));
    expect(after.slice(0, 400)).toContain("catch");
  });

  it("still withholds the write while the form disagrees with the stored row", () => {
    // Saving is the moment a draft stops being a draft. Until then an unsaved
    // number or branch must not write a total onto the order.
    expect(source).toContain("const recordEnabled =");
    expect(source).toContain("recordEnabled,");
  });
});
