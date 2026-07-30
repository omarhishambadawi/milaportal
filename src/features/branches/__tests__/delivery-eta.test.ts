import { describe, expect, it } from "vitest";
import {
  COVERAGE_RADIUS_METRES,
  coverageTier,
  estimateDelivery,
  formatDeliveryBand,
  isWithinCoverage,
} from "../delivery-eta";

/** Straight-line kilometres, which is what a Haversine distance gives us. */
function km(value: number) {
  return { metres: value * 1000 };
}

describe("estimateDelivery", () => {
  it("gives the same neighbourhood the fast band", () => {
    const eta = estimateDelivery({ ...km(1), sameDistrict: true, sameCity: true });
    expect([eta.minMinutes, eta.maxMinutes]).toEqual([20, 30]);
    expect(eta.basis).toBe("same-district");
  });

  it("floors a cross-neighbourhood delivery at 30–45 however near it is", () => {
    // The distance alone would say 20–30. Crossing a district boundary means
    // arterial roads and traffic lights that a kilometre of straight line does
    // not predict, so the floor is the honest answer.
    const eta = estimateDelivery({ ...km(1), sameDistrict: false, sameCity: true });
    expect([eta.minMinutes, eta.maxMinutes]).toEqual([30, 45]);
    expect(eta.basis).toBe("same-city");
  });

  it("bands by distance when nothing is known about the locality", () => {
    // The operational rules verbatim, in straight-line kilometres: 8–10 is
    // 35–45, 10–15 is 45–60, past 15 is open-ended.
    expect([estimateDelivery(km(9)).minMinutes, estimateDelivery(km(9)).maxMinutes]).toEqual([
      35, 45,
    ]);
    expect([estimateDelivery(km(12)).minMinutes, estimateDelivery(km(12)).maxMinutes]).toEqual([
      45, 60,
    ]);
    expect(estimateDelivery(km(18)).minMinutes).toBe(60);
    expect(estimateDelivery(km(18)).maxMinutes).toBeNull();
  });

  it("changes band exactly where delivery coverage ends", () => {
    // The 10 km boundary does double duty: it is where the estimate steps up to
    // 45–60 *and* where the coverage warning appears. If these ever disagree a
    // row will show "over 10 km" beside an in-coverage band, so the agreement is
    // asserted rather than assumed.
    expect(estimateDelivery(km(9.9)).maxMinutes).toBe(45);
    expect(isWithinCoverage(9.9 * 1000)).toBe(true);
    expect(estimateDelivery(km(10.1)).maxMinutes).toBe(60);
    expect(isWithinCoverage(10.1 * 1000)).toBe(false);
  });

  it("never lets locality make a long trip look shorter", () => {
    // A district can sprawl. Being in the customer's own neighbourhood does not
    // shrink 30 km, and a 20–30 band on that trip would be a promise nobody can
    // keep.
    const far = estimateDelivery({ ...km(30), sameDistrict: true, sameCity: true });
    expect(far.minMinutes).toBe(60);
    expect(far.maxMinutes).toBeNull();
  });

  it("takes the slower of the distance band and the same-city floor", () => {
    // 9 km lands in 35–45, which is slower than the 30–45 same-city floor. The
    // floor must not pull it back up to optimism.
    const near = estimateDelivery({ ...km(9), sameDistrict: false, sameCity: true });
    expect([near.minMinutes, near.maxMinutes]).toEqual([35, 45]);

    // And a genuinely long trip keeps its own band rather than the floor's.
    const far = estimateDelivery({ ...km(12), sameDistrict: false, sameCity: true });
    expect([far.minMinutes, far.maxMinutes]).toEqual([45, 60]);
  });

  it("is always a range, always hedged, and never claims to be exact", () => {
    for (const distance of [0, 1, 5, 12, 20, 40, 200]) {
      const eta = estimateDelivery(km(distance));
      expect(eta.label).toMatch(/^≈ \d+(–\d+)? min$|^≈ \d+\+ min$/);
      expect(eta.detail).toMatch(/estimated under normal conditions/i);
    }
  });

  it("treats a nonsensical negative distance as zero rather than throwing", () => {
    expect(estimateDelivery({ metres: -500 }).minMinutes).toBe(20);
  });
});

describe("isWithinCoverage", () => {
  it("treats the boundary itself as covered", () => {
    // A branch at exactly 10 km is inside. The rule is "exceeds 10 km", so the
    // boundary belongs to the covered side.
    expect(isWithinCoverage(COVERAGE_RADIUS_METRES)).toBe(true);
    expect(isWithinCoverage(COVERAGE_RADIUS_METRES + 1)).toBe(false);
    expect(isWithinCoverage(0)).toBe(true);
  });
});

describe("coverageTier", () => {
  it("splits the covered range without moving the coverage boundary", () => {
    expect(coverageTier(1_000)).toBe("available");
    expect(coverageTier(7_999)).toBe("available");
    expect(coverageTier(8_000)).toBe("near-limit");
    expect(coverageTier(COVERAGE_RADIUS_METRES)).toBe("near-limit");
    expect(coverageTier(COVERAGE_RADIUS_METRES + 1)).toBe("outside");
  });

  it("agrees with isWithinCoverage everywhere", () => {
    // The tier is a presentation split of the same rule, not a second rule. If
    // these ever disagree a row shows a green badge next to an amber map pin.
    for (const metres of [0, 500, 7_999, 8_000, 9_999, 10_000, 10_001, 25_000]) {
      expect(coverageTier(metres) === "outside").toBe(!isWithinCoverage(metres));
    }
  });
});

describe("formatDeliveryBand", () => {
  it("renders a closed band and an open-ended one differently", () => {
    expect(formatDeliveryBand(25, 30)).toBe("≈ 25–30 min");
    expect(formatDeliveryBand(60, null)).toBe("≈ 60+ min");
  });
});
