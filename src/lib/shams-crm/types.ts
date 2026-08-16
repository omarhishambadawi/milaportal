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
 * The response carries more than this — `available_qty`, `price_without_tax`,
 * distance, and a `branch` object with address, coordinates, `whatsapp` and
 * `maps_url`. Only the fields below are declared, because only they are read:
 * `available_qty` in particular is deliberately absent, so CRM availability
 * cannot drift into a view where MIS stock is the authority.
 */
export interface RawCrmBranchOfferRow {
  branch?: { code?: string };
  price?: number;
  offer_percent?: number;
  offer_display?: string;
  after_offer_price?: number;
}

export interface RawCrmAvailableBranchesResponse {
  item_code?: string;
  branches?: RawCrmBranchOfferRow[];
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
