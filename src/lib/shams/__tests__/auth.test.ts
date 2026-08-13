/**
 * Shams authentication tests.
 *
 * These drive the real client against a stubbed `fetch`, so they exercise the
 * actual token cache, single-flight and retry logic rather than a re-description
 * of it. Every token value here is a fabricated stand-in — no real credential or
 * token appears in this repository.
 *
 * The behaviours pinned below are the contract the MIS portal's own client
 * implements: Bearer attachment on everything except the token call, a 60 s
 * refresh skew, and on 401 a forced refresh plus exactly one retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShamsError,
  _resetAuthForTests,
  getAccessToken,
  isConfigured,
  readEnv,
  shamsFetch,
  tokenSnapshot,
} from "@/lib/shams/client.server";

const BASE = "https://mis.example.test";

/** A token response shaped like the live one. Values are fabricated. */
function tokenBody(token: string, expiresIn = 1800) {
  return {
    success: true,
    token_type: "Bearer",
    access_token: token,
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    account_identifier: "acct-stub",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetAuthForTests();
  process.env.SHAMS_MIS_BASE_URL = BASE;
  process.env.SHAMS_MIS_ACCOUNT_IDENTIFIER = "acct-stub";
  process.env.SHAMS_MIS_API_KEY = "key-stub";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SHAMS_MIS_ACCOUNT_IDENTIFIER;
  delete process.env.SHAMS_MIS_API_KEY;
  delete process.env.SHAMS_MIS_BASE_URL;
});

/** The `Authorization` header of the Nth fetch call, or undefined. */
function authHeaderOf(callIndex: number): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function urlOf(callIndex: number): string {
  return String(fetchMock.mock.calls[callIndex]?.[0]);
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe("configuration", () => {
  it("requires all three variables together", () => {
    expect(isConfigured()).toBe(true);
    delete process.env.SHAMS_MIS_API_KEY;
    expect(isConfigured()).toBe(false);
    expect(readEnv()).toBeNull();
  });

  it("treats a partial configuration as unconfigured rather than failing later", async () => {
    delete process.env.SHAMS_MIS_ACCOUNT_IDENTIFIER;
    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).rejects.toMatchObject({
      kind: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Token acquisition                                                           */
/* -------------------------------------------------------------------------- */

describe("token acquisition", () => {
  it("posts the credential pair to /api/v2/auth/token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")));
    await getAccessToken();

    expect(urlOf(0)).toBe(`${BASE}/api/v2/auth/token`);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      account_identifier: "acct-stub",
      api_key: "key-stub",
    });
    // The token request itself must not carry an Authorization header.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("rejects a response that carries no access token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    const err = await getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(ShamsError);
    expect(err).toMatchObject({ kind: "auth_failed" });
  });

  it("raises malformed on an unparseable token response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    } as unknown as Response);
    await expect(getAccessToken()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("reports auth_failed when the credentials are rejected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    await expect(getAccessToken()).rejects.toMatchObject({ kind: "auth_failed" });
  });

  it("does not cache a failed exchange", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    await expect(getAccessToken()).rejects.toBeInstanceOf(ShamsError);
    expect(tokenSnapshot().cached).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-after-failure")));
    await expect(getAccessToken()).resolves.toBe("tok-after-failure");
  });

  it("falls back to a default lifetime when expires_in is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, token_type: "Bearer", access_token: "tok-nolife" }),
    );
    await getAccessToken();
    // 1800 s minus elapsed — comfortably above the 60 s skew, so it is usable.
    expect(tokenSnapshot().expiresInSec).toBeGreaterThan(1700);
  });
});

/* -------------------------------------------------------------------------- */
/* Caching, expiry, single-flight                                              */
/* -------------------------------------------------------------------------- */

describe("token caching", () => {
  it("reuses a cached token instead of re-authenticating", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-cached")));
    await getAccessToken();
    await getAccessToken();
    await getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates once the token falls inside the 60s refresh skew", async () => {
    // 30 s of life left: still valid to the server, but inside the skew, so the
    // client must not risk issuing a request with it.
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-nearly-dead", 30)));
    await expect(getAccessToken()).resolves.toBe("tok-nearly-dead");

    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-renewed")));
    await expect(getAccessToken()).resolves.toBe("tok-renewed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers into a single token exchange", async () => {
    let release!: (v: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
    release(jsonResponse(tokenBody("tok-single-flight")));

    expect(await inFlight).toEqual(["tok-single-flight", "tok-single-flight", "tok-single-flight"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh discards the cached token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-old")));
    await getAccessToken();
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-new")));
    await expect(getAccessToken(true)).resolves.toBe("tok-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never exposes the token through the diagnostic snapshot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-secret-value")));
    await getAccessToken();
    const snapshot = tokenSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain("tok-secret-value");
    expect(snapshot).toEqual({ cached: true, expiresInSec: expect.any(Number) });
  });
});

/* -------------------------------------------------------------------------- */
/* Authenticated requests                                                      */
/* -------------------------------------------------------------------------- */

describe("authenticated requests", () => {
  it("attaches Authorization: Bearer to data requests", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-attach")))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await shamsFetch("/api/v2/product/search", { q: "mounjaro" });

    expect(urlOf(1)).toBe(`${BASE}/api/v2/product/search?q=mounjaro`);
    expect(authHeaderOf(1)).toBe("Bearer tok-attach");
  });

  it("sends empty-string parameters, which sales/details relies on", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await shamsFetch("/api/v2/sales/details", {
      start_date: "",
      end_date: "",
      doc_no_start: "75181",
      wh_cd: "P0304",
      omitted: undefined,
    });

    const url = urlOf(1);
    expect(url).toContain("start_date=&end_date=");
    expect(url).not.toContain("omitted");
  });

  it("raises malformed rather than returning a non-object body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody("tok-1"))).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "<html>gateway</html>",
    } as unknown as Response);

    await expect(shamsFetch("/api/v2/product/info", { itemcode: "1" })).rejects.toMatchObject({
      kind: "malformed",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 401 handling                                                                */
/* -------------------------------------------------------------------------- */

describe("401 handling", () => {
  it("refreshes the token and retries once, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-stale"))) // initial token
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401)) // data -> 401
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-fresh"))) // forced refresh
      .mockResolvedValueOnce(jsonResponse({ success: true, count: 1, data: [{ itemCode: "1" }] }));

    const out = await shamsFetch<{ count: number }>("/api/v2/product/search", { q: "x" });

    expect(out.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(authHeaderOf(1)).toBe("Bearer tok-stale");
    expect(urlOf(2)).toBe(`${BASE}/api/v2/auth/token`);
    expect(authHeaderOf(3)).toBe("Bearer tok-fresh");
  });

  it("fails with auth_failed when the retry also returns 401 — no loop", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-2")))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).rejects.toMatchObject({
      kind: "auth_failed",
      httpStatus: 401,
    });
    // Exactly one refresh + one retry; never a third data attempt.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("surfaces no credential material in the error it raises", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-leaky")))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-leaky-2")))
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    const err = await shamsFetch("/api/v2/product/search", { q: "x" }).catch((e) => e);
    const serialized = `${(err as Error).message}`;
    for (const secret of ["tok-leaky", "tok-leaky-2", "key-stub", "acct-stub"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Transient failures                                                          */
/* -------------------------------------------------------------------------- */

describe("transient failures", () => {
  it("retries a 5xx once and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 502))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).resolves.toMatchObject({
      success: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up with http_error after a second 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockResolvedValue(jsonResponse({ error: "boom" }, 503));

    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).rejects.toMatchObject({
      kind: "http_error",
      httpStatus: 503,
    });
  });

  it("maps a network failure to unavailable", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockRejectedValue(new TypeError("network down"));

    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("does not retry a 4xx that is not 401", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody("tok-1")))
      .mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400));

    await expect(shamsFetch("/api/v2/product/search", { q: "x" })).rejects.toMatchObject({
      kind: "http_error",
      httpStatus: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
