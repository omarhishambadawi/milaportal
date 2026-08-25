/**
 * Scheduled AlShrouq dispatch.
 *
 * The transport is mocked in every test — nothing here can reach the real create
 * endpoint. The assertions that matter are the counting ones: how many POSTs a
 * run makes, and whether the worker ever reads the `orders` table (it must not:
 * the snapshot is the authority).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runDueAlShrouqDispatches,
  scheduleAlShrouqDispatch,
} from "@/lib/shams-crm/alshrouq-scheduler.server";
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

const SNAPSHOT = {
  branch_id: BRANCH_ID,
  client_order_id: "9540",
  customer_name: "Ahmed",
  customer_phone: "0500000000",
  payment_type: 3,
  order_value: 0,
  customer_address: "https://maps.app.goo.gl/AAA",
  customer_lat: 24.7,
  customer_lng: 46.6,
};

function request(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    orderId: ORDER_ID,
    displayNo: "#9540",
    branchNo: "P0127",
    userId: USER_ID,
    // The agent dispatching their own order: assignee and caller are one person.
    orderAgentId: USER_ID,
    form: {
      customerName: "Ahmed",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.7",
      lng: "46.6",
      orderValue: "0",
      details: "",
    },
    ...over,
  };
}

/**
 * A Supabase stand-in.
 *
 * `tablesRead` records every table touched, which is how the tests prove the
 * worker never consults `orders`.
 */
function fakeSupabase(
  opts: {
    due?: any[];
    existing?: any;
    insertError?: any;
    claimFails?: boolean;
    /** Rows the reap sweep finds still claimed past the stale cutoff. */
    stale?: any[];
  } = {},
) {
  const inserts: any[] = [];
  const updates: { id: string; patch: any }[] = [];
  const tablesRead: string[] = [];
  let claimed = false;

  const api = {
    inserts,
    updates,
    tablesRead,
    from(table: string) {
      tablesRead.push(table);
      const state: any = { patch: null, eqs: {} as Record<string, unknown> };
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: unknown) => {
          state.eqs[col] = v;
          return chain;
        },
        is: () => chain,
        lte: () => chain,
        /**
         * Only the reap sweep filters on `<`, so this is what identifies it.
         *
         * It is answered with `opts.stale` rather than with the due list: the
         * sweep and the due query look at disjoint states, and a fake that let
         * one answer for the other would let a broken reap look like a working
         * one.
         */
        lt: () => {
          chain.then = (res: any) => {
            const rows = opts.stale ?? [];
            for (const row of rows) updates.push({ id: row.id, patch: state.patch });
            return Promise.resolve({ data: rows, error: null }).then(res);
          };
          return chain;
        },
        limit: async () => ({ data: opts.due ?? [], error: null }),
        maybeSingle: async () => {
          if (state.patch) {
            // A claim attempt.
            if (opts.claimFails || claimed) return { data: null, error: null };
            claimed = true;
            updates.push({ id: state.eqs.id as string, patch: state.patch });
            return { data: { id: state.eqs.id }, error: null };
          }
          return { data: opts.existing ?? null, error: null };
        },
        update: (patch: any) => {
          state.patch = patch;
          // Terminal updates (no .select()) resolve as a thenable.
          chain.then = (res: any) => {
            updates.push({ id: state.eqs.id as string, patch });
            return Promise.resolve({ data: null, error: null }).then(res);
          };
          return chain;
        },
        insert: async (row: any) => {
          inserts.push(row);
          return { data: null, error: opts.insertError ?? null };
        },
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
    fetchOptions: async () => ({
      branchOptions: BRANCH_OPTIONS,
      paymentOptions: PAYMENT_OPTIONS,
    }),
    createOrder: createOrder as any,
    reconcile: async () =>
      ({
        id: 5263,
        externalOrderId: 6099196,
        clientOrderId: "9540",
        statusLabel: "Order Created",
        trackingUrl: "https://alshrouqdelivery.com/tracking/abc",
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

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: "dispatch-1",
    order_id: ORDER_ID,
    client_order_id: "9540",
    payload_snapshot: SNAPSHOT,
    scheduled_for: "2026-08-21T18:00:00Z",
    // The approving agent. The worker sends under *their* CRM identity, so a
    // due row without one is blocked rather than sent by somebody else.
    scheduled_by: "99999999-8888-7777-6666-555555555555",
    ...over,
  };
}

beforeEach(() => {
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});

describe("scheduleAlShrouqDispatch", () => {
  it("parks the dispatch with an immutable snapshot and sends nothing", async () => {
    const supabase = fakeSupabase();
    const when = new Date("2026-08-21T20:30:00Z");
    const r = await scheduleAlShrouqDispatch(request(), when, supabase as any, deps());

    expect(r.kind).toBe("scheduled");
    expect(posts()).toBe(0);

    const row = supabase.inserts[0]!;
    expect(row.dispatch_status).toBe("scheduled");
    expect(row.scheduled_for).toBe(when.toISOString());
    expect(row.scheduled_by).toBe(USER_ID);
    // The whole point: the approved payload, frozen.
    expect(row.payload_snapshot).toMatchObject({
      client_order_id: "9540",
      customer_name: "Ahmed",
      customer_phone: "0500000000",
      branch_id: BRANCH_ID,
      payment_type: 3,
    });
  });

  it("validates now, so a bad order is refused at approval rather than at 2am", async () => {
    const supabase = fakeSupabase();
    const r = await scheduleAlShrouqDispatch(
      request({ form: { ...request().form, customerPhone: "" } }),
      new Date("2026-08-21T20:30:00Z"),
      supabase as any,
      deps(),
    );

    expect(r.kind).toBe("invalid");
    expect(supabase.inserts).toHaveLength(0);
    expect(posts()).toBe(0);
  });

  it("refuses to schedule an order that already has a live dispatch", async () => {
    const supabase = fakeSupabase({ existing: { external_order_id: "6099196" } });
    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date("2026-08-21T20:30:00Z"),
      supabase as any,
      deps(),
    );

    expect(r.kind).toBe("already_dispatched");
    expect(supabase.inserts).toHaveLength(0);
  });

  it("treats a unique violation as the order already being spoken for", async () => {
    const supabase = fakeSupabase({ insertError: { code: "23505" } });
    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date("2026-08-21T20:30:00Z"),
      supabase as any,
      deps(),
    );
    expect(r.kind).toBe("already_dispatched");
  });
});

describe("runDueAlShrouqDispatches", () => {
  it("does nothing when nothing is due", async () => {
    const supabase = fakeSupabase({ due: [] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(s).toMatchObject({ due: 0, claimed: 0, accepted: 0 });
    expect(posts()).toBe(0);
  });

  /**
   * The gate, checked before anything is claimed. A scheduled order that
   * reported "sent" while the gate was shut would be the worst possible failure.
   */
  it("with the gate closed: claims nothing, sends nothing, invents no status", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: false }));

    expect(s.due).toBe(1);
    expect(s.skippedDisabled).toBe(1);
    expect(s.claimed).toBe(0);
    expect(s.accepted).toBe(0);
    expect(posts()).toBe(0);
    expect(supabase.updates).toHaveLength(0);
  });

  it("dispatches a due row from its snapshot and records the reconciled reference", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(s).toMatchObject({ due: 1, claimed: 1, accepted: 1 });
    expect(posts()).toBe(1);

    const final = supabase.updates.at(-1)!.patch;
    expect(final.dispatch_status).toBe("accepted");
    expect(final.external_order_id).toBe("6099196");
    expect(final.tracking_url).toBe("https://alshrouqdelivery.com/tracking/abc");
  });

  /**
   * The immutability guarantee, stated as a fact about which tables are read.
   * If the worker ever consulted `orders`, a later edit could change what a
   * courier is told.
   */
  it("never reads the orders table", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(supabase.tablesRead).not.toContain("orders");
    expect(new Set(supabase.tablesRead)).toEqual(new Set(["alshrouq_dispatches"]));
  });

  it("sends exactly what the snapshot holds, not the current order", async () => {
    const seen: unknown[] = [];
    const createOrder = vi.fn(async (payload: unknown) => {
      seen.push(payload);
      return { kind: "accepted" as const, operationId: "op-1", status: 201, body: null };
    });
    const supabase = fakeSupabase({ due: [dueRow()] });
    await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(SNAPSHOT);
  });

  it("is idempotent — a second concurrent run claims nothing", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));
    // The fake refuses a second claim of the same row, as the compare-and-swap
    // would.
    const second = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(second.claimed).toBe(0);
    expect(second.accepted).toBe(0);
    expect(posts()).toBe(0);
  });

  it("a row it cannot claim is left entirely alone", async () => {
    const supabase = fakeSupabase({ due: [dueRow()], claimFails: true });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(s.claimed).toBe(0);
    expect(posts()).toBe(0);
  });

  it("refuses to invent a payload when the snapshot is missing", async () => {
    const supabase = fakeSupabase({ due: [dueRow({ payload_snapshot: null })] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(s.failed).toBe(1);
    // Never rebuilt from the order.
    expect(posts()).toBe(0);
    expect(supabase.updates.at(-1)!.patch.dispatch_status).toBe("failed");
  });

  it("records a 4xx as failed without a second POST", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "rejected" as const,
      operationId: "op-1",
      status: 422,
      body: null,
    }));
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
      // A refusal with nothing on the CRM's side is a real refusal.
      reconcile: async () => null,
    });

    expect(s.failed).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(supabase.updates.at(-1)!.patch.dispatch_status).toBe("failed");
  });

  /**
   * The "already booked" case — the one an idempotent scheduler must not get
   * wrong. A repeat of a create is refused because the reference already
   * exists, and the delivery it names is this row's own.
   */
  it("a 4xx whose delivery already exists is recorded as accepted, not failed", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "rejected" as const,
      operationId: "op-1",
      status: 409,
      body: null,
    }));
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });

    expect(s.failed).toBe(0);
    expect(s.accepted).toBe(1);
    // Still exactly one POST. The evidence came from a GET.
    expect(createOrder).toHaveBeenCalledTimes(1);
    const patch = supabase.updates.at(-1)!.patch;
    expect(patch.dispatch_status).toBe("accepted");
    expect(patch.external_order_id).toBe("6099196");
  });

  /**
   * A claim that outlived the run that made it.
   *
   * `processing` had no exit: the due query looks only for `scheduled` and
   * cancellation refuses everything but `scheduled`, so a row left claimed by a
   * killed run was stuck and invisible forever.
   */
  it("settles an abandoned claim as indeterminate rather than resending it", async () => {
    const supabase = fakeSupabase({ stale: [{ id: "stuck-1" }] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(s.reaped).toBe(1);
    // Never re-sent. `indeterminate` is the whole point: it may already have
    // reached a courier, so a second POST is exactly what must not happen.
    expect(posts()).toBe(0);
    const patch = supabase.updates.find((u) => u.id === "stuck-1")!.patch;
    expect(patch.dispatch_status).toBe("indeterminate");
    expect(patch.last_error).toMatch(/NOT been sent again/);
  });

  /**
   * Reaping is not dispatching, so the safety gate has no say in it. A
   * deployment with live dispatch switched off must still not accumulate rows
   * stuck in a claim nothing can clear.
   */
  it("settles abandoned claims even while live dispatch is switched off", async () => {
    const supabase = fakeSupabase({ stale: [{ id: "stuck-2" }] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: false }));

    expect(s.reaped).toBe(1);
    expect(posts()).toBe(0);
  });

  /**
   * The poll writes onto a row it could not act on — "the scheduler is not
   * connected" — so the agent is told why a finished countdown produced
   * nothing. Once a worker has the row that sentence is false.
   */
  it("clears the poll's stall note when it claims a row", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    const claim = supabase.updates.find((u) => u.patch.dispatch_status === "processing")!;
    expect(claim.patch.last_error).toBeNull();
  });

  /** The rule that stops a second driver when nobody is watching. */
  it("an indeterminate result that reconciles nothing never re-POSTs", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "unknown",
    }));
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
      reconcile: async () => null,
    });

    expect(s.indeterminate).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(supabase.updates.at(-1)!.patch.dispatch_status).toBe("indeterminate");
  });

  it("an indeterminate result that reconciles is accepted, not resent", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "server_error",
      message: "unknown",
    }));
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });

    expect(s.accepted).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(supabase.updates.at(-1)!.patch.external_order_id).toBe("6099196");
  });

  it("leaks no customer detail into the run summary", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("Ahmed");
    expect(serialized).not.toContain("0500000000");
    expect(serialized).not.toContain("maps.app.goo.gl");
  });
});
