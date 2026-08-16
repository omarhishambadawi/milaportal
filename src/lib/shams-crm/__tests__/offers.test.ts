/**
 * CRM offer pricing.
 *
 * `fetch` is stubbed, so no credentials, no network and no CRM. The stub
 * credentials are obvious fakes and exist only so the client considers itself
 * configured.
 *
 * The response fixture is shaped like the real one — a `branch` sub-object,
 * `available_qty` alongside the pricing fields, and the address/link fields the
 * real endpoint carries — precisely so the tests can assert what is *not* read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCrmSession } from "@/lib/shams-crm/client.server";
import { _clearOfferCache, getProductOffer } from "@/lib/shams-crm/offers.server";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LOGIN_OK = { session_token: "stub-session", id: 1, role: "manager", branch_code: "P0001" };

/** A branch row as the CRM actually sends it, extra fields included. */
const branchRow = (code: string, offerPercent: number, qty = 33) => ({
  branch: {
    code,
    city: "الاحساء",
    district: "طريق الملك",
    address: "…",
    latitude: 25.34,
    longitude: 49.54,
    whatsapp: "https://wa.me/966500000000",
    maps_url: "https://maps.app.goo.gl/example",
  },
  available_qty: qty,
  price: 49.91,
  offer_percent: offerPercent,
  offer_display: `${offerPercent.toFixed(2)}%`,
  after_offer_price: 37.43,
  price_without_tax: 43.4,
  distance_km: 187.85,
  within_radius: false,
});

const AVAILABLE_BRANCHES = {
  item_code: "10612091",
  item_name: "PHARMATON VITALITY FOOD SUPLEMENT CAP, 30'S",
  branches: [branchRow("P0701", 25), branchRow("P0002", 0), branchRow("P0304", 10)],
};

let fetchMock: ReturnType<typeof vi.fn>;

function urlsAsked(): string[] {
  return fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
}

function respondNormally() {
  fetchMock.mockImplementation(async (url: string) =>
    new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse(AVAILABLE_BRANCHES),
  );
}

beforeEach(() => {
  _resetCrmSession();
  _clearOfferCache();
  process.env.SHAMS_CRM_USERNAME = "stub-user";
  process.env.SHAMS_CRM_PASSWORD = "stub-pass";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SHAMS_CRM_USERNAME;
  delete process.env.SHAMS_CRM_PASSWORD;
});

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

describe("the request", () => {
  it("asks the availability endpoint for that one item code, authenticated", async () => {
    respondNormally();

    await getProductOffer("10612091");

    expect(urlsAsked()).toEqual(["/login", "/products/10612091/available-branches"]);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    // The existing Phase 1 client supplies the session; no new auth path.
    expect((init.headers as Record<string, string>)["X-Session-Token"]).toBe("stub-session");
  });

  it("costs nothing for an empty item code", async () => {
    respondNormally();

    expect(await getProductOffer("   ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

describe("mapping", () => {
  it("maps the confirmed pricing fields and the branch identity", async () => {
    respondNormally();

    const offers = await getProductOffer("10612091");

    expect(offers).toContainEqual({
      itemCode: "10612091",
      branchCode: "P0701",
      price: 49.91,
      offerPercent: 25,
      offerDisplay: "25.00%",
      afterOfferPrice: 37.43,
    });
  });

  it("drops branches with no offer rather than reporting a zero discount", async () => {
    respondNormally();

    const offers = await getProductOffer("10612091");

    expect(offers.map((o) => o.branchCode).sort()).toEqual(["P0304", "P0701"]);
    expect(offers.every((o) => o.offerPercent > 0)).toBe(true);
  });

  it("never carries CRM availability or branch contact details", async () => {
    respondNormally();

    const serialized = JSON.stringify(await getProductOffer("10612091"));

    // `available_qty` must not travel with offers: MIS stock is the authority.
    expect(serialized).not.toContain("available_qty");
    expect(serialized).not.toContain("33");
    expect(serialized).not.toContain("wa.me");
    expect(serialized).not.toContain("maps.app.goo.gl");
    expect(serialized).not.toContain("price_without_tax");
  });

  it("takes after_offer_price from the API rather than recomputing it", async () => {
    // 49.91 less 25% is 37.4325; the API says 37.43 and the API wins.
    respondNormally();

    const [offer] = await getProductOffer("10612091");

    expect(offer.afterOfferPrice).toBe(37.43);
  });

  it("an item with no offer anywhere returns an empty list", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login"
        ? jsonResponse(LOGIN_OK)
        : jsonResponse({ item_code: "1", branches: [branchRow("P0002", 0)] }),
    );

    expect(await getProductOffer("1")).toEqual([]);
  });

  it("a malformed response yields no offers rather than throwing", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({ nope: true }),
    );

    expect(await getProductOffer("1")).toEqual([]);
  });

  it("a row without a branch code is dropped — it could not be matched", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login"
        ? jsonResponse(LOGIN_OK)
        : jsonResponse({
            branches: [{ price: 10, offer_percent: 5, after_offer_price: 9.5 }],
          }),
    );

    expect(await getProductOffer("1")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

describe("cache", () => {
  it("serves a repeat read without a second request", async () => {
    respondNormally();

    await getProductOffer("10612091");
    const after = fetchMock.mock.calls.length;
    await getProductOffer("10612091");

    expect(fetchMock.mock.calls).toHaveLength(after);
  });

  it("concurrent reads of one item share a single request", async () => {
    respondNormally();

    await Promise.all([
      getProductOffer("10612091"),
      getProductOffer("10612091"),
      getProductOffer("10612091"),
    ]);

    expect(urlsAsked().filter((p) => p.endsWith("/available-branches"))).toHaveLength(1);
  });

  it("does not share entries between item codes", async () => {
    respondNormally();

    await getProductOffer("10612091");
    await getProductOffer("10400746");

    expect(urlsAsked()).toContain("/products/10612091/available-branches");
    expect(urlsAsked()).toContain("/products/10400746/available-branches");
  });

  it("caches an empty answer, so a product without offers is not re-asked", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({ branches: [] }),
    );

    await getProductOffer("1");
    const after = fetchMock.mock.calls.length;
    await getProductOffer("1");

    expect(fetchMock.mock.calls).toHaveLength(after);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

describe("failure", () => {
  it("raises rather than fabricating pricing, and caches nothing", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );

    await expect(getProductOffer("1")).rejects.toMatchObject({ kind: "http_error" });
    // A failed read leaves no entry behind, so the next open retries.
    await expect(getProductOffer("1")).rejects.toMatchObject({ kind: "http_error" });
  });

  it("is not configured without credentials, and costs no request", async () => {
    delete process.env.SHAMS_CRM_PASSWORD;

    await expect(getProductOffer("1")).rejects.toMatchObject({ kind: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
