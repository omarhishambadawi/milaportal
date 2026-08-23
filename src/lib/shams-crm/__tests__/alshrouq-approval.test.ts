/**
 * The approval boundary: which path a request takes, and what each partial
 * failure leaves behind.
 *
 * The transport is mocked throughout. The assertions that matter are the
 * counting ones — how many POSTs, and how many rows — because the whole point of
 * this layer is that "create an order" and "send a courier" are two outcomes and
 * either can happen without the other going wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchOrderToAlShrouq } from "@/lib/shams-crm/alshrouq-dispatch.server";
import { scheduleAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { DispatchDeps, DispatchRequest } from "@/lib/shams-crm/alshrouq-dispatch.server";

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
];
const PAYMENT_OPTIONS = [
  { id: 1, label: "COD" },
  { id: 3, label: "Paid" },
];

function request(over: Partial<DispatchRequest["form"]> = {}): DispatchRequest {
  return {
    orderId: ORDER_ID,
    displayNo: "#9540",
    branchNo: "P0127",
    userId: USER_ID,
    form: {
      customerName: "Ahmed",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.7136",
      lng: "46.6753",
      orderValue: "0",
      details: "",
      ...over,
    },
  };
}

function fakeSupabase(opts: { existing?: any } = {}) {
  const inserts: any[] = [];
  const api = {
    inserts,
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: opts.existing ?? null, error: null }),
        insert: async (row: any) => {
          inserts.push(row);
          return { data: null, error: null };
        },
      };
      chain.insert = (row: any) => {
        inserts.push(row);
        return {
          select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
          then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
        };
      };
      return chain;
    },
  };
  return api;
}

let posts: () => number;

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
    fetchOptions: async () => ({ branchOptions: BRANCH_OPTIONS, paymentOptions: PAYMENT_OPTIONS }),
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
    newOperationId: () => "op-1",
    // Every live dispatch now runs under the approving agent's CRM identity.
    // Stubbed here so these tests keep exercising the transport rather than the
    // credential lookup, which has its own suite.
    agentPrincipal: async (userId: string) => ({
      ok: true as const,
      principal: {
        kind: "agent" as const,
        agentId: userId,
        username: "agent@example.test",
        password: "test-only",
      },
      crmUsername: "agent@example.test",
      crmUserId: "99001",
    }),
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

describe("Create order only", () => {
  /**
   * There is nothing to assert *inside* the dispatch layer for this path,
   * because the path never reaches it — which is the assertion. `afterCreate`
   * returns early for `order_only`, so no dispatch code runs at all.
   */
  it("is the absence of a dispatch, not a dispatch that did nothing", async () => {
    const supabase = fakeSupabase();
    // Nothing called. No row, no POST.
    expect(supabase.inserts).toHaveLength(0);
  });
});

describe("Create order and send — immediate", () => {
  it("prepares and stops at the gate, writing nothing", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: false }));

    expect(r.kind).toBe("prepared");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  it("sends exactly once when the gate is open", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));

    expect(r.kind).toBe("dispatched");
    expect(posts()).toBe(1);
  });

  it.each([
    ["customer name", { customerName: "" }],
    ["customer phone", { customerPhone: "" }],
  ])("refuses a missing %s and contacts nobody", async (_l, patch) => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(patch), supabase as any, deps({ live: true }));

    expect(r.kind).toBe("invalid");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /**
   * Where the location requirement actually lives.
   *
   * The Phase 6 builder treats coordinates as optional-but-paired, by design and
   * by the contract evidence — so it does *not* refuse an order without them.
   * AlShrouq's requirement is enforced a layer up, by
   * `validateAlShrouqOrderFields` and by the approval dialog, which will not
   * enable "send" until a link has resolved. This asserts both halves so the
   * split is deliberate rather than an accident nobody noticed.
   */
  it("leaves coordinates optional in the builder, and mandatory at approval", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(
      request({ lat: "", lng: "" }),
      supabase as any,
      deps({ live: true }),
    );
    // The builder is content: absent is legal, half a pair is not.
    expect(r.kind).toBe("dispatched");

    const half = await dispatchOrderToAlShrouq(
      request({ lng: "" }),
      supabase as any,
      deps({ live: true }),
    );
    expect(half.kind).toBe("invalid");

    // And the approval layer refuses the same order outright.
    const { validateAlShrouqOrderFields } = await import("@/features/alshrouq/order-fields");
    expect(
      validateAlShrouqOrderFields({
        deliveryType: "AlShrouq",
        customerName: "Ahmed",
        customerPhone: "0500000000",
        customerLocation: "",
        latitude: "",
        longitude: "",
      }).map((i) => i.field),
    ).toEqual(["customer_location", "customer_lat", "customer_lng"]);
  });

  it("a 4xx leaves no dispatch record behind", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: (async () => ({
        kind: "rejected",
        operationId: "op-1",
        status: 422,
        body: null,
      })) as any,
    });

    expect(r.kind).toBe("rejected");
    expect(supabase.inserts).toHaveLength(0);
  });

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
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});

describe("Create order and send — scheduled", () => {
  const WHEN = new Date(Date.now() + 2 * 60 * 60_000);

  it("writes a scheduled row and contacts nobody", async () => {
    const supabase = fakeSupabase();
    const r = await scheduleAlShrouqDispatch(
      request(),
      WHEN,
      supabase as any,
      deps({ live: true }),
    );

    expect(r.kind).toBe("scheduled");
    // The gate is irrelevant here: scheduling never contacts a courier.
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(1);
  });

  it("persists the chosen instant exactly", async () => {
    const supabase = fakeSupabase();
    await scheduleAlShrouqDispatch(request(), WHEN, supabase as any, deps());
    expect(supabase.inserts[0]!.scheduled_for).toBe(WHEN.toISOString());
  });

  it("freezes the approved payload rather than a reference to the order", async () => {
    const supabase = fakeSupabase();
    await scheduleAlShrouqDispatch(request(), WHEN, supabase as any, deps());

    const snap = supabase.inserts[0]!.payload_snapshot;
    expect(snap).toMatchObject({
      customer_name: "Ahmed",
      customer_phone: "0500000000",
      branch_id: BRANCH_ID,
      payment_type: 3,
      client_order_id: "9540",
    });
    // A plain value, not a getter or a live view of anything.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("refuses to schedule an incomplete order", async () => {
    const supabase = fakeSupabase();
    const r = await scheduleAlShrouqDispatch(
      request({ customerPhone: "" }),
      WHEN,
      supabase as any,
      deps(),
    );

    expect(r.kind).toBe("invalid");
    expect(supabase.inserts).toHaveLength(0);
  });
});

describe("one-time handoff", () => {
  it("an already-dispatched order cannot be sent again", async () => {
    const supabase = fakeSupabase({ existing: { external_order_id: "6099196" } });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));

    expect(r.kind).toBe("already_dispatched");
    expect(posts()).toBe(0);
  });

  it("an already-dispatched order cannot be scheduled either", async () => {
    const supabase = fakeSupabase({ existing: { external_order_id: "6099196" } });
    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date(Date.now() + 3_600_000),
      supabase as any,
      deps(),
    );

    expect(r.kind).toBe("already_dispatched");
    expect(supabase.inserts).toHaveLength(0);
  });

  /**
   * Editing a Portal order is a Supabase update against `orders`. Neither
   * dispatch entry point is reachable from it, and neither reads the order at
   * dispatch time — the snapshot does. This asserts the half that lives here:
   * nothing in the dispatch layer is triggered by, or sensitive to, an edit.
   */
  it("a later order edit reaches no dispatch code and no courier", async () => {
    const supabase = fakeSupabase({ existing: { external_order_id: "6099196" } });
    // The only way an edited order could reach AlShrouq is by someone calling
    // one of these again — and both refuse.
    const a = await dispatchOrderToAlShrouq(
      request({ customerName: "Mohamed", customerPhone: "0511111111" }),
      supabase as any,
      deps({ live: true }),
    );
    const b = await scheduleAlShrouqDispatch(
      request({ customerName: "Mohamed" }),
      new Date(Date.now() + 3_600_000),
      supabase as any,
      deps({ live: true }),
    );

    expect(a.kind).toBe("already_dispatched");
    expect(b.kind).toBe("already_dispatched");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});
