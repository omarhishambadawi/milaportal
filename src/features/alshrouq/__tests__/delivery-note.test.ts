/**
 * The AlShrouq delivery note — and the order note it is no longer confused with.
 *
 * ## Two notes, two audiences
 *
 * `orders.notes` is internal: it is what the next person opening this order
 * should know, it is what the Notes card on the order page shows, and it is what
 * `ORDER_EXPORT_COLUMNS` prints under "Notes". Nobody outside the portal reads
 * it.
 *
 * The **delivery note** is an instruction handed to a driver standing at a
 * customer's door. It is collected in the AlShrouq confirmation dialog, sent
 * with the create request, and persisted on the delivery's own row.
 *
 * These were one field. The argument was that one column is simpler than two,
 * and it is — but they are different facts with different readers, so merging
 * them put internal remarks in front of a courier and made editing an internal
 * remark look like editing a delivery instruction.
 *
 * It also did not work where it mattered. The note box was rendered only when
 * the dialog was given a change handler, and only the **create** journey gave it
 * one. On an existing order — the journey a delivery is actually arranged from —
 * the note showed read-only, so a note typed at dispatch time reached nobody,
 * and a note typed into the page's Notes card behind the dialog reached AlShrouq
 * only if the agent happened to save the order first.
 *
 * ## The wire contract
 *
 * The create endpoint takes the driver note as **`details`**. That is not
 * inferred from the GET, which disagrees with the POST about field names (see
 * `value` vs `order_value`); it is read off the PharmacyCRM Desktop's own
 * `_collect_alshrouq_payload`, whose payload dict is built from
 * `('branch_id', 'client_order_id', 'customer_name', 'customer_phone',
 * 'customer_address', 'payment_type', 'details')` and posted verbatim.
 *
 * The path, end to end:
 *
 *   dialog note state -> `AlShrouqApprovalPlan.details` -> `dispatchInputFor` ->
 *   `DispatchRequest.form.details` -> `buildAlshrouqOrderPayload`'s `notes` ->
 *   the CRM payload's `details` -> `alshrouq_dispatches.details` and the frozen
 *   approval snapshot.
 *
 * The tests below are in four parts: the order's own note, which must stay
 * exactly what it was; the proof that the two are independent; the delivery
 * note's journey to the wire; and the wiring, asserted on the source — because a
 * note that reaches the dispatch while never reaching the order (or the reverse)
 * is a wiring failure, not a logic one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildAlshrouqOrderPayload } from "@/lib/shams-crm/alshrouq-payload";
import { scheduleAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { DispatchDeps, DispatchRequest } from "@/lib/shams-crm/alshrouq-dispatch.server";
import { buildOrderPayload } from "@/features/orders/payload";
import { orderFormSchema } from "@/features/orders/schema";
import { dispatchInputFor, type AlShrouqApprovalPlan } from "../approval";
import { ALSHROUQ, ALSHROUQ_NOTE_MAX } from "../constants";

const NOTE = "Second floor, ring the bell twice.";
const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";
const BRANCH_ID = "9999927657247";

/** One order, in the shape the payload builder takes. Shared by the suites below. */
const ORDER = {
  display_no: "#9540",
  customer_name: "Ahmed",
  customer_phone: "0500000000",
  alshrouq_map_url: "https://maps.app.goo.gl/AAA",
  alshrouq_lat: 24.7136,
  alshrouq_lng: 46.6753,
  alshrouq_payment_type: 3,
  invoice_value: 120,
};

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/* ------------------------------------------------------------------------ */
/* The note as the order's own note                                          */
/* ------------------------------------------------------------------------ */

/** The form state, as the order form holds it, with AlShrouq chosen. */
function form(over: Record<string, unknown> = {}) {
  return {
    order_date: "2026-08-22",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Ahmed",
    customer_phone: "0500000000",
    branch_no: "P0127",
    delivery_type: ALSHROUQ,
    invoice_value: "120",
    notes: NOTE,
    status: "Pending",
    agent_id: "",
    call_center_verified: false,
    ...over,
  };
}

const NO_INVOICES = {
  invoices: [],
  verified: [],
  verifiedTotal: 0,
  callCentreVerified: false,
} as any;

function saved(over: Record<string, unknown> = {}) {
  return buildOrderPayload({
    mode: "create",
    form: form(over) as any,
    invoiceNo: "",
    persisted: null,
    invoices: NO_INVOICES,
    canAssign: false,
    canVerify: false,
  });
}

describe("the order's own note is untouched by any of this", () => {
  it("goes into the order's own notes column, through the ordinary save path", () => {
    // Not a new field and not a new writer: `buildOrderPayload` has always sent
    // `notes`. What changed is that nothing else writes to it any more.
    expect(saved().notes).toBe(NOTE);
  });

  it("passes the order schema, which is where its length is decided", () => {
    expect(() => orderFormSchema.parse(saved())).not.toThrow();
  });

  it("is stored as absent rather than as an empty string when nobody typed one", () => {
    // Empty is a legitimate answer, and `notes` is one of the optional fields
    // `buildOrderPayload` deliberately does not fall back for — clearing it is
    // a real edit.
    expect(saved({ notes: "" }).notes).toBeNull();
  });

  it("refuses a note longer than the box allows", () => {
    const tooLong = "x".repeat(ALSHROUQ_NOTE_MAX + 1);
    expect(() => orderFormSchema.parse(saved({ notes: tooLong }))).toThrow();
    // And exactly at the limit is fine, so the box's `maxLength` and the
    // validator cannot disagree by one character.
    expect(() =>
      orderFormSchema.parse(saved({ notes: "x".repeat(ALSHROUQ_NOTE_MAX) })),
    ).not.toThrow();
  });

  it("keeps the note when the agent chooses Create order only", () => {
    // Nothing about the save path is conditional on the dispatch: "order only"
    // produces an ordinary saved order carrying an ordinary note, which is the
    // existing semantics rather than a handover nobody made.
    expect(saved().notes).toBe(NOTE);
    expect(saved().delivery_type).toBe(ALSHROUQ);
  });
});

/* ------------------------------------------------------------------------ */
/* The two are independent                                                   */
/* ------------------------------------------------------------------------ */

describe("the order note and the delivery note do not touch each other", () => {
  const DRIVER_NOTE = "Please call the customer before delivery.";

  it("sends the delivery note to the courier, and no order note with it", () => {
    // The builder is handed the *delivery* note. What the order happens to hold
    // internally is not one of its inputs and cannot reach the wire.
    const built = buildAlshrouqOrderPayload(
      { ...ORDER, notes: DRIVER_NOTE },
      { alshrouqBranchId: BRANCH_ID, paymentOptionIds: [1, 3] },
    );
    expect(built.ok && built.payload.details).toBe(DRIVER_NOTE);
    expect(built.ok && JSON.stringify(built.payload)).not.toContain(NOTE);
  });

  it("saves the order's note without a delivery note existing at all", () => {
    // An order can be saved with an internal note and no delivery. Nothing about
    // the order's note implies a handover, and nothing creates one.
    expect(saved({ notes: NOTE }).notes).toBe(NOTE);
  });

  it("takes the dispatch note from the plan and from nothing else", () => {
    // `dispatchInputFor` reads `details` off the plan the dialog built. There is
    // no parameter through which `orders.notes` could become a driver
    // instruction, which is the property the old design could not claim.
    const input = dispatchInputFor(ORDER_ID, {
      intent: "dispatch",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.7136",
      lng: "46.6753",
      customerName: "Ahmed",
      customerPhone: "0500000000",
      orderValue: "120",
      details: DRIVER_NOTE,
    });
    expect(input.details).toBe(DRIVER_NOTE);
    expect(JSON.stringify(input)).not.toContain(NOTE);
  });
});

/* ------------------------------------------------------------------------ */
/* The note as the driver's note                                             */
/* ------------------------------------------------------------------------ */

describe("the note reaches AlShrouq as the payload's details", () => {
  const order = ORDER;
  const context = { alshrouqBranchId: BRANCH_ID, paymentOptionIds: [1, 3] };

  it("carries the note as `details`", () => {
    const built = buildAlshrouqOrderPayload({ ...order, notes: NOTE }, context);
    expect(built.ok && built.payload.details).toBe(NOTE);
  });

  it("omits the key entirely when there is no note", () => {
    // The contract's optional keys are absent rather than null — an empty
    // driver note is not a driver note.
    const built = buildAlshrouqOrderPayload({ ...order, notes: "" }, context);
    expect(built.ok && "details" in built.payload).toBe(false);
  });

  it("is the same value the approval plan carried", () => {
    const plan: AlShrouqApprovalPlan = {
      intent: "dispatch",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/AAA",
      lat: "24.7136",
      lng: "46.6753",
      customerName: "Ahmed",
      customerPhone: "0500000000",
      orderValue: "120",
      details: NOTE,
    };
    expect(dispatchInputFor(ORDER_ID, plan).details).toBe(NOTE);
  });
});

/* ------------------------------------------------------------------------ */
/* The note on the dispatch row                                              */
/* ------------------------------------------------------------------------ */

/** The scheduler's Supabase stand-in, cut down to the insert this asserts on. */
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

function deps(): Partial<DispatchDeps> {
  return {
    fetchOptions: async () => ({
      branchOptions: [
        {
          id: BRANCH_ID,
          internal_code: "P0127",
          branch_name: "Al Yasmin",
          label: "P0127 | Al Yasmin",
          covered: true,
          note: null,
        },
      ],
      paymentOptions: [
        { id: 1, label: "COD" },
        { id: 3, label: "Paid" },
      ],
    }),
    // Present so a mistake here would be visible as a call, never as a send.
    createOrder: vi.fn() as any,
  };
}

function request(details: string): DispatchRequest {
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
      lat: "24.7136",
      lng: "46.6753",
      orderValue: "120",
      details,
    },
  };
}

describe("the note is frozen onto the dispatch", () => {
  it("is written to the row and into the immutable snapshot", async () => {
    const supabase = fakeSupabase();
    const result = await scheduleAlShrouqDispatch(
      request(NOTE),
      new Date(Date.now() + 5 * 60 * 60 * 1000),
      supabase as any,
      deps(),
    );

    expect(result.kind).toBe("scheduled");
    const row = supabase.inserts[0]!;
    // The column the card reads back on a reopen…
    expect(row.details).toBe(NOTE);
    // …and the snapshot the worker dispatches from, so an order edited after
    // approval still hands the courier the note that was approved.
    expect(row.payload_snapshot.details).toBe(NOTE);
  });

  it("writes null rather than an empty string when there is no note", async () => {
    const supabase = fakeSupabase();
    await scheduleAlShrouqDispatch(
      request(""),
      new Date(Date.now() + 5 * 60 * 60 * 1000),
      supabase as any,
      deps(),
    );
    expect(supabase.inserts[0]!.details).toBeNull();
  });

  it("attributes the approval to the verified session, never to anything sent", async () => {
    // The note is the only thing the browser contributes. Who approved it, when,
    // and which order it belongs to are all derived server-side.
    const supabase = fakeSupabase();
    await scheduleAlShrouqDispatch(
      request(NOTE),
      new Date(Date.now() + 5 * 60 * 60 * 1000),
      supabase as any,
      deps(),
    );
    const row = supabase.inserts[0]!;
    expect(row.scheduled_by).toBe(USER_ID);
    expect(row.dispatched_by).toBe(USER_ID);
    expect(row.order_id).toBe(ORDER_ID);
    expect(typeof row.scheduled_at).toBe("string");
  });
});

/* ------------------------------------------------------------------------ */
/* The wiring                                                                */
/* ------------------------------------------------------------------------ */

describe("one delivery note, collected where the delivery is approved", () => {
  const dialog = read("../components/approval-dialog.tsx");
  const orderForm = read("../../orders/components/order-form.tsx");
  const section = read("../components/dispatch-section.tsx");

  it("collects the note in the confirmation dialog", () => {
    expect(dialog).toContain('id="alshrouq-delivery-note"');
    expect(dialog).toContain("Delivery note");
    // The limit comes from the constant both validators are pinned to, never
    // from a number typed into the markup.
    expect(dialog).toContain("maxLength={ALSHROUQ_NOTE_MAX}");
  });

  it("makes the box editable on both journeys, not just on create", () => {
    /*
     * The reported bug, as a source assertion.
     *
     * The box used to be rendered only when an `onDetailsChange` prop was
     * supplied, and only the create journey supplied one — so on an existing
     * order, which is the journey a delivery is normally arranged from, the
     * dialog showed the note read-only and there was nowhere to type one. The
     * textarea is now unconditional and bound to the dialog's own state.
     */
    expect(dialog).not.toContain("onDetailsChange");
    expect(dialog).toContain("value={note}");
    expect(dialog).toContain("onChange={(e) => setNote(e.target.value)}");
  });

  it("hands the typed note back in the plan as `details`", () => {
    // The one value the browser contributes to a dispatch. Everything else in
    // the plan is copied from the order.
    expect(dialog).toContain("details: note,");
  });

  it("never writes into the order's own notes field", () => {
    /*
     * The separation, asserted where it was previously broken. The order form
     * used to pass `details={form.notes}` and a handler that wrote the dialog's
     * text straight back into `orders.notes`, which is what made an internal
     * remark and a driver instruction the same string.
     */
    expect(orderForm).not.toContain("onDetailsChange");
    expect(orderForm).not.toContain("details={form.notes}");
    // The order's Notes card is still there, still bound to `form.notes`, and
    // is now the only thing that writes to it.
    expect(orderForm).toContain('id="order-notes"');
    expect(orderForm).toContain("setForm((f) => ({ ...f, notes: e.target.value }))");
  });

  it("does not add a second notes store", () => {
    // No new table, no new mutation, no new column: the note is the dispatch
    // row's `details`, which already existed and is what AlShrouq is told.
    expect(dialog).not.toContain("supabase");
    expect(dialog).not.toContain('from("order_activity")');
  });

  it("shows the delivery's own note back, never the order's", () => {
    /*
     * The card used to fall back to the order's `notes` when the dispatch had
     * none, so an internal remark appeared under the heading "Delivery note" —
     * describing instructions no courier had been given. It reads the row only.
     */
    expect(section).toContain("shown?.details");
    expect(section).not.toContain("shown?.details?.trim() || notes");
    expect(section).not.toContain("ctx?.prefill.notes");
    expect(read("../use-order-dispatch.ts")).toContain("created_at,details,");
  });
});
