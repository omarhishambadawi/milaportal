/**
 * The AlShrouq status read: one GET, and every way it can decline to answer.
 *
 * Entirely offline. `fetch` is stubbed for every test, so no CRM is contacted.
 * The stub credentials are obvious fakes and exist only to make `readCrmEnv`
 * return a value, matching `alshrouq-create.test.ts`.
 *
 * The load-bearing assertions are the negative ones. This module sits next to a
 * transport that puts a driver at a customer's door, so what it must never do
 * matters more than what it returns: **no request it makes is anything but a
 * GET**, and no failure path reaches the create or cancel endpoints. Several
 * tests assert exactly that, because a status check that could dispatch is the
 * one defect this feature could introduce.
 *
 * The server function's gate is asserted against its *source*: `createServerFn`
 * needs a request context this suite cannot build, and an unasserted permission
 * check is how a read quietly becomes reachable by anyone.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCrmSession } from "@/lib/shams-crm/client.server";
import {
  isAlShrouqCrmOrderId,
  normalizeAlShrouqStatus,
  refreshAlShrouqOrderStatus,
} from "@/lib/shams-crm/alshrouq-status.server";

const LOGIN_OK = { session_token: "stub-session", id: 1, role: "manager", branch_code: "P0001" };

/** The record as the CRM returns it — the shape confirmed from 127 real rows. */
const LIVE_RECORD = {
  id: 5263,
  external_order_id: 9540,
  client_order_id: "9540",
  customer_name: "A Customer",
  customer_phone: "+966 54 768 2448",
  customer_address: "https://www.google.com/maps?q=21.5558662,39.2905617",
  status_id: "9",
  status_label: "Order delivered",
  tracking_url: "https://alshrouqdelivery.com/tracking/eyJ0eXAi",
  driver_name: "Abdullah mohammed khaled fuad",
  driver_phone: "560238535",
  driver_lat: 21.5558662,
  driver_lng: 39.2905617,
  last_tracking_status: "Order delivered",
  last_tracking_event_at: null,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Login always succeeds; `responder` decides what the refresh does. */
function mockCrm(responder: () => Promise<Response>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/login")) return jsonResponse(LOGIN_OK);
    return responder();
  });
}

function calls() {
  return fetchMock.mock.calls.map((c) => ({
    url: String(c[0]),
    init: (c[1] ?? {}) as RequestInit,
  }));
}

/** Every request that was not the login handshake. */
function crmCalls() {
  return calls().filter((c) => !c.url.endsWith("/login"));
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

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

describe("refreshAlShrouqOrderStatus", () => {
  it("reads the refresh endpoint and normalizes the record", async () => {
    mockCrm(async () => jsonResponse(LIVE_RECORD));

    const result = await refreshAlShrouqOrderStatus("5263");

    expect(result).toEqual({
      kind: "ok",
      status: {
        statusLabel: "Order delivered",
        lastTrackingStatus: "Order delivered",
        trackingUrl: "https://alshrouqdelivery.com/tracking/eyJ0eXAi",
        driverName: "Abdullah mohammed khaled fuad",
        driverPhone: "560238535",
        driverLat: 21.5558662,
        driverLng: 39.2905617,
      },
    });
  });

  it("calls exactly the documented path, once, as a GET", async () => {
    mockCrm(async () => jsonResponse(LIVE_RECORD));

    await refreshAlShrouqOrderStatus("5263");

    const sent = crmCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain("/integrations/alshrouq/orders/5263/refresh");
    // `crmFetch` sends no explicit method; a GET is the absence of one.
    expect(sent[0].init.method ?? "GET").toBe("GET");
  });

  it("carries none of the customer's identity out of the response", async () => {
    mockCrm(async () => jsonResponse(LIVE_RECORD));

    const result = await refreshAlShrouqOrderStatus("5263");
    const keys = result.kind === "ok" ? Object.keys(result.status) : [];

    // Seven fields, and the customer's name, phone and address are not among
    // them — a status check has no business re-shipping those to a browser.
    expect(keys.sort()).toEqual(
      [
        "driverLat",
        "driverLng",
        "driverName",
        "driverPhone",
        "lastTrackingStatus",
        "statusLabel",
        "trackingUrl",
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Partial records                                                            */
/* -------------------------------------------------------------------------- */

describe("a record with no driver assigned yet", () => {
  it("degrades every optional field to null rather than throwing", async () => {
    mockCrm(async () => jsonResponse({ id: 5263, status_label: "Order Created", status_id: "23" }));

    const result = await refreshAlShrouqOrderStatus("5263");

    expect(result).toEqual({
      kind: "ok",
      status: {
        statusLabel: "Order Created",
        lastTrackingStatus: null,
        trackingUrl: null,
        driverName: null,
        driverPhone: null,
        driverLat: null,
        driverLng: null,
      },
    });
  });

  it("treats an empty object as a readable record with nothing in it", async () => {
    mockCrm(async () => jsonResponse({}));

    const result = await refreshAlShrouqOrderStatus("5263");

    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.status.statusLabel).toBeNull();
  });
});

describe("normalizeAlShrouqStatus", () => {
  it("refuses a tracking URL that is not absolute http(s)", () => {
    // The column is upstream text; a `javascript:` value must never reach an
    // anchor. Treated as no URL rather than rewritten.
    expect(normalizeAlShrouqStatus({ tracking_url: "javascript:alert(1)" }).trackingUrl).toBeNull();
    expect(normalizeAlShrouqStatus({ tracking_url: "/orders/1" }).trackingUrl).toBeNull();
    expect(normalizeAlShrouqStatus({ tracking_url: "   " }).trackingUrl).toBeNull();
  });

  it("drops a placeholder 0,0 position rather than pinning the Gulf of Guinea", () => {
    const s = normalizeAlShrouqStatus({ driver_lat: 0, driver_lng: 0 });
    expect(s.driverLat).toBeNull();
    expect(s.driverLng).toBeNull();
  });

  it("drops an out-of-range coordinate", () => {
    const s = normalizeAlShrouqStatus({ driver_lat: 999, driver_lng: 39.29 });
    expect(s.driverLat).toBeNull();
    expect(s.driverLng).toBe(39.29);
  });

  it("trims text and treats blanks as absent", () => {
    const s = normalizeAlShrouqStatus({ status_label: "  Order delivered  ", driver_name: "" });
    expect(s.statusLabel).toBe("Order delivered");
    expect(s.driverName).toBeNull();
  });

  it("survives a response that is not an object at all", () => {
    expect(normalizeAlShrouqStatus(null).statusLabel).toBeNull();
    expect(normalizeAlShrouqStatus("nope").statusLabel).toBeNull();
    expect(normalizeAlShrouqStatus([1, 2]).statusLabel).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Invalid identifiers                                                        */
/* -------------------------------------------------------------------------- */

describe("the order id is checked before anything is sent", () => {
  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["non-numeric", "abc"],
    ["path traversal", "5263/../../login"],
    ["query injection", "5263?x=1"],
    ["absurdly long", "1".repeat(40)],
  ])("refuses a %s id without making a request", async (_label, id) => {
    mockCrm(async () => jsonResponse(LIVE_RECORD));

    const result = await refreshAlShrouqOrderStatus(id);

    expect(result).toEqual({ kind: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only a plain integer id", () => {
    expect(isAlShrouqCrmOrderId("5263")).toBe(true);
    expect(isAlShrouqCrmOrderId("0")).toBe(true);
    expect(isAlShrouqCrmOrderId("52 63")).toBe(false);
    expect(isAlShrouqCrmOrderId("-1")).toBe(false);
    expect(isAlShrouqCrmOrderId(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Upstream failures                                                          */
/* -------------------------------------------------------------------------- */

describe("failures are outcomes, never exceptions", () => {
  it("reports a 404 as not_found", async () => {
    mockCrm(async () => jsonResponse({ detail: "not found" }, 404));

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "not_found" });
  });

  it("reports a 403 as forbidden", async () => {
    mockCrm(async () => jsonResponse({ detail: "forbidden" }, 403));

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "forbidden" });
  });

  it("reports a persistent 401 as forbidden, after the client's one re-login", async () => {
    mockCrm(async () => jsonResponse({ detail: "unauthorized" }, 401));

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "forbidden" });
  });

  it("reports a timeout as unavailable", async () => {
    mockCrm(async () => {
      throw abortError();
    });

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "unavailable" });
  });

  it("reports a network failure as unavailable", async () => {
    mockCrm(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "unavailable" });
  });

  it("reports an unreadable body as failed", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/login")) return jsonResponse(LOGIN_OK);
      return {
        ok: true,
        status: 200,
        text: async () => "<html>not json</html>",
      } as unknown as Response;
    });

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "failed" });
  });

  it("reports a 500 as failed", async () => {
    mockCrm(async () => jsonResponse({ detail: "boom" }, 500));

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "failed" });
  });

  it("reports missing credentials without contacting anything", async () => {
    delete process.env.SHAMS_CRM_USERNAME;
    delete process.env.SHAMS_CRM_PASSWORD;

    await expect(refreshAlShrouqOrderStatus("5263")).resolves.toEqual({ kind: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* It cannot write                                                            */
/* -------------------------------------------------------------------------- */

describe("nothing in this path can send a courier", () => {
  it.each([
    ["success", 200],
    ["not found", 404],
    ["forbidden", 403],
    ["server error", 500],
  ])("issues no POST, PUT, PATCH or DELETE on a %s", async (_label, status) => {
    mockCrm(async () => jsonResponse(status === 200 ? LIVE_RECORD : { detail: "x" }, status));

    await refreshAlShrouqOrderStatus("5263");

    for (const c of crmCalls()) {
      expect((c.init.method ?? "GET").toUpperCase()).toBe("GET");
    }
  });

  it("never touches the create or cancel endpoints", async () => {
    mockCrm(async () => jsonResponse(LIVE_RECORD));

    await refreshAlShrouqOrderStatus("5263");

    for (const c of crmCalls()) {
      expect(c.url).toContain("/refresh");
      expect(c.url).not.toMatch(/\/cancel\b/);
    }
  });

  it("imports no create transport", () => {
    // Structural, not behavioural: the guarantee is that this module cannot
    // reach the POST even by mistake, and that is a property of its imports.
    const src = readFileSync(
      fileURLToPath(new URL("../alshrouq-status.server.ts", import.meta.url)),
      "utf8",
    );
    // The import statements, not the prose: the module's own comment names the
    // create transport precisely to explain why it must not reach it.
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom "/.test(l))
      .join("\n");
    expect(imports).not.toContain("alshrouq-create.server");
    expect(imports).not.toContain("createAlshrouqOrder");
    expect(src).not.toContain('method: "POST"');
  });
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

describe("the server function's gate", () => {
  const fn = readFileSync(
    fileURLToPath(new URL("../../shams.functions.ts", import.meta.url)),
    "utf8",
  );
  /*
   * This handler only, bounded by the *next* export rather than by a named one.
   *
   * It previously ran to `alshrouqResolveDispatch`, which meant any function
   * added between the two was read as part of this one — and the assertions
   * below are about what `alshrouqOrderStatus` does, not about its neighbours.
   * `alshrouqCorrectResolution` landing in that gap is what exposed it.
   */
  const statusStart = fn.indexOf("export const alshrouqOrderStatus");
  const handler = fn.slice(statusStart, fn.indexOf("export const ", statusStart + 20));

  it("requires an authenticated session", () => {
    expect(handler).toContain("requireSupabaseAuth");
  });

  it("takes a MilaPortal dispatch id, never a raw CRM order id", () => {
    // A caller who could name a CRM id could ask about any delivery in the
    // chain. The CRM id is read from the row, on the server.
    expect(handler).toContain("z.object({ dispatchId: z.string().uuid() })");
    expect(handler).toContain('.select("id,order_id,local_id")');
  });

  it("reuses the order-action permission rule rather than inventing one", () => {
    expect(handler).toContain('_permission: "edit_all_orders"');
    expect(handler).toContain('_permission: "edit_orders"');
    expect(handler).toContain("const owns = order.agent_id === userId;");
    expect(handler).toContain(
      'if (!canAll && !(owns && canOwn)) throw new Error("Forbidden: insufficient permissions");',
    );
  });

  it("refuses before the CRM is contacted", () => {
    // The permission check must precede the import of the transport, or a
    // forbidden caller still spends a request.
    expect(handler.indexOf("Forbidden: insufficient permissions")).toBeLessThan(
      handler.indexOf("refreshAlShrouqOrderStatus"),
    );
  });

  it("reads the dispatch row through the caller's own client, so RLS applies", () => {
    expect(handler).toContain('(supabase as any)\n      .from("alshrouq_dispatches")');
    expect(handler).not.toContain("supabaseAdmin");
  });

  it("reports a dispatch with no CRM reference rather than guessing one", () => {
    expect(handler).toContain('return { kind: "no_reference" }');
    // The AlShrouq reference is a different identifier and must not be
    // substituted for the CRM's row id.
    expect(handler).not.toContain("external_order_id");
  });
});
