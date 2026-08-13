/**
 * Shams MIS → MilaServ normalization. Pure, synchronous, no I/O.
 *
 * Kept free of `fetch` and of Supabase so it can be unit-tested directly against
 * captured payloads, which is how every rule below was arrived at.
 *
 * ## Privacy
 *
 * `sales/details` returns identifiers (`PatCd`, `Customer`, `Customer_Code`,
 * `Cus_Cd`) alongside the amounts. They are dropped **here**, at the boundary,
 * rather than in the UI: a field that never leaves this function cannot reach a
 * cache, a log line, an XLSX export or the browser. Nothing in the current use
 * case — looking up a document's totals and lines — needs them.
 *
 * The customer *label* is the deliberate exception, because it carries the sales
 * channel. See `groupInvoices` for which field that is and why.
 */

import type {
  RawProductInfo,
  RawProductSearchRow,
  RawSalesRow,
  RawStockRow,
  ShamsBranchStock,
  ShamsInvoice,
  ShamsInvoiceItem,
  ShamsProduct,
  ShamsProductDetail,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse one of the API's numeric strings.
 *
 * The sales endpoint returns every number as a string and is inconsistent about
 * notation: `".000"`, `"0.0"`, `"806.22000000000003"`, `"-639.63"`, `""`. A bare
 * `Number()` copes with the leading-dot forms but turns `""` and `null` into
 * `0` silently, which is wrong for a genuinely absent value — so emptiness is
 * checked first and the caller decides what absent means.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A money figure, rounded to two decimals.
 *
 * The API leaks binary-float noise into its strings (`"806.22000000000003"`,
 * `"1445.8499999999999"`). Carrying that through means a UI that renders
 * 806.2200000000001, and totals that disagree with the pharmacy's own receipts
 * in the last decimal place.
 */
export function toMoney(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 100) / 100;
}

/** A quantity. Same parsing, but quantities are integral in practice. */
export function toQuantity(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 1000) / 1000;
}

/** Trim to a string, or null when absent/blank. */
function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The first value that is present and not blank.
 *
 * Blank counts as absent, which is the difference between this and the `??`
 * chain it replaces: the API spells a missing field `""` rather than `null`, so
 * `a ?? b` would settle on an empty `a` and never reach `b`.
 */
function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return null;
}

/**
 * `"2026-08-13 00:00:00"` → `"2026-08-13T00:00:00"`.
 *
 * The API supplies **no timezone**, so none is invented — appending `Z` here
 * would silently shift every document by three hours in a portal whose business
 * timezone is Asia/Riyadh. Unparseable input is passed through untouched rather
 * than nulled, so a format change surfaces as odd data rather than missing data.
 */
export function toIsoDateTime(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(text);
  return match ? `${match[1]}T${match[2]}` : text;
}

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

/** Rows missing an item code are dropped — they cannot be acted on. */
export function normalizeProducts(rows: RawProductSearchRow[] | undefined | null): ShamsProduct[] {
  if (!Array.isArray(rows)) return [];
  const out: ShamsProduct[] = [];
  for (const row of rows) {
    const itemCode = toText(row?.itemCode);
    if (!itemCode) continue;
    out.push({
      itemCode,
      itemName: toText(row?.itemName) ?? "",
      retailPrice: toMoney(row?.retailPrice),
    });
  }
  return out;
}

export function normalizeProductDetail(
  raw: RawProductInfo | null | undefined,
): ShamsProductDetail | null {
  const itemCode = toText(raw?.itemCode);
  if (!itemCode) return null;
  const retailPrice = toMoney(raw?.retailPrice);
  return {
    itemCode,
    itemName: toText(raw?.itemName) ?? "",
    retailPrice,
    // Falls back to the ex-tax price rather than to 0, so a missing field cannot
    // present as a free product.
    retailPriceWithTax:
      toNumber(raw?.retailPriceWithTax) === null ? retailPrice : toMoney(raw?.retailPriceWithTax),
  };
}

/**
 * Per-branch stock, ordered by branch code.
 *
 * The API returns a row per branch whether or not the item is stocked there
 * (136 of 136 rows zero for one captured item), so callers that only want
 * availability should filter on `quantity > 0` rather than expect a short list.
 */
export function normalizeStock(rows: RawStockRow[] | undefined | null): ShamsBranchStock[] {
  if (!Array.isArray(rows)) return [];
  const out: ShamsBranchStock[] = [];
  for (const row of rows) {
    const branchCode = toText(row?.branchCode);
    if (!branchCode) continue;
    out.push({
      branchCode,
      // Observed to always duplicate branchCode; echoed rather than dropped so
      // the model stays faithful to the API if that ever changes.
      branchName: toText(row?.branchName) ?? branchCode,
      areaName: toText(row?.areaName) ?? "",
      quantity: toQuantity(row?.quantity),
      lzQuantity: toQuantity(row?.lzQuantity),
    });
  }
  out.sort((a, b) => a.branchCode.localeCompare(b.branchCode));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Is this row the document header?
 *
 * `Prior === "0"` marks the header; item lines carry `"1"`, `"2"`, … . The
 * captured document shows why this cannot be skipped: its header row holds
 * `GrandAmt "806.220"` with empty item fields, and its single item row holds
 * `Amt "806.22000000000003"` with `GrandAmt ".000"`. Treating each row as an
 * invoice reports the document twice and doubles the day's takings.
 */
export function isHeaderRow(row: RawSalesRow): boolean {
  return toText(row?.Prior) === "0";
}

/**
 * Identity of the document a row belongs to.
 *
 * Document numbers are only unique **within a warehouse**, so the key is the
 * pair. `Doc_No` is normalized by stripping leading zeros because the API
 * accepts a zero-padded number on input (`doc_no_start=0075181`) but returns it
 * unpadded (`"75181"`) — without this, a caller who searched by the padded form
 * cannot match the document they get back.
 */
export function documentKey(row: RawSalesRow): string {
  const branch = toText(row?.Whouse) ?? "";
  const doc = stripLeadingZeros(toText(row?.Doc_No) ?? "");
  return `${branch}::${doc}`;
}

/** `"0075181"` → `"75181"`; `"0"` and `"000"` → `"0"`. */
export function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+/, "");
  return stripped === "" ? (value === "" ? "" : "0") : stripped;
}

/**
 * The Call Centre indicator, as it appears at the **end** of a `Customer` value.
 *
 * The suffix is the whole rule. Shams uses one account label per channel, and
 * the channel is expressed by appending `-Call Centre` — so `CALL CENTER SALES`
 * is a walk-in account whose *name* mentions a call center, while `CALL CENTER
 * SALES-Call Centre` is the call-centre account. Matching on the words alone
 * would classify the first as the second, which is the exact mistake this
 * pattern exists to avoid.
 *
 * What is tolerated is formatting only:
 * - case (`-CALL CENTRE`, `-call centre`),
 * - whitespace around the hyphen (`HOME DELIVERY - Call Centre`),
 * - trailing whitespace.
 *
 * What is not: the hyphen is required (so a bare `CALL CENTER` is not a match),
 * and the suffix must terminate the value (so `…-Call Centre Riyadh` is not).
 */
const CALL_CENTRE_SUFFIX = /-\s*call\s+centre\s*$/i;

/**
 * Is this `Customer` value a Call Centre account?
 *
 * The single home of the rule. Callers — server functions, the invoice UI, and
 * whatever Phase 2 matching needs — read `ShamsInvoice.isCallCentre` rather than
 * re-deriving it, so the business rule cannot drift between layers.
 */
export function isCallCentreCustomer(customer: unknown): boolean {
  const text = toText(customer);
  if (!text) return false;
  return CALL_CENTRE_SUFFIX.test(text);
}

function toInvoiceItem(row: RawSalesRow): ShamsInvoiceItem | null {
  const itemCode = toText(row?.ItmCd);
  if (!itemCode) return null;
  return {
    itemCode,
    itemName: toText(row?.ItmName) ?? "",
    quantity: toQuantity(row?.Qty),
    lzQuantity: toQuantity(row?.LzQty),
    freeQuantity: toQuantity(row?.FocQty),
    freeLzQuantity: toQuantity(row?.FocLzQty),
    unitRate: toMoney(row?.Rate),
    grossAmount: toMoney(row?.ItmGrossAmt),
    discountAmount: toMoney(row?.ItmDiscAmt),
    amount: toMoney(row?.Amt),
    tax: toMoney(row?.ItemTax),
    netAmount: toMoney(row?.Item_NetAmt),
  };
}

/**
 * Fold a flat `sales/details` response into documents.
 *
 * One response can carry many documents (a date-range or document-range query),
 * each contributing one header row and N item rows, all sharing the same 35
 * keys. Rows are bucketed by `documentKey`, the header supplies the totals and
 * the rest supply the lines.
 *
 * A bucket with no header row still yields an invoice — with zeroed totals and
 * its items intact — rather than being discarded. Losing lines silently because
 * the header was filtered out upstream is the worse failure: the totals being
 * zero is visible, missing items are not.
 *
 * Document order follows first appearance in the response; items keep their
 * given order, which is the only ordering the API expresses.
 *
 * ## Which field is "the customer"
 *
 * `Customer_Name`, falling back to `CusName` — **not** `Customer`. The response
 * carries several customer-ish fields and they do not agree: for document
 * P0221/22138, `Customer` holds the bare account name while `Customer_Name`
 * holds `…-Call Centre`, the label that says which sales channel the document
 * came through. Reading `Customer` therefore silently lost the suffix and
 * classified a call-centre invoice as a walk-in one.
 *
 * The precedence is not a guess: the MIS portal's own shipped bundle builds the
 * "Customer" line of its Sales Register as
 * `Customer_Name ?? CusName ?? ""`, and its "Customer code" line from
 * `Customer_Code`. Mirroring that is what makes the portal and MilaServ agree
 * about who a document belongs to. Blank is treated as absent, which `??` alone
 * does not do — the API spells a missing field `""`.
 */
export function groupInvoices(rows: RawSalesRow[] | undefined | null): ShamsInvoice[] {
  if (!Array.isArray(rows)) return [];

  const order: string[] = [];
  const buckets = new Map<string, { header: RawSalesRow | null; items: RawSalesRow[] }>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = documentKey(row);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { header: null, items: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    // First header wins; a duplicate would otherwise silently replace the totals.
    if (isHeaderRow(row)) {
      if (bucket.header === null) bucket.header = row;
    } else {
      bucket.items.push(row);
    }
  }

  const invoices: ShamsInvoice[] = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    // Identity may come from either row type — both carry Doc_No and Whouse.
    const identity = bucket.header ?? bucket.items[0];
    if (!identity) continue;

    const h = bucket.header;
    const items: ShamsInvoiceItem[] = [];
    for (const raw of bucket.items) {
      const item = toInvoiceItem(raw);
      if (item) items.push(item);
    }

    // The customer label lives on the header row only — item rows blank every
    // customer field — so a header-less bucket has no customer to report.
    const customer = firstText(h?.Customer_Name, h?.CusName);

    invoices.push({
      docNo: stripLeadingZeros(toText(identity.Doc_No) ?? ""),
      docDate: toIsoDateTime(identity.Doc_Dt),
      docType: toText(identity.Doc_type),
      branchCode: toText(identity.Whouse),
      division: toText(identity.Division),
      cancelled: toText(h?.Doc_Cancelled ?? identity.Doc_Cancelled) === "1",
      customer,
      isCallCentre: isCallCentreCustomer(customer),
      cashAmount: toMoney(h?.Cash_Amt),
      cashTax: toMoney(h?.Cash_Tax),
      creditAmount: toMoney(h?.Credit_Amt),
      creditTax: toMoney(h?.Credit_Tax),
      discount: toMoney(h?.Discount),
      totalTax: toMoney(h?.TotalTax),
      grandTotal: toMoney(h?.GrandAmt),
      totalCost: toMoney(h?.TotalCost),
      profit: toMoney(h?.Profit),
      items,
    });
  }

  return invoices;
}
