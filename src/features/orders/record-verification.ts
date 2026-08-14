/**
 * The single call that records an order's verified invoices.
 *
 * One RPC, and one place that knows how to shape it, because there are two
 * callers and they must not drift:
 *
 *   * `useOrderInvoices`, when an order is open and Shams has answered — the
 *     delayed-invoice path, where a document that landed an hour after the order
 *     was taken is reconciled on the next open;
 *   * the order form, immediately after **creating** an order whose invoice was
 *     already in the MIS — the case that had no path at all, because the whole
 *     mechanism was keyed on an order id that did not exist yet.
 *
 * Everything the recording *decides* lives in the database (see
 * `record_invoice_verification`): idempotence per invoice, the total recomputed
 * from the log, the Call Center flag read off the documents' own channel, and
 * the two automated timeline events. This is the wire, not the rule.
 */

import { supabase } from "@/integrations/supabase/client";
import { verificationEntries, type OrderInvoice } from "./invoice-verification";

/** What the server did, so a caller can tell a reconciliation from a no-op. */
export interface VerificationResult {
  recorded: number;
  verified_count: number;
  verified_total: number;
  call_centre_count: number;
  /** True when the order's value or flag actually moved. */
  synced: boolean;
  /** True only on the transition that ticked the Call Center box. */
  flagged: boolean;
}

/**
 * Record what Shams returned against an order.
 *
 * Returns null when there is nothing verified to send — a fresh order whose
 * invoice has not appeared yet is the ordinary case, not a failure, and must
 * cost no request.
 */
export async function recordInvoiceVerification(
  orderId: string,
  invoices: readonly OrderInvoice[],
): Promise<VerificationResult | null> {
  const entries = verificationEntries(invoices);
  if (entries.length === 0) return null;

  // `as any`: the RPC is newer than the generated types, which are re-emitted
  // upstream and must not be hand-edited.
  const { data, error } = await supabase.rpc("record_invoice_verification" as any, {
    _order_id: orderId,
    _entries: entries,
  });
  if (error) throw error;
  return data as unknown as VerificationResult;
}
