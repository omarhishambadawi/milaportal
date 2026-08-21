/**
 * The dispatch state machine, cancellation, and the rule that no uncertain
 * dispatch may quietly become sendable again.
 *
 * The transport is mocked throughout and the assertions that matter are the
 * counting ones — how many POSTs, how many rows — because every property here is
 * ultimately about whether a second driver can be put on the road.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ALSHROUQ_DISPATCH_STATUSES,
  blocksNewDispatch,
  canCancelDispatch,
  describeCancelRefusal,
  isAlShrouqDispatchStatus,
  isTerminalDispatchStatus,
  isWorkerClaimable,
  ownsDispatchSlot,
  type AlShrouqDispatchStatus,
} from "@/lib/shams-crm/alshrouq-dispatch-state";
import { dispatchOrderToAlShrouq } from "@/lib/shams-crm/alshrouq-dispatch.server";
import {
  cancelScheduledAlShrouqDispatch,
  runDueAlShrouqDispatches,
} from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { DispatchDeps, DispatchRequest } from "@/lib/shams-crm/alshrouq-dispatch.server";
import {
  buildAlShrouqTimeline,
  summariseAlShrouqDispatch,
  type AlShrouqDispatchRow,
} from "@/features/alshrouq/dispatch-timeline";

/** Every column null, so a test can name only the one it is about. */
const emptyRow: AlShrouqDispatchRow = {
  dispatch_status: null,
  scheduled_for: null,
  scheduled_at: null,
  last_attempt_at: null,
  dispatched_at: null,
  cancelled_at: null,
  external_order_id: null,
  tracking_url: null,
  refreshed_at: null,
  last_error: null,
  status: null,
  resolution_outcome: null,
  resolved_at: null,
  resolution_note: null,
};

/* ------------------------------------------------------------------------- */
/* The pure rules                                                            */
/* ------------------------------------------------------------------------- */

describe("the state machine", () => {
  it("knows exactly the six states the database's CHECK allows", () => {
    expect([...ALSHROUQ_DISPATCH_STATUSES].sort()).toEqual(
      ["accepted", "cancelled", "failed", "indeterminate", "processing", "scheduled"].sort(),
    );
    expect(isAlShrouqDispatchStatus("scheduled")).toBe(true);
    expect(isAlShrouqDispatchStatus("delivered")).toBe(false);
    expect(isAlShrouqDispatchStatus(null)).toBe(false);
  });

  /**
   * The central rule. Everything that is not cancelled owns the order's slot,
   * which is the same predicate as `alshrouq_dispatches_live_order_key`.
   */
  it.each<[AlShrouqDispatchStatus, boolean]>([
    ["scheduled", true],
    ["processing", true],
    ["accepted", true],
    ["failed", true],
    ["indeterminate", true],
    ["cancelled", false],
  ])("%s owns the dispatch slot: %s", (status, owns) => {
    expect(ownsDispatchSlot(status)).toBe(owns);
    expect(blocksNewDispatch(status)).toBe(owns);
  });

  /**
   * The safety default. If the Portal cannot tell what state a dispatch is in,
   * the safe reading is that one exists.
   */
  it("treats an unknown or missing status as blocking", () => {
    expect(blocksNewDispatch(null)).toBe(true);
    expect(blocksNewDispatch(undefined)).toBe(true);
    expect(blocksNewDispatch("something-new")).toBe(true);
  });

  it("permits cancellation from scheduled and from nothing else", () => {
    expect(canCancelDispatch("scheduled")).toBe(true);
    for (const status of ALSHROUQ_DISPATCH_STATUSES.filter((s) => s !== "scheduled")) {
      expect(canCancelDispatch(status)).toBe(false);
    }
    expect(canCancelDispatch(null)).toBe(false);
  });

  it("lets the worker claim only a scheduled row", () => {
    expect(isWorkerClaimable("scheduled")).toBe(true);
    for (const status of ALSHROUQ_DISPATCH_STATUSES.filter((s) => s !== "scheduled")) {
      expect(isWorkerClaimable(status)).toBe(false);
    }
  });

  it("treats indeterminate as terminal, like the outcomes that are settled", () => {
    expect(isTerminalDispatchStatus("indeterminate")).toBe(true);
    expect(isTerminalDispatchStatus("accepted")).toBe(true);
    expect(isTerminalDispatchStatus("failed")).toBe(true);
    expect(isTerminalDispatchStatus("cancelled")).toBe(true);
    expect(isTerminalDispatchStatus("scheduled")).toBe(false);
    expect(isTerminalDispatchStatus("processing")).toBe(false);
  });

  it("has a refusal sentence for every state it will not cancel", () => {
    for (const status of ALSHROUQ_DISPATCH_STATUSES.filter((s) => s !== "scheduled")) {
      expect(describeCancelRefusal(status).length).toBeGreaterThan(10);
    }
    expect(describeCancelRefusal("processing")).toBe(
      "Dispatch is already being processed and cannot be cancelled.",
    );
  });
});

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

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

function request(): DispatchRequest {
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
    },
  };
}

/**
 * A Supabase stand-in that remembers one row and applies `.eq()` filters to
 * updates, so a compare-and-swap either matches or does not — which is the whole
 * behaviour under test for cancellation.
 */
function fakeSupabase(existing?: Record<string, unknown> | null) {
  const state = { row: existing ? { ...existing } : (null as Record<string, unknown> | null) };
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const api = {
    state,
    inserts,
    updates,
    from() {
      const filters: Record<string, unknown> = {};
      let pending: Record<string, unknown> | null = null;

      const matches = () => {
        if (!state.row) return false;
        for (const [key, value] of Object.entries(filters)) {
          if (key === "__null") continue;
          if (state.row[key] !== value) return false;
        }
        // `.is(col, null)` is recorded as a null-valued filter.
        const nulls = (filters.__null as string[]) ?? [];
        for (const col of nulls) {
          if (state.row[col] != null) return false;
        }
        return true;
      };

      const chain: any = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        lte: () => chain,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return chain;
        },
        is: (col: string, value: unknown) => {
          if (value === null) {
            filters.__null = [...((filters.__null as string[]) ?? []), col];
          }
          return chain;
        },
        maybeSingle: async () => {
          if (pending) {
            // An update: apply it only if the guarded row still matches.
            if (!matches()) return { data: null, error: null };
            Object.assign(state.row!, pending);
            updates.push(pending);
            const applied = pending;
            pending = null;
            return { data: { id: "row-1", ...applied }, error: null };
          }
          return { data: matches() ? state.row : null, error: null };
        },
        update: (patch: Record<string, unknown>) => {
          pending = patch;
          return chain;
        },
      };
      chain.insert = (row: Record<string, unknown>) => {
        inserts.push(row);
        state.row = { ...row };
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

function deps(
  live: boolean,
  createOrder: any = vi.fn(async () => ({
    kind: "accepted" as const,
    operationId: "op-1",
    status: 201,
    body: null,
  })),
): Partial<DispatchDeps> {
  return {
    fetchOptions: async () => ({
      branchOptions: BRANCH_OPTIONS,
      paymentOptions: [{ id: 3, label: "Paid" }],
    }),
    createOrder,
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
    liveEnabled: () => live,
  };
}

/** A stored row in a given state, as the duplicate check would find it. */
function storedRow(status: AlShrouqDispatchStatus): Record<string, unknown> {
  return {
    id: "row-1",
    order_id: ORDER_ID,
    dispatch_status: status,
    cancelled_at: status === "cancelled" ? "2026-08-21T11:00:00.000Z" : null,
    external_order_id: status === "accepted" ? "6099196" : null,
    local_id: null,
    status: status === "accepted" ? "Order Created" : null,
    tracking_url: null,
    dispatched_at: "2026-08-21T12:30:06.000Z",
    created_at: "2026-08-21T09:00:00.000Z",
    scheduled_for: "2026-08-21T12:30:00.000Z",
  };
}

/* ------------------------------------------------------------------------- */
/* Immediate dispatch                                                        */
/* ------------------------------------------------------------------------- */

describe("immediate dispatch persistence", () => {
  it("writes accepted explicitly rather than relying on the column default", async () => {
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true));

    expect(r.kind).toBe("dispatched");
    expect(supabase.inserts).toHaveLength(1);
    // The point: the value is present in the insert, not inherited from the DDL.
    expect(supabase.inserts[0].dispatch_status).toBe("accepted");
    expect(supabase.inserts[0].attempt_count).toBe(1);
    expect(supabase.inserts[0].last_attempt_at).toBeTruthy();
  });

  it("persists an unconfirmed send as indeterminate, with no invented evidence", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "The CRM did not respond in time.",
    }));
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });

    expect(r.kind).toBe("indeterminate");
    expect(supabase.inserts).toHaveLength(1);
    const row = supabase.inserts[0];
    expect(row.dispatch_status).toBe("indeterminate");
    expect(row.last_error).toBe("The CRM did not respond in time.");
    expect(row.external_order_id).toBeNull();
    expect(row.tracking_url).toBeNull();
  });

  /** Uncertain is not refused. The two must never be collapsed. */
  it("never records an unconfirmed send as failed", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "server_error",
      message: "The CRM returned 502.",
    }));
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });

    expect(supabase.inserts[0].dispatch_status).not.toBe("failed");
    expect(supabase.inserts[0].dispatch_status).toBe("indeterminate");
  });

  it("makes exactly one POST and never a second", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "unknown",
    }));
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  /** The whole point of persisting it: the next attempt is refused. */
  it("leaves the order unsendable — a second attempt is refused without a POST", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "unknown",
    }));
    const supabase = fakeSupabase();

    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });
    expect(createOrder).toHaveBeenCalledTimes(1);

    // Same fake, same stored row — exactly what a second click would meet.
    const again = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });

    expect(again.kind).toBe("already_dispatched");
    // No second POST, and no second row.
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(supabase.inserts).toHaveLength(1);
  });

  /** Reconciliation finding the order is still evidence, and still accepted. */
  it("keeps the reconciled path unchanged", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "server_error",
      message: "unknown",
    }));
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("dispatched");
    expect(supabase.inserts[0].dispatch_status).toBe("accepted");
    expect(supabase.inserts[0].external_order_id).toBe("6099196");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  /** A 4xx is the CRM declining a request it understood. Nothing was created. */
  it("still persists nothing for a 4xx refusal", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "rejected" as const,
      operationId: "op-1",
      status: 422,
      body: null,
    }));
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("rejected");
    expect(supabase.inserts).toHaveLength(0);
  });

  it("with the gate closed, writes nothing and sends nothing", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(false, createOrder));

    expect(r.kind).toBe("prepared");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Duplicate protection, state by state                                      */
/* ------------------------------------------------------------------------- */

describe("duplicate protection", () => {
  it.each<AlShrouqDispatchStatus>([
    "scheduled",
    "processing",
    "accepted",
    "failed",
    "indeterminate",
  ])("a %s dispatch blocks another POST", async (status) => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase(storedRow(status));
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /**
   * The documented exception, and it is safe because of what cancellation
   * allows: a dispatch can only be cancelled while `scheduled`, so a cancelled
   * row is always one that contacted nobody. The partial unique index was built
   * for this — "a cancelled one no longer counts, so a mistaken dispatch can be
   * cancelled and re-sent".
   */
  it("a cancelled dispatch leaves the order sendable again", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const supabase = fakeSupabase(storedRow("cancelled"));
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("dispatched");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason "cancelled frees the slot" cannot be turned against an uncertain
   * dispatch.
   *
   * Freeing the slot is only safe because of what cancellation *refuses*. If an
   * `indeterminate` row could be cancelled, its slot would be released and the
   * order would become sendable again — the exact hole this phase exists to
   * close. So the guarantee is not "cancellation is careful"; it is that the
   * only state cancellation can leave is one that never contacted anybody.
   */
  it("cannot be unlocked by cancelling an uncertain dispatch", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase(storedRow("indeterminate"));

    const cancelled = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);
    expect(cancelled.kind).toBe("conflict");
    // The row still owns the slot, so the order is still unsendable.
    expect(supabase.state.row!.cancelled_at).toBeNull();

    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));
    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
  });

  /** The same, for a delivery the courier has actually accepted. */
  it("cannot be unlocked by cancelling an accepted dispatch", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase(storedRow("accepted"));

    expect((await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any)).kind).toBe(
      "conflict",
    );
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
  });

  /**
   * A status this build does not recognise is treated as owning the slot, in
   * the service and on the screen alike.
   */
  it("treats an unrecognised stored status as blocking", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase({ ...storedRow("accepted"), dispatch_status: "in_transit" });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(
      summariseAlShrouqDispatch({ ...emptyRow, dispatch_status: "in_transit" }).handedOver,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Cancellation                                                              */
/* ------------------------------------------------------------------------- */

describe("cancelling a scheduled dispatch", () => {
  it("moves scheduled to cancelled and stamps cancelled_at", async () => {
    const supabase = fakeSupabase(storedRow("scheduled"));
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);

    expect(r.kind).toBe("cancelled");
    expect(supabase.state.row!.dispatch_status).toBe("cancelled");
    expect(supabase.state.row!.cancelled_at).toBeTruthy();
    if (r.kind === "cancelled") expect(Date.parse(r.cancelledAt)).not.toBeNaN();
  });

  /**
   * Cancellation has no transport. This asserts the shape of that claim: the
   * operation takes only an order id and a database handle, so there is nothing
   * it could call a courier with.
   */
  it("contacts AlShrouq not at all", async () => {
    const supabase = fakeSupabase(storedRow("scheduled"));
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);
      expect(r.kind).toBe("cancelled");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Not one outbound request of any kind, to AlShrouq or anywhere else.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the frozen payload untouched", async () => {
    const snapshot = { branch_id: BRANCH_ID, client_order_id: "9540", customer_name: "Ahmed" };
    const supabase = fakeSupabase({ ...storedRow("scheduled"), payload_snapshot: snapshot });

    await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);

    expect(supabase.state.row!.payload_snapshot).toEqual(snapshot);
    for (const patch of supabase.updates) {
      expect(patch).not.toHaveProperty("payload_snapshot");
    }
  });

  it.each<[AlShrouqDispatchStatus, string]>([
    ["processing", "already being processed"],
    ["accepted", "already been sent"],
    ["indeterminate", "awaiting review"],
    ["failed", "already failed"],
  ])("refuses to cancel a %s dispatch, and says why", async (status, phrase) => {
    const supabase = fakeSupabase(storedRow(status));
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);

    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("unreachable");
    expect(r.status).toBe(status);
    expect(r.message).toContain(phrase);
    // And the row is untouched — never silently mutated.
    expect(supabase.state.row!.dispatch_status).toBe(status);
    expect(supabase.state.row!.cancelled_at).toBeNull();
  });

  it("reports an already-cancelled dispatch as its own outcome", async () => {
    const supabase = fakeSupabase(storedRow("cancelled"));
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);
    expect(r.kind).toBe("already_cancelled");
  });

  it("reports an order with no dispatch at all", async () => {
    const supabase = fakeSupabase(null);
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);
    expect(r.kind).toBe("not_found");
  });
});

describe("the race between cancellation and the worker", () => {
  /**
   * The worker claimed the row first. Cancellation must not pretend it won, and
   * must not overwrite a row that may be mid-request.
   */
  it("loses honestly when the worker has already claimed the row", async () => {
    const supabase = fakeSupabase(storedRow("scheduled"));

    // The worker's compare-and-swap happens first.
    supabase.state.row!.dispatch_status = "processing";

    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);

    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") throw new Error("unreachable");
    expect(r.message).toContain("already being processed");
    expect(supabase.state.row!.dispatch_status).toBe("processing");
    expect(supabase.state.row!.cancelled_at).toBeNull();
  });

  /**
   * Cancellation won. The worker's claim now matches nothing, and an unclaimed
   * row is never sent — so no POST happens even though the run had already
   * selected the row as due.
   */
  it("wins cleanly, and the worker then cannot claim or send it", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase({
      ...storedRow("scheduled"),
      payload_snapshot: { branch_id: BRANCH_ID, client_order_id: "9540" },
    });

    const cancelled = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);
    expect(cancelled.kind).toBe("cancelled");

    // The worker runs immediately afterwards against the same row.
    const summary = await runDueAlShrouqDispatches(supabase as any, deps(true, createOrder));

    expect(summary.claimed).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.state.row!.dispatch_status).toBe("cancelled");
  });

  /** A cancelled row is not due work: the query that finds due rows excludes it. */
  it("is never selected as due once cancelled", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase(storedRow("cancelled"));

    const summary = await runDueAlShrouqDispatches(supabase as any, deps(true, createOrder));

    expect(summary.due).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(0);
  });
});

describe("a cancelled dispatch in the timeline", () => {
  /**
   * No new event plumbing: the existing derivation already reads `cancelled_at`,
   * so cancelling produces its event through the same mechanism as every other
   * dispatch fact.
   */
  it("produces the cancellation event from the persisted row", async () => {
    const supabase = fakeSupabase({
      ...storedRow("scheduled"),
      scheduled_at: "2026-08-21T09:00:00.000Z",
    });
    await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, supabase as any);

    const row = supabase.state.row!;
    const events = buildAlShrouqTimeline({
      dispatch_status: row.dispatch_status as string,
      scheduled_for: row.scheduled_for as string,
      scheduled_at: row.scheduled_at as string,
      last_attempt_at: null,
      dispatched_at: row.dispatched_at as string,
      cancelled_at: row.cancelled_at as string,
      external_order_id: null,
      tracking_url: null,
      refreshed_at: null,
      last_error: null,
      status: null,
      resolution_outcome: null,
      resolved_at: null,
      resolution_note: null,
    });

    expect(events.map((e) => e.title)).toEqual([
      "AlShrouq delivery scheduled",
      "AlShrouq delivery cancelled",
    ]);
    // And no claim that anything was sent.
    expect(events.some((e) => e.kind === "accepted")).toBe(false);
  });
});
