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
