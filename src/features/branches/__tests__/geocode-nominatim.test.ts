import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGeocodeCache, geocodeWithOpenStreetMap } from "../geocode-nominatim";

/** A Nominatim response body for a point in Dammam. */
function hit(lat: number, lng: number) {
  return {
    ok: true,
    json: async () => [{ lat: String(lat), lon: String(lng) }],
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
    expect(first?.lat).toBeCloseTo(26.4207, 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The cache is keyed on the normalized form, so a differently-typed spelling
    // of the same query is also a hit — which is the point of reusing
    // `normalizePlace` rather than the raw string.
    const second = await geocodeWithOpenStreetMap("  حي  الفيصليه  الدمام ");
    expect(second?.lat).toBeCloseTo(26.4207, 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
