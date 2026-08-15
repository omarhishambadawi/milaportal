/**
 * Catalog search tests — the upstream side of product discovery.
 *
 * `search.test.ts` covers the matching rules in isolation. What is tested here
 * is the part that decides *which products ever get matched*: how many requests
 * a query costs, what is sent as `q`, and whether a product the API only
 * returned for one probe still reaches the agent.
 *
 * `shamsFetch` is stubbed, so no credentials, no network and no MIS.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawProductSearchRow } from "@/lib/shams/types";

const fetchMock = vi.fn();

vi.mock("@/lib/shams/client.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/shams/client.server")>(
    "@/lib/shams/client.server",
  );
  return { ...actual, shamsFetch: (...args: unknown[]) => fetchMock(...args) };
});

const { searchProducts, _clearCaches, MAX_SEARCH_PROBES } =
  await import("@/lib/shams/catalog.server");

const row = (itemCode: string, itemName: string): RawProductSearchRow => ({
  itemCode,
  itemName,
  retailPrice: 1261.4,
});

const MOUNJARO = row("10609670", "MOUNJARO 2.5 MG 0.5ML PEN, 4'S");
const S26 = row("10501234", "S-26 GOLD 3 1800 GM");
const NOISE = row("10999999", "PANADOL 500MG");

/** Answer each `q` with its own rows. */
function respondWith(rowsByTerm: Record<string, RawProductSearchRow[]>) {
  fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => ({
    success: true,
    data: rowsByTerm[query.q] ?? [],
  }));
}

function termsAsked(): string[] {
  return fetchMock.mock.calls.map((c) => (c[1] as Record<string, string>).q);
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearCaches();
});

describe("searchProducts — plain queries", () => {
  it("sends the query as typed, in exactly one request", async () => {
    respondWith({ mounjaro: [MOUNJARO] });

    const products = await searchProducts("mounjaro");

    expect(termsAsked()).toEqual(["mounjaro"]);
    expect(products.map((p) => p.itemCode)).toEqual(["10609670"]);
  });

  it("still finds a product from a partial spelling", async () => {
    respondWith({ mounj: [MOUNJARO] });
    expect((await searchProducts("mounj")).map((p) => p.itemCode)).toEqual(["10609670"]);
  });

  it("never sends an asterisk upstream", async () => {
    respondWith({ mou: [MOUNJARO], "2.5": [MOUNJARO] });

    await searchProducts("mou*n*j*2.5");

    for (const term of termsAsked()) expect(term).not.toContain("*");
  });

  it("asks nothing at all for a query below the floor", async () => {
    await searchProducts("m");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchProducts — wildcard queries", () => {
  it("finds Mounjaro 2.5 from mou*n*j*2.5", async () => {
    respondWith({ mou: [MOUNJARO, NOISE] });

    const products = await searchProducts("mou*n*j*2.5");

    expect(products.map((p) => p.itemCode)).toEqual(["10609670"]);
  });

  it("finds S-26 Gold 3 1800 from *26*gold*3*1800", async () => {
    respondWith({ gold: [S26], "1800": [S26, NOISE] });

    const products = await searchProducts("*26*gold*3*1800");

    expect(products.map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  /**
   * The reliability fix. A single probe is only a superset if the API returns
   * everything it matched — and it exposes no limit/page/offset, so a
   * server-side cap cannot be ruled out. Here the first probe's response is
   * truncated to noise; the product still has to be found.
   */
  it("finds a product the most selective probe did not return", async () => {
    respondWith({
      gold: [NOISE], // as if truncated upstream — the real match cut off
      "1800": [S26],
    });

    const products = await searchProducts("*26*gold*3*1800");

    expect(products.map((p) => p.itemCode)).toEqual(["10501234"]);
    expect(termsAsked().length).toBeGreaterThan(1);
  });

  it("merges the probes and returns each product once", async () => {
    respondWith({ gold: [S26], "1800": [S26], "26": [S26] });

    const products = await searchProducts("*26*gold*3*1800");

    expect(products).toHaveLength(1);
  });

  it("bounds how many requests one query may cost", async () => {
    respondWith({});

    await searchProducts("mounjaro*kwikpen*12.5*0.6*2.4*qr");

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(MAX_SEARCH_PROBES);
  });

  it("drops candidates that fail the full expression", async () => {
    // Both probes return noise alongside the match; noise satisfies neither
    // the fragment set nor its order.
    respondWith({ mou: [MOUNJARO, NOISE], "2.5": [MOUNJARO, NOISE] });

    const products = await searchProducts("mou*n*j*2.5");

    expect(products.map((p) => p.itemName)).toEqual(["MOUNJARO 2.5 MG 0.5ML PEN, 4'S"]);
  });

  it("is case-insensitive and tolerant of the agent's spacing", async () => {
    respondWith({ mou: [MOUNJARO], "2.5": [MOUNJARO] });

    expect(await searchProducts("MOU * 2.5")).toHaveLength(1);
    expect(await searchProducts("  mou*2.5  ")).toHaveLength(1);
  });

  it("returns nothing when no fragment is long enough to search with", async () => {
    expect(await searchProducts("a*b*c")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The regression this guards. `moun*2.5` sent `2.5` as a second probe, which
   * matches every 2.5 mg product Shams sells. The endpoint has no `limit`, and
   * the probes were awaited together, so that one request held the whole search
   * — including the good `moun` answer — until it timed out. The agent watched a
   * skeleton that never resolved.
   */
  it("does not spend a second request on a short, unselective fragment", async () => {
    respondWith({ moun: [MOUNJARO] });

    const products = await searchProducts("moun*2.5");

    expect(termsAsked()).toEqual(["moun"]);
    expect(products.map((p) => p.itemCode)).toEqual(["10609670"]);
  });

  it("still corroborates with fragments that are selective enough", async () => {
    respondWith({ gold: [S26], "1800": [S26] });

    await searchProducts("*26*gold*3*1800");

    expect(termsAsked()).toEqual(["gold", "1800"]);
  });

  it("answers from the first probe when a corroborating one fails", async () => {
    // The first probe IS the search; the rest are optional insurance, so one of
    // them failing must not cost the agent the answer that already arrived.
    fetchMock.mockImplementation(async (_path: string, query: Record<string, string>) => {
      if (query.q === "1800") throw new Error("upstream blew up");
      return { success: true, data: query.q === "gold" ? [S26] : [] };
    });

    const products = await searchProducts("*26*gold*3*1800");

    expect(products.map((p) => p.itemCode)).toEqual(["10501234"]);
  });

  it("fails the search when the first probe fails", async () => {
    fetchMock.mockRejectedValue(new Error("MIS unreachable"));

    await expect(searchProducts("mounjaro")).rejects.toThrow();
  });

  it("caps how long a corroborating probe may hold the search", async () => {
    respondWith({ gold: [S26], "1800": [S26] });

    await searchProducts("*26*gold*3*1800");

    const [, secondCall] = fetchMock.mock.calls;
    // The primary carries no override — it uses the transport's own timeout.
    expect(fetchMock.mock.calls[0][2]).toBeUndefined();
    expect((secondCall[2] as { timeoutMs?: number })?.timeoutMs).toBeGreaterThan(0);
  });
});

describe("searchProducts — caching and ranking", () => {
  it("does not repeat a search it has already run", async () => {
    respondWith({ mounjaro: [MOUNJARO] });

    await searchProducts("mounjaro");
    const afterFirst = fetchMock.mock.calls.length;
    await searchProducts("MOUNJARO");

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("puts the best match first rather than the API's own order", async () => {
    respondWith({
      mounjaro: [
        row("1", "PEN NEEDLE FOR MOUNJARO"),
        row("2", "MOUNJARO"),
        row("3", "MOUNJARO 5 MG"),
      ],
    });

    const products = await searchProducts("mounjaro");

    expect(products.map((p) => p.itemName)).toEqual([
      "MOUNJARO",
      "MOUNJARO 5 MG",
      "PEN NEEDLE FOR MOUNJARO",
    ]);
  });
});
