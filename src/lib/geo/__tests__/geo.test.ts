import { describe, expect, it } from "vitest";
import {
  KSA_BOUNDS,
  boundsOf,
  centerOf,
  describeDistance,
  formatDistance,
  formatDuration,
  formatLatLng,
  haversineMetres,
  isValidLatLng,
  isWithin,
  mapSearchUrl,
  multiStopUrl,
  navigationUrl,
  normalizeAddress,
  parseCoordinatePair,
  resolveMapUrl,
  straightLineDistance,
} from "..";
import { latLngParam } from "../coordinates";

/** Two real branch coordinates from the master workbook. */
const HAZM = { lat: 24.5372826, lng: 46.6456098 };
const YARMOUK = { lat: 24.8061703, lng: 46.7752712 };

describe("coordinates", () => {
  it("parses the sheet's decimal degrees to the column's precision", () => {
    const { point, outOfRange } = parseCoordinatePair("24.53728256", "46.64560984");
    expect(point).toEqual({ lat: 24.5372826, lng: 46.6456098 });
    expect(outOfRange).toBe(false);
  });

  it("accepts numbers as well as strings", () => {
    expect(parseCoordinatePair(24.5, 46.6).point).toEqual({ lat: 24.5, lng: 46.6 });
  });

  it("strips stray symbols a locale-formatted sheet leaves behind", () => {
    expect(parseCoordinatePair("24.5372826°N", "46.6456098°E").point).toEqual(HAZM);
  });

  it("rejects a swapped pair rather than placing it in the ocean", () => {
    const { point, outOfRange } = parseCoordinatePair("46.6456098", "24.5372826");
    expect(point).toBeNull();
    expect(outOfRange).toBe(true);
  });

  it("reports nothing, and no complaint, for empty input", () => {
    expect(parseCoordinatePair("", "")).toEqual({ point: null, outOfRange: false });
    expect(parseCoordinatePair(null, undefined)).toEqual({ point: null, outOfRange: false });
  });

  it("validates points against the globe and against the country", () => {
    expect(isValidLatLng(HAZM)).toBe(true);
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
    expect(isWithin(HAZM, KSA_BOUNDS)).toBe(true);
    // Cairo — a real place, but not one this business has branches in.
    expect(isWithin({ lat: 30.04, lng: 31.23 }, KSA_BOUNDS)).toBe(false);
  });

  it("keeps a space for display and drops it for URLs", () => {
    expect(formatLatLng(HAZM, 4)).toBe("24.5373, 46.6456");
    expect(latLngParam(HAZM)).toBe("24.5372826,46.6456098");
  });

  it("boxes a set of points and finds its centre", () => {
    const box = boundsOf([HAZM, YARMOUK]);
    expect(box).toEqual({
      south: HAZM.lat,
      west: HAZM.lng,
      north: YARMOUK.lat,
      east: YARMOUK.lng,
    });
    expect(boundsOf([])).toBeNull();
    const centre = centerOf(box!);
    expect(centre.lat).toBeCloseTo((HAZM.lat + YARMOUK.lat) / 2, 6);
  });

  it("normalizes the sheet's inconsistent address separators", () => {
    expect(normalizeAddress("الرياض/ حي الحزم /ش علي النقيب")).toBe(
      normalizeAddress("الرياض / حي الحزم / ش علي النقيب"),
    );
    expect(normalizeAddress(null)).toBe("");
  });
});

describe("haversine", () => {
  it("agrees with PostGIS to within the sphere/spheroid difference", () => {
    // PostGIS ST_Distance over geography(4326) reports 32,547.4 m for this pair
    // (checked against the live database). Haversine models the earth as a
    // sphere rather than the WGS84 spheroid, so it should land within a few
    // tenths of a percent — close enough to rank branches by, which is all the
    // fallback claims to do. A larger gap would mean the formula is wrong.
    const POSTGIS_METRES = 32_547.4;
    const metres = haversineMetres(HAZM, YARMOUK);
    expect(Math.abs(metres - POSTGIS_METRES) / POSTGIS_METRES).toBeLessThan(0.005);
  });

  it("is zero for a point against itself, and symmetric", () => {
    expect(haversineMetres(HAZM, HAZM)).toBeCloseTo(0, 6);
    expect(haversineMetres(HAZM, YARMOUK)).toBeCloseTo(haversineMetres(YARMOUK, HAZM), 6);
  });

  it("labels its result as an estimate", () => {
    const result = straightLineDistance(HAZM, YARMOUK);
    expect(result.source).toBe("straight-line");
    expect(result.seconds).toBeNull();
  });
});

describe("formatting", () => {
  it("rounds sub-kilometre distances rather than implying false precision", () => {
    expect(formatDistance(847)).toBe("850 m");
    expect(formatDistance(20)).toBe("50 m");
  });

  it("switches to kilometres, with a decimal only where it means something", () => {
    expect(formatDistance(1500)).toBe("1.5 km");
    expect(formatDistance(31_000)).toBe("31 km");
  });

  it("formats durations", () => {
    expect(formatDuration(90)).toBe("2 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(null)).toBe("—");
  });

  it("hedges the wording when the distance is only an estimate", () => {
    expect(describeDistance({ metres: 9000, seconds: null, source: "straight-line" })).toBe(
      "about 9 km away",
    );
    expect(describeDistance({ metres: 12_000, seconds: 1080, source: "road" })).toBe(
      "12 km by road · 18 min",
    );
  });
});

describe("map URLs", () => {
  it("builds a search link that survives URL decoding intact", () => {
    expect(decodeURIComponent(mapSearchUrl(HAZM))).toContain("query=24.5372826,46.6456098");
  });

  it("builds a navigation link with no stray + from a space", () => {
    const url = navigationUrl(HAZM);
    expect(url).not.toContain("+");
    expect(url).toContain("dir_action=navigate");
  });

  it("prefers a stored place link over coordinates", () => {
    expect(
      resolveMapUrl({
        maps_url: "https://maps.app.goo.gl/abc",
        latitude: 24.5,
        longitude: 46.6,
      }),
    ).toBe("https://maps.app.goo.gl/abc");
  });

  it("ignores a stored value that is not a URL", () => {
    const url = resolveMapUrl({ maps_url: "-", latitude: 24.5, longitude: 46.6 });
    expect(url).toContain("google.com/maps");
  });

  it("caps a multi-stop route at the waypoint limit Google honours", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      lat: 24 + index * 0.01,
      lng: 46 + index * 0.01,
    }));
    const url = multiStopUrl(many)!;
    // origin + destination + 8 waypoints = the 10 the builder promises.
    expect(decodeURIComponent(url).split("|")).toHaveLength(8);
  });

  it("degrades a one-point route to a search rather than an empty directions link", () => {
    expect(multiStopUrl([HAZM])).toContain("/search/");
    expect(multiStopUrl([])).toBeNull();
  });
});
