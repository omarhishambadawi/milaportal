import { describe, expect, it } from "vitest";
import { rankNearestBranches, resolveOrigin } from "../locator";
import { decorate } from "../search";
import type { Branch } from "../types";

function branch(overrides: Partial<Branch> & Pick<Branch, "branch_no" | "city">): Branch {
  return {
    phone: null,
    area_manager: null,
    area_manager_phone: null,
    email: null,
    address: null,
    maps_url: null,
    latitude: null,
    longitude: null,
    scooter: false,
    scooter_note: null,
    working_hours: null,
    friday_hours: null,
    duty_hours: null,
    active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Real Saudi coordinates, so the KSA bounds check is exercised honestly. */
const BRANCHES = decorate([
  // Riyadh, Al Hazm — the reference point most assertions measure from.
  branch({
    branch_no: "P0001",
    city: "الرياض",
    address: "الرياض/ حي الحزم /ش علي النقيب",
    latitude: 24.5372826,
    longitude: 46.6456098,
  }),
  // Riyadh, ~6 km north of P0001.
  branch({
    branch_no: "P0002",
    city: "الرياض",
    address: "الرياض/ حي العليا",
    latitude: 24.5912,
    longitude: 46.6853,
  }),
  // Jeddah — a long way west, so it must never outrank a Riyadh branch.
  branch({
    branch_no: "P0021",
    city: "جدة",
    address: "جدة/حي اليرموك",
    latitude: 21.4858,
    longitude: 39.1925,
  }),
  // No coordinates at all: unrankable, and must be skipped rather than sorted last.
  branch({ branch_no: "المستودع", city: "الرياض", address: "الرياض/السلي" }),
]);

const NEAR_HAZM = { lat: 24.54, lng: 46.65 };

describe("resolveOrigin", () => {
  it("reads a bare coordinate pair", async () => {
    const { origin } = await resolveOrigin("24.5372826, 46.6456098", BRANCHES);
    expect(origin?.kind).toBe("coordinates");
    expect(origin?.point.lat).toBeCloseTo(24.5372826, 5);
    expect(origin?.point.lng).toBeCloseTo(46.6456098, 5);
  });

  it("accepts the separators people actually paste", async () => {
    for (const input of ["24.5372 46.6456", "24.5372;46.6456", "  24.5372 , 46.6456  "]) {
      const { origin } = await resolveOrigin(input, BRANCHES);
      expect(origin?.point.lat).toBeCloseTo(24.5372, 3);
    }
  });

  it("pulls coordinates out of the Google Maps links agents are sent", async () => {
    const cases = [
      "https://www.google.com/maps/@24.5372826,46.6456098,17z",
      "https://www.google.com/maps/place/X/data=!3d24.5372826!4d46.6456098",
      "https://maps.google.com/?q=24.5372826,46.6456098",
    ];
    for (const url of cases) {
      const { origin } = await resolveOrigin(url, BRANCHES);
      expect(origin?.kind).toBe("map-link");
      expect(origin?.point.lat).toBeCloseTo(24.5372826, 5);
    }
  });

  it("rejects a swapped pair rather than putting the customer in the ocean", async () => {
    // 46.64 N, 24.53 E is in Russia. A swap is the failure mode that survives
    // eyeballing, because both halves still look like Saudi numbers.
    const { origin, error } = await resolveOrigin("46.6456098, 24.5372826", BRANCHES);
    expect(origin).toBeNull();
    expect(error).toMatch(/outside Saudi Arabia/i);
  });

  it("does not read two numbers out of a street address as a location", async () => {
    // "شارع 60" and "حي 4" are numbers in prose, not a coordinate pair.
    const { origin } = await resolveOrigin("شارع 60 حي 4", BRANCHES);
    expect(origin?.kind).not.toBe("coordinates");
  });

  it("falls back to the area of the branches whose text matches", async () => {
    // One match: the origin is that branch's own position, and the copy says so.
    const single = await resolveOrigin("الحزم", BRANCHES);
    expect(single.origin?.kind).toBe("directory-area");
    expect(single.origin?.point.lat).toBeCloseTo(24.5372826, 3);
    expect(single.origin?.detail).toMatch(/approximate/i);

    // Several matches: the origin is their centre, and the count is stated so an
    // agent can see whether it was one street or a whole city.
    const many = await resolveOrigin("الرياض", BRANCHES);
    expect(many.origin?.kind).toBe("directory-area");
    expect(many.origin?.detail).toMatch(/2 matching branches/);
    // Between the two Riyadh branches, not on top of either.
    expect(many.origin?.point.lat).toBeCloseTo((24.5372826 + 24.5912) / 2, 3);
  });

  it("refuses a query that matches every branch, which has said nothing", async () => {
    // Every fixture branch is `active`, so this matches all of them; answering
    // with the centre of the country would be worse than declining.
    const { origin, error } = await resolveOrigin("الرياض جدة", BRANCHES);
    expect(origin).toBeNull();
    expect(error).toMatch(/could not place/i);
  });

  it("treats an empty box as nothing to do, not as a failure", async () => {
    const { origin, error } = await resolveOrigin("   ", BRANCHES);
    expect(origin).toBeNull();
    expect(error).toBeNull();
  });

  it("prefers a geocoder over the directory guess when one is supplied", async () => {
    const geocode = async () => ({ lat: 21.4858, lng: 39.1925 });
    const { origin } = await resolveOrigin("some street in Jeddah", BRANCHES, geocode);
    expect(origin?.detail).toBe("Geocoded address");
    expect(origin?.point.lat).toBeCloseTo(21.4858, 4);
  });

  it("ignores a geocoder that returns a point outside the country", async () => {
    const geocode = async () => ({ lat: 51.5, lng: -0.12 });
    const { origin, error } = await resolveOrigin("London", BRANCHES, geocode);
    expect(origin).toBeNull();
    expect(error).toMatch(/could not place/i);
  });
});

describe("rankNearestBranches", () => {
  it("orders by distance and caps the list", async () => {
    const ranked = await rankNearestBranches(NEAR_HAZM, BRANCHES, { limit: 2 });
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0001", "P0002"]);
  });

  it("skips branches with no coordinates rather than ranking them last", async () => {
    const ranked = await rankNearestBranches(NEAR_HAZM, BRANCHES);
    // A branch with no location is unrankable, not "very far away" — sorting it
    // to the end would invite an agent to read it as the worst option.
    expect(ranked.map((entry) => entry.item.branch_no)).not.toContain("المستودع");
    expect(ranked).toHaveLength(3);
  });

  it("labels every distance as straight-line, which is what the UI hedges on", async () => {
    const ranked = await rankNearestBranches(NEAR_HAZM, BRANCHES);
    for (const entry of ranked) {
      expect(entry.distance.source).toBe("straight-line");
      expect(entry.distance.seconds).toBeNull();
    }
  });

  it("produces a plausible magnitude", async () => {
    const [nearest] = await rankNearestBranches(NEAR_HAZM, BRANCHES);
    // ~0.5 km from the fixture point to P0001.
    expect(nearest.distance.metres).toBeGreaterThan(100);
    expect(nearest.distance.metres).toBeLessThan(2000);
  });

  it("returns nothing when no branch can be placed", async () => {
    const unplaceable = decorate([branch({ branch_no: "P9999", city: "الرياض" })]);
    expect(await rankNearestBranches(NEAR_HAZM, unplaceable)).toEqual([]);
  });

  it("takes distances from an injected provider, which is the Routes seam", async () => {
    // Reversing the order proves the provider — not the Haversine default —
    // decides the ranking, so swapping in Routes later changes only this arg.
    const provider = async (_origin: unknown, destinations: readonly unknown[]) =>
      destinations.map((_, index) => ({
        metres: (destinations.length - index) * 1000,
        seconds: 60,
        source: "road" as const,
      }));

    const ranked = await rankNearestBranches(NEAR_HAZM, BRANCHES, { provider });
    expect(ranked[0].item.branch_no).toBe("P0021");
    expect(ranked[0].distance.source).toBe("road");
  });
});
