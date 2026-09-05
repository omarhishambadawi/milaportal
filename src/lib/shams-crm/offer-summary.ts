/**
 * One item's offer, reduced to what a product row can say. PURE: no I/O.
 *
 * The question this answers is narrow and load-bearing: **may a product be shown
 * a single discounted price?**
 *
 * An offer in this API is not a product-level thing. It is a discount percentage
 * on one item at one branch (`docs/shams/api-discovery.md` §11.2), denormalised
 * across every branch of the availability response. For the one captured item
 * all 138 branches reported the same `offer_percent`, which suggests the
 * discount really is a property of the product — but that is `n=1`, §11.4
 * records "whether an offer can differ between branches" as **NOT VERIFIED**,
 * and the per-branch shape is preserved until it is not.
 *
 * So a product-level price is offered only when the data itself proves it is
 * safe, and the proof is unanimity:
 *
 *   1. the offer reaches **every** branch holding the item (`scope.kind` is
 *      `all`) — otherwise the price depends on which branch the customer walks
 *      into, and a single figure would be wrong at some of them;
 *   2. every offering branch agrees on the **list** price;
 *   3. every offering branch agrees on the **offer** price.
 *
 * Any disagreement, and `unitPrice` / `offerPrice` are null. The badge still
 * renders — an agent should know a promotion exists — but the row shows the
 * catalogue price and says "some branches", and the per-branch figures are in
 * the Branch Stock table where they belong.
 *
 * ## Nothing here is arithmetic
 *
 * `offerPrice` is `afterOfferPrice` as the CRM sent it. No percentage is ever
 * applied to a price in this codebase: rounding is Shams's to decide, and a
 * figure derived here could differ by a halala from the one the till charges —
 * on a number an agent reads aloud to a customer.
 */

import type { ShamsCrmOffer, ShamsOfferScope, ShamsOfferScopeKind } from "./types";

/**
 * What the local offer dataset holds for one item, and what a row renders.
 *
 * Deliberately small and flat: this is the shape that crosses to the browser for
 * every product in a search result, so it carries a verdict rather than the
 * ~62 KB of per-branch rows it was computed from.
 */
export interface ShamsOfferSummary {
  itemCode: string;
  /**
   * Coverage, from `classifyOfferScope` — the same classification the badge has
   * always shown, now computed once at sync time instead of per request.
   *
   * `unknown` never reaches storage: it means "nobody asked", and a stored row
   * exists precisely because somebody did. It survives in the type because a
   * caller looking up an item the sweep has not reached yet gets `unknown`, and
   * that must not be confused with `none`.
   */
  scope: ShamsOfferScopeKind;
  /** Branches holding the item, per the CRM's own availability rows. */
  branchesAvailable: number;
  /** How many of those also carry an offer. */
  branchesWithOffer: number;
  /** Preformatted by the API, e.g. `"25.00%"`. Null when branches disagree. */
  offerDisplay: string | null;
  /**
   * The product's list price, when every offering branch quotes the same one.
   *
   * Null whenever a single product-level figure would be a claim the data does
   * not support. A caller with a null here shows the catalogue price instead —
   * never a price it derived.
   */
  unitPrice: number | null;
  /**
   * The price to charge, when one product-level figure is valid. Null otherwise.
   *
   * `unitPrice` and `offerPrice` are decided together and are null together: a
   * row showing one without the other would invite the reader to infer the
   * missing half.
   */
  offerPrice: number | null;
}

/** Every value in the list is the same one, and there is at least one. */
function unanimous(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

/**
 * Reduce one item's classified scope and per-branch offers to a product row.
 *
 * `scope` is passed in rather than recomputed so `classifyOfferScope` stays the
 * single authority on coverage — the badge, the stored summary and the Branch
 * Stock header all trace back to one comparison.
 */
export function summariseProductOffer(
  scope: ShamsOfferScope,
  offers: readonly ShamsCrmOffer[],
): ShamsOfferSummary {
  const base = {
    itemCode: scope.itemCode,
    scope: scope.kind,
    branchesAvailable: scope.branchesAvailable,
    branchesWithOffer: scope.branchesWithOffer,
    offerDisplay: scope.offerDisplay,
  };

  // No promotion, or one that does not reach every stocking branch. Either way
  // there is no single price this product can be said to cost.
  if (scope.kind !== "all" || offers.length === 0 || scope.offerDisplay === null) {
    return { ...base, unitPrice: null, offerPrice: null };
  }

  const unitPrice = unanimous(offers.map((offer) => offer.price));
  const offerPrice = unanimous(offers.map((offer) => offer.afterOfferPrice));

  // Both or neither. A row that showed an agreed discounted price beside a
  // disputed list price would invite exactly the wrong subtraction.
  if (unitPrice === null || offerPrice === null) {
    return { ...base, unitPrice: null, offerPrice: null };
  }

  return { ...base, unitPrice, offerPrice };
}

/**
 * The summary for an item the offer sweep has never covered.
 *
 * Its own constructor rather than a null the caller interprets, because the
 * distinction it encodes is the one this whole feature can get dangerously
 * wrong: **`unknown` is not `none`**. An item nobody has asked the CRM about has
 * no evidence either way, and rendering that as "no offer" would tell an agent
 * something nobody established — on a call, about money.
 */
export function unknownOfferSummary(itemCode: string): ShamsOfferSummary {
  return {
    itemCode,
    scope: "unknown",
    branchesAvailable: 0,
    branchesWithOffer: 0,
    offerDisplay: null,
    unitPrice: null,
    offerPrice: null,
  };
}

/** Does this summary carry a promotion worth putting a badge on? */
export function hasOffer(summary: ShamsOfferSummary | undefined | null): boolean {
  return summary?.scope === "all" || summary?.scope === "some";
}

/**
 * May this product show a single discounted price on a search row?
 *
 * The one predicate every caller uses, so "when is a global offer price valid"
 * has exactly one answer in the codebase.
 */
export function hasProductOfferPrice(
  summary: ShamsOfferSummary | undefined | null,
): summary is ShamsOfferSummary & { unitPrice: number; offerPrice: number } {
  return (
    !!summary &&
    summary.scope === "all" &&
    summary.unitPrice !== null &&
    summary.offerPrice !== null
  );
}
