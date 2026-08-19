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
import type {
  RawCrmAvailableBranchesResponse,
  ShamsCrmOffer,
  ShamsOfferScope,
  ShamsOfferScopeKind,
} from "./types";

/** Matches the MIS stock TTL. An offer is a price, not reference data. */
const OFFER_TTL_MS = 60_000;

/** Larger than the branch list, so one item's offers never evict another's. */
const OFFER_CACHE_ENTRIES = 200;

/**
 * What one `available-branches` read yields, kept together.
 *
 * The offers and the count of branches holding the item come out of the *same*
 * 62 KB response, so caching them separately would mean fetching it twice to
 * answer two questions about one item. `branchesAvailable` is the denominator
 * for offer scope and nothing else — see `RawCrmBranchOfferRow`.
 */
interface OfferRead {
  offers: ShamsCrmOffer[];
  branchesAvailable: number;
}

const offerCache = new TtlCache<OfferRead>(OFFER_TTL_MS, OFFER_CACHE_ENTRIES);
/** In-flight reads, so N concurrent callers for one item cause one request. */
const inFlight = new Map<string, Promise<OfferRead>>();

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
): OfferRead {
  const rows = Array.isArray(body?.branches) ? body.branches : [];
  const out: ShamsCrmOffer[] = [];
  let branchesAvailable = 0;

  for (const row of rows) {
    const branchCode = typeof row?.branch?.code === "string" ? row.branch.code.trim() : "";
    if (!branchCode) continue;

    // The denominator for offer scope. The endpoint returns a row for every
    // branch in the chain rather than only stocked ones, so "branches that
    // have it" has to be read off the quantity — counting rows would answer
    // "how many branches exist", which is not the question a badge saying
    // "all branches" is making a claim about.
    const availableQty = num(row?.available_qty);
    if (availableQty !== null && availableQty > 0) branchesAvailable++;

    const offerPercent = num(row?.offer_percent);
    const afterOfferPrice = num(row?.after_offer_price);
    const price = num(row?.price);
    if (offerPercent === null || offerPercent <= 0) continue;
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
  return { offers: out, branchesAvailable };
}

/**
 * Classify how widely an offer applies. Pure — the rule, in one place.
 *
 * Exported so it can be tested directly and so the UI never re-derives it: the
 * difference between "all branches" and "some branches" is a claim to an agent
 * quoting a price, and a second copy of this comparison is how the two come to
 * disagree.
 *
 * The denominator is **branches that hold the item**, not branches that exist.
 * An offer on every stocking branch is "all" even when most of the chain has
 * none of the product, which is the reading that matches what an agent is
 * asking: "if I find it, is it on offer?"
 *
 * A branch with an offer but no stock cannot make the count exceed the
 * denominator into a false "some" — the comparison is clamped for that reason.
 */
export function classifyOfferScope(
  itemCode: string,
  offers: readonly ShamsCrmOffer[],
  branchesAvailable: number,
): ShamsOfferScope {
  const branchesWithOffer = offers.length;

  let kind: ShamsOfferScopeKind;
  if (branchesWithOffer === 0) {
    kind = "none";
  } else if (branchesAvailable === 0 || branchesWithOffer >= branchesAvailable) {
    // No stocking branch that lacks an offer. `>=` rather than `===` because an
    // offer can sit on a branch holding nothing, and that must not read as a
    // gap in coverage.
    kind = "all";
  } else {
    kind = "some";
  }

  // One figure only when every offering branch agrees on it. §11.4 records that
  // whether offers vary by branch is NOT VERIFIED, so disagreement is handled
  // rather than assumed impossible.
  const displays = new Set(offers.map((o) => o.offerDisplay));
  const offerDisplay = displays.size === 1 ? [...displays][0] : null;

  return { itemCode, kind, branchesAvailable, branchesWithOffer, offerDisplay };
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
async function readOffers(itemCode: string): Promise<OfferRead> {
  const code = itemCode.trim();
  if (!code) return { offers: [], branchesAvailable: 0 };

  const cached = offerCache.get(code);
  if (cached) return cached;

  const pending = inFlight.get(code);
  if (pending) return pending;

  const request = crmFetch<RawCrmAvailableBranchesResponse>(
    `/products/${encodeURIComponent(code)}/available-branches`,
  )
    .then((body) => {
      const read = normalizeOffers(code, body);
      offerCache.set(code, read);
      return read;
    })
    .finally(() => {
      inFlight.delete(code);
    });

  inFlight.set(code, request);
  return request;
}

export async function getProductOffer(itemCode: string): Promise<ShamsCrmOffer[]> {
  return (await readOffers(itemCode)).offers;
}

/**
 * How widely one item's offer applies.
 *
 * Reads the same cached response `getProductOffer` does, so an opened product
 * and the badge on the row it was opened from cost one request between them.
 */
export async function getProductOfferScope(itemCode: string): Promise<ShamsOfferScope> {
  const { offers, branchesAvailable } = await readOffers(itemCode);
  return classifyOfferScope(itemCode.trim(), offers, branchesAvailable);
}

/**
 * Hard ceiling on one batched scope lookup.
 *
 * This is the number that keeps a convenience from becoming an incident. There
 * is **no bulk offers endpoint** (`api-discovery.md` §11.5): each item is its
 * own ~62 KB request, so a badge on every row of an unbounded result set would
 * mean up to 100 upstream requests and megabytes of traffic *per search*.
 *
 * Twelve is chosen to match how the feature is actually used — an agent narrows
 * to a product and wants to know whether it is on offer before opening it — not
 * to browse the catalog. Above it the UI says offers were not checked rather
 * than showing blanks that would read as "no offer".
 */
export const MAX_OFFER_SCOPE_ITEMS = 12;

/** How many of those run at once. Small: each is a 62 KB response. */
const SCOPE_CONCURRENCY = 4;

/**
 * Offer scope for several items, in one call.
 *
 * One *browser* request for the whole result set, fanned out server-side under
 * bounded concurrency against the same 60 s cache and single-flight map that a
 * single product read uses. A repeated search inside that window costs nothing.
 *
 * An item that fails is **omitted**, not reported as having no offer. The
 * caller renders a missing entry as "not checked", which is the truth: the CRM
 * being unreachable is not evidence about a promotion.
 */
export async function getOfferScopes(itemCodes: readonly string[]): Promise<ShamsOfferScope[]> {
  const codes = [...new Set(itemCodes.map((c) => c.trim()).filter(Boolean))].slice(
    0,
    MAX_OFFER_SCOPE_ITEMS,
  );
  if (codes.length === 0) return [];

  const out: ShamsOfferScope[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= codes.length) return;
      try {
        out.push(await getProductOfferScope(codes[index]));
      } catch {
        // Omitted on purpose — see above.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SCOPE_CONCURRENCY, codes.length) }, worker));
  return out;
}
