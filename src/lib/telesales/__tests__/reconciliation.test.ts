import { describe, expect, it } from "vitest";
import { invoiceCheckability, reconcileInvoice, type ReconcilableLead } from "../reconciliation";
import { branchStockState } from "@/lib/shams/availability";
import type { ShamsBranchStock, ShamsInvoice, ShamsInvoiceItem } from "@/lib/shams/types";

function item(over: Partial<ShamsInvoiceItem> = {}): ShamsInvoiceItem {
  return {
    itemCode: "10611028",
    itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    quantity: 1,
    lzQuantity: 0,
    freeQuantity: 0,
    freeLzQuantity: 0,
    unitRate: 1261.4,
    grossAmount: 1261.4,
    discountAmount: 0,
    amount: 1261.4,
    tax: 0,
    netAmount: 1261.4,
    ...over,
  };
}

function invoice(over: Partial<ShamsInvoice> = {}): ShamsInvoice {
  return {
    docNo: "188767",
    docDate: "2026-07-30T00:00:00",
    docType: "Credit",
    branchCode: "P0001",
    division: null,
    cancelled: false,
    customer: "CASH IN BOX",
    isCallCentre: false,
    cashAmount: 1261.4,
    cashTax: 0,
    creditAmount: 0,
    creditTax: 0,
    discount: 0,
    totalTax: 0,
    grandTotal: 1261.4,
    totalCost: 0,
    profit: 0,
    items: [item()],
    ...over,
  };
}

function lead(over: Partial<ReconcilableLead> = {}): ReconcilableLead {
  return {
    leadType: "cash",
    documentNo: "188767",
    branchNo: "P0001",
    sourceDate: "2026-07-30",
    itemCode: "10611028",
    itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
    quantity: 1,
    ...over,
  };
}

describe("what can be checked at all", () => {
  it("checks a Cash lead with a warehouse code and a document number", () => {
    expect(invoiceCheckability(lead())).toEqual({ checkable: true });
  });

  it("does not check a Wasfaty lead", () => {
    // A prescription is not a Shams invoice.
    expect(invoiceCheckability(lead({ leadType: "wasfaty" }))).toEqual({
      checkable: false,
      reason: "wasfaty_lead",
    });
  });

  it("does not check a lead with no document number", () => {
    expect(invoiceCheckability(lead({ documentNo: null })).checkable).toBe(false);
    expect(invoiceCheckability(lead({ documentNo: "   " })).checkable).toBe(false);
  });

  it("does not check a lead whose branch is not a warehouse code", () => {
    /*
     * The case that would otherwise become a spurious error. Wasfaty sheets put
     * pharmacy numbers like 202 and 123 in the branch column, and
     * `validateInvoiceQuery` would reject them as `invalid_query` — which would
     * reach an agent as a failure when the truthful answer is that there is
     * nothing to check.
     */
    expect(invoiceCheckability(lead({ branchNo: "202" }))).toEqual({
      checkable: false,
      reason: "branch_not_a_warehouse_code",
    });
    expect(invoiceCheckability(lead({ branchNo: null })).checkable).toBe(false);
  });
});

describe("matching", () => {
  it("matches an invoice that agrees on number, branch, date, product and quantity", () => {
    const v = reconcileInvoice({ lead: lead(), invoices: [invoice()] });
    expect(v.status).toBe("matched");
    expect(v.discrepancies).toEqual([]);
    expect(v.invoice?.docNo).toBe("188767");
    expect(v.invoice?.branchCode).toBe("P0001");
    expect(v.invoice?.docDay).toBe("2026-07-30");
    expect(v.matchedLine?.itemCode).toBe("10611028");
  });

  it("reports an invoice that does not exist at that branch", () => {
    const v = reconcileInvoice({ lead: lead(), invoices: [] });
    expect(v.status).toBe("not_matched");
    expect(v.reason).toContain("188767");
    expect(v.reason).toContain("P0001");
  });

  it("refuses to choose between two documents sharing a number", () => {
    const v = reconcileInvoice({
      lead: lead(),
      invoices: [invoice(), invoice({ grandTotal: 999 })],
    });
    expect(v.status).toBe("ambiguous");
    expect(v.candidates).toHaveLength(2);
    expect(v.invoice).toBeNull();
  });

  it("ignores a neighbouring document the range endpoint returned", () => {
    // `getInvoices` is a range query with both ends defaulted to the same value.
    // A third party returning a neighbour must not become a match.
    const v = reconcileInvoice({
      lead: lead(),
      invoices: [invoice({ docNo: "188768" })],
    });
    expect(v.status).toBe("not_matched");
  });
});

describe("discrepancies on a matched document", () => {
  it("flags a date that disagrees", () => {
    const v = reconcileInvoice({
      lead: lead({ sourceDate: "2026-07-29" }),
      invoices: [invoice()],
    });
    expect(v.status).toBe("matched");
    expect(v.discrepancies).toContain("date_mismatch");
  });

  it("flags a product that is not on the invoice", () => {
    const v = reconcileInvoice({
      lead: lead({ itemCode: "10104198", itemName: "OZEMPIC 1 MG" }),
      invoices: [invoice()],
    });
    expect(v.status).toBe("matched");
    expect(v.discrepancies).toContain("product_not_on_invoice");
    expect(v.matchedLine).toBeNull();
  });

  it("matches a product by name when the code was lost", () => {
    const v = reconcileInvoice({
      lead: lead({ itemCode: null }),
      invoices: [invoice()],
    });
    expect(v.discrepancies).not.toContain("product_not_on_invoice");
    expect(v.matchedLine?.itemName).toContain("MOUNJARO");
  });

  it("does not match two strengths that share a prefix", () => {
    // "MOUNJARO KWIKPEN 5 MG" and "MOUNJARO KWIKPEN 15MG" are different
    // medicines, so the name fallback compares whole strings.
    const v = reconcileInvoice({
      lead: lead({ itemCode: null, itemName: "MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR" }),
      invoices: [invoice()],
    });
    expect(v.discrepancies).toContain("product_not_on_invoice");
  });

  it("flags a quantity that disagrees", () => {
    const v = reconcileInvoice({
      lead: lead({ quantity: 2 }),
      invoices: [invoice({ items: [item({ quantity: 1 })] })],
    });
    expect(v.discrepancies).toContain("quantity_mismatch");
  });

  it("flags a cancelled invoice", () => {
    const v = reconcileInvoice({ lead: lead(), invoices: [invoice({ cancelled: true })] });
    expect(v.status).toBe("matched");
    expect(v.discrepancies).toContain("invoice_cancelled");
  });

  it("does not invent a date disagreement when the lead has no date", () => {
    const v = reconcileInvoice({ lead: lead({ sourceDate: null }), invoices: [invoice()] });
    expect(v.discrepancies).not.toContain("date_mismatch");
  });

  it("does not invent a quantity disagreement when the lead has no quantity", () => {
    const v = reconcileInvoice({ lead: lead({ quantity: null }), invoices: [invoice()] });
    expect(v.discrepancies).not.toContain("quantity_mismatch");
  });
});

describe("the free cross-check from the customer's own history", () => {
  /*
   * The history is already on screen for Phase 2, so consulting it costs no
   * request. It is what makes "wrong branch" detectable without the branch
   * sweep's fan-out.
   */
  it("says where else the document number appears", () => {
    const v = reconcileInvoice({
      lead: lead(),
      invoices: [],
      historyDocuments: [{ docNo: "188767", branchCode: "P0027" }],
    });
    expect(v.status).toBe("not_matched");
    expect(v.discrepancies).toContain("found_at_another_branch");
    expect(v.reason).toContain("P0027");
  });

  it("does not claim another branch when the history shows the same one", () => {
    const v = reconcileInvoice({
      lead: lead(),
      invoices: [],
      historyDocuments: [{ docNo: "188767", branchCode: "P0001" }],
    });
    expect(v.discrepancies).not.toContain("found_at_another_branch");
  });

  it("is unaffected when there is no history to consult", () => {
    expect(reconcileInvoice({ lead: lead(), invoices: [] }).discrepancies).toEqual([]);
  });
});

describe("branch stock, through the integration's own logic", () => {
  /*
   * `branchStockState` is the Stock tab's rule and is reused verbatim. These
   * assert the four states as a telesales lead meets them, so a change to that
   * shared function is caught here as well as in the Shams module's own tests.
   */
  const rows = (over: Partial<ShamsBranchStock>[] = []): ShamsBranchStock[] =>
    over.map((o) => ({
      branchCode: "P0001",
      branchName: "P0001",
      areaName: "JEDDAH",
      quantity: 0,
      lzQuantity: 0,
      ...o,
    }));

  it("reports stock at the lead's branch", () => {
    expect(branchStockState(rows([{ branchCode: "P0001", quantity: 7 }]), "P0001")).toEqual({
      state: "in_stock",
      quantity: 7,
    });
  });

  it("reports out of stock as a quantity, not as unknown", () => {
    expect(branchStockState(rows([{ branchCode: "P0001", quantity: 0 }]), "P0001")).toEqual({
      state: "out_of_stock",
      quantity: 0,
    });
  });

  it("reports a product the MIS does not carry as not found", () => {
    expect(branchStockState([], "P0001")).toEqual({ state: "not_found", quantity: null });
  });

  it("reports a branch missing from a non-empty response as unknown, not empty", () => {
    // The distinction the availability module documents: a branch absent from a
    // response that listed others is unaccounted for, not empty-handed.
    expect(branchStockState(rows([{ branchCode: "P0005", quantity: 3 }]), "P0001")).toEqual({
      state: "unknown",
      quantity: null,
    });
  });

  it("reports a lookup that never happened as unknown", () => {
    expect(branchStockState(undefined, "P0001")).toEqual({ state: "unknown", quantity: null });
  });

  it("matches the branch case-insensitively", () => {
    expect(branchStockState(rows([{ branchCode: "p0001", quantity: 2 }]), "P0001").state).toBe(
      "in_stock",
    );
  });
});
