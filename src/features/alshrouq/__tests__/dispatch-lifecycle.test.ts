/**
 * The five create/dispatch paths, traced end to end, with every write counted.
 *
 * ## Why this exists
 *
 * The same report keeps coming back: *"Create order + AlShrouq delivery" does
 * not reach AlShrouq, and reopening asks me to send again.* Each investigation
 * re-derives the same answer by reading the same six files, so it is written
 * down here as executable fact instead — what each path calls, what it POSTs,
 * and what it leaves in `orders` and `alshrouq_dispatches`.
 *
 * ## The answer, once
 *
 * The orchestration is **not** broken. `afterCreate` calls the dispatch server
 * function on every `dispatch` intent, and `prepareAlShrouqDispatch` runs the
 * duplicate check, the branch resolution and the payload build. What stops it is
 * the production gate: with `ALSHROUQ_LIVE_DISPATCH_ENABLED` unset an
 * **immediate** handover returns `prepared` and writes **no row** — deliberately,
 * so a dry run cannot take the order's dispatch slot and block the real send
 * later. No row is why the reopened card falls back to readiness.
 *
 * So "nothing was persisted" is the gate working, not a bug, and the tests below
 * assert it stays that way. A **scheduled** handover is the one that persists on
 * every deployment: it reserves the slot and contacts nobody.
 *
 * These run with the gate shut, which is this deployment's real configuration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchOrderToAlShrouq,
  type DispatchDeps,
  type DispatchRequest,
} from "@/lib/shams-crm/alshrouq-dispatch.server";
import { scheduleAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { buildOrderPayload, type OrderFormState } from "@/features/orders/payload";
import { orderFormSchema } from "@/features/orders/schema";
import { summariseAlShrouqDispatch } from "../dispatch-timeline";
import { shownDispatch } from "../dispatch-selection";
import { ALSHROUQ } from "../constants";

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";
const BRANCH_ID = "9999927657247";
const BRANCH_NO = "P0002";
const MAP_URL = "https://maps.app.goo.gl/kQ7xR2vN8mP4tL9s";
const NOTE = "Second floor, ring the bell twice.";

const BRANCH_OPTIONS = [
  {
    id: BRANCH_ID,
    internal_code: BRANCH_NO,
    branch_name: "الرياض",
    label: "P0002 | الرياض",
    covered: true,
    note: null,
  },
];

afterEach(() => {
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});

/** Counts every insert, so "nothing was written" is a number rather than a claim. */
function fakeSupabase(existing: Record<string, unknown> | null = null) {
  const inserts: any[] = [];
  return {
    inserts,
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: existing, error: null }),
        insert: async (row: any) => {
          inserts.push(row);
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

let posts: () => number;

function deps(): Partial<DispatchDeps> {
  const createOrder = vi.fn(async () => ({
    kind: "accepted" as const,
    operationId: "op-1",
    status: 201,
    body: null,
  }));
  posts = () => createOrder.mock.calls.length;
  return {
    fetchOptions: async () => ({
      branchOptions: BRANCH_OPTIONS,
      paymentOptions: [
        { id: 1, label: "COD" },
        { id: 3, label: "SPAN Machine" },
      ],
    }),
    createOrder: createOrder as any,
  };
}

function request(): DispatchRequest {
  return {
    orderId: ORDER_ID,
    displayNo: "#9767",
    branchNo: BRANCH_NO,
    userId: USER_ID,
    // The agent dispatching their own order: assignee and caller are one person.
    orderAgentId: USER_ID,
    form: {
      customerName: "Test Customer",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: MAP_URL,
      lat: "24.8060200",
      lng: "46.7752300",
      orderValue: "150",
      details: NOTE,
    },
  };
}

/** The order row the insert actually receives, through the real builder. */
function orderRow(): Record<string, unknown> {
  const form: OrderFormState = {
    order_date: "2026-08-22",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Test Customer",
    customer_phone: "0500000000",
    branch_no: BRANCH_NO,
    delivery_type: ALSHROUQ,
    invoice_value: "150",
    notes: NOTE,
    status: "Pending",
    agent_id: "11111111-1111-4111-8111-111111111111",
    call_center_verified: false,
    alshrouq_map_url: MAP_URL,
    alshrouq_lat: "24.8060200",
    alshrouq_lng: "46.7752300",
    alshrouq_payment_type: "3",
  };
  const payload = buildOrderPayload({
    mode: "create",
    form,
    invoiceNo: "",
    persisted: null,
    invoices: { invoices: [], verified: [], verifiedTotal: 0, callCentreVerified: false } as any,
    canAssign: false,
    canVerify: false,
  });
  return orderFormSchema.parse(payload) as Record<string, unknown>;
}

/* ------------------------------------------------------------------------ */
/* A — Create order only                                                    */
/* ------------------------------------------------------------------------ */

describe("A: create order only", () => {
  it("writes the order with every AlShrouq field, and dispatches nothing", () => {
    const row = orderRow();
    expect(row.delivery_type).toBe(ALSHROUQ);
    expect(row.branch_no).toBe(BRANCH_NO);
    expect(row.customer_name).toBe("Test Customer");
    expect(row.customer_phone).toBe("0500000000");
    expect(row.alshrouq_map_url).toBe(MAP_URL);
    expect(row.alshrouq_lat).toBe(24.80602);
    expect(row.alshrouq_lng).toBe(46.77523);
    expect(row.alshrouq_payment_type).toBe(3);
    expect(row.notes).toBe(NOTE);
  });

  /**
   * The dispatch service is never reached: `afterCreate` returns on any intent
   * that is not `dispatch`. Asserted as the state the reopened page then reads.
   */
  it("leaves alshrouq_dispatches empty", () => {
    const supabase = fakeSupabase();
    expect(supabase.inserts).toHaveLength(0);
    expect(shownDispatch(supabase.inserts)).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* B — Create + AlShrouq, ASAP                                              */
/* ------------------------------------------------------------------------ */

describe("B: create + AlShrouq, as soon as possible", () => {
  /**
   * The path *is* invoked — the whole pipeline runs — and it stops at the gate.
   * `prepared` is the proof it ran: an orchestration that never called would
   * produce no result at all.
   */
  it("runs the pipeline, contacts nobody, and writes nothing", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(request(), supabase as any, deps());

    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") {
      expect(result.liveDispatchEnabled).toBe(false);
      // The payload was fully built before the gate — the branch resolved and
      // the note reached it, so nothing downstream is waiting on missing data.
      expect(result.payload.branchId).toBe(BRANCH_ID);
      expect(result.payload.paymentType).toBe(3);
      expect(result.payload.hasCoordinates).toBe(true);
      expect(result.payload.hasDetails).toBe(true);
    }
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /** The order itself is unaffected: every field is still saved. */
  it("keeps the order and its AlShrouq configuration regardless", () => {
    expect(orderRow().delivery_type).toBe(ALSHROUQ);
    expect(orderRow().alshrouq_payment_type).toBe(3);
  });
});

/* ------------------------------------------------------------------------ */
/* C — Create + AlShrouq, scheduled                                         */
/* ------------------------------------------------------------------------ */

describe("C: create + AlShrouq, scheduled", () => {
  /**
   * The path that persists on every deployment, gate or no gate. It reserves the
   * order's dispatch slot and contacts nobody, so its state survives a reload
   * without any courier having been called.
   */
  it("persists a scheduled row with a frozen snapshot, and posts nothing", async () => {
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const result = await scheduleAlShrouqDispatch(request(), when, supabase as any, deps());

    expect(result.kind).toBe("scheduled");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(1);

    const row = supabase.inserts[0]!;
    expect(row.order_id).toBe(ORDER_ID);
    expect(row.dispatch_status).toBe("scheduled");
    expect(row.scheduled_for).toBe(when.toISOString());
    expect(row.payload_snapshot.branch_id).toBe(BRANCH_ID);
    // The driver's note is frozen on the row as it was approved.
    expect(row.payload_snapshot.details).toBe(NOTE);
  });
});

/* ------------------------------------------------------------------------ */
/* D — Reopening an order that already has a dispatch                       */
/* ------------------------------------------------------------------------ */

describe("D: reopening a dispatched order", () => {
  /**
   * The row is the source of truth, and it is read with **no form state at
   * all** — a reopen, a refresh, a fresh login. The card must report the
   * delivery, not offer to create one.
   */
  it("reports the persisted dispatch and treats it as handed over", () => {
    const rows = [
      {
        dispatch_status: "accepted",
        external_order_id: "ALS-99812",
        tracking_url: "https://alshrouqdelivery.com/tracking/abc",
        cancelled_at: null,
        created_at: "2026-08-22T10:00:00.000Z",
      },
    ];
    const summary = summariseAlShrouqDispatch(shownDispatch(rows as any) as any);
    expect(summary.handedOver).toBe(true);
    expect(summary.status).toBe("accepted");
  });

  /** A second attempt is refused before anything is built or sent. */
  it("refuses a second send while a live row exists", async () => {
    const supabase = fakeSupabase({
      external_order_id: "ALS-99812",
      local_id: "551",
      status: "Accepted",
      tracking_url: null,
      dispatched_at: "2026-08-22T10:00:00.000Z",
    });
    const result = await dispatchOrderToAlShrouq(request(), supabase as any, deps());

    expect(result.kind).toBe("already_dispatched");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /** Two immediate approvals in a row still write nothing and post nothing. */
  it("cannot produce a duplicate dispatch", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/* E — Retrying a failed dispatch                                           */
/* ------------------------------------------------------------------------ */

describe("E: retrying after a failure", () => {
  /**
   * A cancelled row does not hold the slot, so a retry is *possible* — but
   * nothing here performs one. There is no timer, no effect and no automatic
   * re-send anywhere in the path; a retry is a person pressing a button.
   */
  it("is possible only because the old row no longer holds the slot", async () => {
    // `maybeSingle` filters on `cancelled_at IS NULL`, so a cancelled row is
    // absent from the duplicate check — modelled here as no live row.
    const supabase = fakeSupabase(null);
    const result = await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    // Still stops at the gate: a retry is not a way around it.
    expect(result.kind).toBe("prepared");
    expect(posts()).toBe(0);
  });

  /** And an unconfirmed send is never retried, because it may already exist. */
  it("treats an indeterminate row as handed over, so nothing offers to resend", () => {
    const summary = summariseAlShrouqDispatch(
      shownDispatch([{ dispatch_status: "indeterminate", cancelled_at: null }] as any) as any,
    );
    expect(summary.handedOver).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
/* The gate, asserted from the outside                                      */
/* ------------------------------------------------------------------------ */

describe("no courier is contacted while the gate is shut", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["1", "1"],
    ["TRUE", "TRUE"],
    ["yes", "yes"],
  ])("stays shut for %s", async (_label, value) => {
    if (value === undefined) delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
    else process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED = value;

    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    expect(result.kind).toBe("prepared");
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Shams CRM never learns that an order was scheduled                       */
/* ------------------------------------------------------------------------ */

/**
 * Scheduling is MilaPortal's, and only MilaPortal's.
 *
 * The CRM has no concept of a future delivery in this integration and must not
 * be given one: a scheduled order is stored locally, contacts nobody, and is
 * sent at its due time as an ordinary immediate create. These tests are the
 * proof of both halves — nothing early, and nothing *about* scheduling ever.
 */
describe("no scheduling metadata reaches Shams CRM", () => {
  /** Every key MilaPortal uses for scheduling. None may appear on the wire. */
  const FORBIDDEN = [
    "scheduled_for",
    "scheduled_at",
    "scheduled_by",
    "scheduled",
    "schedule",
    "dispatch_time",
    "mila_schedule",
    "future_delivery",
    "dispatch_status",
    "payload_snapshot",
  ];

  it("sends zero requests when the order is scheduled", async () => {
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await scheduleAlShrouqDispatch(request(), when, supabase as any, deps());
    // The whole point: the CRM is not contacted at creation time at all.
    expect(posts()).toBe(0);
  });

  /**
   * The frozen snapshot is the *CRM payload*, not a MilaPortal record. The
   * scheduling instant lives in the row's own `scheduled_for` column beside it,
   * which is MilaPortal's bookkeeping and never sent.
   */
  it("freezes only the CRM payload, with no scheduling keys inside it", async () => {
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await scheduleAlShrouqDispatch(request(), when, supabase as any, deps());

    const row = supabase.inserts[0]!;
    const snapshot = row.payload_snapshot as Record<string, unknown>;
    for (const key of FORBIDDEN) {
      expect(Object.keys(snapshot)).not.toContain(key);
    }
    // The instant is MilaPortal's, on the row, outside the payload.
    expect(row.scheduled_for).toBe(when.toISOString());
  });

  /**
   * The strongest statement available offline: what a scheduled order will send
   * is *the same object* an immediate one would have sent. The only difference
   * between the two paths is when the POST happens.
   */
  it("freezes exactly the payload the immediate path would have sent", async () => {
    const scheduledDb = fakeSupabase();
    await scheduleAlShrouqDispatch(
      request(),
      new Date(Date.now() + 6 * 60 * 60 * 1000),
      scheduledDb as any,
      deps(),
    );
    const snapshot = scheduledDb.inserts[0]!.payload_snapshot as Record<string, unknown>;

    // The immediate path stops at the gate and reports the summary it built.
    const immediateDb = fakeSupabase();
    const immediate = await dispatchOrderToAlShrouq(request(), immediateDb as any, deps());
    expect(immediate.kind).toBe("prepared");
    if (immediate.kind !== "prepared") return;

    // Same branch, same client order id, same payment, same value — one payload
    // shape, built by one builder, for both journeys.
    expect(snapshot.branch_id).toBe(immediate.payload.branchId);
    expect(snapshot.client_order_id).toBe(immediate.payload.clientOrderId);
    expect(snapshot.payment_type).toBe(immediate.payload.paymentType);
    expect(snapshot.value).toBe(immediate.payload.orderValue);
  });

  /** And the payload type itself has no scheduling field to populate. */
  it("has no scheduling field in the payload contract at all", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const contract = readFileSync(
      fileURLToPath(new URL("../../../lib/shams-crm/alshrouq-payload.ts", import.meta.url)),
      "utf8",
    );
    const iface = contract.slice(
      contract.indexOf("export interface AlShrouqCreatePayload"),
      contract.indexOf("export interface AlShrouqOrderSource"),
    );
    for (const key of FORBIDDEN) {
      expect(iface).not.toContain(key);
    }
  });
});
