/**
 * Shams CRM wire and normalized shapes.
 *
 * A different system from the MIS in `src/lib/shams` — different host, different
 * authentication, different envelope — so the types live apart rather than being
 * widened to cover both. See `docs/shams/api-discovery.md` §10.
 */

/** `POST /login`. Every field optional: the client trusts none of them. */
export interface RawCrmLoginResponse {
  session_token?: string;
  id?: number | string;
  role?: string;
  branch_code?: string;
  username?: string;
  allowed_features?: unknown;
}

/**
 * A row of `GET /products/names`.
 *
 * The response is a **bare JSON array**, not the `{success, count, data}`
 * envelope the MIS uses. Three fields, nothing else — no barcode, pack size,
 * category, or Arabic name.
 */
export interface RawCrmProductRow {
  code?: string;
  name?: string;
  price?: number;
}

/** One catalog product, named to match `ShamsProduct` so callers read alike. */
export interface ShamsCrmProduct {
  itemCode: string;
  itemName: string;
  retailPrice: number;
}

/**
 * Who the server says we are.
 *
 * Deliberately **without** the session token: this is the shape a caller may
 * see, and the token must never leave the client module.
 */
export interface ShamsCrmIdentity {
  userId: string | null;
  role: string | null;
  branchCode: string | null;
  username: string | null;
}

/* -------------------------------------------------------------------------- */
/* Offers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A branch row of `GET /products/{item_code}/available-branches`.
 *
 * The response carries more than this — `price_without_tax`, distance, and a
 * `branch` object with address, coordinates, `whatsapp` and `maps_url`. Only
 * the fields below are declared, because only they are read.
 *
 * ## `available_qty` — read for one purpose, and only one
 *
 * It was deliberately absent, so CRM availability could not drift into a view
 * where MIS stock is the authority. It is declared now because answering
 * "does this offer cover **every branch that has the product**, or only some?"
 * needs a denominator, and this response is the only place that carries the
 * offer and the availability together — the endpoint returns a row for every
 * branch in the chain, not only stocked ones, so counting rows would answer a
 * different question.
 *
 * **It is never rendered as stock and never reaches a stock view.** It is
 * consumed inside `offers.server.ts` to produce two integers and is dropped
 * there; `ShamsCrmOffer` still has no quantity field, and MIS `product/stock`
 * remains the only source of the numbers an agent reads.
 */
export interface RawCrmBranchOfferRow {
  branch?: { code?: string };
  price?: number;
  offer_percent?: number;
  offer_display?: string;
  after_offer_price?: number;
  /** Branch availability. Scope denominator only — see above. */
  available_qty?: number;
}

export interface RawCrmAvailableBranchesResponse {
  item_code?: string;
  branches?: RawCrmBranchOfferRow[];
}

/* -------------------------------------------------------------------------- */
/* Offer scope                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How widely an item's offer applies, as a single word.
 *
 * `unknown` is a real member and not a failure: offers cost one 62 KB request
 * per item with no bulk form, so a large result set is deliberately not
 * checked. A UI that rendered "no offer" for an item nobody asked about would
 * be stating something it does not know.
 */
export type ShamsOfferScopeKind = "all" | "some" | "none" | "unknown";

/**
 * One item's offer coverage, summarised for a list.
 *
 * Deliberately small. The underlying response is ~62 KB of per-branch rows and
 * none of it needs to reach a browser that is only asking whether a badge
 * belongs on a row.
 */
export interface ShamsOfferScope {
  itemCode: string;
  kind: ShamsOfferScopeKind;
  /** Branches holding the item, per the CRM's own availability rows. */
  branchesAvailable: number;
  /** How many of those also carry an offer. */
  branchesWithOffer: number;
  /**
   * The discount to show, preformatted by the API (e.g. `"25.00%"`).
   *
   * `null` when there is no offer, or when branches disagree — a single figure
   * would be wrong in that case, and §11.4 records that whether offers vary by
   * branch is NOT VERIFIED, so the disagreeing case is handled rather than
   * assumed away.
   */
  offerDisplay: string | null;
}

/**
 * Offer pricing for one item at one branch.
 *
 * Separate from `ShamsProduct` on purpose: an offer is branch-specific and
 * time-varying, while the catalog is reference data cached for six hours.
 * `docs/shams/api-discovery.md` §11.4.
 *
 * There is no offer id, name, validity window or eligibility rule — the API
 * exposes none, so none is modelled.
 */
export interface ShamsCrmOffer {
  itemCode: string;
  /** `P` + 4 digits, the same identifier MIS stock rows use. */
  branchCode: string;
  /** List price before the offer, as the CRM reports it. */
  price: number;
  offerPercent: number;
  /** Preformatted by the API, e.g. `"25.00%"`. */
  offerDisplay: string;
  /** The price to charge. Taken from the API, never recomputed. */
  afterOfferPrice: number;
}
