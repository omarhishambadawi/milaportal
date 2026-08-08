import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGeocodeCache, geocodeWithOpenStreetMap } from "../geocode-nominatim";

/** A Nominatim response body for a point in Dammam. */
function hit(lat: number, lng: number, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => [{ lat: String(lat), lon: String(lng), ...extra }],
  } as unknown as Response;
}

afterEach(() => {
  clearGeocodeCache();
  vi.unstubAllGlobals();
});

describe("geocodeWithOpenStreetMap", () => {
  it("returns a Saudi point and caches it, so the same query never fetches twice", async () => {
    const fetchMock = vi.fn(async () => hit(26.4207, 50.0888));
    vi.stubGlobal("fetch", fetchMock);

    const first = await geocodeWithOpenStreetMap("حي الفيصلية الدمام");
    expect(first?.point.lat).toBeCloseTo(26.4207, 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The cache is keyed on the normalized form, so a differently-typed spelling
    // of the same query is also a hit — which is the point of reusing
    // `normalizePlace` rather than the raw string.
    const second = await geocodeWithOpenStreetMap("  حي  الفيصليه  الدمام ");
    expect(second?.point.lat).toBeCloseTo(26.4207, 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the names around the point, which is what earns a locality band", async () => {
    // Without these the origin is a bare coordinate and every result is banded on
    // kilometres alone — the neighbourhood is the whole reason for asking for
    // `addressdetails`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        hit(21.4858, 39.1925, {
          addresstype: "road",
          address: { road: "شارع فلسطين", suburb: "حي الرويس", city: "جدة" },
        }),
      ),
    );

    const found = await geocodeWithOpenStreetMap("شارع فلسطين جدة");
    expect(found?.city).toBe("جدة");
    expect(found?.district).toBe("حي الرويس");
    expect(found?.street).toBe("شارع فلسطين");
    expect(found?.precision).toBe("street");
  });

  it("reports a city-wide match as such, so its district is not believed", async () => {
    // A city centroid carries whatever neighbourhood happens to sit on it.
    // `precision` is how the ranker knows not to treat that as the customer's.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        hit(24.7136, 46.6753, {
          addresstype: "city",
          address: { city: "الرياض", suburb: "حي العليا" },
        }),
      ),
    );

    const found = await geocodeWithOpenStreetMap("الرياض");
    expect(found?.precision).toBe("city");
  });

  it("constrains the request to Saudi Arabia", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return hit(24.7, 46.7);
      }),
    );

    await geocodeWithOpenStreetMap("some place");

    expect(seen[0]).toContain("countrycodes=sa");
    expect(seen[0]).toContain("limit=1");
    expect(seen[0]).toContain("addressdetails=1");
  });

  it("rejects a result outside Saudi Arabia even when the API returns one", async () => {
    // `countrycodes` is a hint the service mostly honours. The bounds check is
    // what actually guarantees it, because a locator that silently places a
    // customer in Cairo is worse than one that says it does not know.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => hit(30.0444, 31.2357)),
    );
    expect(await geocodeWithOpenStreetMap("الروضة")).toBeNull();
  });

  it("returns null rather than throwing when the network is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await geocodeWithOpenStreetMap("anywhere at all")).toBeNull();
  });

  it("returns null on a non-OK response and does not cache it", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await geocodeWithOpenStreetMap("rate limited")).toBeNull();

    // A miss is remembered for the session so a failing query is not retried on
    // every keystroke, but it is never written to localStorage — a timeout must
    // not poison that query permanently on this machine.
    expect(await geocodeWithOpenStreetMap("rate limited")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of a query that normalizes to nothing", async () => {
    const fetchMock = vi.fn(async () => hit(24, 46));
    vi.stubGlobal("fetch", fetchMock);
    // "حي" is a classifier with no name attached.
    expect(await geocodeWithOpenStreetMap("حي")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a search that names a city", () => {
  it("confines the search to a box around it rather than the whole country", async () => {
    // `countrycodes=sa` narrows to a country the size of Western Europe, which is
    // not narrow enough for a name like "النخيل" that repeats in four Saudi
    // towns. `bounded=1` makes the box a filter, not a preference.
    const fetchMock = vi.fn(async (_url: string) => hit(24.7241, 46.6402));
    vi.stubGlobal("fetch", fetchMock);

    await geocodeWithOpenStreetMap("حي النخيل الرياض", {
      city: "الرياض",
      near: { lat: 24.72, lng: 46.7 },
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("bounded")).toBe("1");

    const [left, top, right, bottom] = url.searchParams.get("viewbox")!.split(",").map(Number);
    expect(left).toBeCloseTo(46.2, 3);
    expect(right).toBeCloseTo(47.2, 3);
    expect(top).toBeCloseTo(25.22, 3);
    expect(bottom).toBeCloseTo(24.22, 3);

    // Huraymila, the town this bounding exists to exclude, is outside it.
    expect(46.105 < left || 46.105 > right || 25.116 > top || 25.116 < bottom).toBe(true);
  });

  it("does not bound a search that named no city", async () => {
    const fetchMock = vi.fn(async (_url: string) => hit(26.4207, 50.0888));
    vi.stubGlobal("fetch", fetchMock);

    await geocodeWithOpenStreetMap("حي الفيصلية الدمام");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("bounded")).toBeNull();
    expect(url.searchParams.get("viewbox")).toBeNull();
  });

  it("caches per city, so two cities are two questions", async () => {
    // One entry for both would let whichever ran first answer for the other —
    // which is the duplicate-name failure, reintroduced through the cache.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(hit(24.7241, 46.6402))
      .mockResolvedValueOnce(hit(26.3253, 43.975));
    vi.stubGlobal("fetch", fetchMock);

    const riyadh = await geocodeWithOpenStreetMap("النخيل", {
      city: "الرياض",
      near: { lat: 24.72, lng: 46.7 },
    });
    const buraydah = await geocodeWithOpenStreetMap("النخيل", {
      city: "بريدة",
      near: { lat: 26.33, lng: 43.97 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(riyadh?.point.lat).toBeCloseTo(24.7241, 3);
    expect(buraydah?.point.lat).toBeCloseTo(26.3253, 3);
  });
});
