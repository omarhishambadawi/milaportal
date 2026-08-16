/**
 * Shams CRM offer pricing (server-only).
 *
 * One endpoint, one item at a time:
 *
 *   GET /products/{item_code}/available-branches
 *
 * It is the only confirmed source of promotional pricing — there is no offers
 * feed, no bulk form and no offer entity of its own (`api-discovery.md` §11).
 * The response is ~62 KB for one item, which is the whole reason this is fetched
 * for a product an agent has actually opened and never for a result set.
 *
 * ## What is taken, and what is deliberately left
 *
 * Only the five pricing fields plus the branch code. The response also carries
 * `available_qty`, and it is **not read here**: MIS `product/stock` is the stock
 * authority for this page, and a second availability number flowing into the
 * same view is how the two quietly start disagreeing. Address, coordinates,
 * `whatsapp` and `maps_url` are likewise dropped rather than forwarded.
 *
 * ## Cache
 *
 * Its own, 60 s, keyed by item code — deliberately not the catalog's six hours.
 * An offer is a live price, and a stale one is a price an agent quotes wrongly;
 * 60 s matches the MIS stock TTL, which is the closer precedent. `TtlCache` is
 * reused rather than reinvented, with a single-flight map beside it so
 * concurrent opens of the same product cost one request.
 */

import { TtlCache } from "@/lib/shams/client.server";
import { crmFetch } from "./client.server";
import type { RawCrmAvailableBranchesResponse, ShamsCrmOffer } from "./types";

/** Matches the MIS stock TTL. An offer is a price, not reference data. */
const OFFER_TTL_MS = 60_000;

/** Larger than the branch list, so one item's offers never evict another's. */
const OFFER_CACHE_ENTRIES = 200;

const offerCache = new TtlCache<ShamsCrmOffer[]>(OFFER_TTL_MS, OFFER_CACHE_ENTRIES);
/** In-flight reads, so N concurrent callers for one item cause one request. */
const inFlight = new Map<string, Promise<ShamsCrmOffer[]>>();

/** Test seam. */
export function _clearOfferCache(): void {
  offerCache.clear();
  inFlight.clear();
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Rows that actually carry an offer, normalized.
 *
 * A branch with `offer_percent` absent, zero or negative has no offer, and is
 * dropped rather than returned as a zero-percent discount — the UI must never be
 * handed something it could render as "0% off". A row without a branch code
 * cannot be matched to an MIS row, so it is dropped too.
 *
 * `afterOfferPrice` comes from the API. It is never recomputed from `price` and
 * `offer_percent`: rounding is Shams's to decide, and a price we derived could
 * differ from the one the branch actually charges.
 */
function normalizeOffers(
  itemCode: string,
  body: RawCrmAvailableBranchesResponse | null,
): ShamsCrmOffer[] {
  const rows = Array.isArray(body?.branches) ? body.branches : [];
  const out: ShamsCrmOffer[] = [];
  for (const row of rows) {
    const branchCode = typeof row?.branch?.code === "string" ? row.branch.code.trim() : "";
    const offerPercent = num(row?.offer_percent);
    const afterOfferPrice = num(row?.after_offer_price);
    const price = num(row?.price);
    if (!branchCode || offerPercent === null || offerPercent <= 0) continue;
    if (afterOfferPrice === null || price === null) continue;
    out.push({
      itemCode,
      branchCode,
      price,
      offerPercent,
      offerDisplay:
        typeof row?.offer_display === "string" && row.offer_display.trim()
          ? row.offer_display.trim()
          : `${offerPercent}%`,
      afterOfferPrice,
    });
  }
  return out;
}

/**
 * Offer pricing for one item, per branch, for the branches that have one.
 *
 * An item with no offer anywhere returns `[]` — that is an answer, and it is
 * cached like any other, so a product without promotions does not re-ask every
 * time it is opened.
 *
 * Transport failures raise `ShamsCrmError`. Callers treat offers as optional and
 * catch; nothing here decides that for them.
 */
export async function getProductOffer(itemCode: string): Promise<ShamsCrmOffer[]> {
  const code = itemCode.trim();
  if (!code) return [];

  const cached = offerCache.get(code);
  if (cached) return cached;

  const pending = inFlight.get(code);
  if (pending) return pending;

  const request = crmFetch<RawCrmAvailableBranchesResponse>(
    `/products/${encodeURIComponent(code)}/available-branches`,
  )
    .then((body) => {
      const offers = normalizeOffers(code, body);
      offerCache.set(code, offers);
      return offers;
    })
    .finally(() => {
      inFlight.delete(code);
    });

  inFlight.set(code, request);
  return request;
}
