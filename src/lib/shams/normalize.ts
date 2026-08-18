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
 *
 * `crm/data` is the other exception, and a larger one: identifying a customer is
 * the entire point of that endpoint, so `groupCrmHistory` keeps the name, the
 * mobile number and the loyalty id. Nothing is dropped there because there is
 * nothing incidental to drop — every field it returns was asked for. The
 * boundary that matters for the CRM is therefore not this one but the
 * permission gate in `shams.functions.ts` and the rule that a mobile number is
 * never written into a URL. See `docs/shams/api-discovery.md` §6.
 */

import type {
  RawCrmRow,
  RawProductInfo,
  RawProductSearchRow,
  RawSalesRow,
  RawStockRow,
  ShamsBranchStock,
  ShamsCrmCustomer,
  ShamsCrmSale,
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

/* -------------------------------------------------------------------------- */
/* CRM                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The key the branch label arrives under: the empty string.
 *
 * `crm/data` rows carry `"": "P0215-JEDDAH"` — an unaliased column in the
 * upstream query. Named here so the two places that touch it say why, rather
 * than leaving a bare `row[""]` that reads like a bug.
 */
export const CRM_BRANCH_KEY = "" as const;

/**
 * `"P0215-JEDDAH"` → `{branchCode: "P0215", branchCity: "JEDDAH"}`.
 *
 * The code is what matters: it is the same identifier space as `branches.
 * branch_no` and as `sales/details`'s `wh_cd`, so it is what makes a history row
 * linkable to a document. A label that does not start with a branch code yields
 * `branchCode: null` and keeps the label intact — better to show an agent a
 * string the MIS printed than to drop the branch entirely, but a `null` code
 * means nothing downstream will try to look the document up.
 */
export function parseCrmBranch(value: unknown): {
  branchCode: string | null;
  branchCity: string | null;
  branchLabel: string | null;
} {
  const label = toText(value);
  if (!label) return { branchCode: null, branchCity: null, branchLabel: null };
  // Anchored: the code is a prefix, and the rest — however it is punctuated —
  // is the city. Splitting on every hyphen would mangle a hyphenated city name.
  const match = /^([A-Za-z]\d{4})\s*-\s*(.*)$/.exec(label);
  if (!match) return { branchCode: null, branchCity: null, branchLabel: label };
  return {
    branchCode: match[1].toUpperCase(),
    branchCity: toText(match[2]),
    branchLabel: label,
  };
}

/**
 * A mobile number in the form `crm/data` is queried with.
 *
 * The capture is unambiguous about there being *two* forms: the request asked
 * for `mobileno=555555555` and the response reported `Mobileno: "0555555555"`.
 * The API is therefore queried in the nine-digit national form without its
 * leading zero, and every way an agent might have the number written down —
 * `0555555555`, `+966 55 555 5555`, `00966555555555`, `055-555-5555` — has to
 * arrive at it.
 *
 * So: keep the digits, drop an international prefix, drop the trunk zero.
 * Returns `null` for anything that does not then look like a Saudi mobile.
 *
 * The nine-digits-starting-five shape is this portal's own input guard, not a
 * rule the API published — `crm/data` answers `200` with `count: 0` for a
 * number it does not know, so without a guard a typo is indistinguishable from
 * a customer who has never shopped. It is deliberately the only thing here that
 * is not read off the wire.
 */
export function normalizeCrmMobile(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;

  let digits = text.replace(/\D+/g, "");
  // `00` then country code, or a bare country code. Applied in that order so
  // `00966…` loses both and not just the first.
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("966")) digits = digits.slice(3);
  digits = digits.replace(/^0+/, "");

  return /^5\d{8}$/.test(digits) ? digits : null;
}

/**
 * Fold a `crm/data` response into one customer and their purchased lines.
 *
 * The payload repeats the customer on every row, so the customer is read from
 * the first row that actually names one and the rest are read as history. Rows
 * are **not** grouped into documents: unlike `sales/details` there are no
 * document totals to fold — a row is one item on one invoice, and that is the
 * granularity the history is genuinely at.
 *
 * Order is preserved as returned. The API expresses no other ordering, and
 * re-sorting client-side would fight the paging, which is server-side.
 */
export function groupCrmHistory(rows: RawCrmRow[] | undefined | null): {
  customer: ShamsCrmCustomer | null;
  sales: ShamsCrmSale[];
} {
  if (!Array.isArray(rows)) return { customer: null, sales: [] };

  let customer: ShamsCrmCustomer | null = null;
  const sales: ShamsCrmSale[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    // First row carrying an id wins. An id is the one field that makes the
    // customer identifiable, so a row without one cannot establish identity —
    // and the points would then belong to nobody.
    if (customer === null) {
      const customerId = toText(row.Id);
      if (customerId) {
        customer = {
          customerId,
          name: toText(row.Name),
          mobile: toText(row.Mobileno),
          availablePoints: toQuantity(row.Lm_Availbale_Points),
          pointsValue: toMoney(row.Lm_Availbale_Value),
        };
      }
    }

    const branch = parseCrmBranch(row[CRM_BRANCH_KEY]);
    const docNo = toText(row.InvNo);
    sales.push({
      docNo: docNo === null ? null : stripLeadingZeros(docNo),
      docDate: toIsoDateTime(row.InvDate),
      branchCode: branch.branchCode,
      branchCity: branch.branchCity,
      branchLabel: branch.branchLabel,
      itemCode: toText(row.Itm_Cd),
      itemName: toText(row.Itm_Name),
      quantity: toQuantity(row.Qty),
    });
  }

  return { customer, sales };
}
