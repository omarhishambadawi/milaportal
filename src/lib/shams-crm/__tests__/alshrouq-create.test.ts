/**
 * The AlShrouq create transport and its reconciliation read.
 *
 * Entirely offline. `fetch` is stubbed for every test, so no CRM is contacted
 * and no delivery can be created. The stub credentials are obvious fakes and
 * exist only to make `readCrmEnv` return a value, matching `client.test.ts`.
 *
 * The load-bearing assertions here are the counting ones: several tests assert
 * `createPosts()` is exactly 1 — or 0 — because the property this transport
 * exists to guarantee is that one logical create is one POST attempt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCrmSession } from "@/lib/shams-crm/client.server";
import {
  createAlshrouqOrder,
  findAlshrouqOrderByClientOrderId,
  newAlshrouqOperationId,
  sanitizeResponseBody,
} from "@/lib/shams-crm/alshrouq-create.server";
import { buildAlshrouqOrderPayload } from "@/lib/shams-crm/alshrouq-payload";

const CREATE_PATH = "/integrations/alshrouq/orders";
const LOGIN_OK = { session_token: "stub-session", id: 1, role: "manager", branch_code: "P0001" };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

/** A 2xx whose body cannot be parsed. */
function unreadableResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => "<html>not json</html>",
  } as unknown as Response;
}

function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Login always succeeds; `createResponder` decides what the create does. */
function mockCrm(createResponder: () => Promise<Response>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/login")) return jsonResponse(LOGIN_OK);
    return createResponder();
  });
}

function calls() {
  return fetchMock.mock.calls.map((c) => ({
    url: String(c[0]),
    init: (c[1] ?? {}) as RequestInit,
  }));
}

/** How many POSTs were sent to the create endpoint. The number that matters. */
function createPosts() {
  return calls().filter((c) => c.url.includes(CREATE_PATH) && c.init.method === "POST").length;
}

function createCall() {
  const c = calls().find((x) => x.url.includes(CREATE_PATH) && x.init.method === "POST");
  if (!c) throw new Error("no create POST was made");
  return c;
}

const PAYMENT_IDS = [1, 2, 3, 4] as const;

/** Built by the Phase 6 builder — never hand-written here. */
function samplePayload() {
  const result = buildAlshrouqOrderPayload(
    {
      display_no: "#9540",
      customer_name: "Test Customer",
      customer_phone: "0500798930",
      alshrouq_map_url: "https://maps.app.goo.gl/abc123",
      alshrouq_lat: 21.5558662,
      alshrouq_lng: 39.2905617,
      alshrouq_payment_type: 3,
      invoice_value: 0,
      notes: null,
    },
    { alshrouqBranchId: "9999927657121", paymentOptionIds: PAYMENT_IDS, preparationTime: 10 },
  );
  if (!result.ok) throw new Error("fixture payload should build");
  return result.payload;
}

beforeEach(() => {
  _resetCrmSession();
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

describe("newAlshrouqOperationId", () => {
  it("is a uuid4", () => {
    expect(newAlshrouqOperationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("gives each logical operation its own id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAlshrouqOperationId()));
    expect(ids.size).toBe(50);
  });
});

describe("createAlshrouqOrder — the request", () => {
  it("POSTs to the confirmed endpoint", async () => {
    mockCrm(async () => jsonResponse({ ok: true }));
    await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    const c = createCall();
    expect(c.url).toBe(`https://shams-crm.cloud${CREATE_PATH}`);
    expect(c.init.method).toBe("POST");
  });

  it("sends the confirmed headers, and no credential", async () => {
    mockCrm(async () => jsonResponse({ ok: true }));
    const operationId = newAlshrouqOperationId();
    await createAlshrouqOrder(samplePayload(), operationId);

    const h = createCall().init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["X-Session-Token"]).toBe("stub-session");
    expect(h["X-Client-Operation-Id"]).toBe(operationId);
    expect(JSON.stringify(h)).not.toContain("stub-pass");
    expect(JSON.stringify(h)).not.toContain("stub-user");
  });

  it("sends exactly the Phase 6 builder's output as the body", async () => {
    mockCrm(async () => jsonResponse({ ok: true }));
    const payload = samplePayload();
    await createAlshrouqOrder(payload, newAlshrouqOperationId());

    expect(createCall().init.body).toBe(JSON.stringify(payload));
    // And the builder's rules survive the trip: zero stays zero.
    expect(JSON.parse(String(createCall().init.body)).order_value).toBe(0);
  });

  it("does not mutate the payload", async () => {
    mockCrm(async () => jsonResponse({ ok: true }));
    const payload = samplePayload();
    const before = structuredClone(payload);
    await createAlshrouqOrder(payload, newAlshrouqOperationId());
    expect(payload).toEqual(before);
  });

  it("throws without transmitting when the CRM is not configured", async () => {
    delete process.env.SHAMS_CRM_USERNAME;
    delete process.env.SHAMS_CRM_PASSWORD;

    await expect(createAlshrouqOrder(samplePayload(), newAlshrouqOperationId())).rejects.toThrow();
    // The invariant: a throw means nothing left the machine.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createAlshrouqOrder — outcomes", () => {
  it("2xx is accepted", async () => {
    mockCrm(async () => jsonResponse({ id: 5263, note: "created" }, 201));
    const operationId = newAlshrouqOperationId();
    const r = await createAlshrouqOrder(samplePayload(), operationId);

    expect(r).toEqual({
      kind: "accepted",
      operationId,
      status: 201,
      body: { id: 5263, note: "created" },
    });
    expect(createPosts()).toBe(1);
  });

  it("4xx is rejected, and keeps the CRM's own reason", async () => {
    mockCrm(async () => jsonResponse({ detail: "branch not covered" }, 422));
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ detail: "branch not covered" });
    expect(createPosts()).toBe(1);
  });

  /**
   * The Phase 9 correction. A 4xx means the CRM understood and declined; a 5xx
   * means nothing of the kind — the CRM brokers onward to AlShrouq, so a server
   * error is equally consistent with the delivery having been created and the
   * acknowledgement lost. Treating it as a refusal would invite a resend.
   */
  it.each([500, 502, 503, 504])("%i is indeterminate, never a refusal", async (status) => {
    mockCrm(async () => jsonResponse({ detail: "upstream error" }, status));
    const operationId = newAlshrouqOperationId();
    const r = await createAlshrouqOrder(samplePayload(), operationId);

    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") throw new Error("unreachable");
    expect(r.errorKind).toBe("server_error");
    expect(r.operationId).toBe(operationId);
    expect(r.message).toContain(String(status));
    // The property that matters: no second driver.
    expect(createPosts()).toBe(1);
  });

  it("no 5xx sends a second POST", async () => {
    for (const status of [500, 502, 503, 504, 599]) {
      _resetCrmSession();
      fetchMock.mockReset();
      mockCrm(async () => jsonResponse({ detail: "boom" }, status));
      const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());
      expect(r.kind).toBe("indeterminate");
      expect(createPosts()).toBe(1);
    }
  });

  it("leaks no credential on the 5xx indeterminate path", async () => {
    mockCrm(async () =>
      jsonResponse({ session_token: "leaked-token", detail: "internal error" }, 500),
    );
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("leaked-token");
    expect(serialized).not.toContain("stub-session");
    expect(serialized).not.toContain("stub-user");
    expect(serialized).not.toContain("stub-pass");
  });

  it("still treats a 4xx as a genuine refusal", async () => {
    // The distinction Phase 9 rests on: 400 declined, 500 unknown.
    mockCrm(async () => jsonResponse({ detail: "bad branch" }, 400));
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    expect(r.kind).toBe("rejected");
    expect(createPosts()).toBe(1);
  });

  it("401 is indeterminate, never a refusal and never a resend", async () => {
    mockCrm(async () => jsonResponse({ detail: "unauthorized" }, 401));
    const operationId = newAlshrouqOperationId();
    const r = await createAlshrouqOrder(samplePayload(), operationId);

    expect(r).toEqual({
      kind: "indeterminate",
      operationId,
      errorKind: "auth_failed",
      message: expect.stringContaining("unknown"),
    });
    // crmFetch would have re-logged-in and re-sent here. This must not.
    expect(createPosts()).toBe(1);
  });

  it("a timeout is indeterminate and sends nothing further", async () => {
    mockCrm(async () => {
      throw abortError();
    });
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") throw new Error("unreachable");
    expect(r.errorKind).toBe("timeout");
    expect(createPosts()).toBe(1);
  });

  it("a network failure is indeterminate and sends nothing further", async () => {
    mockCrm(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") throw new Error("unreachable");
    expect(r.errorKind).toBe("network");
    expect(createPosts()).toBe(1);
  });

  it("a 2xx whose body cannot be read is indeterminate, not assumed", async () => {
    mockCrm(async () => unreadableResponse(200));
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") throw new Error("unreachable");
    expect(r.errorKind).toBe("malformed");
    expect(createPosts()).toBe(1);
  });

  it("carries the operation id on every outcome", async () => {
    for (const [status, expected] of [
      [200, "accepted"],
      [422, "rejected"],
      [401, "indeterminate"],
    ] as const) {
      _resetCrmSession();
      fetchMock.mockReset();
      mockCrm(async () => jsonResponse({ detail: "x" }, status));
      const operationId = newAlshrouqOperationId();
      const r = await createAlshrouqOrder(samplePayload(), operationId);
      expect(r.kind).toBe(expected);
      expect(r.operationId).toBe(operationId);
    }
  });

  it("never leaks a credential or token into the result", async () => {
    mockCrm(async () =>
      jsonResponse({
        session_token: "leaked-token",
        api_key: "leaked-key",
        customer_name: "A Real Person",
        customer_phone: "0500000000",
        id: 5263,
      }),
    );
    const r = await createAlshrouqOrder(samplePayload(), newAlshrouqOperationId());

    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("leaked-token");
    expect(serialized).not.toContain("leaked-key");
    expect(serialized).not.toContain("A Real Person");
    expect(serialized).not.toContain("0500000000");
    expect(serialized).not.toContain("stub-session");
    expect(serialized).not.toContain("stub-pass");
    // Non-sensitive diagnostics survive.
    expect(serialized).toContain("5263");
  });
});

describe("sanitizeResponseBody", () => {
  it("redacts credentials and identities by key, keeping shape", () => {
    expect(
      sanitizeResponseBody({
        id: 1,
        tracking_url: "https://alshrouqdelivery.com/tracking/abc",
        customer_phone: "0500000000",
        driver_name: "Someone",
        authorization: "Bearer x",
        nested: { password: "p", status_label: "Order Created" },
      }),
    ).toEqual({
      id: 1,
      tracking_url: "https://alshrouqdelivery.com/tracking/abc",
      customer_phone: "[redacted]",
      driver_name: "[redacted]",
      authorization: "[redacted]",
      nested: { password: "[redacted]", status_label: "Order Created" },
    });
  });

  it("caps runaway arrays and strings so a diagnostic cannot become a dump", () => {
    const out = sanitizeResponseBody({ rows: Array.from({ length: 200 }, (_, i) => i) }) as any;
    expect(out.rows).toHaveLength(26);
    expect(out.rows[25]).toBe("[175 more]");

    const long = sanitizeResponseBody({ s: "x".repeat(5000) }) as any;
    expect(long.s.endsWith("…[truncated]")).toBe(true);
  });
});

describe("findAlshrouqOrderByClientOrderId — reconciliation", () => {
  const RECORD = {
    id: 5263,
    external_order_id: 6099196,
    client_order_id: "9540",
    branch_id: "9999927657206",
    customer_name: "Someone",
    customer_phone: "0500000000",
    payment_type: 3,
    order_value: 0.0,
    preparation_time: 10,
    status_id: "23",
    status_label: "Order Created",
    tracking_url: "https://alshrouqdelivery.com/tracking/abc",
    is_cancelled: false,
    created_at: "2026-08-20T23:55:32.457774",
    updated_at: "2026-08-20T23:55:32.749943",
  };

  function mockHistory(rows: unknown) {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/login")) return jsonResponse(LOGIN_OK);
      return jsonResponse(rows);
    });
  }

  it("finds the record by client_order_id and never POSTs", async () => {
    mockHistory([{ ...RECORD, client_order_id: "9999" }, RECORD]);
    const found = await findAlshrouqOrderByClientOrderId("9540");

    expect(found).toEqual({
      id: 5263,
      externalOrderId: 6099196,
      clientOrderId: "9540",
      branchId: "9999927657206",
      paymentType: 3,
      orderValue: 0,
      preparationTime: 10,
      statusId: "23",
      statusLabel: "Order Created",
      isCancelled: false,
      trackingUrl: "https://alshrouqdelivery.com/tracking/abc",
      createdAt: "2026-08-20T23:55:32.457774",
      updatedAt: "2026-08-20T23:55:32.749943",
    });
    expect(createPosts()).toBe(0);
  });

  it("carries no customer or driver identity out of the CRM", async () => {
    mockHistory([RECORD]);
    const found = await findAlshrouqOrderByClientOrderId("9540");
    const serialized = JSON.stringify(found);
    expect(serialized).not.toContain("Someone");
    expect(serialized).not.toContain("0500000000");
  });

  it("uses GET against the confirmed history endpoint", async () => {
    mockHistory([RECORD]);
    await findAlshrouqOrderByClientOrderId("9540", {
      fromDate: "2026-08-19",
      toDate: "2026-08-21",
    });

    const historyCall = calls().find((c) => c.url.includes(CREATE_PATH));
    if (!historyCall) throw new Error("no history call");
    // crmFetch issues GET; assert no method was set to anything mutating.
    expect(historyCall.init.method).toBe("GET");
    expect(historyCall.url).toContain("from_date=2026-08-19");
    expect(historyCall.url).toContain("to_date=2026-08-21");
    expect(historyCall.url).toContain("include_raw_data=false");
    expect(createPosts()).toBe(0);
  });

  it("returns null when nothing matches — never resolving doubt with a POST", async () => {
    mockHistory([{ ...RECORD, client_order_id: "0001" }]);
    expect(await findAlshrouqOrderByClientOrderId("9540")).toBeNull();
    expect(createPosts()).toBe(0);
  });

  it("spans a day either side, so a create near midnight is still found", async () => {
    mockHistory([RECORD]);
    await findAlshrouqOrderByClientOrderId("9540", { now: new Date("2026-08-20T23:55:00Z") });

    const url = calls().find((c) => c.url.includes(CREATE_PATH))!.url;
    expect(url).toContain("from_date=2026-08-19");
    expect(url).toContain("to_date=2026-08-21");
  });

  it("tolerates a non-array response rather than throwing", async () => {
    mockHistory({ unexpected: true });
    expect(await findAlshrouqOrderByClientOrderId("9540")).toBeNull();
  });
});
