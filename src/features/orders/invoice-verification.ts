/**
 * An order's invoices and what has been verified about them. Pure, no I/O.
 *
 * ## Why an invoice can be missing and the order still fine
 *
 * A document does not appear in the MIS the moment an order is taken — it can
 * surface an hour or two later. So "not found" at 09:00 is **not** "does not
 * exist"; it is `pending`, and the order is valid either way. Nothing here ever
 * turns a failed or empty lookup into a permanent verdict, and nothing marks an
 * order invalid for want of an invoice. That single rule is why the state is a
 * named union rather than a boolean.
 *
 * ## One order, many invoices
 *
 * `orders.invoice_no` holds one *or many* numbers, so this models a collection
 * throughout. Identity is the number with leading zeros stripped — the MIS
 * accepts `022138` on input and returns `22138`, and an agent may type either —
 * which is what stops one document being counted as two.
 */

import { stripLeadingZeros } from "@/lib/shams/normalize";
import type { ItemAvailability } from "@/lib/shams/availability";

/**
 * Where one invoice number has got to.
 *
 *   pending      Shams has no such document at the branch asked. Expected for a
 *                fresh order; never a failure.
 *   verified     Shams returned the document. Its branch, customer and total are
 *                facts, and the branch is where Shams holds it, not where the
 *                order said.
 *   unavailable  The MIS could not be reached or refused. Temporary by
 *                assumption — distinct from `pending`, which is a real answer.
 */
export type InvoiceState = "pending" | "verified" | "unavailable";

/** One invoice on an order, with whatever is known about it so far. */
export interface OrderInvoice {
  /** As typed on the order, for display. */
  invoiceNo: string;
  /** Zero-stripped. The identity — two spellings of one document share it. */
  key: string;
  state: InvoiceState;
  /** Where Shams holds it. Null until verified; never taken from the order. */
  branchCode: string | null;
  /** The MIS customer label, verbatim. Null when the document has none. */
  customer: string | null;
  /** `Customer_Name`'s `-Call Centre` suffix rule, carried not re-derived. */
  isCallCentre: boolean;
  /** The document's grand total. Null unless verified — never guessed. */
  total: number | null;
  docDate: string | null;
  cancelled: boolean;
  /** Line-by-line availability at the branch that raised it. */
  items: ItemAvailability[];
}

/** What the order as a whole can say about its invoices. */
export interface InvoiceSummary {
  invoices: OrderInvoice[];
  verified: OrderInvoice[];
  pending: OrderInvoice[];
  unavailable: OrderInvoice[];
  /**
   * Sum of the verified totals, and only those.
   *
   * A pending invoice contributes nothing rather than a guess, so this is "what
   * has been confirmed so far" — which is exactly what it is labelled as while
   * `allVerified` is false.
   */
  verifiedTotal: number;
  /** True only when every number on the order has been verified. */
  allVerified: boolean;
  /** True when the order carries more than one number, whatever their state. */
  isMulti: boolean;
}

/** The identity of an invoice number: what makes two spellings one document. */
export function invoiceKey(invoiceNo: string): string {
  return stripLeadingZeros(invoiceNo.trim());
}

/**
 * Collapse an order's invoice list, keeping one entry per document.
 *
 * First mention wins, except that a verified entry always displaces an
 * unverified one for the same key — an order listing `22138` and `022138` has
 * one invoice, and if either lookup found it, it is found.
 */
export function dedupeInvoices(invoices: readonly OrderInvoice[]): OrderInvoice[] {
  const byKey = new Map<string, OrderInvoice>();
  for (const invoice of invoices) {
    const seen = byKey.get(invoice.key);
    if (!seen || (seen.state !== "verified" && invoice.state === "verified")) {
      byKey.set(invoice.key, invoice);
    }
  }
  return [...byKey.values()];
}

/**
 * The order's invoice position.
 *
 * Deduplicated first, so a total can never count one document twice however
 * many times it appears on the order.
 */
export function summarizeInvoices(invoices: readonly OrderInvoice[]): InvoiceSummary {
  const unique = dedupeInvoices(invoices);
  const verified = unique.filter((i) => i.state === "verified");
  const pending = unique.filter((i) => i.state === "pending");
  const unavailable = unique.filter((i) => i.state === "unavailable");

  const verifiedTotal = verified.reduce((sum, i) => sum + (i.total ?? 0), 0);

  return {
    invoices: unique,
    verified,
    pending,
    unavailable,
    // Rounded to the currency's own precision: summing floats off the wire
    // otherwise produces 380.00000000000006 for two clean figures.
    verifiedTotal: Math.round(verifiedTotal * 100) / 100,
    allVerified: unique.length > 0 && verified.length === unique.length,
    isMulti: unique.length > 1,
  };
}

/**
 * Should the portal record an automatic verification for this order?
 *
 * Deliberately narrow. Verification is claimed only when Shams actually
 * returned at least one document — never because a number was typed, because a
 * lookup ran, because one failed, or because the order exists. A pending or
 * unavailable invoice produces nothing, which is what keeps the Call Center
 * checkbox honest.
 *
 * `alreadyRecorded` carries the keys the order's timeline already holds, so a
 * re-render, a refetch or a second agent opening the same order re-derives the
 * same answer and asks for nothing. The database enforces this too; doing it
 * here as well means the common case makes no request at all.
 */
export function invoicesToRecord(
  summary: InvoiceSummary,
  alreadyRecorded: ReadonlySet<string>,
): OrderInvoice[] {
  return summary.verified.filter((i) => !alreadyRecorded.has(i.key));
}

/**
 * Does the order's stored value still disagree with what has been verified?
 *
 * This is the second half of the answer to "should we call the server", and it
 * exists because the first half was not enough. Recording used to be triggered
 * *only* by an invoice the timeline did not yet hold, which made the whole
 * thing a one-shot: if that single write did not land — the function not
 * deployed, a dropped response, a tab closed mid-flight — the order kept a
 * verified invoice of SAR 212.60 beside a value of 0.00 for ever, because every
 * later visit correctly concluded there was nothing *new* to record and
 * therefore asked for nothing.
 *
 * Comparing the figures instead makes it self-healing: whatever went wrong last
 * time, the next person to open the order reconciles it. Compared with a
 * tolerance rather than `!==` because the stored column is `numeric(12,2)` and
 * the total is a float summed from the wire.
 *
 * Returns false when nothing is verified — an order with no verified invoice has
 * nothing to be reconciled *to*, and must keep whatever value was typed.
 */
export function needsValueSync(
  summary: InvoiceSummary,
  storedValue: number | null | undefined,
  storedVerifiedFlag: boolean | null | undefined,
): boolean {
  if (summary.verified.length === 0) return false;
  if (!storedVerifiedFlag) return true;
  const stored = Number(storedValue ?? 0);
  return Math.abs(stored - summary.verifiedTotal) >= 0.005;
}
