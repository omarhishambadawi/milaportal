/**
 * Presenting a customer's purchase history. Pure, synchronous, no I/O.
 *
 * Kept out of the components for the same reason the sorting is: month headings
 * and "which purchases belong to August" are rules, and a rule that lives in
 * JSX is a rule that gets a second, slightly different copy the next time
 * someone needs it.
 *
 * Everything here works on `ShamsCrmSale[]` in the order it is given, which is
 * newest-first by the time it leaves `normalize.ts`.
 */

import type { ShamsCrmSale } from "./types";

/**
 * Month names, written out rather than formatted through `Intl`.
 *
 * `toLocaleString` follows the runtime's locale, which on some machines renders
 * Arabic-Indic digits and month names the rest of this English UI does not use —
 * the portal already has tests failing for exactly that reason. A heading has to
 * agree with the dates in the rows beneath it.
 */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** One month's worth of a history. */
export interface ShamsCrmSaleMonth {
  /** `"2026-08"` — sortable, and unique per month. Used as a React key. */
  key: string;
  /** `"August 2026"`. `"Undated"` for rows the API gave no date. */
  label: string;
  sales: ShamsCrmSale[];
  /** How many distinct invoices the month covers, not how many lines. */
  invoices: number;
}

/**
 * The `YYYY-MM` a sale belongs to, or `null` when it has no usable date.
 *
 * Read off the ISO string rather than through `Date`. The API supplies no
 * timezone, so constructing an instant would move a midnight purchase into the
 * previous month for anyone west of Riyadh — and a purchase silently filed
 * under July when the receipt says August is worse than no grouping at all.
 */
export function saleMonthKey(sale: ShamsCrmSale): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(sale.docDate ?? "");
  return match ? `${match[1]}-${match[2]}` : null;
}

/** `"2026-08"` → `"August 2026"`. */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  return `${MONTH_NAMES[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/**
 * Split a history into months, preserving the order it arrived in.
 *
 * Deliberately **order-preserving rather than sorting**: the caller has already
 * sorted newest-first in the data layer, and re-sorting here would put the same
 * rule in two places and let them drift. Months come out in the order their
 * first row appears, and rows keep their relative order inside each month — so
 * a newest-first list yields newest-first months containing newest-first
 * purchases, with no second comparator to keep in step.
 *
 * Works for any range and assumes no particular months: a gap in a customer's
 * buying simply produces no heading, rather than an empty one.
 *
 * Undated rows collect into one trailing group instead of being dropped. A
 * purchase the API dated badly is still a purchase.
 *
 * ## Pagination
 *
 * This groups the page it is handed, because that is all the API returns —
 * `crm/data` pages server-side and reports no total. A month that straddles a
 * page boundary therefore gets a heading on both pages, which is the honest
 * rendering: the second page really is showing more of August. Nothing is
 * duplicated and nothing is hidden; each row appears under exactly one heading
 * on exactly one page.
 */
export function groupSalesByMonth(sales: readonly ShamsCrmSale[]): ShamsCrmSaleMonth[] {
  const order: string[] = [];
  const buckets = new Map<string, ShamsCrmSale[]>();

  for (const sale of sales) {
    const key = saleMonthKey(sale) ?? "";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(sale);
  }

  return order.map((key) => {
    const group = buckets.get(key) ?? [];
    return {
      key: key || "undated",
      label: key ? monthLabel(key) : "Undated",
      sales: group,
      invoices: countInvoices(group),
    };
  });
}

/**
 * How many distinct invoices a set of lines came from.
 *
 * The API returns one row per *item*, so a three-item purchase is three rows.
 * Counting rows and calling them purchases would overstate what a customer
 * bought — which is exactly the sort of invented metric a summary must not
 * carry.
 *
 * A line with no document number counts as its own invoice: it cannot be shown
 * to belong to any other, and folding all of them together would understate.
 */
export function countInvoices(sales: readonly ShamsCrmSale[]): number {
  let unidentified = 0;
  const seen = new Set<string>();
  for (const sale of sales) {
    if (!sale.docNo) {
      unidentified++;
      continue;
    }
    // Branch is part of a document's identity — numbers repeat across
    // warehouses, so the number alone would merge two different purchases.
    seen.add(`${sale.branchCode ?? ""}::${sale.docNo}`);
  }
  return seen.size + unidentified;
}

/**
 * The most recent purchase date in a history, or `null`.
 *
 * Taken by scanning rather than by trusting position, so it stays correct if a
 * caller ever hands over an unsorted list. Same string comparison as the sort:
 * ISO-8601 orders lexicographically.
 */
export function latestSaleDate(sales: readonly ShamsCrmSale[]): string | null {
  let latest: string | null = null;
  for (const sale of sales) {
    if (!sale.docDate) continue;
    if (latest === null || sale.docDate > latest) latest = sale.docDate;
  }
  return latest;
}
