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
  classifyDispatchFailure,
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
    /**
     * What the live-dispatch lookup finds *after* an insert has been attempted.
     *
     * The duplicate check and the post-conflict read are the same query against
     * the same fake, and they must be able to disagree: "nothing live when we
     * looked, something live by the time we wrote" is exactly the race the
     * unique index exists for, and a fake that cannot express it cannot tell
     * that race apart from a collision with a row that is not live at all.
     */
    existingAfterInsert?: any;
    insertError?: any;
    claimFails?: boolean;
    /** Rows the reap sweep finds still claimed past the stale cutoff. */
    stale?: any[];
  } = {},
) {
  const inserts: any[] = [];
  const updates: { id: string; patch: any }[] = [];
  const tablesRead: string[] = [];
  /**
   * Which rows have already been claimed, by id.
   *
   * A set rather than a flag because a batch has several rows: the
   * compare-and-swap refuses a *second* claim of the *same* row, and a fake
   * that refused the second claim of any row could not tell batch isolation
   * working from batch isolation broken.
   */
  const claimedIds = new Set<string>();
  let inserted = false;

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
        order: () => chain,
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
            const id = state.eqs.id as string;
            if (opts.claimFails || claimedIds.has(id)) return { data: null, error: null };
            claimedIds.add(id);
            updates.push({ id, patch: state.patch });
            return { data: { id }, error: null };
          }
          if (inserted && opts.existingAfterInsert !== undefined) {
            return { data: opts.existingAfterInsert, error: null };
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
          inserted = true;
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
    const supabase = fakeSupabase({
      insertError: { code: "23505" },
      // The row that won the race, found by the read that follows the conflict.
      existingAfterInsert: { external_order_id: "6099196" },
    });
    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date("2026-08-21T20:30:00Z"),
      supabase as any,
      deps(),
    );
    expect(r.kind).toBe("already_dispatched");
  });

  /**
   * The cancel-and-reschedule case, from the reported incident.
   *
   * A collision that leaves **no live row** is not "already dispatched": there
   * is nothing there, and saying so would show the agent a delivery that does
   * not exist while quietly declining to schedule the one they asked for. It is
   * a failed save, and it says so.
   *
   * With `20260901130000` applied it does not happen at all — the identity index
   * is scoped to live rows, so cancelled history no longer collides — but the
   * honest report is what stops a future constraint from lying on its behalf.
   */
  it("does not report a dispatch that is not there when the collision is not a live row", async () => {
    const supabase = fakeSupabase({ insertError: { code: "23505" } });
    await expect(
      scheduleAlShrouqDispatch(
        request(),
        new Date("2026-08-21T20:30:00Z"),
        supabase as any,
        deps(),
      ),
    ).rejects.toThrow("The scheduled dispatch could not be saved.");
  });

  /**
   * The acceptance criterion, end to end: cancelled history does not block a
   * fresh schedule for the same order.
   *
   * `existing: null` is what the database reports once the previous row carries
   * `cancelled_at` — both unique indexes are partial on `cancelled_at IS NULL`,
   * so a cancelled row is invisible to the duplicate check and to the
   * constraint alike. The new row is written and carries its own snapshot.
   */
  it("schedules again after the previous dispatch was cancelled", async () => {
    const supabase = fakeSupabase({ existing: null });
    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date("2026-08-21T20:30:00Z"),
      supabase as any,
      deps(),
    );

    expect(r.kind).toBe("scheduled");
    expect(supabase.inserts).toHaveLength(1);
    // The same identity as the cancelled one, deliberately: it is derived from
    // the order and is never invented per attempt.
    expect(supabase.inserts[0].client_order_id).toBe("9540");
    expect(supabase.inserts[0].dispatch_status).toBe("scheduled");
    expect(posts()).toBe(0);
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

/* -------------------------------------------------------------------------- */
/* The 2026-09-12 incident: a failure before the POST                          */
/* -------------------------------------------------------------------------- */

/**
 * The scheduled-dispatch endpoint answered pg_cron with a 500 every minute for
 * about a quarter of an hour, and deliveries whose time had come did not go out.
 *
 * The cause was not the cron, the due query or the claim. It was that
 * `createAlshrouqOrder` **throws** for everything that fails before the POST is
 * transmitted — a refused CRM login, an unreachable CRM, a login timeout — and
 * nothing in the worker caught it. One throw aborted the whole batch, escaped to
 * the route as a 500, and left the row it had just claimed sitting in
 * `processing`, where the only thing that could reach it was the fifteen-minute
 * reaper, which settles it as `indeterminate` for a person to ring the courier
 * about. A delivery that had never been sent to anybody.
 *
 * Every test below is one sentence of that, inverted.
 */
describe("a failure before anything is transmitted", () => {
  /** `createAlshrouqOrder`'s own contract: it throws only when nothing was sent. */
  function throwsBeforeSending(kind: string, httpStatus: number | null = null) {
    return vi.fn(async () => {
      const err = new Error("upstream") as Error & {
        kind: string;
        httpStatus: number | null;
      };
      err.name = "ShamsCrmError";
      err.kind = kind;
      err.httpStatus = httpStatus;
      throw err;
    });
  }

  /**
   * The headline. The delivery stays recoverable instead of being stranded.
   */
  it("puts the row back to scheduled rather than stranding it in processing", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: throwsBeforeSending("unavailable") as any,
    });

    expect(s.retryable).toBe(1);
    expect(s.claimed).toBe(1);
    expect(s.accepted).toBe(0);
    expect(s.indeterminate).toBe(0);

    const final = supabase.updates.at(-1)!.patch;
    // Back where it started, so the next poll finds it — not `processing`, not
    // `indeterminate`, and above all not `accepted`.
    expect(final.dispatch_status).toBe("scheduled");
    expect(final.last_error).toMatch(/still scheduled and will be tried again/);
    expect(final.attempt_count).toBe(1);
  });

  /** The run answers pg_cron normally. A 500 a minute was the visible symptom. */
  it("does not throw out of the run", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    await expect(
      runDueAlShrouqDispatches(supabase as any, {
        ...deps({ live: true }),
        createOrder: throwsBeforeSending("timeout") as any,
      }),
    ).resolves.toMatchObject({ retryable: 1 });
  });

  /**
   * Batch isolation. One unreachable delivery used to take the rest of the
   * minute's work down with it.
   */
  it("one failing delivery does not stop the others", async () => {
    const createOrder = vi.fn(async (payload: any) => {
      if (payload.client_order_id === "bad") {
        const err = new Error("upstream") as Error & { kind: string };
        err.name = "ShamsCrmError";
        err.kind = "unavailable";
        throw err;
      }
      return { kind: "accepted" as const, operationId: "op-1", status: 201, body: null };
    });

    const supabase = fakeSupabase({
      due: [
        dueRow({
          id: "bad-1",
          client_order_id: "bad",
          payload_snapshot: { ...SNAPSHOT, client_order_id: "bad" },
        }),
        dueRow({ id: "good-1" }),
        dueRow({ id: "good-2" }),
      ],
    });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });

    expect(s.claimed).toBe(3);
    expect(s.retryable).toBe(1);
    expect(s.accepted).toBe(2);
    // The two healthy deliveries went out in the same run as the broken one.
    expect(createOrder).toHaveBeenCalledTimes(3);
  });

  /**
   * The failure is named, so the production alert is not just "500".
   *
   * A 401 on the login is the agent's credential being refused and needs a
   * person; anything else on the login is the CRM having a bad time and does
   * not. Telling an administrator to re-enter a password that is perfectly
   * correct is the wrong answer to a 502.
   */
  it.each([
    ["auth_failed", 401, "authentication", false],
    ["auth_failed", 403, "authentication", false],
    // A transport that has not narrowed `auth_failed` — which is what the CRM's
    // 426 version gate arrived through on 2026-09-10.
    ["auth_failed", 502, "upstream", true],
    // What that same gate is called now. Its fix is a deployment, not a
    // password, so it is neither `authentication` nor retryable.
    ["incompatible_client", 426, "incompatible_client", false],
    ["not_configured", null, "configuration", false],
    ["timeout", null, "timeout", true],
    ["unavailable", null, "upstream", true],
    ["http_error", 500, "upstream", true],
    ["malformed", 200, "upstream", true],
  ])("classifies %s/%s as %s", async (kind, status, category, retryable) => {
    const failure = classifyDispatchFailure(
      Object.assign(new Error("x"), { kind, httpStatus: status }),
    );
    expect(failure.category).toBe(category);
    expect(failure.retryable).toBe(retryable);
  });

  /** A Postgres SQLSTATE is a database fault, not an upstream one. */
  it("tells a database fault apart from an upstream one", () => {
    const failure = classifyDispatchFailure(
      Object.assign(new Error("could not connect"), { code: "08006" }),
    );
    expect(failure.category).toBe("database");
    expect(failure.retryable).toBe(true);
  });

  /** A classification is a category, never the upstream's own words. */
  it("never copies the upstream message into what it stores", () => {
    const failure = classifyDispatchFailure(
      Object.assign(new Error("login failed for ahmed@example.test / hunter2"), {
        kind: "auth_failed",
        httpStatus: 401,
      }),
    );
    expect(failure.message).not.toContain("hunter2");
    expect(failure.message).not.toContain("ahmed@example.test");
  });

  /** A refused credential is an administrator's problem, counted as such. */
  it("counts a refused sign-in as blocked, not as a transient retry", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: throwsBeforeSending("auth_failed", 401) as any,
    });

    expect(s.blocked).toBe(1);
    expect(s.retryable).toBe(0);
    expect(supabase.updates.at(-1)!.patch.dispatch_status).toBe("scheduled");
  });

  /**
   * The 2026-09-10 outage's own shape, as the transport now reports it.
   *
   * The CRM's minimum-client-version gate answers 426 before it looks at the
   * credentials. `login()` reads the published floor and retries once, so
   * reaching the worker means even that failed — the delivery waits for a
   * deployment, and says so, rather than telling anyone to change a password.
   */
  it("survives the CRM refusing the client version", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: throwsBeforeSending("incompatible_client", 426) as any,
    });

    expect(s.blocked).toBe(1);
    expect(s.indeterminate).toBe(0);
    const final = supabase.updates.at(-1)!.patch;
    // Recoverable: the delivery is still scheduled, and goes out on the first
    // run after the Portal is updated.
    expect(final.dispatch_status).toBe("scheduled");
    expect(final.last_error).toMatch(/refused this version of the Portal/);
    expect(final.last_error).not.toMatch(/credentials/);
  });

  /**
   * The one case that must NOT be released.
   *
   * The POST was made; only writing down what came back failed. Releasing the
   * row here would re-POST a delivery that may already have a driver, so it
   * stays claimed for the reaper to settle as `indeterminate`.
   */
  it("leaves a row claimed when the POST happened and the result could not be written", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    const failing = {
      from(table: string) {
        const chain = supabase.from(table);
        const update = chain.update;
        chain.update = (patch: any) => {
          const next = update(patch);
          // The claim goes through `.maybeSingle()` and still succeeds; the
          // terminal write is awaited directly, and that is the one that fails.
          if (patch.dispatch_status !== "processing") {
            next.then = (_resolve: any, reject: any) => reject(new Error("connection lost"));
          }
          return next;
        };
        return chain;
      },
    };

    const s = await runDueAlShrouqDispatches(failing as any, deps({ live: true }));

    expect(s.unsettled).toBe(1);
    expect(s.retryable).toBe(0);
    expect(s.blocked).toBe(0);
    // Never returned to `scheduled`: a second POST is exactly what must not
    // follow a transmitted create.
    expect(supabase.updates.every((u) => u.patch.dispatch_status !== "scheduled")).toBe(true);
  });

  /**
   * The recovery sentence from the incident report, as a test.
   *
   * Due at 18:30, the endpoint failing from 18:26 to 18:41. At 18:42 the row is
   * still `scheduled`, still overdue, and the first healthy run sends it. The
   * due query asks `scheduled_for <= now`, never `== this minute`.
   */
  it("sends a delivery that became overdue while the scheduler was failing", async () => {
    const supabase = fakeSupabase({
      due: [dueRow({ scheduled_for: "2026-09-12T18:30:00Z", last_attempt_at: null })],
    });
    const s = await runDueAlShrouqDispatches(
      supabase as any,
      deps({ live: true }),
      new Date("2026-09-12T18:42:00Z"),
    );

    expect(s.due).toBe(1);
    expect(s.accepted).toBe(1);
    expect(posts()).toBe(1);
  });

  /**
   * A released row rests before it is tried again.
   *
   * Without this a delivery held up by a refused sign-in would ask the CRM to
   * refuse it sixty times an hour, which `client.server.ts` names as the way an
   * account gets locked.
   */
  it("holds a just-released row back for the backoff, then takes it", async () => {
    const justTried = fakeSupabase({
      due: [dueRow({ last_attempt_at: "2026-09-12T18:41:30Z" })],
    });
    const held = await runDueAlShrouqDispatches(
      justTried as any,
      deps({ live: true }),
      new Date("2026-09-12T18:42:00Z"),
    );
    expect(held.deferred).toBe(1);
    expect(held.due).toBe(0);
    expect(posts()).toBe(0);

    const rested = fakeSupabase({
      due: [dueRow({ last_attempt_at: "2026-09-12T18:38:00Z" })],
    });
    const sent = await runDueAlShrouqDispatches(
      rested as any,
      deps({ live: true }),
      new Date("2026-09-12T18:42:00Z"),
    );
    expect(sent.deferred).toBe(0);
    expect(sent.accepted).toBe(1);
    expect(posts()).toBe(1);
  });

  /** A delivery that has never been attempted is never delayed by the backoff. */
  it("does not delay a first attempt", async () => {
    const supabase = fakeSupabase({ due: [dueRow({ last_attempt_at: null })] });
    const s = await runDueAlShrouqDispatches(
      supabase as any,
      deps({ live: true }),
      new Date("2026-09-12T18:42:00Z"),
    );
    expect(s.deferred).toBe(0);
    expect(s.accepted).toBe(1);
  });

  /**
   * Releasing does not free the order's slot.
   *
   * The row stays live — `cancelled_at` untouched — so
   * `alshrouq_dispatches_live_order_key` still holds the order, and no second
   * dispatch can be created for it while this one waits.
   */
  it("keeps the order's dispatch slot while it waits", async () => {
    const supabase = fakeSupabase({ due: [dueRow()] });
    await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: throwsBeforeSending("unavailable") as any,
    });

    for (const update of supabase.updates) {
      expect(update.patch).not.toHaveProperty("cancelled_at");
      expect(update.patch.dispatch_status).not.toBe("cancelled");
    }
  });

  /**
   * A retry of a released row is still one POST, because the claim is still a
   * compare-and-swap. Two overlapping runs over the same released row send once.
   */
  it("a released row cannot be dispatched twice by overlapping runs", async () => {
    const supabase = fakeSupabase({ due: [dueRow({ last_attempt_at: "2026-09-12T18:00:00Z" })] });
    const shared = deps({ live: true });
    const now = new Date("2026-09-12T18:42:00Z");

    const [a, b] = await Promise.all([
      runDueAlShrouqDispatches(supabase as any, shared, now),
      runDueAlShrouqDispatches(supabase as any, shared, now),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(a.accepted + b.accepted).toBe(1);
    expect(posts()).toBe(1);
  });

  /** A cancelled or already-sent row is never in the due set to begin with. */
  it("never reconsiders a row that is not scheduled", async () => {
    const supabase = fakeSupabase({ due: [] });
    const s = await runDueAlShrouqDispatches(supabase as any, {
      ...deps({ live: true }),
      createOrder: throwsBeforeSending("unavailable") as any,
    });

    expect(s).toMatchObject({ due: 0, claimed: 0, retryable: 0, blocked: 0 });
    expect(supabase.updates).toHaveLength(0);
  });
});
