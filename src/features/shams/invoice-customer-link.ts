/**
 * Which customer a document belongs to — but only when Shams said so.
 *
 * ## The relationship this API does and does not expose
 *
 * The obvious enrichment — read an invoice, find its customer — is **not
 * available**, and the capture is clear about why. `sales/details` returns six
 * customer-ish fields (`PatCd`, `CusName`, `Customer`, `Customer_Name`,
 * `Customer_Code`, `Cus_Cd`) and **none of them is a mobile number**; on the
 * captured document they hold an account label (`CASH IN BOX-`) and a ledger
 * code (`14-00-0052`), which identify the *till*, not the person. `crm/data`
 * takes `mobileno` and nothing else. So there is no key to join on, and any
 * invoice → customer lookup would have to guess.
 *
 * The relationship runs the other way, and there it is explicit: a `crm/data`
 * row names the document its line was sold on — `InvNo` `"22635"` with branch
 * `"P0215-JEDDAH"` — and the MIS portal's own operator followed exactly that
 * link in the capture, calling `sales/details?doc_no_start=22635&wh_cd=p0215`
 * straight afterwards. A customer identified this way is not inferred; it is
 * what the CRM endpoint returned.
 *
 * ## So this is a note of provenance, not a cache
 *
 * When an agent opens a document *from* a customer's history, this remembers
 * which customer that history was. The Invoices tab reads it and shows the
 * customer for that one document. A document reached any other way — typed into
 * the search box, arrived at from an order — has no entry here and shows no
 * customer, because for that document nothing has established one.
 *
 * That is also the whole performance story. Enrichment costs **zero** extra
 * requests: the customer was already on screen when the agent clicked. There is
 * no per-invoice CRM call to deduplicate, batch or throttle, because there is
 * no per-invoice CRM call.
 *
 * ## Deliberately in memory, deliberately not persisted
 *
 * A tab-local `Map`, cleared by a refresh. It holds a name and a mobile number,
 * so it goes no further than the session that fetched them: not `localStorage`,
 * not the URL, not a server-side store keyed by mobile number. Losing it on
 * reload is correct — the agent would be re-doing the CRM search anyway, and a
 * link this cheap to re-establish is not worth persisting identifiable data
 * for.
 */

import { stripLeadingZeros } from "@/lib/shams/normalize";
import type { ShamsCrmCustomer } from "@/lib/shams/types";

/**
 * Bound on remembered links.
 *
 * One entry per document an agent has opened from a history. A shift of heavy
 * use is tens; this is generous and stops a long-lived tab growing without end.
 */
const MAX_ENTRIES = 200;

/**
 * `(branch, document)` → the customer whose history named it.
 *
 * Keyed on the document's full identity because a document number alone is not
 * one: `22635` exists in many warehouses and means a different sale in each.
 * Keying on the number alone would attach a Jeddah customer to a Riyadh
 * document — precisely the false match this module exists to avoid.
 */
const links = new Map<string, ShamsCrmCustomer>();

/** Zero-padding is input formatting, not identity — `022635` is `22635`. */
function linkKey(branchCode: string, docNo: string): string {
  return `${branchCode.trim().toUpperCase()}::${stripLeadingZeros(docNo.trim())}`;
}

/**
 * Record that Shams reported this document on this customer's history.
 *
 * Called only from the CRM history table, with the customer that same response
 * returned. Nothing else may write here: an entry means "the API said so", and
 * a caller that had to work the relationship out for itself does not qualify.
 */
export function rememberInvoiceCustomer(
  branchCode: string | null,
  docNo: string | null,
  customer: ShamsCrmCustomer | null,
): void {
  if (!branchCode || !docNo || !customer) return;

  const key = linkKey(branchCode, docNo);
  // Refresh insertion order on re-open, so the eviction below drops the
  // genuinely least recent rather than whatever was written first.
  links.delete(key);

  if (links.size >= MAX_ENTRIES) {
    const oldest = links.keys().next();
    if (!oldest.done) links.delete(oldest.value);
  }
  links.set(key, customer);
}

/**
 * The customer for this document, or `null`.
 *
 * `null` is the normal answer and never an error state: almost every document
 * anyone looks up was reached by number, and for those the honest thing to show
 * is nothing at all.
 */
export function recallInvoiceCustomer(
  branchCode: string | null | undefined,
  docNo: string | null | undefined,
): ShamsCrmCustomer | null {
  if (!branchCode || !docNo) return null;
  return links.get(linkKey(branchCode, docNo)) ?? null;
}

/** Test seam. */
export function _clearInvoiceCustomerLinks(): void {
  links.clear();
}
