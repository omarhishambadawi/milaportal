/**
 * One dispatch path, one snapshot, one send.
 *
 * Two kinds of assertion live here, and both are deliberate.
 *
 * The **behavioural** ones run the real service against a fake Supabase and a
 * mocked transport: they prove that an order which has been handed over cannot
 * be handed over again, and that both journeys build the identical request.
 *
 * The **source** ones read the files. That is unusual, and it is the only way to
 * assert some of these: "the order save path never writes `payload_snapshot`" is
 * a property of *where the write lives*, not of any value a function returns, so
 * a runtime test could only ever demonstrate it for the inputs it happened to
 * pick. The same suite style already guards the order form's layout contract in
 * `features/orders/__tests__/new-order-layout.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { dispatchOrderToAlShrouq } from "@/lib/shams-crm/alshrouq-dispatch.server";
import { scheduleAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { DispatchDeps, DispatchRequest } from "@/lib/shams-crm/alshrouq-dispatch.server";
import { dispatchInputFor, type AlShrouqApprovalPlan } from "../approval";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const dispatchService = read("../../../lib/shams-crm/alshrouq-dispatch.server.ts");
const scheduler = read("../../../lib/shams-crm/alshrouq-scheduler.server.ts");
const card = read("../components/dispatch-section.tsx");
const dialog = read("../components/approval-dialog.tsx");
const orderForm = read("../../orders/components/order-form.tsx");
const orderPayload = read("../../orders/payload.ts");
const orderFormHook = read("../../orders/hooks/use-order-form.ts");
const orderMutations = read("../../orders/hooks/use-orders-mutations.ts");

/* ------------------------------------------------------------------------- */
/* payload_snapshot: written once, never amended                             */
/* ------------------------------------------------------------------------- */

describe("payload_snapshot immutability", () => {
  /**
   * The invariant holds structurally, not by defence. There is exactly one
   * statement in the repository that writes the column, and it is an INSERT.
   */
  it("is written in exactly one place, and that place is an insert", () => {
    const writers = [dispatchService, scheduler, card, dialog].filter((s) =>
      s.includes("payload_snapshot"),
    );
    expect(writers).toHaveLength(1);
    expect(writers[0]).toBe(scheduler);

    // In the scheduler it appears in the row literal handed to `.insert(row)`,
    // and the file's only `insert` is that one.
    const insertIndex = scheduler.indexOf(".insert(row)");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(scheduler.indexOf("payload_snapshot:")).toBeLessThan(insertIndex);
  });

  /**
   * The dangerous shape, spelled out: no `.update({...payload_snapshot...})`
   * anywhere. The worker updates the row four times — to claim it, and to record
   * each outcome — and none of those may restate what was approved.
   */
  it("appears in no update, in the scheduler or anywhere else", () => {
    for (const source of [scheduler, dispatchService, card, dialog]) {
      for (const block of source.split(".update(").slice(1)) {
        // Bounded to the update's own argument: every call in these files is
        // `.update({…}).eq(…)`, so the `.eq(` is the end of what is written.
        const written = block.slice(0, block.indexOf(".eq("));
        expect(written).not.toContain("payload_snapshot");
      }
    }
  });

  /** The worker reads the snapshot; it never rebuilds one from the order. */
  it("is read by the worker rather than reconstructed", () => {
    expect(scheduler).toContain("row.payload_snapshot");
    // The refusal path when it is missing: fail, never invent.
    expect(scheduler).toContain("The approved dispatch details are missing.");
    expect(scheduler).not.toContain('from("orders")');
  });
});

/* ------------------------------------------------------------------------- */
/* A Portal edit reaches no courier                                          */
/* ------------------------------------------------------------------------- */

describe("editing an order after it has been dispatched", () => {
  /**
   * The order save path and the dispatch path share no code and no table. An
   * edit cannot rebuild a payload, cannot touch a dispatch row, and cannot
   * contact anyone — because nothing on that path knows how.
   */
  it("does not touch alshrouq_dispatches from any order-save module", () => {
    for (const source of [orderPayload, orderFormHook, orderMutations]) {
      expect(source).not.toContain("alshrouq_dispatches");
      expect(source).not.toContain("payload_snapshot");
    }
  });

  it("does not call the dispatch service from any order-save module", () => {
    for (const source of [orderPayload, orderFormHook, orderMutations]) {
      expect(source).not.toContain("alshrouqDispatchOrder");
      expect(source).not.toContain("dispatchOrderToAlShrouq");
      expect(source).not.toContain("scheduleAlShrouqDispatch");
      expect(source).not.toContain("createAlshrouqOrder");
    }
  });

  /**
   * The one place the create journey is allowed to reach the dispatch layer is
   * `afterCreate`, which runs after an *insert*. `useOrderForm` is handed a
   * callback; it does not know what the callback does, and it is not invoked on
   * the update path.
   */
  it("reaches the approval only through the create hook, never the update path", () => {
    expect(orderFormHook).toContain("afterCreate");
    const afterUpdate = /afterUpdate|afterSave|afterEdit/.test(orderFormHook);
    expect(afterUpdate).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* One send control, and none once it has gone                               */
/* ------------------------------------------------------------------------- */

describe("the dispatch UI", () => {
  /**
   * The card is the only place a send can start. The create journey's dialog is
   * opened by the page's existing Create order button, not by a second control.
   */
  it("has exactly one send control, in the card", () => {
    const controls = card.match(/Send to AlShrouq/g) ?? [];
    expect(controls).toHaveLength(1);
    // And the card holds no dispatch form of its own any more.
    expect(card).not.toContain("Open dispatch form");
  });

  /**
   * Absent, not disabled. A disabled button beside a delivery that is already on
   * its way still invites a click, and `handedOver` is true for `indeterminate`
   * as well as `accepted`.
   */
  it("renders no send control once the order has been handed over", () => {
    expect(card).toContain("summary.handedOver ? (");
    // The action lives in the else-branch of that ternary.
    const handedOverIndex = card.indexOf("summary.handedOver ? (");
    const sendIndex = card.indexOf("Send to AlShrouq", handedOverIndex);
    const elseIndex = card.indexOf("          ) : (", handedOverIndex);
    expect(elseIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(elseIndex);
  });

  it("mounts the approval dialog only while something may still be approved", () => {
    expect(card).toContain("{ready && (");
    expect(card).toContain('mode="existing"');
  });

  /** Both journeys open the same component. There is no second dialog file. */
  it("uses one dialog for both journeys", () => {
    expect(card).toContain("AlShrouqApprovalDialog");
    expect(orderForm).toContain("AlShrouqApprovalDialog");
    expect(orderForm).toContain('mode="create"');
    expect(orderForm).not.toContain("create-approval-dialog");
  });

  /**
   * The card is a reader. It builds no payload, knows no endpoint, and reaches
   * the transport through nothing — a component that assembled requests is how
   * the reverted integration turned a re-render into a second courier.
   */
  it("assembles no request of its own", () => {
    expect(card).toContain("dispatchInputFor");
    expect(card).not.toContain("buildAlshrouqOrderPayload");
    expect(card).not.toContain("branch_id");
    expect(card).not.toContain("client_order_id");
    // No endpoint as a *value*. The prose in the header names the config
    // endpoint to explain why no delivery fee is shown, which is documentation
    // rather than something the component could send anything to.
    expect(card).not.toMatch(/["'`]\/integrations/);
    expect(card).not.toContain("shams-crm.cloud");
  });

  /** Tracking is rendered from the persisted column, never assembled. */
  it("links tracking only from the persisted URL", () => {
    expect(card).toContain("summary.trackingUrl && (");
    expect(card).toContain('rel="noopener noreferrer"');
    expect(card).not.toMatch(/https?:\/\/[^"]*\$\{/);
  });
});

describe("the order page's right-hand column", () => {
  /**
   * AlShrouq above the branch panel. The column stacks in document order on a
   * narrow screen, so whichever comes first is what an agent sees without
   * scrolling — and the delivery being acted on should not sit below reference
   * material.
   */
  it("puts the AlShrouq card before the branch card", () => {
    const alshrouq = orderForm.indexOf("<AlShrouqDispatchSection");
    const branch = orderForm.indexOf("<BranchPreviewPanel");
    expect(alshrouq).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(-1);
    expect(alshrouq).toBeLessThan(branch);
  });

  it("still renders the shared timeline component rather than a second one", () => {
    expect(orderForm).toContain("<OrderActivityTimeline");
    expect(orderForm.match(/<OrderActivityTimeline/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* The production safety gate                                                */
/* ------------------------------------------------------------------------- */

describe("the safety gate is still the only way through", () => {
  it("is read from the environment inside the service, and nowhere else", () => {
    expect(dispatchService).toContain('process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED === "true"');
    // Never inlined into a browser bundle, and never a request field.
    for (const source of [card, dialog, orderForm]) {
      expect(source).not.toContain("ALSHROUQ_LIVE_DISPATCH_ENABLED");
      expect(source).not.toContain("liveDispatchEnabled:");
    }
  });

  it("cannot be asked for by a caller", () => {
    // `DispatchRequest` has no `live` field, and neither does the shared input:
    // no property named `live` is declared or assigned on either side, so there
    // is nothing a crafted request could set.
    expect(dispatchService).not.toMatch(/\blive\s*\??\s*:\s*boolean/);
    const approval = read("../approval.ts");
    expect(approval).not.toMatch(/\blive\s*\??\s*:/);
    expect(approval).not.toContain("liveEnabled");
  });
});

/* ------------------------------------------------------------------------- */
/* Both journeys, one backend contract                                       */
/* ------------------------------------------------------------------------- */

describe("the two journeys send the same request", () => {
  const plan: AlShrouqApprovalPlan = {
    intent: "dispatch",
    paymentType: "3",
    mapUrl: "https://maps.app.goo.gl/AAA",
    lat: "24.7136",
    lng: "46.6753",
    customerName: "Ahmed",
    customerPhone: "0500000000",
    orderValue: "0",
    details: "Second floor",
  };
  const ORDER = "11111111-2222-3333-4444-555555555555";

  /**
   * The consolidation, asserted directly: whichever screen the agent approved
   * from, the request is built by one function from one plan shape.
   */
  it("builds an identical input from an identical plan", () => {
    expect(dispatchInputFor(ORDER, plan)).toEqual({
      orderId: ORDER,
      customerName: "Ahmed",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.7136",
      lng: "46.6753",
      orderValue: "0",
      details: "Second floor",
    });
  });

  /** Absent means "now". The key is omitted rather than sent as an empty value. */
  it("omits the schedule entirely for an immediate approval", () => {
    expect("scheduledFor" in dispatchInputFor(ORDER, plan)).toBe(false);
    const later = dispatchInputFor(ORDER, { ...plan, scheduledFor: "2026-08-21T12:30:00.000Z" });
    expect(later.scheduledFor).toBe("2026-08-21T12:30:00.000Z");
  });

  /** Both callers go through it, so neither can quietly gain a field. */
  it("is the only place either journey assembles a dispatch request", () => {
    const hook = read("../use-create-approval.ts");
    expect(hook).toContain("dispatchInputFor(orderId, current)");
    expect(card).toContain("dispatchInputFor(orderId!, plan)");
    // Neither builds the object inline any more.
    expect(hook).not.toContain("customerPhone: current.customerPhone");
    expect(card).not.toContain("customerPhone: f.customerPhone");
  });
});

/* ------------------------------------------------------------------------- */
/* Duplicate protection, at runtime                                          */
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

function fakeSupabase(existing?: unknown) {
  const inserts: unknown[] = [];
  return {
    inserts,
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: existing ?? null, error: null }),
      };
      chain.insert = (row: unknown) => {
        inserts.push(row);
        return {
          select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
          then: (res: any) => Promise.resolve({ data: null, error: null }).then(res),
        };
      };
      return chain;
    },
  };
}

function deps(
  live: boolean,
  createOrder = vi.fn(async () => ({
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
    liveEnabled: () => live,
  };
}

describe("an order that has already been handed over", () => {
  /** The row exists, so the check refuses before anything is built or sent. */
  it("cannot be sent again, on the immediate path", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const supabase = fakeSupabase({
      external_order_id: "6099196",
      local_id: "5263",
      status: "Order Created",
      tracking_url: null,
      dispatched_at: "2026-08-21T12:30:06.000Z",
    });

    const r = await dispatchOrderToAlShrouq(request(), supabase as any, deps(true, createOrder));

    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /** And cannot be parked for later either — a schedule reserves the same slot. */
  it("cannot be scheduled again", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase({
      external_order_id: "6099196",
      status: "Order Created",
      tracking_url: null,
      dispatched_at: "2026-08-21T12:30:06.000Z",
    });

    const r = await scheduleAlShrouqDispatch(
      request(),
      new Date(Date.now() + 3_600_000),
      supabase as any,
      deps(true, createOrder as any),
    );

    expect(r.kind).toBe("already_dispatched");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});

describe("with the gate closed", () => {
  it("the immediate path writes nothing and contacts nobody", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase();
    const r = await dispatchOrderToAlShrouq(
      request(),
      supabase as any,
      deps(false, createOrder as any),
    );

    expect(r.kind).toBe("prepared");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /**
   * Scheduling is deliberately *not* gated: parking a row contacts nobody, and
   * the gate is checked again by the worker before anything is claimed. What
   * matters is that the snapshot is what gets frozen.
   */
  it("scheduling still parks a frozen snapshot and contacts nobody", async () => {
    const createOrder = vi.fn();
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 3_600_000);

    const r = await scheduleAlShrouqDispatch(
      request(),
      when,
      supabase as any,
      deps(false, createOrder as any),
    );

    expect(r.kind).toBe("scheduled");
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(supabase.inserts).toHaveLength(1);

    const row = supabase.inserts[0] as Record<string, any>;
    expect(row.dispatch_status).toBe("scheduled");
    expect(row.scheduled_for).toBe(when.toISOString());
    expect(row.scheduled_at).toBeTruthy();
    // The snapshot is the payload, frozen — not a reference to the order.
    expect(row.payload_snapshot).toMatchObject({
      branch_id: BRANCH_ID,
      client_order_id: "9540",
      customer_name: "Ahmed",
    });
    expect(row.payload_snapshot.order_id).toBeUndefined();
  });
});
