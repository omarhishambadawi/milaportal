/**
 * Shams CRM session and catalog cache.
 *
 * `fetch` is stubbed, so no credentials, no network and no CRM. The stub
 * credentials below are obvious fakes and exist only to make `readCrmEnv`
 * return a value — no real username or password appears in this repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCrmSession,
  crmFetch,
  isCrmConfigured,
  ShamsCrmError,
} from "@/lib/shams-crm/client.server";
import {
  _clearCatalogCache,
  catalogStatus,
  getCatalog,
  refreshCatalog,
} from "@/lib/shams-crm/catalog.server";
import { runCrmSmokeTest } from "@/lib/shams-crm/diagnostics.server";

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

/** Which URLs were requested, in order. */
function pathsAsked(): string[] {
  return fetchMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
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

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe("configuration", () => {
  it("is not configured when either credential is missing", () => {
    delete process.env.SHAMS_CRM_PASSWORD;
    expect(isCrmConfigured()).toBe(false);

    process.env.SHAMS_CRM_PASSWORD = "stub-pass";
    delete process.env.SHAMS_CRM_USERNAME;
    expect(isCrmConfigured()).toBe(false);
  });

  it("refuses to call without credentials, and costs no request", async () => {
    delete process.env.SHAMS_CRM_USERNAME;
    delete process.env.SHAMS_CRM_PASSWORD;

    await expect(crmFetch("/products/names")).rejects.toMatchObject({
      kind: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

describe("session", () => {
  it("logs in, then sends the session token on the data request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse(PRODUCTS));

    await crmFetch("/products/names");

    expect(pathsAsked()).toEqual(["/login", "/products/names"]);
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("stub-session");
    // The login body carries the credentials; the data request must not.
    expect(init.body).toBeUndefined();
  });

  it("reuses the session rather than logging in per request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValue(jsonResponse(PRODUCTS));

    await crmFetch("/products/names");
    await crmFetch("/products/names");
    await crmFetch("/products/names");

    expect(pathsAsked().filter((p) => p === "/login")).toHaveLength(1);
  });

  it("concurrent callers share one login", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse(PRODUCTS),
    );

    await Promise.all([crmFetch("/a"), crmFetch("/b"), crmFetch("/c")]);

    expect(pathsAsked().filter((p) => p === "/login")).toHaveLength(1);
  });

  it("a rejected login raises auth_failed and is not cached", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "no" }, 401));

    await expect(crmFetch("/products/names")).rejects.toMatchObject({ kind: "auth_failed" });
    await expect(crmFetch("/products/names")).rejects.toBeInstanceOf(ShamsCrmError);
    // Each attempt logs in again rather than reusing a failure.
    expect(pathsAsked().filter((p) => p === "/login")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 401 recovery                                                                */
/* -------------------------------------------------------------------------- */

describe("401 recovery", () => {
  it("discards the session, logs in once more, and retries the request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK)) // first login
      .mockResolvedValueOnce(jsonResponse({}, 401)) // data request rejected
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK)) // re-login
      .mockResolvedValueOnce(jsonResponse(PRODUCTS)); // retry succeeds

    const body = await crmFetch<typeof PRODUCTS>("/products/names");

    expect(body).toHaveLength(2);
    expect(pathsAsked()).toEqual(["/login", "/products/names", "/login", "/products/names"]);
  });

  it("does not loop: a second 401 raises after exactly one re-login", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 401),
    );

    await expect(crmFetch("/products/names")).rejects.toMatchObject({ kind: "auth_failed" });

    expect(pathsAsked().filter((p) => p === "/login")).toHaveLength(2);
    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(2);
  });

  it("a non-401 error is not retried", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(LOGIN_OK))
      .mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(crmFetch("/products/names")).rejects.toMatchObject({
      kind: "http_error",
      httpStatus: 500,
    });
    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Catalog cache                                                               */
/* -------------------------------------------------------------------------- */

describe("catalog cache", () => {
  function respondNormally() {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse(PRODUCTS),
    );
  }

  it("normalizes rows and drops any without a code or a name", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login"
        ? jsonResponse(LOGIN_OK)
        : jsonResponse([...PRODUCTS, { code: "", name: "no code" }, { code: "x", price: 1 }]),
    );

    const products = await getCatalog();

    expect(products).toHaveLength(2);
    expect(products[0]).toEqual({
      itemCode: "10400746",
      itemName: "NAN 2 OPTIPRO 1800 GM",
      retailPrice: 100,
    });
  });

  it("serves a second call from cache, with no further request", async () => {
    respondNormally();

    await getCatalog();
    const after = fetchMock.mock.calls.length;
    await getCatalog();

    expect(fetchMock.mock.calls).toHaveLength(after);
  });

  it("concurrent callers share one download", async () => {
    respondNormally();

    const [a, b, c] = await Promise.all([getCatalog(), getCatalog(), getCatalog()]);

    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("refreshCatalog forces exactly one refetch", async () => {
    respondNormally();

    await getCatalog();
    refreshCatalog();
    await getCatalog();

    expect(pathsAsked().filter((p) => p === "/products/names")).toHaveLength(2);
  });

  it("a failed refresh keeps serving the previous catalog", async () => {
    respondNormally();
    const first = await getCatalog();

    refreshCatalog();
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );

    // Stale reference data beats none: the error is swallowed, not surfaced.
    await expect(getCatalog()).resolves.toEqual(first);
  });

  it("a cold cache surfaces the failure rather than pretending to be empty", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );

    await expect(getCatalog()).rejects.toMatchObject({ kind: "http_error" });
  });

  it("reports size and age without exposing the rows", async () => {
    respondNormally();
    expect(catalogStatus()).toEqual({ cached: false, count: 0, ageMs: null, fetches: 0 });

    await getCatalog();
    const status = catalogStatus();

    expect(status.cached).toBe(true);
    expect(status.count).toBe(2);
    expect(status.ageMs).toBeGreaterThanOrEqual(0);
    // One successful upstream fetch: the signal the smoke test compares across
    // a getCatalog() call to tell a real download from a stale fallback.
    expect(status.fetches).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Smoke test — it must not report green over a broken CRM                     */
/* -------------------------------------------------------------------------- */

describe("runCrmSmokeTest", () => {
  function respondNormally() {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse(PRODUCTS),
    );
  }

  function respondCatalogBroken() {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/login" ? jsonResponse(LOGIN_OK) : jsonResponse({}, 500),
    );
  }

  it("reports not-configured without calling anything", async () => {
    delete process.env.SHAMS_CRM_USERNAME;

    await expect(runCrmSmokeTest()).resolves.toEqual({
      configured: false,
      login: null,
      catalogStatus: null,
      catalogCount: null,
      cacheReused: null,
      errorKind: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("healthy: fresh fetch, then a real cache hit", async () => {
    respondNormally();

    await expect(runCrmSmokeTest()).resolves.toEqual({
      configured: true,
      login: "success",
      catalogStatus: 200,
      catalogCount: 2,
      cacheReused: true,
      errorKind: null,
    });
  });

  it("cold cache and a broken catalog surfaces the real status", async () => {
    respondCatalogBroken();

    await expect(runCrmSmokeTest()).resolves.toMatchObject({
      login: null,
      catalogStatus: 500,
      cacheReused: null,
      errorKind: "http_error",
    });
  });

  /**
   * The false-green this fix exists for.
   *
   * A warm isolate holds a good catalog; the CRM then breaks. `getCatalog`
   * serves the previous rows and swallows the error, so both calls return the
   * *same stale array* — which reference equality alone read as a cache hit,
   * producing login success / 200 / cacheReused true over a dead upstream.
   */
  it("warm cache + failing refetch is NOT reported as a cache hit", async () => {
    respondNormally();
    await getCatalog(); // isolate is now warm with a good catalog
    const warm = catalogStatus();
    expect(warm.cached).toBe(true);

    respondCatalogBroken();
    const result = await runCrmSmokeTest();

    expect(result.cacheReused).not.toBe(true);
    expect(result.cacheReused).toBe(false);
    expect(result.errorKind).toBe("stale_fallback");
    expect(result.login).not.toBe("success");
    expect(result.catalogStatus).not.toBe(200);
    expect(result.catalogCount).toBeNull();
  });

  it("the stale rows are still served to the application itself", async () => {
    // Phase 1's fallback is unchanged: the diagnostic reports the failure, but
    // callers keep getting reference data rather than nothing.
    respondNormally();
    const good = await getCatalog();

    respondCatalogBroken();
    await runCrmSmokeTest();

    await expect(getCatalog()).resolves.toEqual(good);
  });
});
