/**
 * The dispatch service.
 *
 * The transport is mocked in every test — nothing here can reach the real create
 * endpoint. The assertions that matter most are the counting ones: `posts()` is
 * 0 for every dry-run test and never above 1 anywhere, because one dispatch is
 * one POST and a closed gate is no POST at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchOrderToAlShrouq,
  isAlShrouqLiveDispatchEnabled,
  type DispatchDeps,
  type DispatchFormInput,
} from "@/lib/shams-crm/alshrouq-dispatch.server";

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";
const BRANCH_ID = "9999927657247";

const BRANCH_OPTIONS = [
  {
    id: BRANCH_ID,
    internal_code: "P0127",
    branch_name: "Al Yasmin",
    label: "P0127 | Al Yasmin",
    covered: true,
    note: null,
  },
  {
    id: "9999927657127",
    internal_code: "P0007",
    branch_name: "Not Covered",
    label: "P0007 | Not Covered",
    covered: false,
    note: "Not Covered",
  },
];

const PAYMENT_OPTIONS = [
  { id: 1, label: "COD" },
  { id: 2, label: "SPAN Machine" },
  { id: 3, label: "Paid" },
  { id: 4, label: "AlshrouqPay" },
];

function form(over: Partial<DispatchFormInput> = {}): DispatchFormInput {
  return {
    customerName: "Test Customer",
    customerPhone: "0500798930",
    paymentType: "3",
    mapUrl: "https://maps.app.goo.gl/abc123",
    lat: "",
    lng: "",
    orderValue: "0",
    details: "",
    ...over,
  };
}

function request(over: Partial<Parameters<typeof dispatchOrderToAlShrouq>[0]> = {}) {
  return {
    orderId: ORDER_ID,
    displayNo: "#9540",
    branchNo: "P0127",
    userId: USER_ID,
    form: form(),
    ...over,
  };
}

/** A Supabase stand-in: records inserts, answers the live-dispatch lookup. */
function fakeSupabase(opts: { existing?: Record<string, unknown> | null; insertError?: any } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const api = {
    inserts,
    from(table: string) {
      if (table !== "alshrouq_dispatches") throw new Error(`unexpected table ${table}`);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: opts.existing ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return {
            select: () => ({
              maybeSingle: async () =>
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : { data: { ...row, dispatched_at: "2026-08-21T10:00:00Z" }, error: null },
            }),
          };
        },
      };
      return chain;
    },
  };
  return api;
}

let posts: () => number;

/** Deps with a mocked transport. `live` opens the gate; it defaults closed. */
function deps(over: Partial<DispatchDeps> & { live?: boolean } = {}): Partial<DispatchDeps> {
  const createOrder = vi.fn(async () => ({
    kind: "accepted" as const,
    operationId: "op-1",
    status: 201,
    body: null,
  }));
  posts = () => createOrder.mock.calls.length;
  const { live, ...rest } = over;
  return {
    fetchOptions: async () => ({
      branchOptions: BRANCH_OPTIONS,
      paymentOptions: PAYMENT_OPTIONS,
    }),
    createOrder: createOrder as any,
    reconcile: async () => null,
    newOperationId: () => "op-1",
    liveEnabled: () => live === true,
    ...rest,
  };
}

beforeEach(() => {
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});

describe("isAlShrouqLiveDispatchEnabled — the safety gate", () => {
  it("is off when unset", () => {
    expect(isAlShrouqLiveDispatchEnabled()).toBe(false);
  });

  it('is off for anything that is not exactly "true"', () => {
    for (const v of ["", "false", "1", "TRUE", "True", "yes", "on"]) {
      process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED = v;
      expect(isAlShrouqLiveDispatchEnabled()).toBe(false);
    }
  });

  it("is on only for the exact string", () => {
    process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED = "true";
    expect(isAlShrouqLiveDispatchEnabled()).toBe(true);
  });
});

describe("dispatchOrderToAlShrouq — validation", () => {
  it.each([
    ["customer name", { customerName: "  " }, "customer_name"],
    ["customer phone", { customerPhone: "" }, "customer_phone"],
    ["payment type", { paymentType: "" }, "payment_type"],
    ["order value", { orderValue: "" }, "order_value"],
  ])("refuses a missing %s without sending", async (_label, patch, field) => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form(patch) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") throw new Error("unreachable");
    expect(r.errors.map((e) => e.field)).toContain(field);
    expect(posts()).toBe(0);
  });

  it("refuses a payment type the CRM does not offer", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form({ paymentType: "99" }) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("invalid");
    expect(posts()).toBe(0);
  });

  it("accepts an order value of zero", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form({ orderValue: "0" }) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.payload.orderValue).toBe(0);
  });
});

describe("dispatchOrderToAlShrouq — branch", () => {
  it("prepares a covered branch", async () => {
    const r = await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, deps());
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.payload.branchId).toBe(BRANCH_ID);
    expect(r.payload.clientOrderId).toBe("9540");
  });

  it("refuses an uncovered branch without sending", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ branchNo: "P0007" }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("branch_unresolved");
    if (r.kind !== "branch_unresolved") throw new Error("unreachable");
    expect(r.branch.kind).toBe("not_covered");
    expect(posts()).toBe(0);
  });

  it("refuses an unknown branch without sending", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ branchNo: "P9999" }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("branch_unresolved");
    expect(posts()).toBe(0);
  });

  it("reports an unreachable CRM as its own outcome", async () => {
    const r = await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, {
      ...deps(),
      fetchOptions: async () => {
        throw new Error("down");
      },
    });
    expect(r.kind).toBe("options_unavailable");
    expect(posts()).toBe(0);
  });
});

describe("dispatchOrderToAlShrouq — duplicate protection", () => {
  it("returns the existing dispatch and prepares nothing new", async () => {
    const supabase = fakeSupabase({
      existing: { external_order_id: "6099196", status: "Order Created", local_id: "5263" },
    });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));

    expect(r.kind).toBe("already_dispatched");
    if (r.kind !== "already_dispatched") throw new Error("unreachable");
    expect(r.dispatch.externalOrderId).toBe("6099196");
    // Checked before anything is built or sent, even with the gate open.
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  it("proceeds when there is no active dispatch", async () => {
    const r = await dispatchOrderToAlShrouq(
      request(),
      fakeSupabase({ existing: null }) as any,
      deps(),
    );
    expect(r.kind).toBe("prepared");
  });

  it("treats a unique violation as the other request having won", async () => {
    const supabase = fakeSupabase({ insertError: { code: "23505" } });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));
    // The index is the backstop; the agent is told it is already sent, not
    // shown a database error.
    expect(r.kind).toBe("already_dispatched");
    expect(posts()).toBe(1);
  });
});

describe("dispatchOrderToAlShrouq — the safety gate", () => {
  it("with the gate closed: no POST, no persistence, no fake reference", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps());

    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.liveDispatchEnabled).toBe(false);
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
    // Nothing in the result may look like an external order.
    expect(JSON.stringify(r)).not.toContain("external");
  });

  it("the gate is read from the environment, never from the request", async () => {
    // There is no field to pass. This is the whole protection: a caller cannot
    // express "dispatch for real", only the deployment can.
    expect(Object.keys(request())).not.toContain("live");
    process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED = "true";
    const supabase = fakeSupabase();
    // Default deps read the env; the mocked transport still stands in for it.
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(),
      liveEnabled: isAlShrouqLiveDispatchEnabled,
    });
    expect(r.kind).not.toBe("prepared");
    expect(posts()).toBe(1);
  });
});

describe("dispatchOrderToAlShrouq — live path (mocked transport)", () => {
  it("takes the reference from the GET, never from the POST body", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      // A POST body that claims an id — it must be ignored.
      createOrder: (async () => ({
        kind: "accepted",
        operationId: "op-1",
        status: 201,
        body: { external_order_id: 111111, id: 222222 },
      })) as any,
      reconcile: async () =>
        ({
          id: 5263,
          externalOrderId: 6099196,
          clientOrderId: "9540",
          branchId: BRANCH_ID,
          paymentType: 3,
          orderValue: 0,
          preparationTime: null,
          statusId: "23",
          statusLabel: "Order Created",
          isCancelled: false,
          trackingUrl: "https://alshrouqdelivery.com/tracking/abc",
          createdAt: null,
          updatedAt: null,
        }) as any,
    });

    expect(r.kind).toBe("dispatched");
    if (r.kind !== "dispatched") throw new Error("unreachable");
    expect(r.dispatch.externalOrderId).toBe("6099196");
    expect(r.dispatch.localId).toBe("5263");
    // The POST body claimed 111111/222222. Neither reaches the record: the
    // reference is whatever the GET said.
    expect(supabase.inserts[0]!.external_order_id).toBe("6099196");
    expect(supabase.inserts[0]!.local_id).toBe("5263");
  });

  it("records the authenticated agent, never a hardcoded one", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));
    expect(supabase.inserts[0]!.dispatched_by).toBe(USER_ID);
  });

  it("a 4xx rejection persists nothing", async () => {
    const supabase = fakeSupabase();
    const createOrder = vi.fn(async () => ({
      kind: "rejected" as const,
      operationId: "op-1",
      status: 422,
      body: null,
    }));
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });
    expect(r.kind).toBe("rejected");
    expect(supabase.inserts).toHaveLength(0);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  /** The rule that stops a second driver. */
  it("an indeterminate result never issues a second POST", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "unknown",
    }));
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
      reconcile: async () => null,
    });

    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") throw new Error("unreachable");
    expect(r.reconciled).toBeNull();
    expect(createOrder).toHaveBeenCalledTimes(1);

    /*
     * Not found means "still unknown", never "safe to send again" — and that is
     * now enforced by a row rather than by hope.
     *
     * This assertion used to be `inserts).toHaveLength(0)`, on the reasoning
     * that a record must not claim a courier that may not exist. It does not
     * claim one: it records `indeterminate`, with no reference, no tracking and
     * no `accepted` anywhere. What it does is take the order's slot in
     * `alshrouq_dispatches_live_order_key`, which is what makes the next attempt
     * come back `already_dispatched` instead of POSTing again. Writing nothing
     * left an order that had already been transmitted looking untouched.
     */
    expect(supabase.inserts).toHaveLength(1);
    const row = supabase.inserts[0] as Record<string, unknown>;
    expect(row.dispatch_status).toBe("indeterminate");
    expect(row.last_error).toBe("unknown");
    expect(row.attempt_count).toBe(1);
    // No evidence was invented for a send nobody could confirm.
    expect(row.external_order_id).toBeNull();
    expect(row.local_id).toBeNull();
    expect(row.tracking_url).toBeNull();
    expect(row.status).toBeNull();
    // And the caller is handed the row, so the page can stop offering to send.
    expect(r.dispatch).not.toBeNull();
  });

  it("an indeterminate result that reconciles is treated as dispatched, not resent", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "server_error",
      message: "unknown",
    }));
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
      reconcile: async () =>
        ({
          id: 5263,
          externalOrderId: 6099196,
          clientOrderId: "9540",
          statusLabel: "Order Created",
          trackingUrl: null,
          isCancelled: false,
        }) as any,
    });

    expect(r.kind).toBe("dispatched");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});
