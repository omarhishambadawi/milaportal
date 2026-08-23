/**
 * The AlShrouq delivery note — one note, on the paths that already existed.
 *
 * ## What was actually added
 *
 * Almost nothing, and that is the assertion this suite is really making. The
 * driver note was already a field the whole way down:
 *
 *   `AlShrouqApprovalPlan.details` → `dispatchInputFor` → the server function's
 *   `details: z.string().max(500)` → `DispatchRequest.form.details` →
 *   `buildAlshrouqOrderPayload`'s `notes` → the CRM payload's `details` →
 *   `alshrouq_dispatches.details` and the frozen `payload_snapshot`.
 *
 * What was missing was a box to type it in. So the dialog now writes into the
 * order's own `notes` — the column the Notes card on the order page shows, that
 * `ORDER_EXPORT_COLUMNS` puts under "Notes", and that `alshrouqDispatchContext`
 * already hands back as `prefill.notes`. No second notes system, no new table,
 * no new column, no new permission, and no change to `orderFormSchema` or
 * `buildOrderPayload`, both of which have carried `notes` since before AlShrouq
 * existed.
 *
 * The tests below are therefore in two halves: the persistence path, exercised
 * for real, and the wiring, asserted on the source — because a note that reaches
 * the dispatch while never reaching the order (or the reverse) is the failure
 * worth catching, and it is a wiring failure, not a logic one.
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

describe("the note is saved with the order", () => {
  it("goes into the order's own notes column, through the ordinary save path", () => {
    // Not a new field and not a new writer: `buildOrderPayload` has always sent
    // `notes`, which is why the note survives a reopen without anything new
    // being persisted for it.
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
/* The note as the driver's note                                             */
/* ------------------------------------------------------------------------ */

describe("the note reaches AlShrouq as the payload's details", () => {
  const order = {
    display_no: "#9540",
    customer_name: "Ahmed",
    customer_phone: "0500000000",
    alshrouq_map_url: "https://maps.app.goo.gl/AAA",
    alshrouq_lat: 24.7136,
    alshrouq_lng: 46.6753,
    alshrouq_payment_type: 3,
    invoice_value: 120,
  };
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

describe("one note, and one place it is written", () => {
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

  it("writes it to the order's notes and nowhere else", () => {
    expect(orderForm).toContain(
      "onDetailsChange={(value) => setForm((f) => ({ ...f, notes: value }))}",
    );
    expect(orderForm).toContain("details={form.notes}");
  });

  it("does not add a second notes store", () => {
    // No new table, no new mutation, no note-shaped state of the dialog's own:
    // the note is `orders.notes` and the dispatch's `details`, both of which
    // already existed.
    expect(dialog).not.toMatch(/useState[^\n]*note/i);
    expect(dialog).not.toContain("supabase");
    expect(dialog).not.toContain('from("order_activity")');
  });

  it("keeps the dialog a confirmation for an order that is already saved", () => {
    // `onDetailsChange` is supplied by the create journey only. Editing a saved
    // order's note from the dialog would put a value on the dispatch that the
    // order does not hold until somebody presses Save.
    expect(section).toContain("details={ctx?.prefill.notes || notes}");
    expect(section).not.toContain("onDetailsChange");
  });

  it("shows the approved note back, from the dispatch row rather than the form", () => {
    expect(section).toContain("shown?.details");
    expect(read("../use-order-dispatch.ts")).toContain("created_at,details,");
  });
});
