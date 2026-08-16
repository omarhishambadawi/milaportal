/**
 * The CRM → Portal product seam.
 *
 * `fetch` is stubbed, so no credentials, no network and no CRM. What is checked
 * here is only what the seam is responsible for: that Portal callers get
 * `ShamsProduct`, that it rides the Phase 1 cache rather than a second one, and
 * that a failure stays a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCrmSession } from "@/lib/shams-crm/client.server";
import { _clearCatalogCache, catalogStatus } from "@/lib/shams-crm/catalog.server";
import { getCrmProducts, isCrmCatalogAvailable } from "@/lib/shams-crm/products.server";
import type { ShamsProduct } from "@/lib/shams/types";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LOGIN_OK = { session_token: "stub-session", id: 1, role: "manager", branch_code: "P0001" };
const PRODUCTS = [
  { code: "10400746", name: "NAN 2 OPTIPRO 1800 GM", price: 100 },
  { code: "10400741", name: "NAN OPTIPRO KIDS MILK, 400 G", price: 50 },
];

let fetchMock: ReturnType<typeof vi.fn>;

function pathsAsked(): string[] {
  return fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
}

function respondNormally() {
  fetchMock.mockImplementation(async (url: string) =>
    new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse(PRODUCTS),
  );
}

beforeEach(() => {
  _resetCrmSession();
  _clearCatalogCache();
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

describe("isCrmCatalogAvailable", () => {
  it("follows configuration, and makes no request", () => {
    expect(isCrmCatalogAvailable()).toBe(true);

    delete process.env.SHAMS_CRM_PASSWORD;
    expect(isCrmCatalogAvailable()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getCrmProducts", () => {
  it("returns rows the Portal's own product type accepts", async () => {
    respondNormally();

    const products = await getCrmProducts();

    // The assignment is the assertion: if the two shapes ever diverge, this
    // stops compiling, which is the point of the seam.
    const asPortal: readonly ShamsProduct[] = products;
    expect(asPortal[0]).toEqual({
      itemCode: "10400746",
      itemName: "NAN 2 OPTIPRO 1800 GM",
      retailPrice: 100,
    });
    expect(asPortal).toHaveLength(2);
  });

  it("rides the Phase 1 cache — no second download, no second cache", async () => {
    respondNormally();

    const first = await getCrmProducts();
    const second = await getCrmProducts();

    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(1);
    // The same underlying array, so this is the Phase 1 cache and not a copy
    // held somewhere else.
    expect(first).toBe(second);
    expect(catalogStatus().fetches).toBe(1);
  });

  it("shares one download with a concurrent caller", async () => {
    respondNormally();

    await Promise.all([getCrmProducts(), getCrmProducts(), getCrmProducts()]);

    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(1);
  });

  it("propagates a failure rather than returning an empty catalog", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );

    // An outage must not read as "this pharmacy sells nothing".
    await expect(getCrmProducts()).rejects.toMatchObject({ kind: "http_error" });
  });

  it("refuses without credentials, and costs no request", async () => {
    delete process.env.SHAMS_CRM_USERNAME;
    delete process.env.SHAMS_CRM_PASSWORD;

    await expect(getCrmProducts()).rejects.toMatchObject({ kind: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps serving the previous catalog when a refresh fails", async () => {
    respondNormally();
    const good = await getCrmProducts();

    const { refreshCatalog } = await import("@/lib/shams-crm/catalog.server");
    refreshCatalog();
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );

    // Phase 1's fallback is unchanged by this seam.
    await expect(getCrmProducts()).resolves.toEqual(good);
  });
});
