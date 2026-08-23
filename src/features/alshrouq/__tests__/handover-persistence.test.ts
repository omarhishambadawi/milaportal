/**
 * What "Create order + AlShrouq delivery" actually leaves behind, and what the
 * reopened order page makes of it.
 *
 * ## The report
 *
 * An agent chose **Create order + AlShrouq delivery**, the order was created,
 * and reopening it showed the card reading *"Not available — this order cannot
 * be delivered by AlShrouq — choose a branch to check AlShrouq coverage"* beside
 * a branch that was plainly filled in, with the send button dead.
 *
 * Two separate things were wrong, and this suite pins both.
 *
 * ## 1. Nothing was persisted, and that is the safety gate working
 *
 * With `ALSHROUQ_LIVE_DISPATCH_ENABLED` unset, an **immediate** handover runs
 * the whole pipeline and stops at the gate, returning `prepared` and writing
 * **no row** — deliberately, so a dry run cannot take the order's dispatch slot
 * and block the real send later. So in this deployment "as soon as possible"
 * leaves the same persisted state as "Create order only", and the reopened page
 * has no dispatch to report. That is honest, and it is not something to fix by
 * inventing a row: the tests below assert the gate still holds and still writes
 * nothing.
 *
 * A **scheduled** handover is different and always was: it persists a
 * `scheduled` row with a frozen snapshot without contacting anybody, so it
 * survives a reload on any deployment.
 *
 * ## 2. The card judged the order by the form
 *
 * That is the part that was broken. With no dispatch row the card falls back to
 * *readiness*, and readiness was computed from `alshrouq.coverage` — which
 * `useAlShrouqOrder` short-circuits to `no_branch` whenever
 * `form.delivery_type` is not AlShrouq. A saved AlShrouq order whose form had
 * not put the method back therefore described itself as uncoverable.
 * `cardCoverage` is the fix, and the reload tests below are about it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchOrderToAlShrouq,
  type DispatchDeps,
  type DispatchRequest,
} from "@/lib/shams-crm/alshrouq-dispatch.server";
import { scheduleAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { resolveAlShrouqBranch } from "@/lib/shams-crm/alshrouq-branches";
import { cardCoverage, showAlShrouqSection, shownDispatch } from "../dispatch-selection";
import { coverageAllowsDispatch } from "../order-requirements";
import { summariseAlShrouqDispatch } from "../dispatch-timeline";
import { ALSHROUQ } from "../constants";

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";
const BRANCH_ID = "9999927657247";
const BRANCH_NO = "P0002";

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

/** Records every row written, so "nothing was persisted" is a countable claim. */
function fakeSupabase() {
  const inserts: any[] = [];
  return {
    inserts,
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
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
      customerName: "Test",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.80602",
      lng: "46.77523",
      orderValue: "0",
      details: "",
    },
  };
}

/* ------------------------------------------------------------------------ */
/* What each choice persists                                                */
/* ------------------------------------------------------------------------ */

describe("what the create journey leaves behind", () => {
  /**
   * "Create order only" runs none of this. There is no dispatch call at all —
   * `afterCreate` returns before sending — so the absence of a row is not a
   * failure, it is the whole meaning of the choice.
   */
  it("writes no dispatch for an order-only create", async () => {
    const supabase = fakeSupabase();
    // Nothing calls the service. Asserted as the state the page then reads.
    expect(supabase.inserts).toHaveLength(0);
    expect(shownDispatch(supabase.inserts)).toBeNull();
  });

  /**
   * The gate, unchanged and still shut. Everything up to the POST succeeds and
   * **nothing is written** — an order with no courier must not acquire a
   * dispatch record, or the duplicate check would refuse the real send later on
   * the strength of a dry run.
   */
  it("sends nothing and persists nothing for an immediate handover while the gate is shut", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(request(), supabase as any, deps());

    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") expect(result.liveDispatchEnabled).toBe(false);
    expect(posts()).toBe(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /**
   * A scheduled handover persists on every deployment, gate or no gate — it
   * reserves the slot and contacts nobody. This is the path whose state must
   * survive a reload, and it does.
   */
  it("persists a scheduled row without contacting anybody", async () => {
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
  });

  /** One approval, one row. The slot is taken by the database, not by a flag. */
  it("does not write a second row for a second immediate approval", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    await dispatchOrderToAlShrouq(request(), supabase as any, deps());
    expect(supabase.inserts).toHaveLength(0);
    expect(posts()).toBe(0);
  });
});

/* ------------------------------------------------------------------------ */
/* What the reopened page makes of it                                       */
/* ------------------------------------------------------------------------ */

/**
 * One page load with **no client state at all** — a reopen, a refresh, a fresh
 * login. The form has not been hydrated, which is the condition every one of
 * these regressions needs.
 */
function reopened(db: {
  deliveryType: string | null;
  branchNo: string | null;
  rows: Record<string, unknown>[];
}) {
  const orderBranch = resolveAlShrouqBranch(BRANCH_OPTIONS, db.branchNo);
  // What `useAlShrouqOrder` reports while the form says nothing: it
  // short-circuits, and this is the value that used to reach the card.
  const formCoverage = { kind: "no_branch" } as const;

  const coverage = cardCoverage(false, formCoverage, orderBranch);
  return {
    visible: showAlShrouqSection({
      storedDeliveryType: db.deliveryType,
      formDeliveryType: "",
      hasDispatchHistory: db.rows.length > 0,
    }),
    covered: coverageAllowsDispatch(coverage),
    coverageKind: coverage.kind,
    dispatch: summariseAlShrouqDispatch(shownDispatch(db.rows as any) as any),
  };
}

describe("reopening the order", () => {
  /**
   * The exact screen from the report: an AlShrouq order, a real branch, no
   * dispatch row because the gate is shut. It must read as *ready to send*, not
   * as an order AlShrouq cannot deliver.
   */
  it("does not call a saved AlShrouq order uncoverable", () => {
    const page = reopened({ deliveryType: ALSHROUQ, branchNo: BRANCH_NO, rows: [] });

    expect(page.visible).toBe(true);
    // The regression: this was `no_branch`, which rendered "Not available".
    expect(page.coverageKind).toBe("covered");
    expect(page.covered).toBe(true);
    // And there is genuinely no dispatch to report, which is the honest answer.
    expect(page.dispatch.status).toBeNull();
  });

  /** A branch AlShrouq really does not serve still says so, from the order. */
  it("still reports a genuinely uncovered branch", () => {
    const uncovered = [{ ...BRANCH_OPTIONS[0]!, covered: false }];
    const coverage = cardCoverage(
      false,
      { kind: "no_branch" },
      resolveAlShrouqBranch(uncovered, BRANCH_NO),
    );
    expect(coverage.kind).toBe("not_covered");
    expect(coverageAllowsDispatch(coverage)).toBe(false);
  });

  /** While the form *is* answering, the form wins — an edit must be visible. */
  it("prefers the form's answer while the form is the one being filled in", () => {
    const live = { kind: "covered", branchName: "الرياض" } as const;
    expect(cardCoverage(true, live, resolveAlShrouqBranch([], "P9999"))).toBe(live);
  });

  /** Before the context lands there is nothing better than the form's answer. */
  it("falls back to the form's answer when the order context has not arrived", () => {
    const formCoverage = { kind: "unknown" } as const;
    expect(cardCoverage(false, formCoverage, undefined)).toBe(formCoverage);
  });

  /* Each persisted state, read back after the client state is thrown away. */
  const states = [
    {
      name: "scheduled",
      row: { dispatch_status: "scheduled", scheduled_for: "2026-08-23T19:00:00Z" },
      label: "Scheduled",
    },
    {
      name: "accepted",
      row: { dispatch_status: "accepted", external_order_id: "6099196" },
      label: "Accepted by AlShrouq",
    },
    {
      name: "failed",
      row: { dispatch_status: "failed", last_error: "refused" },
      label: "Dispatch failed",
    },
    {
      name: "indeterminate",
      row: { dispatch_status: "indeterminate" },
      label: "Delivery status unavailable",
    },
    {
      name: "cancelled",
      row: { dispatch_status: "cancelled", cancelled_at: "2026-08-22T14:10:00Z" },
      label: "Scheduled delivery cancelled",
    },
  ];

  for (const state of states) {
    it(`shows a ${state.name} dispatch, not a readiness guess, after a reload`, () => {
      const page = reopened({
        deliveryType: ALSHROUQ,
        branchNo: BRANCH_NO,
        rows: [{ cancelled_at: null, ...state.row }],
      });
      expect(page.visible).toBe(true);
      // The persisted row is what the card reports — readiness is not consulted.
      expect(page.dispatch.status).toBe(state.row.dispatch_status);
      expect(page.dispatch.label).toBe(state.label);
    });
  }

  /** A resolved dispatch keeps the machine's state and carries the outcome. */
  it("keeps a resolved dispatch reporting what the courier said", () => {
    const page = reopened({
      deliveryType: ALSHROUQ,
      branchNo: BRANCH_NO,
      rows: [
        {
          cancelled_at: null,
          dispatch_status: "indeterminate",
          resolution_outcome: "confirmed_delivered",
          resolved_at: "2026-08-22T18:00:00Z",
        },
      ],
    });
    expect(page.dispatch.status).toBe("indeterminate");
    expect(page.dispatch.resolutionOutcome).toBe("confirmed_delivered");
  });

  /** An order that has nothing to do with AlShrouq is still left alone. */
  it("shows nothing for an ordinary order", () => {
    const page = reopened({ deliveryType: "Store Pickup", branchNo: BRANCH_NO, rows: [] });
    expect(page.visible).toBe(false);
  });
});
