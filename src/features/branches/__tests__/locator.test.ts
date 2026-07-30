import { describe, expect, it, vi } from "vitest";
import { buildLocationIndex } from "../location-index";
import { rankNearestBranches, resolveOrigin, type OriginLocality } from "../locator";
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

const INDEX = buildLocationIndex(BRANCHES);

const NEAR_HAZM = { lat: 24.54, lng: 46.65 };

describe("resolveOrigin", () => {
  it("reads a bare coordinate pair", async () => {
    const { origin } = await resolveOrigin("24.5372826, 46.6456098", INDEX);
    expect(origin?.kind).toBe("coordinates");
    expect(origin?.point.lat).toBeCloseTo(24.5372826, 5);
    expect(origin?.point.lng).toBeCloseTo(46.6456098, 5);
  });

  it("accepts the separators people actually paste", async () => {
    for (const input of ["24.5372 46.6456", "24.5372;46.6456", "  24.5372 , 46.6456  "]) {
      const { origin } = await resolveOrigin(input, INDEX);
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
      const { origin } = await resolveOrigin(url, INDEX);
      expect(origin?.kind).toBe("map-link");
      expect(origin?.point.lat).toBeCloseTo(24.5372826, 5);
    }
  });

  it("rejects a swapped pair rather than putting the customer in the ocean", async () => {
    // 46.64 N, 24.53 E is in Russia. A swap is the failure mode that survives
    // eyeballing, because both halves still look like Saudi numbers.
    const { origin, error } = await resolveOrigin("46.6456098, 24.5372826", INDEX);
    expect(origin).toBeNull();
    expect(error).toMatch(/outside Saudi Arabia/i);
  });

  it("does not read two numbers out of a street address as a location", async () => {
    // "شارع 60" and "حي 4" are numbers in prose, not a coordinate pair.
    const { origin } = await resolveOrigin("شارع 60 حي 4", INDEX);
    expect(origin?.kind).not.toBe("coordinates");
  });

  it("resolves a district to the centre of its branches", async () => {
    // "حي الحزم" holds one branch, so the district centroid is that branch.
    const { origin } = await resolveOrigin("الحزم", INDEX);
    expect(origin?.kind).toBe("place");
    expect(origin?.entry?.kind).toBe("district");
    expect(origin?.point.lat).toBeCloseTo(24.5372826, 5);
    expect(origin?.detail).toMatch(/approximate/i);
  });

  it("resolves a city to the centroid of every branch in it", async () => {
    const { origin } = await resolveOrigin("الرياض", INDEX);
    expect(origin?.entry?.kind).toBe("city");
    // The mean of the two locatable Riyadh branches — the warehouse has no
    // coordinates and so contributes nothing.
    expect(origin?.point.lat).toBeCloseTo((24.5372826 + 24.5912) / 2, 5);
    expect(origin?.detail).toMatch(/2 branches/);
  });

  it("resolves an English city name", async () => {
    const { origin } = await resolveOrigin("jeddah", INDEX);
    expect(origin?.entry?.kind).toBe("city");
    expect(origin?.point.lat).toBeCloseTo(21.4858, 4);
  });

  it("refuses a query that names no place in the directory", async () => {
    const { origin, error } = await resolveOrigin("زقاق لا وجود له", INDEX);
    expect(origin).toBeNull();
    expect(error).toMatch(/no city, district or area/i);
  });

  it("treats an empty box as nothing to do, not as a failure", async () => {
    const { origin, error } = await resolveOrigin("   ", INDEX);
    expect(origin).toBeNull();
    expect(error).toBeNull();
  });

  it("never reaches the geocoder when the local index answers", async () => {
    // The cascade the brief specifies: local resolver, then the dataset, and
    // OpenStreetMap only if both came up empty. A geocoder that fires on a
    // query the directory could answer is a network call — and a bill, once
    // this is Google — for something already known.
    const geocode = vi.fn(async () => ({ lat: 0, lng: 0 }));

    for (const local of ["الحزم", "الرياض", "jeddah", "P0001", "24.5372, 46.6456"]) {
      await resolveOrigin(local, INDEX, geocode);
    }
    expect(geocode).not.toHaveBeenCalled();
  });

  it("does not reach the geocoder for an ambiguous local match either", async () => {
    // The place *was* found; the only open question is which city. Asking a
    // geocoder would swap a question the agent can answer for a guess they
    // cannot check.
    const ambiguous = buildLocationIndex(
      decorate([
        branch({
          branch_no: "A1",
          city: "الرياض",
          address: "الرياض/ حي الروضة",
          latitude: 24.7,
          longitude: 46.78,
        }),
        branch({
          branch_no: "A2",
          city: "جدة",
          address: "جدة/ حي الروضة",
          latitude: 21.55,
          longitude: 39.16,
        }),
      ]),
    );
    const geocode = vi.fn(async () => ({ lat: 0, lng: 0 }));
    const { choices } = await resolveOrigin("الروضة", ambiguous, geocode);
    expect(choices).toHaveLength(2);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("falls back to the geocoder only when nothing local matches", async () => {
    const geocode = vi.fn(async () => ({ lat: 26.4207, lng: 50.0888 }));
    const { origin } = await resolveOrigin("حي لا يوجد في الدليل", INDEX, geocode);
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(origin?.kind).toBe("geocoded");
    expect(origin?.detail).toMatch(/openstreetmap/i);
    expect(origin?.point.lat).toBeCloseTo(26.4207, 4);
  });

  it("ignores a geocoder that returns a point outside the country", async () => {
    const geocode = async () => ({ lat: 51.5, lng: -0.12 });
    const { origin, error } = await resolveOrigin("مكان مجهول تماما", INDEX, geocode);
    expect(origin).toBeNull();
    expect(error).toMatch(/no city, district or area/i);
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

  it("attaches a delivery band to every result", async () => {
    const ranked = await rankNearestBranches(NEAR_HAZM, BRANCHES);
    for (const entry of ranked) {
      expect(entry.eta.label).toMatch(/^≈ /);
      expect(entry.eta.minMinutes).toBeGreaterThanOrEqual(20);
    }
  });
});

/**
 * Locality-aware ranking.
 *
 * A fixture built for the one case that matters and is hard to see: a branch in
 * the customer's own neighbourhood that is *slightly farther* than one across the
 * district boundary. Two branches due north and due south of the origin, 900m and
 * 1200m away, so the answer flips on locality alone rather than on rounding.
 */
describe("rankNearestBranches with a resolved locality", () => {
  const ORIGIN = { lat: 24.65, lng: 46.7 };

  /** 1200 m south of the origin, in the origin's own district. */
  const IN_DISTRICT = branch({
    branch_no: "P0100",
    city: "الرياض",
    address: "الرياض/ حي الحزم /ش علي النقيب",
    latitude: 24.639209,
    longitude: 46.7,
  });

  /** 900 m north of the origin, a different district in the same city. */
  const NEARER = branch({
    branch_no: "P0200",
    city: "الرياض",
    address: "الرياض/ حي العليا /ش التخصصي",
    latitude: 24.658094,
    longitude: 46.7,
  });

  const LOCAL = decorate([IN_DISTRICT, NEARER]);

  const IN_HAZM: OriginLocality = {
    city: "الرياض",
    district: "حي الحزم",
    street: null,
    precision: "district",
  };

  it("bands the estimate by locality even though distance decides the order", async () => {
    // Distance is the ordering rule, so the 900m branch leads. Locality still
    // shapes each *estimate*: the same-neighbourhood branch gets 20–30 and the
    // one across the district boundary is floored at 30–45, which is why the
    // farther branch can show the faster arrival.
    const ranked = await rankNearestBranches(ORIGIN, LOCAL, { locality: IN_HAZM });
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0200", "P0100"]);

    const hazm = ranked.find((entry) => entry.item.branch_no === "P0100");
    expect(hazm?.sameDistrict).toBe(true);
    expect(hazm?.eta.minMinutes).toBe(20);

    const olaya = ranked.find((entry) => entry.item.branch_no === "P0200");
    expect(olaya?.sameDistrict).toBe(false);
    expect(olaya?.eta.minMinutes).toBe(30);
  });

  it("puts every in-coverage branch ahead of every branch beyond 10 km", async () => {
    // The one place the order deliberately contradicts the kilometres it prints:
    // a branch that cannot deliver is not a better answer for being nearer to the
    // top of the list. P0400 sits ~11 km out, past the coverage boundary.
    const withFar = decorate([
      branch({
        branch_no: "P0400",
        city: "الرياض",
        address: "الرياض/ حي الحزم",
        latitude: 24.65,
        longitude: 46.8087, // ~11 km east, outside coverage
      }),
      IN_DISTRICT,
      NEARER,
    ]);
    const ranked = await rankNearestBranches(ORIGIN, withFar, { locality: IN_HAZM });
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0200", "P0100", "P0400"]);
    expect(ranked[0].insideCoverage).toBe(true);
    expect(ranked[1].insideCoverage).toBe(true);
    expect(ranked[2].insideCoverage).toBe(false);
  });

  it("breaks a sub-500m tie on scooter availability", async () => {
    // Two branches ~120m apart: indistinguishable at the precision a straight
    // line supports, so the one with its own rider is the better recommendation
    // even though it is the marginally farther of the two.
    const tied = decorate([
      branch({
        branch_no: "P0500",
        city: "الرياض",
        address: "الرياض/ حي الحزم",
        latitude: 24.6505,
        longitude: 46.7,
        scooter: false,
      }),
      branch({
        branch_no: "P0501",
        city: "الرياض",
        address: "الرياض/ حي الحزم",
        latitude: 24.6515,
        longitude: 46.7,
        scooter: true,
      }),
    ]);
    const ranked = await rankNearestBranches(ORIGIN, tied);
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0501", "P0500"]);
    // Confirms the premise: the scooter branch really is the farther one.
    expect(ranked[0].distance.metres).toBeGreaterThan(ranked[1].distance.metres);
  });

  it("orders on distance alone when the origin is only a point", async () => {
    const ranked = await rankNearestBranches(ORIGIN, LOCAL);
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0200", "P0100"]);
    expect(ranked[0].sameCity).toBe(false);
  });

  it("does not believe the district of a city-wide match", async () => {
    // A city centroid carries whatever neighbourhood sits on it. Treating that as
    // the customer's would hand a 20–30 band to a branch picked by an accident of
    // geometry, so at city precision only the city name counts — and the nearer
    // branch wins again.
    const ranked = await rankNearestBranches(ORIGIN, LOCAL, {
      locality: { ...IN_HAZM, precision: "city" },
    });
    expect(ranked.map((entry) => entry.item.branch_no)).toEqual(["P0200", "P0100"]);
    expect(ranked[0].sameDistrict).toBe(false);
    expect(ranked[0].sameCity).toBe(true);
  });

  it("counts a shared street as the same neighbourhood", async () => {
    // The sheet does not always write a حي segment, and two addresses on one
    // street in one city are in the same neighbourhood whether it did or not.
    // Asserted on the flags and the band rather than on position, because the
    // order is decided by distance.
    const ranked = await rankNearestBranches(ORIGIN, LOCAL, {
      locality: {
        city: "الرياض",
        district: null,
        street: "ش علي النقيب",
        precision: "street",
      },
    });
    const hazm = ranked.find((entry) => entry.item.branch_no === "P0100");
    expect(hazm?.sameStreet).toBe(true);
    expect(hazm?.sameDistrict).toBe(true);
    expect(hazm?.eta.minMinutes).toBe(20);
  });

  it("does not match a street name against a different city", async () => {
    // "ش علي النقيب" in Jeddah is not the Riyadh one, and there is a street with
    // the same name in most Saudi cities.
    const ranked = await rankNearestBranches(ORIGIN, LOCAL, {
      locality: {
        city: "جدة",
        district: null,
        street: "ش علي النقيب",
        precision: "street",
      },
    });
    expect(ranked.every((entry) => !entry.sameStreet)).toBe(true);
    expect(ranked.every((entry) => !entry.sameCity)).toBe(true);
  });

  it("does not let the same neighbourhood outrank a genuinely nearer branch", async () => {
    // A same-district branch 12 km out is both farther and outside coverage, so
    // it loses on both of the first two rules rather than being rescued by its
    // neighbourhood.
    const spread = decorate([
      branch({
        branch_no: "P0300",
        city: "الرياض",
        address: "الرياض/ حي الحزم",
        latitude: 24.65,
        longitude: 46.81864, // ~12 km east
      }),
      IN_DISTRICT,
      NEARER,
    ]);
    const ranked = await rankNearestBranches(ORIGIN, spread, { locality: IN_HAZM });
    expect(ranked[0].item.branch_no).toBe("P0200");
    expect(ranked[ranked.length - 1].item.branch_no).toBe("P0300");
  });

  it("keeps the ordering stable regardless of the input order", async () => {
    // Guards the comparator's transitivity. Three branches inside one 500m band
    // plus one outside it is exactly the shape that an `|a - b| < 500` test gets
    // wrong, and a broken comparator shows up as an order that depends on how the
    // rows happened to arrive.
    const rows = [
      branch({ branch_no: "A", city: "الرياض", latitude: 24.65, longitude: 46.7 }),
      branch({ branch_no: "B", city: "الرياض", latitude: 24.6536, longitude: 46.7 }),
      branch({ branch_no: "C", city: "الرياض", latitude: 24.6572, longitude: 46.7 }),
      branch({ branch_no: "D", city: "الرياض", latitude: 24.6608, longitude: 46.7 }),
    ];
    const forward = await rankNearestBranches(ORIGIN, decorate(rows));
    const reversed = await rankNearestBranches(ORIGIN, decorate([...rows].reverse()));
    expect(reversed.map((entry) => entry.item.branch_no)).toEqual(
      forward.map((entry) => entry.item.branch_no),
    );
  });
});
