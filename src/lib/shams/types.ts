/**
 * Shams Pharmacy MIS — wire types and the normalized models the portal consumes.
 *
 * Every `Raw*` type below was read off a real HAR capture of the MIS portal
 * (2026-08-13, 21 requests). Nothing here is inferred from endpoint naming or
 * from what a pharmacy API "ought" to return: the catalog genuinely exposes
 * three fields, and the fields it does not expose (barcode, generic name,
 * strength, dosage form, pack size, category, VAT rate) are absent from these
 * types on purpose so that no consumer can come to depend on them.
 *
 * See `docs/shams/api-discovery.md` for the capture and the field-by-field
 * evidence, including what is marked NOT VERIFIED.
 */

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

/** Every observed response carries `success`; list responses add `count`. */
export interface RawEnvelope {
  success?: boolean;
  count?: number;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v2/auth/token` response — the API's machine authentication.
 *
 * Exchanged for `{account_identifier, api_key}`. No cookie is set; the token
 * travels in the `Authorization` header on every subsequent request.
 *
 * `expires_at` is an absolute ISO-8601 instant *with* offset (observed
 * `+03:00`). The client keys off `expires_in` instead — a duration cannot drift
 * with clock skew between this server and the MIS.
 */
export interface RawTokenResponse extends RawEnvelope {
  /** Observed: `"Bearer"`. */
  token_type?: string;
  access_token?: string;
  /** Seconds. Observed: 1800. */
  expires_in?: number;
  expires_at?: string;
  account_identifier?: string;
}

/**
 * The safe shape a credential/auth check returns.
 *
 * Carries no identifier, key or token — only whether the exchange worked and
 * how long the resulting token lasts.
 */
export interface ShamsAuthStatus {
  ok: boolean;
  tokenType: string;
  expiresInSec: number | null;
}

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

/** A row of `GET /api/v2/product/search?q=`. Exactly three fields. */
export interface RawProductSearchRow {
  itemCode?: string;
  itemName?: string;
  retailPrice?: number;
}

export interface RawProductSearchResponse extends RawEnvelope {
  search?: string;
  data?: RawProductSearchRow[];
}

/**
 * `GET /api/v2/product/info?itemcode=` payload.
 *
 * `data` is a single OBJECT here, not an array — the one place the API's
 * envelope shape changes between endpoints.
 */
export interface RawProductInfo {
  itemCode?: string;
  itemName?: string;
  retailPrice?: number;
  retailPriceWithTax?: number;
}

export interface RawProductInfoResponse extends RawEnvelope {
  data?: RawProductInfo | null;
}

/** A row of `GET /api/v2/product/stock?itemcode=` — one per branch. */
export interface RawStockRow {
  branchCode?: string;
  branchName?: string;
  areaName?: string;
  quantity?: number;
  lzQuantity?: number;
}

export interface RawStockResponse extends RawEnvelope {
  data?: RawStockRow[];
}

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A row of `GET /api/v2/sales/details`.
 *
 * Two things make this shape awkward, and both are properties of the API rather
 * than of this client:
 *
 * 1. **Every numeric arrives as a string**, in inconsistent notation — `".000"`,
 *    `"0.0"`, `"806.22000000000003"`, `"-639.63"`. They are parsed and rounded
 *    in `normalize.ts`, never used raw.
 * 2. **Header and item rows share one flat shape.** Both carry all 35 keys; the
 *    row's role is carried by `Prior` (see `normalize.ts`). A header row zeroes
 *    the item fields and an item row zeroes the document totals, so summing the
 *    response without splitting on `Prior` double-counts every invoice.
 */
export interface RawSalesRow {
  Usr_ID?: string;
  Doc_No?: string;
  Doc_Dt?: string;
  Doc_type?: string;
  /**
   * Customer / patient identifiers — see the privacy note in `normalize.ts`.
   *
   * These do **not** agree with each other. `Customer_Name` is the label the MIS
   * portal itself displays as "Customer", and the only one carrying the
   * `-Call Centre` channel suffix; `Customer` holds a bare account name. Only
   * `Customer_Name` (falling back to `CusName`) survives normalization.
   */
  PatCd?: string;
  CusName?: string;
  Customer?: string;
  Customer_Name?: string;
  Customer_Code?: string;
  Cus_Cd?: string;
  Whouse?: string;
  Division?: string;
  Doc_Cancelled?: string;
  Cash_Amt?: string;
  Cash_Tax?: string;
  Credit_Amt?: string;
  Credit_Tax?: string;
  Discount?: string;
  TotalCost?: string;
  Profit?: string;
  TotalTax?: string;
  GrandAmt?: string;
  /** Row discriminator: `"0"` = document header, anything else = item line. */
  Prior?: string;
  ItmCd?: string;
  ItmName?: string;
  Qty?: string;
  LzQty?: string;
  FocQty?: string;
  FocLzQty?: string;
  Rate?: string;
  ItmGrossAmt?: string;
  ItmDiscAmt?: string;
  Amt?: string;
  ItemTax?: string;
  Item_NetAmt?: string;
}

export interface RawSalesResponse extends RawEnvelope {
  /** The API echoes the parameters it actually understood. */
  parameters?: Record<string, string | null>;
  data?: RawSalesRow[];
}

/* -------------------------------------------------------------------------- */
/* CRM                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A row of `GET /api/v2/crm/data?mobileno=&fromdt=&todt=&page=&per_page=`.
 *
 * The shape is **denormalized**: there is no customer object and no nested
 * history. Every row repeats the same five customer fields and then carries one
 * purchased line. A customer who bought three items on two invoices comes back
 * as six rows with identical `Id`/`Name`/`Mobileno`/points.
 *
 * Two properties of this payload are worth stating before anyone extends it:
 *
 * 1. **The branch arrives under an empty key.** The JSON literally contains
 *    `"": "P0215-JEDDAH"` between `Lm_Availbale_Value` and `Customer` — the
 *    upstream query has an unaliased column. It is not a capture artefact and it
 *    is not renamed here, because `""` is the name. TypeScript can hold it and
 *    `normalize.ts` reads `row[""]`; see `CRM_BRANCH_KEY` there.
 * 2. **`Lm_Availbale_Points` is spelled that way upstream.** The transposition
 *    is the API's. Correcting it here would mean reading a field that does not
 *    exist.
 *
 * Numbers arrive as strings, as everywhere else in this API.
 */
export interface RawCrmRow {
  /** Loyalty customer id, e.g. `"333181"`. */
  Id?: string;
  /** The loyalty member's name — *not* the invoice's account label. */
  Name?: string;
  /** Observed with a leading zero (`"0555555555"`), unlike the query. */
  Mobileno?: string;
  /** Available loyalty points, e.g. `"1261.400000"`. */
  Lm_Availbale_Points?: string;
  /** Monetary value of those points in SAR, e.g. `"12.614000"`. */
  Lm_Availbale_Value?: string;
  /**
   * The document's account label, e.g. `"CASH IN BOX"`.
   *
   * The same document read through `sales/details` reports `Customer_Name`
   * `"CASH IN BOX-"`, so the two agree on the account but not character for
   * character. Nothing derives the call-centre flag from this field — that rule
   * belongs to `sales/details`, whose suffix this one does not reproduce.
   */
  Customer?: string;
  /** Document number, unpadded — e.g. `"22635"`. Pairs with the branch. */
  InvNo?: string;
  /** `"2026-07-03 00:00:00"`, no timezone, same as `sales/details`. */
  InvDate?: string;
  Itm_Cd?: string;
  Itm_Name?: string;
  Qty?: string;
  /**
   * The branch, under its empty key: `"P0215-JEDDAH"` — code, hyphen, city.
   *
   * Declared as an index signature because `""` cannot be written as a normal
   * property name in a way that reads clearly. Deliberately not widened to
   * `[key: string]` over `unknown`: that would let any misspelt field access
   * type-check.
   */
  "": string | undefined;
}

/**
 * `GET /api/v2/crm/data` envelope.
 *
 * The only endpoint in either capture with a `pagination` block — and the
 * block is half-empty. `total` and `total_pages` were `null` in every captured
 * response, including one that returned rows, so **the size of a result set is
 * not knowable from this API**. `page` and `per_page` are echoed and are real.
 * See `crm.server.ts` for how "is there another page" is answered without them.
 */
export interface RawCrmResponse extends RawEnvelope {
  pagination?: {
    page?: number | null;
    per_page?: number | null;
    /** Always `null` in every capture. Not relied on. */
    total?: number | null;
    /** Always `null` in every capture. Not relied on. */
    total_pages?: number | null;
  } | null;
  /** The API echoes the parameters it actually understood. */
  parameters?: Record<string, string | null>;
  data?: RawCrmRow[];
}

/* -------------------------------------------------------------------------- */
/* Normalized models — what MilaServ code consumes                             */
/* -------------------------------------------------------------------------- */

/** A catalog hit. Three fields, because that is what the catalog returns. */
export interface ShamsProduct {
  itemCode: string;
  itemName: string;
  /** SAR. */
  retailPrice: number;
}

/**
 * Product detail.
 *
 * In every captured response `retailPriceWithTax` equalled `retailPrice`, so
 * the tax-inclusive figure is carried through rather than being used to derive
 * a VAT rate — one equal pair is not evidence of a rate.
 */
export interface ShamsProductDetail extends ShamsProduct {
  retailPriceWithTax: number;
}

/** Per-branch availability for one item. */
export interface ShamsBranchStock {
  /** Shams branch code, e.g. `P0304`. Identical to `branches.branch_no`. */
  branchCode: string;
  /** Echoed from the API. Observed to always duplicate `branchCode`. */
  branchName: string;
  /** Region label, e.g. `RIYADH`, `QASIM`. */
  areaName: string;
  quantity: number;
  /** Semantics NOT VERIFIED — zero across every captured row. */
  lzQuantity: number;
}

/**
 * A branch that genuinely holds a given document number.
 *
 * Lives here rather than beside the fan-out that produces it because the
 * chooser UI consumes both this shape and the comparator that orders it, and
 * neither should drag a `.server` module into the client bundle.
 */
export interface InvoiceBranchMatch {
  branchCode: string;
  /** The document's date, so a chooser can tell two same-numbered docs apart. */
  docDate: string | null;
  grandTotal: number;
  cancelled: boolean;
  /** Carried through so the chooser can show the status without a second read. */
  isCallCentre: boolean;
  customer: string | null;
}

/** One line of an invoice. */
export interface ShamsInvoiceItem {
  itemCode: string;
  itemName: string;
  quantity: number;
  lzQuantity: number;
  /** Free-of-charge quantity. */
  freeQuantity: number;
  freeLzQuantity: number;
  unitRate: number;
  grossAmount: number;
  discountAmount: number;
  amount: number;
  tax: number;
  netAmount: number;
}

/**
 * A document assembled from its header row and its item rows.
 *
 * The identifiers present on the wire are deliberately absent: nothing in the
 * portal's use case needs them, and dropping them at the normalization boundary
 * means they cannot reach a cache, a log or the browser. `customer` is kept — it
 * is the account label the MIS portal itself displays for the document.
 */
export interface ShamsInvoice {
  /** Unpadded, as returned. The API accepts a zero-padded number on input. */
  docNo: string;
  /** ISO-8601 where parseable, else the raw string. */
  docDate: string | null;
  /** Observed values: `"Credit"`. Others NOT VERIFIED. */
  docType: string | null;
  /** Warehouse code — the same identifier space as `branches.branch_no`. */
  branchCode: string | null;
  division: string | null;
  cancelled: boolean;
  /**
   * The customer label the MIS portal shows for this document, verbatim apart
   * from trimming — read from `Customer_Name`, falling back to `CusName`.
   *
   * An account label — `HOME DELIVERY-Call Centre`, `CALL CENTER SALES`,
   * `NUPCO / …-Call Centre`. Kept unmodified because it is the raw evidence
   * behind `isCallCentre`, and because matching Shams documents to MilaServ
   * orders will need the label itself, not just the derived flag.
   */
  customer: string | null;
  /**
   * Did this document come through the call centre?
   *
   * Derived from `customer` alone, by the `-Call Centre` suffix rule in
   * `normalize.ts`. Consume this rather than re-reading the label: the rule is
   * narrower than it looks, and `CALL CENTER SALES` is *not* a call-centre
   * account.
   */
  isCallCentre: boolean;
  cashAmount: number;
  cashTax: number;
  creditAmount: number;
  creditTax: number;
  discount: number;
  totalTax: number;
  grandTotal: number;
  /** Cost and margin. Commercially sensitive — see the RBAC gate. */
  totalCost: number;
  profit: number;
  items: ShamsInvoiceItem[];
}

/* -------------------------------------------------------------------------- */
/* CRM — normalized                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The loyalty customer behind a mobile number.
 *
 * Lifted off the repeated columns of `crm/data` rows — every row carries the
 * same five — so a result set yields exactly one of these, or none.
 */
export interface ShamsCrmCustomer {
  /** Loyalty customer id, as returned. */
  customerId: string;
  name: string | null;
  /** As the API returns it (leading zero included), not as it was queried. */
  mobile: string | null;
  availablePoints: number;
  /** SAR value of `availablePoints`. */
  pointsValue: number;
}

/**
 * One purchased line from a customer's history.
 *
 * A line, not an invoice: `crm/data` returns one row per item, so a two-item
 * invoice appears twice with the same `docNo`. Nothing is folded into documents
 * here — unlike `sales/details`, this payload carries no document totals to
 * fold, and the history is genuinely a list of things the customer bought.
 */
export interface ShamsCrmSale {
  /** Document number, unpadded. Identifies an invoice only with `branchCode`. */
  docNo: string | null;
  /** ISO-8601 where parseable, else the raw string. No timezone — see `toIsoDateTime`. */
  docDate: string | null;
  /**
   * Warehouse code parsed out of the branch label, e.g. `P0215`.
   *
   * `null` when the label is missing or does not carry a recognisable code —
   * which is the signal that this row cannot be linked to a document, since
   * `sales/details` needs a `wh_cd`.
   */
  branchCode: string | null;
  /** The city half of the branch label, e.g. `JEDDAH`. */
  branchCity: string | null;
  /** The label verbatim, e.g. `P0215-JEDDAH`. Shown when it cannot be split. */
  branchLabel: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantity: number;
}

/**
 * One page of a customer's sales history.
 *
 * `hasMore` rather than a page count, because the API supplies no total —
 * see `RawCrmResponse`.
 */
export interface ShamsCrmHistory {
  /** `null` when the mobile number matched no customer. */
  customer: ShamsCrmCustomer | null;
  sales: ShamsCrmSale[];
  page: number;
  perPage: number;
  /** Whether a further page is worth asking for. Inferred; see `crm.server.ts`. */
  hasMore: boolean;
}
