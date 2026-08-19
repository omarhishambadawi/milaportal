/**
 * Offer coverage — "all branches" versus "some branches".
 *
 * This is a claim made to an agent who is about to quote a price, so the
 * classifier is tested rather than trusted. The failure that matters is a badge
 * reading "all branches" when the customer's branch is one of the ones without
 * the offer.
 *
 * The denominator is the part worth stating: coverage is measured against
 * branches that **hold the item**, not branches that exist. The endpoint returns
 * a row for every branch in the chain, so counting rows would make every offer
 * look partial.
 */

import { describe, expect, it, vi } from "vitest";
import type { ShamsCrmOffer } from "@/lib/shams-crm/types";

vi.mock("@/lib/shams-crm/client.server", () => ({
  crmFetch: vi.fn(),
  ShamsCrmError: class extends Error {},
}));

const { classifyOfferScope, MAX_OFFER_SCOPE_ITEMS } = await import("@/lib/shams-crm/offers.server");

const offer = (branchCode: string, offerDisplay = "25.00%"): ShamsCrmOffer => ({
  itemCode: "10611030",
  branchCode,
  price: 1261.4,
  offerPercent: 25,
  offerDisplay,
  afterOfferPrice: 946.05,
});

describe("classifying offer coverage", () => {
  it("is `none` when no branch carries an offer", () => {
    const scope = classifyOfferScope("10611030", [], 40);
    expect(scope.kind).toBe("none");
    expect(scope.branchesWithOffer).toBe(0);
    expect(scope.offerDisplay).toBeNull();
  });

  it("is `all` when every stocking branch has one", () => {
    const scope = classifyOfferScope("10611030", [offer("P0215"), offer("P0304")], 2);
    expect(scope.kind).toBe("all");
    expect(scope.branchesAvailable).toBe(2);
    expect(scope.branchesWithOffer).toBe(2);
  });

  it("is `some` when a stocking branch is left out", () => {
    // The case the distinction exists for: three of forty.
    const offers = [offer("P0215"), offer("P0304"), offer("P0017")];
    const scope = classifyOfferScope("10611030", offers, 40);
    expect(scope.kind).toBe("some");
    expect(scope.branchesWithOffer).toBe(3);
    expect(scope.branchesAvailable).toBe(40);
  });

  it("does not read the whole chain as the denominator", () => {
    // 138 branches exist; 2 hold the item and both are on offer. That is "all",
    // and counting rows instead of stock would wrongly call it "some".
    expect(classifyOfferScope("x", [offer("P0215"), offer("P0304")], 2).kind).toBe("all");
  });

  it("treats an offer at a branch holding nothing as coverage, not a gap", () => {
    // More offers than stocking branches must not underflow into `some`.
    const scope = classifyOfferScope("x", [offer("P0215"), offer("P0304")], 1);
    expect(scope.kind).toBe("all");
  });

  it("is `all` when the item is nowhere in stock but is on offer", () => {
    // No stocking branch lacks the offer, because there are none. Calling this
    // `some` would imply a branch the agent could go to that is not covered.
    expect(classifyOfferScope("x", [offer("P0215")], 0).kind).toBe("all");
  });

  it("reports one discount only when the branches agree on it", () => {
    expect(classifyOfferScope("x", [offer("P0215"), offer("P0304")], 2).offerDisplay).toBe(
      "25.00%",
    );
  });

  it("reports no single discount when branches disagree", () => {
    // Whether offers can vary by branch is NOT VERIFIED (api-discovery §11.4),
    // so disagreement is handled rather than assumed impossible — and picking
    // one of two figures would be quoting a price that is wrong somewhere.
    const scope = classifyOfferScope("x", [offer("P0215", "25.00%"), offer("P0304", "10.00%")], 2);
    expect(scope.kind).toBe("all");
    expect(scope.offerDisplay).toBeNull();
  });

  it("carries the item code through, so a batched result can be matched back", () => {
    expect(classifyOfferScope("10611030", [], 1).itemCode).toBe("10611030");
  });
});

describe("the batch cap", () => {
  it("is small, because each item is its own ~62 KB request", () => {
    // There is no bulk offers endpoint (api-discovery §11.5). If this ever
    // grows, it is a decision about upstream load, not a formatting change.
    expect(MAX_OFFER_SCOPE_ITEMS).toBe(12);
  });
});
