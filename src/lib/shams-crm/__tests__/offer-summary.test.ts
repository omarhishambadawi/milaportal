/**
 * When a product may be shown a single discounted price — and when it may not.
 *
 * This is the rule that decides what a search row says about money, so the
 * tests are written as claims about the agent's screen rather than about the
 * function's shape. The failure this suite exists to prevent is specific and
 * expensive: a branch-specific promotion rendered as a global product price,
 * quoted to a customer, and wrong at whichever branch they walk into.
 *
 * `docs/shams/api-discovery.md` §11.4 records that whether an offer can differ
 * between branches is **NOT VERIFIED** — one captured item, 138 branches, all
 * agreeing. So the code does not assume they agree; it checks, every time, and
 * these are the checks.
 */

import { describe, expect, it } from "vitest";
import {
  hasOffer,
  hasProductOfferPrice,
  summariseProductOffer,
  unknownOfferSummary,
} from "@/lib/shams-crm/offer-summary";
import { classifyOfferScope } from "@/lib/shams-crm/offers.server";
import type { ShamsCrmOffer } from "@/lib/shams-crm/types";

const ITEM = "10400746";

const offer = (branchCode: string, overrides: Partial<ShamsCrmOffer> = {}): ShamsCrmOffer => ({
  itemCode: ITEM,
  branchCode,
  price: 60.62,
  offerPercent: 20,
  offerDisplay: "20.00%",
  afterOfferPrice: 48.5,
  ...overrides,
});

/**
 * The real classifier, not a stand-in.
 *
 * Coverage and the price pair are decided by two functions that have to agree,
 * and a hand-written scope object would let the suite pass while the pair
 * disagreed in production.
 */
const summarise = (offers: ShamsCrmOffer[], branchesAvailable: number) =>
  summariseProductOffer(classifyOfferScope(ITEM, offers, branchesAvailable), offers);

/* -------------------------------------------------------------------------- */
/* The case the screenshot was about                                           */
/* -------------------------------------------------------------------------- */

describe("a promotion at every stocking branch", () => {
  const offers = [offer("P0221"), offer("P0222"), offer("P0304")];

  it("yields a product-level price pair", () => {
    const summary = summarise(offers, 3);
    expect(summary.scope).toBe("all");
    expect(summary.offerDisplay).toBe("20.00%");
    expect(summary.unitPrice).toBe(60.62);
    expect(summary.offerPrice).toBe(48.5);
    expect(hasProductOfferPrice(summary)).toBe(true);
  });

  it("takes the offer price from the API rather than computing it", () => {
    // 60.62 less 20% is 48.496, which rounds to 48.50 — and that agreement is a
    // coincidence of this fixture, not a rule. The API's own figure is used
    // because rounding is Shams's to decide and the till applies theirs.
    const odd = [offer("P0221", { afterOfferPrice: 48.51 })];
    expect(summarise(odd, 1).offerPrice).toBe(48.51);
  });
});

/* -------------------------------------------------------------------------- */
/* The cases where a single price would be a lie                               */
/* -------------------------------------------------------------------------- */

describe("a promotion that does not reach every stocking branch", () => {
  // Three branches hold it; only one discounts it.
  const summary = summarise([offer("P0221")], 3);

  it("is classified as partial coverage", () => {
    expect(summary.scope).toBe("some");
  });

  it("carries no product-level price", () => {
    // The whole point. A row showing "48.50" here would be wrong at two of the
    // three branches a customer might walk into.
    expect(summary.unitPrice).toBeNull();
    expect(summary.offerPrice).toBeNull();
    expect(hasProductOfferPrice(summary)).toBe(false);
  });

  it("still earns a badge, so the agent knows a promotion exists", () => {
    expect(hasOffer(summary)).toBe(true);
    expect(summary.offerDisplay).toBe("20.00%");
  });
});

describe("branches that disagree", () => {
  it("withholds the price pair when the discounts differ", () => {
    const summary = summarise(
      [
        offer("P0221", { offerPercent: 20, offerDisplay: "20.00%", afterOfferPrice: 48.5 }),
        offer("P0222", { offerPercent: 25, offerDisplay: "25.00%", afterOfferPrice: 45.47 }),
      ],
      2,
    );
    // Coverage is still complete — every stocking branch discounts it — but
    // there is no single figure to name.
    expect(summary.scope).toBe("all");
    expect(summary.offerDisplay).toBeNull();
    expect(summary.offerPrice).toBeNull();
    expect(hasProductOfferPrice(summary)).toBe(false);
  });

  it("withholds it when the offer prices differ under one percentage", () => {
    // Same headline discount, different money. Possible if list prices differ
    // by branch, and a single "48.50" would then be wrong at one of them.
    const summary = summarise(
      [
        offer("P0221", { afterOfferPrice: 48.5 }),
        offer("P0222", { price: 62.0, afterOfferPrice: 49.6 }),
      ],
      2,
    );
    expect(summary.offerDisplay).toBe("20.00%");
    expect(summary.unitPrice).toBeNull();
    expect(summary.offerPrice).toBeNull();
  });

  it("withholds it when the list prices differ under one offer price", () => {
    const summary = summarise(
      [offer("P0221", { price: 60.62 }), offer("P0222", { price: 61.0 })],
      2,
    );
    expect(summary.unitPrice).toBeNull();
    expect(summary.offerPrice).toBeNull();
  });

  it("never yields half a price pair", () => {
    // A row showing an agreed discounted price beside a disputed list price
    // would invite exactly the wrong subtraction.
    for (const offers of [
      [offer("P0221", { price: 60.62 }), offer("P0222", { price: 61.0 })],
      [offer("P0221", { afterOfferPrice: 48.5 }), offer("P0222", { afterOfferPrice: 49.0 })],
    ]) {
      const summary = summarise(offers, offers.length);
      expect(summary.unitPrice === null).toBe(summary.offerPrice === null);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* No offer, and no answer                                                     */
/* -------------------------------------------------------------------------- */

describe("a product with no promotion", () => {
  const summary = summarise([], 40);

  it("is a real answer, not an absence", () => {
    expect(summary.scope).toBe("none");
    expect(summary.branchesAvailable).toBe(40);
    expect(summary.branchesWithOffer).toBe(0);
  });

  it("carries no badge and no price pair", () => {
    expect(hasOffer(summary)).toBe(false);
    expect(hasProductOfferPrice(summary)).toBe(false);
    expect(summary.offerPrice).toBeNull();
  });
});

describe("a product nobody has asked about", () => {
  const summary = unknownOfferSummary(ITEM);

  /**
   * The distinction the whole dataset is built around. Before the sweep reaches
   * an item there is no evidence either way, and rendering that as "no offer"
   * would tell an agent something nobody established.
   */
  it("is not the same as having no offer", () => {
    expect(summary.scope).toBe("unknown");
    expect(summary.scope).not.toBe("none");
  });

  it("carries no badge and no price pair", () => {
    expect(hasOffer(summary)).toBe(false);
    expect(hasProductOfferPrice(summary)).toBe(false);
  });

  it("is refused a price pair even if one were somehow attached", () => {
    // `hasProductOfferPrice` gates on `scope === "all"` as well as on the
    // numbers, so a malformed row cannot talk its way onto a search result.
    expect(hasProductOfferPrice({ ...summary, unitPrice: 60.62, offerPrice: 48.5 })).toBe(false);
  });
});

describe("the predicates refuse nothing at all", () => {
  it("treat null and undefined as no offer and no price", () => {
    expect(hasOffer(null)).toBe(false);
    expect(hasOffer(undefined)).toBe(false);
    expect(hasProductOfferPrice(null)).toBe(false);
    expect(hasProductOfferPrice(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage counts survive the summary                                         */
/* -------------------------------------------------------------------------- */

describe("the counts behind the badge", () => {
  it("carry through from the classifier unchanged", () => {
    const summary = summarise([offer("P0221"), offer("P0222")], 5);
    expect(summary.branchesAvailable).toBe(5);
    expect(summary.branchesWithOffer).toBe(2);
    // They are branch counts, not quantities. Nothing here is a stock figure,
    // and MIS `product/stock` remains the only source of those.
    expect(summary).not.toHaveProperty("quantity");
    expect(summary).not.toHaveProperty("availableQty");
  });

  it("keeps an offer at a branch holding nothing from reading as partial", () => {
    // `classifyOfferScope` clamps with `>=` for exactly this: an offer can sit
    // on a branch with no stock, and that must not look like a gap in coverage.
    const summary = summarise([offer("P0221"), offer("P0222")], 1);
    expect(summary.scope).toBe("all");
  });
});
