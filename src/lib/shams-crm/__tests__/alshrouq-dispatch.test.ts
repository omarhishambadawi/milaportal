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
    // The agent dispatching their own order: assignee and caller are one person.
    orderAgentId: USER_ID,
    form: form(),
    ...over,
  };
}

/** A Supabase stand-in: records inserts, answers the live-dispatch lookup. */
function fakeSupabase(
  opts: {
    existing?: Record<string, unknown> | null;
    /**
     * What the live-dispatch lookup finds *after* the insert was attempted.
     *
     * The duplicate check and the post-conflict read are the same query, and
     * they have to be able to disagree: "nothing live when we looked, something
     * live by the time we wrote" is the race the unique index is for, and it is
     * a different situation from a collision with a row that is not live at all.
     */
    existingAfterInsert?: Record<string, unknown> | null;
    insertError?: any;
  } = {},
) {
  const inserts: Record<string, unknown>[] = [];
  let inserted = false;
  /** `order_activity` rows — where a refusal is recorded, since no dispatch row is. */
  const activity: Record<string, unknown>[] = [];
  const api = {
    inserts,
    activity,
    from(table: string) {
      // The refusal record goes to the order timeline, not to this table.
      // Collected rather than refused so a test can assert what was written.
      if (table === "order_activity") {
        return {
          insert: async (row: Record<string, unknown>) => {
            activity.push(row);
            return { error: null };
          },
        };
      }
      if (table !== "alshrouq_dispatches") throw new Error(`unexpected table ${table}`);
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data:
            inserted && opts.existingAfterInsert !== undefined
              ? opts.existingAfterInsert
              : (opts.existing ?? null),
          error: null,
        }),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          inserted = true;
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
    // COD, deliberately: the fixture's own method is "Paid", where a blank
    // value is no longer missing information — it is zero to collect.
    ["order value", { paymentType: "1", orderValue: "" }, "order_value"],
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

  /* ---------------------------------------------------------------------- */
  /* A paid order collects nothing                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * `order_value` is what the driver is told to collect at the door, not what
   * the pharmacy invoiced. On a method whose label is "Paid" those are two
   * different numbers, and sending the invoice is how a customer is asked to
   * pay for the same order twice.
   */
  it("sends nothing to collect when the customer has already paid", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form({ paymentType: "3", orderValue: "250.75" }) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.payload.orderValue).toBe(0);
  });

  /** And a blank invoice stops being a problem: there is nothing to collect. */
  it("does not require an order value on a paid method", async () => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form({ paymentType: "3", orderValue: "" }) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.payload.orderValue).toBe(0);
  });

  /**
   * The one that would be a real incident.
   *
   * `AlshrouqPay` contains the letters of "Pay" and sits beside "Paid" in the
   * same list, but the courier collects through AlShrouq's own wallet — zeroing
   * it would tell a driver to hand over goods and take nothing.
   */
  it.each([
    ["COD", "1"],
    ["SPAN Machine", "2"],
    ["AlshrouqPay", "4"],
  ])("still collects the full value on %s", async (_label, id) => {
    const r = await dispatchOrderToAlShrouq(
      request({ form: form({ paymentType: id, orderValue: "250.75" }) }),
      fakeSupabase() as any,
      deps(),
    );
    expect(r.kind).toBe("prepared");
    if (r.kind !== "prepared") throw new Error("unreachable");
    expect(r.payload.orderValue).toBe(250.75);
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
    const supabase = fakeSupabase({
      insertError: { code: "23505" },
      // The row that won, read back after the conflict.
      existingAfterInsert: { external_order_id: "6099196", status: "Order Created" },
    });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));
    // The index is the backstop; the agent is told it is already sent, not
    // shown a database error.
    expect(r.kind).toBe("already_dispatched");
    expect(posts()).toBe(1);
  });

  /**
   * The reported incident, at the point it did its damage.
   *
   * AlShrouq has booked a courier. The insert that records it collides with
   * something that is **not** a live dispatch — which is what a total unique
   * index on `client_order_id` did after a cancel-and-resend, before
   * `20260901130000` scoped it to live rows the way its sibling already was.
   *
   * Reporting `already_dispatched` there was the worst available answer: it told
   * the agent nothing had been sent, while a driver was on the way and the order
   * carried no record of it. The reference is reported instead, and the failure
   * to record it is logged rather than swallowed.
   */
  it("never reports a booked courier as an existing dispatch it cannot find", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = fakeSupabase({ insertError: { code: "23505" } });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));

    expect(r.kind).not.toBe("already_dispatched");
    expect(posts()).toBe(1);
    expect(error.mock.calls.some(([m]) => String(m).includes("could not be recorded"))).toBe(true);
  });

  /**
   * The acceptance criterion: a cancelled dispatch does not block the next one.
   *
   * `existing: null` is the database's answer once the previous row carries
   * `cancelled_at` — it is invisible to the duplicate check and, after
   * `20260901130000`, to both unique indexes. The new dispatch is sent once and
   * persisted with the same `client_order_id`, which is derived from the order
   * and never invented per attempt.
   */
  it("dispatches again after the previous dispatch was cancelled", async () => {
    const supabase = fakeSupabase({ existing: null });
    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));

    expect(r.kind).toBe("dispatched");
    expect(posts()).toBe(1);
    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.inserts[0].client_order_id).toBe("9540");
    expect(supabase.inserts[0].dispatch_status).toBe("accepted");
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

/* ------------------------------------------------------------------------- */
/* A refusal keeps its reason                                                */
/* ------------------------------------------------------------------------- */

/**
 * The second half of the reported incident.
 *
 * An order was saved, sent, and refused, and the agent was told:
 *
 *     AlShrouq refused the delivery. No courier was sent.
 *
 * The CRM had answered with a 4xx **and a body**. `createAlshrouqOrder`
 * received it, sanitized it, and returned it on the result; this service then
 * replaced it with a constant string, logged nothing and persisted nothing. The
 * reason existed for the length of one function call and was then unrecoverable.
 *
 * These tests pin the reason all the way to the caller, and pin the two rules a
 * refusal must not break: no row is written, and no second POST is sent.
 */
describe("a 4xx refusal is reported with its reason", () => {
  const rejectionWith = (body: unknown, status = 422) =>
    vi.fn(async () => ({ kind: "rejected" as const, operationId: "op-1", status, body }));

  it("carries the CRM's explanation to the caller", async () => {
    const createOrder = rejectionWith({
      detail: [{ loc: ["body", "customer_phone"], msg: "invalid phone number" }],
    });
    const r = await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });

    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.reason).toBe("customer_phone: invalid phone number");
    expect(r.status).toBe(422);
    // The message an agent reads names the field and the status.
    expect(r.message).toContain("customer_phone");
    expect(r.message).toContain("422");
  });

  /** A refusal with nothing in it is still a refusal, and still says so. */
  it("falls back to the generic sentence when the body carries no reason", async () => {
    const r = await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith(null, 400) as any,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.reason).toBeNull();
    expect(r.message).toContain("400");
    expect(r.message).toContain("Nothing was dispatched.");
  });

  /**
   * A 4xx is the one outcome where the transport guarantees nothing was
   * created, so the order must stay sendable: an agent who corrects the field
   * the CRM objected to has to be able to try again. A `failed` row here would
   * take the order's slot in `alshrouq_dispatches_live_order_key` and lock a
   * fixable order out of dispatch permanently.
   */
  it("writes no row, so a corrected order can still be sent", async () => {
    const supabase = fakeSupabase();
    const createOrder = rejectionWith({ detail: "bad branch" });
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: createOrder as any,
    });
    expect(supabase.inserts).toHaveLength(0);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("logs the refusal without the customer's identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ detail: "branch closed" }) as any,
    });

    expect(warn).toHaveBeenCalled();
    const [label, payload] = warn.mock.calls[0]!;
    expect(String(label)).toContain("[alshrouq]");
    const logged = JSON.stringify(payload);
    // Enough to find the attempt again.
    expect(logged).toContain(ORDER_ID);
    expect(logged).toContain("9540");
    expect(logged).toContain("branch closed");
    expect(logged).toContain("422");
    // Never the person.
    expect(logged).not.toContain("Test Customer");
    expect(logged).not.toContain("0500798930");
    expect(logged).not.toContain("maps.app.goo.gl");
  });

  /** An unrecognised refusal shape must not throw and lose the outcome. */
  it("survives a refusal body it cannot read", async () => {
    const r = await dispatchOrderToAlShrouq(request(), fakeSupabase() as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ something: { unexpected: [1, 2, 3] } }, 409) as any,
    });
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.reason).toBeNull();
    expect(r.message).toContain("409");
  });
});

/* ------------------------------------------------------------------------- */
/* A refusal outlives the toast that reported it                             */
/* ------------------------------------------------------------------------- */

/**
 * The regression for what actually blocked closing this incident.
 *
 * Phase 1 recovered the CRM's reason and put it in the message and a log line.
 * Neither is durable: the agent's toast is gone on navigation, and the log goes
 * to the platform's drain, which is not where the people handling the order
 * look. An immediate refusal writes **no** dispatch row — correctly, because a
 * 4xx created nothing and the order must stay sendable — so the refusal left
 * no trace on the order at all. That is precisely why the reported production
 * refusal could not be explained after the fact.
 *
 * It is recorded on `order_activity` now: durable, on the order's own timeline,
 * and deliberately *not* on `alshrouq_dispatches`, so it cannot take the slot
 * that would lock a fixable order out of dispatch.
 */
describe("a refusal is recorded on the order", () => {
  const rejectionWith = (body: unknown, status = 422) =>
    vi.fn(async () => ({ kind: "rejected" as const, operationId: "op-1", status, body }));

  it("writes the reason to the order's activity, not to alshrouq_dispatches", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ detail: "branch is not active" }) as any,
    });

    // The rule that keeps the order retryable: no dispatch row, no slot taken.
    expect(supabase.inserts).toHaveLength(0);

    expect(supabase.activity).toHaveLength(1);
    const row = supabase.activity[0]! as any;
    expect(row.order_id).toBe(ORDER_ID);
    expect(row.actor_id).toBe(USER_ID);
    expect(row.action).toBe("alshrouq_dispatch_rejected");
    expect(row.details.reason).toBe("branch is not active");
    expect(row.details.http_status).toBe(422);
  });

  /**
   * The blind spot that would otherwise repeat this incident verbatim: a shape
   * the parser cannot read used to be discarded whole. Key *names* are enough to
   * teach it the shape, and cannot themselves carry a phone number or a token.
   */
  it("records the body's shape when no reason could be read", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ status: "NOK", failures: ["x"], ref: 9 }, 400) as any,
    });

    const details = (supabase.activity[0]! as any).details;
    expect(details.reason).toBeNull();
    expect(details.body_shape).toEqual(["status", "failures", "ref"]);
  });

  /** Noise, when the reason is already there. */
  it("omits the shape once a reason was read", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ detail: "nope" }) as any,
    });
    expect((supabase.activity[0]! as any).details.body_shape).toBeUndefined();
  });

  /**
   * Which optional keys went out is the correlation that settles a question
   * like "was `customer_address` missing on the ones that failed" in one look —
   * without putting the address, the phone or the note on a timeline agents read.
   */
  it("records which optional payload keys were sent, never their contents", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(
      request({ form: form({ mapUrl: "https://maps.app.goo.gl/abc123", details: "ring twice" }) }),
      supabase as any,
      { ...deps({ live: true }), createOrder: rejectionWith({ detail: "no" }) as any },
    );

    const details = (supabase.activity[0]! as any).details;
    expect(details.sent_address).toBe(true);
    expect(details.sent_details).toBe(true);
    expect(details.client_order_id).toBe("9540");

    const serialised = JSON.stringify(details);
    expect(serialised).not.toContain("Test Customer");
    expect(serialised).not.toContain("0500798930");
    expect(serialised).not.toContain("maps.app.goo.gl");
    expect(serialised).not.toContain("ring twice");
  });

  it("distinguishes a payload that carried no address", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(
      request({ form: form({ mapUrl: "", lat: "21.56312", lng: "39.17516" }) }),
      supabase as any,
      { ...deps({ live: true }), createOrder: rejectionWith({ detail: "no" }) as any },
    );

    const details = (supabase.activity[0]! as any).details;
    expect(details.sent_address).toBe(false);
    expect(details.sent_coordinates).toBe(true);
  });

  /**
   * Bookkeeping must never turn a refusal into an error. The caller still gets
   * the refusal and its reason even if the activity write is impossible.
   */
  it("still reports the refusal when the record cannot be written", async () => {
    const supabase = {
      from(table: string) {
        if (table === "order_activity") throw new Error("no grant");
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await dispatchOrderToAlShrouq(request(), supabase as any, {
      ...deps({ live: true }),
      createOrder: rejectionWith({ detail: "still refused" }) as any,
    });

    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") throw new Error("unreachable");
    expect(r.reason).toBe("still refused");
    // Silence here would recreate the blindness this exists to remove.
    expect(warn.mock.calls.some(([m]) => String(m).includes("could not record"))).toBe(true);
  });

  /** Only a refusal. An accepted dispatch has a row, and needs no second story. */
  it("writes no activity row when the dispatch is accepted", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, deps({ live: true }));
    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.activity).toHaveLength(0);
  });
});
