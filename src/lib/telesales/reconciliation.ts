import type { ShamsInvoice } from "@/lib/shams/types";
import { purchaseDay } from "./customer-intelligence";

/**
 * Reconciling a telesales lead against the invoice the MIS actually holds.
 *
 * Pure. Given a lead and whatever `sales/details` returned for its branch and
 * document number, this decides whether the lead corresponds to a real
 * purchase — and, when it does not quite, says which part disagrees.
 *
 * ===========================================================================
 * Why this is new logic when almost nothing else in this phase is
 * ===========================================================================
 * The stock question already had an answer in the integration
 * (`branchStockState`), and the customer question already had one
 * (`getCustomerHistory`). This one did not: the Shams module can fetch a
 * document, but nothing in it has ever had to decide whether a *lead* and a
 * *document* are the same commercial event. That comparison is the new part,
 * and it is here, pure and tested, rather than inside a component.
 *
 * ===========================================================================
 * Conservative, in a specific sense
 * ===========================================================================
 * The lookup is **branch-scoped**: `getInvoices` is asked for one document
 * number at one warehouse. That is deliberate and it is the whole reason this
 * can be trusted — a document number is unique only within a branch. MilaPortal's
 * own orders table demonstrates the failure it avoids: 29 invoice numbers there
 * appear against more than one branch, so a global lookup on the number alone
 * would confidently return somebody else's sale.
 *
 * Everything beyond "a document with this number exists at this branch" is
 * reported as a discrepancy rather than used to force a verdict, because the
 * document genuinely exists either way and an agent is better served by
 * "matched, but the product is not on it" than by a bare "not matched".
 */

/** The four states the brief requires, and no more. */
export type InvoiceMatchStatus = "matched" | "not_matched" | "ambiguous" | "not_checked";

/**
 * What disagrees between the lead and the document it matched.
 *
 * A discrepancy never downgrades `matched` on its own. The document is real and
 * the number and branch agree; these say what else does not.
 */
export type InvoiceDiscrepancy =
  | "date_mismatch"
  | "product_not_on_invoice"
  | "quantity_mismatch"
  | "invoice_cancelled"
  | "found_at_another_branch";

export const DISCREPANCY_LABELS: Record<InvoiceDiscrepancy, string> = {
  date_mismatch: "Invoice date differs from the lead's source date",
  product_not_on_invoice: "The lead's product is not on this invoice",
  quantity_mismatch: "Quantity differs from the lead",
  invoice_cancelled: "This invoice has been cancelled",
  found_at_another_branch: "This document number also appears at another branch",
};

/** Why a lead was not checked at all. Agent-facing. */
export type NotCheckedReason =
  | "wasfaty_lead"
  | "no_document_number"
  | "no_branch"
  | "branch_not_a_warehouse_code";

export const NOT_CHECKED_LABELS: Record<NotCheckedReason, string> = {
  wasfaty_lead: "Wasfaty leads are prescriptions, not Shams invoices.",
  no_document_number: "This lead carries no invoice number to check.",
  no_branch: "This lead carries no branch, and an invoice number is only unique within one.",
  branch_not_a_warehouse_code:
    "This lead's branch is not a Shams warehouse code, so the invoice cannot be looked up.",
};

/** One invoice line that matched, or the document's summary. */
export interface MatchedInvoice {
  docNo: string;
  docDate: string | null;
  /** `YYYY-MM-DD` where the date could be read. */
  docDay: string | null;
  branchCode: string | null;
  customer: string | null;
  cancelled: boolean;
  grandTotal: number;
  itemCount: number;
}

export interface MatchedLine {
  itemCode: string;
  itemName: string;
  quantity: number;
}

export interface InvoiceVerification {
  status: InvoiceMatchStatus;
  /** One sentence for the agent. Never an upstream message. */
  reason: string;
  notCheckedReason: NotCheckedReason | null;
  discrepancies: InvoiceDiscrepancy[];
  invoice: MatchedInvoice | null;
  /** The invoice line carrying the lead's product, when there is one. */
  matchedLine: MatchedLine | null;
  /** For `ambiguous`: what came back, so a person can choose. */
  candidates: MatchedInvoice[];
}

/**
 * The shape `getInvoices` will accept as a branch.
 *
 * Mirrors `BRANCH_CODE_PATTERN` in `sales.server.ts`, which is module-private.
 * Checking it here is not duplication of a *rule* — it is refusing to make a
 * request the validator would reject anyway, which matters because Wasfaty
 * leads carry pharmacy numbers like `202` and `123` in the same column. Sending
 * one would raise `invalid_query` and surface to an agent as a failure, when the
 * truthful answer is that there is nothing to check.
 */
const WAREHOUSE_CODE = /^[A-Z]\d{4}$/i;

/** The lead fields reconciliation needs. Kept narrow so tests read clearly. */
export interface ReconcilableLead {
  leadType: string;
  documentNo: string | null;
  branchNo: string | null;
  sourceDate: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantity: number | null;
}

/**
 * Can this lead be checked at all, and if not, why?
 *
 * Called before any request is made — a lead that cannot be verified must not
 * cost an upstream round trip to discover that.
 */
export function invoiceCheckability(
  lead: ReconcilableLead,
): { checkable: true } | { checkable: false; reason: NotCheckedReason } {
  if (lead.leadType === "wasfaty") return { checkable: false, reason: "wasfaty_lead" };
  if (!lead.documentNo?.trim()) return { checkable: false, reason: "no_document_number" };
  if (!lead.branchNo?.trim()) return { checkable: false, reason: "no_branch" };
  if (!WAREHOUSE_CODE.test(lead.branchNo.trim())) {
    return { checkable: false, reason: "branch_not_a_warehouse_code" };
  }
  return { checkable: true };
}

function summarize(invoice: ShamsInvoice): MatchedInvoice {
  return {
    docNo: invoice.docNo,
    docDate: invoice.docDate,
    docDay: purchaseDay({ docDate: invoice.docDate }),
    branchCode: invoice.branchCode,
    customer: invoice.customer,
    cancelled: invoice.cancelled,
    grandTotal: invoice.grandTotal,
    itemCount: invoice.items.length,
  };
}

function notChecked(reason: NotCheckedReason): InvoiceVerification {
  return {
    status: "not_checked",
    reason: NOT_CHECKED_LABELS[reason],
    notCheckedReason: reason,
    discrepancies: [],
    invoice: null,
    matchedLine: null,
    candidates: [],
  };
}

/**
 * One document number seen in the customer's own purchase history.
 *
 * Comes from the CRM history the profile has *already* loaded, so consulting it
 * costs nothing. It is what makes "found at another branch" detectable without
 * the branch-sweep fan-out: if the customer's history shows this document number
 * at a different warehouse, the lead's branch is probably wrong.
 */
export interface HistoryDocument {
  docNo: string | null;
  branchCode: string | null;
}

/**
 * Compare a lead with what the MIS returned for its branch and document number.
 *
 * `invoices` is the result of a branch-scoped single-document lookup, so it is
 * normally zero rows or one. More than one is treated as `ambiguous` rather than
 * resolved by picking: two documents sharing a number at one warehouse is not
 * something this function gets to adjudicate, and choosing would attach a lead
 * to a sale nobody verified.
 */
export function reconcileInvoice(input: {
  lead: ReconcilableLead;
  invoices: readonly ShamsInvoice[];
  /** Optional, free: the customer history already on screen. */
  historyDocuments?: readonly HistoryDocument[];
}): InvoiceVerification {
  const gate = invoiceCheckability(input.lead);
  if (!gate.checkable) return notChecked(gate.reason);

  const wanted = input.lead.documentNo!.trim();
  const branch = input.lead.branchNo!.trim().toUpperCase();

  /*
   * Only documents whose number actually equals the one asked for.
   *
   * `getInvoices` is a range query with both ends defaulted to the same value,
   * but the MIS is a third party and a range endpoint that returns a neighbour
   * is exactly the kind of thing that should not silently become a match.
   */
  const exact = input.invoices.filter((i) => i.docNo?.trim() === wanted);

  if (exact.length === 0) {
    const elsewhere = (input.historyDocuments ?? []).find(
      (d) =>
        d.docNo?.trim() === wanted &&
        (d.branchCode ?? "").trim().toUpperCase() !== branch &&
        Boolean(d.branchCode),
    );
    return {
      status: "not_matched",
      reason: elsewhere
        ? `No invoice ${wanted} at ${branch}. The customer's history shows this number at ${elsewhere.branchCode}.`
        : `No invoice ${wanted} was found at ${branch}.`,
      notCheckedReason: null,
      discrepancies: elsewhere ? ["found_at_another_branch"] : [],
      invoice: null,
      matchedLine: null,
      candidates: [],
    };
  }

  if (exact.length > 1) {
    return {
      status: "ambiguous",
      reason: `${exact.length} invoices at ${branch} carry the number ${wanted}. A person needs to choose.`,
      notCheckedReason: null,
      discrepancies: [],
      invoice: null,
      matchedLine: null,
      candidates: exact.map(summarize),
    };
  }

  const invoice = exact[0];
  const summary = summarize(invoice);
  const discrepancies: InvoiceDiscrepancy[] = [];

  if (invoice.cancelled) discrepancies.push("invoice_cancelled");

  /*
   * The product, matched on code and falling back to a name comparison.
   *
   * The code is the reliable half — the retention backlog carries Shams item
   * codes verbatim. The name fallback exists for the rows whose code was lost
   * upstream, and it is a whole-string comparison after case folding rather
   * than a substring test, because "MOUNJARO KWIKPEN 5 MG" and "MOUNJARO
   * KWIKPEN 15MG" share a prefix and are different medicines.
   */
  const leadCode = input.lead.itemCode?.trim();
  const leadName = input.lead.itemName?.trim().toUpperCase();
  const line =
    (leadCode ? invoice.items.find((i) => i.itemCode?.trim() === leadCode) : undefined) ??
    (leadName
      ? invoice.items.find((i) => (i.itemName ?? "").trim().toUpperCase() === leadName)
      : undefined);

  if (!line && (leadCode || leadName)) discrepancies.push("product_not_on_invoice");

  if (line && input.lead.quantity != null && Number(input.lead.quantity) !== line.quantity) {
    discrepancies.push("quantity_mismatch");
  }

  /*
   * Dates are compared by day, not by instant.
   *
   * The MIS supplies no timezone, so the day is read off the string — the same
   * rule the purchase history uses. A lead whose source date is absent is not a
   * disagreement; there is simply nothing to compare.
   */
  if (input.lead.sourceDate && summary.docDay && input.lead.sourceDate !== summary.docDay) {
    discrepancies.push("date_mismatch");
  }

  return {
    status: "matched",
    reason: discrepancies.length
      ? `Invoice ${wanted} exists at ${branch}, with ${discrepancies.length} thing${
          discrepancies.length === 1 ? "" : "s"
        } that do not agree.`
      : `Invoice ${wanted} at ${branch} matches this lead.`,
    notCheckedReason: null,
    discrepancies,
    invoice: summary,
    matchedLine: line
      ? { itemCode: line.itemCode, itemName: line.itemName, quantity: line.quantity }
      : null,
    candidates: [],
  };
}

/** Badge copy per status. */
export const MATCH_STATUS_LABELS: Record<InvoiceMatchStatus, string> = {
  matched: "Invoice matched",
  not_matched: "Invoice not matched",
  ambiguous: "Multiple possible invoices",
  not_checked: "Not checked",
};
