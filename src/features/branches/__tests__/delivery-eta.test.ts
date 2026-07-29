import { describe, expect, it } from "vitest";
import { estimateDelivery, formatDeliveryBand } from "../delivery-eta";

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
    // The brief's distance rules, read as straight-line kilometres — which the
    // road factor turns into the drive each band is really describing.
    expect(estimateDelivery(km(10)).maxMinutes).toBe(50);
    expect(estimateDelivery(km(10)).minMinutes).toBe(35);
    expect(estimateDelivery(km(18)).minMinutes).toBe(45);
    expect(estimateDelivery(km(18)).maxMinutes).toBe(60);
    expect(estimateDelivery(km(30)).minMinutes).toBe(60);
    expect(estimateDelivery(km(30)).maxMinutes).toBeNull();
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
    // 10 km straight line is 13 km by road, whose band (35–50) is slower than the
    // 30–45 floor. The floor must not pull it back up to optimism.
    const near = estimateDelivery({ ...km(10), sameDistrict: false, sameCity: true });
    expect([near.minMinutes, near.maxMinutes]).toEqual([35, 50]);

    // And the road factor is applied before banding, so 12 km straight line is
    // treated as the ~15.6 km drive it is rather than landing a band lower.
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

describe("formatDeliveryBand", () => {
  it("renders a closed band and an open-ended one differently", () => {
    expect(formatDeliveryBand(25, 30)).toBe("≈ 25–30 min");
    expect(formatDeliveryBand(60, null)).toBe("≈ 60+ min");
  });
});
