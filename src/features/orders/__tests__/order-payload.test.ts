/**
 * What an order save actually sends.
 *
 * This suite exists for one production failure: editing an order and changing
 * only its value was rejected with
 * `delivery_type: "Delivery / pickup method is required"`, on orders that have
 * a delivery method — every row in the database has one. The field was not
 * missing from the order, it was missing from the *form state* at submit, and
 * the payload was built from that state alone.
 *
 * So the rule under test is the one in `buildOrderPayload`: a **required** field
 * left blank is a hydration failure, never an intention, and an existing order
 * falls back to its stored value. Optional fields do the opposite — blank is a
 * real edit and must be sent as null, or they could never be cleared.
 */

import { describe, expect, it } from "vitest";
import { orderFormSchema } from "../schema";
import { buildOrderPayload, type OrderFormState, type PersistedOrder } from "../payload";
import { summarizeInvoices, type OrderInvoice } from "../invoice-verification";

const NOTHING_VERIFIED = summarizeInvoices([]);

function verifiedInvoice(invoiceNo: string, total: number, isCallCentre = true): OrderInvoice {
  return {
    invoiceNo,
    key: invoiceNo.replace(/^0+/, "") || "0",
    state: "verified",
    branchCode: "P0008",
    customer: isCallCentre ? "HOME DELIVERY-Call Centre" : "CASH IN BOX-",
    isCallCentre,
    total,
    docDate: "2026-08-14T00:00:00",
    cancelled: false,
    items: [],
  };
}

/** A fully hydrated form, as the agent sees it on a loaded order. */
function form(overrides: Partial<OrderFormState> = {}): OrderFormState {
  return {
    order_date: "2026-08-14",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Sara",
    customer_phone: "0500000000",
    // The helper's method is AlShrouq, which since the delivery location was
    // added is the one method that requires a customer location — so a "fully
    // hydrated" AlShrouq form has one.
    alshrouq_map_url: "https://maps.app.goo.gl/aBcDeF",
    alshrouq_lat: "24.5372826",
    alshrouq_lng: "46.6456098",
    alshrouq_payment_type: "1",
    alshrouq_scheduled_at: "",
    branch_no: "P0008",
    delivery_type: "AlShrouq",
    invoice_value: "1261.40",
    notes: "leave at reception",
    status: "Completed",
    agent_id: "11111111-1111-4111-8111-111111111111",
    call_center_verified: false,
    ...overrides,
  };
}

/** The same order, as stored. */
function persisted(overrides: Partial<PersistedOrder> = {}): PersistedOrder {
  return {
    order_date: "2026-08-14",
    team: "customer_care",
    order_type: "Cash",
    branch_no: "P0008",
    delivery_type: "AlShrouq",
    status: "Completed",
    ...overrides,
  };
}

const build = (args: Partial<Parameters<typeof buildOrderPayload>[0]> = {}) =>
  buildOrderPayload({
    mode: "edit",
    form: form(),
    invoiceNo: "0123892",
    persisted: persisted(),
    invoices: NOTHING_VERIFIED,
    canAssign: true,
    canVerify: true,
    ...args,
  });

/* -------------------------------------------------------------------------- */
/* The reported failure                                                        */
/* -------------------------------------------------------------------------- */

describe("editing an order whose delivery method did not reach the form", () => {
  it("falls back to the stored value instead of sending it empty", () => {
    // The exact reported state: everything hydrated except this one field.
    const payload = build({ form: form({ delivery_type: "" }) });
    expect(payload.delivery_type).toBe("AlShrouq");
    expect(() => orderFormSchema.parse(payload)).not.toThrow();
  });

  it("used to fail validation, and the schema still would on its own", () => {
    // Proof that the fix is in the payload and not in a weakened schema: the
    // blank value is still rejected when nothing backs it.
    expect(() => orderFormSchema.parse({ ...build(), delivery_type: "" })).toThrow();
  });

  it("keeps a pickup order on pickup", () => {
    const payload = build({
      form: form({ delivery_type: "" }),
      persisted: persisted({ delivery_type: "Store Pickup" }),
    });
    expect(payload.delivery_type).toBe("Store Pickup");
  });

  it("prefers what the agent actually chose over the stored value", () => {
    const payload = build({
      form: form({ delivery_type: "Azman" }),
      persisted: persisted({ delivery_type: "Store Pickup" }),
    });
    expect(payload.delivery_type).toBe("Azman");
  });

  it("backs up every required field, not only the one that was reported", () => {
    // A form that lost everything — a save attempted before the fetch landed.
    const blank = form({
      order_date: "",
      team: "",
      order_type: "",
      branch_no: "",
      delivery_type: "",
      status: "",
    });
    const payload = build({ form: blank });
    expect(payload).toMatchObject({
      order_date: "2026-08-14",
      team: "customer_care",
      order_type: "Cash",
      branch_no: "P0008",
      delivery_type: "AlShrouq",
      status: "Completed",
    });
    expect(() => orderFormSchema.parse(payload)).not.toThrow();
  });

  it("does not invent a value for a new order, which has nothing to fall back to", () => {
    const payload = buildOrderPayload({
      mode: "create",
      form: form({ delivery_type: "" }),
      invoiceNo: "",
      persisted: undefined,
      invoices: NOTHING_VERIFIED,
      canAssign: true,
      canVerify: true,
    });
    expect(payload.delivery_type).toBe("");
    expect(() => orderFormSchema.parse(payload)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing else may be dropped while fixing that                               */
/* -------------------------------------------------------------------------- */

describe("the full edit payload", () => {
  it("carries every field the order has", () => {
    const payload = build();
    for (const field of [
      "order_date",
      "team",
      "order_type",
      "branch_no",
      "delivery_type",
      "status",
      "customer_name",
      "customer_phone",
      "notes",
      "invoice_no",
      "invoice_value",
    ]) {
      expect(payload, field).toHaveProperty(field);
    }
    expect(() => orderFormSchema.parse(payload)).not.toThrow();
  });

  it("passes each edited field through", () => {
    const payload = build({
      form: form({
        branch_no: "P0206",
        customer_name: "Ahmed",
        customer_phone: "0511111111",
        notes: "call before delivery",
        order_type: "Wasfaty",
        delivery_type: "Branch Scooter",
        order_date: "2026-08-15",
        status: "Pending",
      }),
      invoiceNo: "0123891, 0123892",
    });
    expect(payload).toMatchObject({
      branch_no: "P0206",
      customer_name: "Ahmed",
      customer_phone: "0511111111",
      notes: "call before delivery",
      order_type: "Wasfaty",
      delivery_type: "Branch Scooter",
      order_date: "2026-08-15",
      status: "Pending",
      invoice_no: "0123891, 0123892",
    });
  });

  it("lets the optional fields be cleared, which the required ones may not be", () => {
    // The mirror-image bug: backing these off the stored row would make a
    // customer name impossible to remove.
    const payload = build({
      form: form({ customer_name: "", customer_phone: "", notes: "" }),
      invoiceNo: "",
    });
    expect(payload.customer_name).toBeNull();
    expect(payload.customer_phone).toBeNull();
    expect(payload.notes).toBeNull();
    expect(payload.invoice_no).toBeNull();
  });

  it("keeps a new order Pending whatever the form holds", () => {
    const payload = buildOrderPayload({
      mode: "create",
      form: form({ status: "Completed" }),
      invoiceNo: "",
      persisted: undefined,
      invoices: NOTHING_VERIFIED,
      canAssign: true,
      canVerify: true,
    });
    expect(payload.status).toBe("Pending");
  });
});

/* -------------------------------------------------------------------------- */
/* Assignment and the Call Center flag                                         */
/* -------------------------------------------------------------------------- */

describe("assignment in the payload", () => {
  it("is sent when the caller may reassign", () => {
    expect(build({ canAssign: true }).agent_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("is left out entirely when they may not, rather than written back", () => {
    expect(build({ canAssign: false }).agent_id).toBeUndefined();
  });
});

describe("the Call Center flag in the payload", () => {
  it("is left out for a caller who may not verify", () => {
    expect(build({ canVerify: false }).call_center_verified).toBeUndefined();
  });

  it("sends a manual tick", () => {
    expect(build({ form: form({ call_center_verified: true }) }).call_center_verified).toBe(true);
  });

  it("never sends false over a flag a verified call-centre invoice has set", () => {
    // Otherwise a save carrying stale form state unticks an automated result.
    const invoices = summarizeInvoices([verifiedInvoice("0123892", 1261.4, true)]);
    expect(
      build({ invoices, form: form({ call_center_verified: false }) }).call_center_verified,
    ).toBeUndefined();
  });

  it("still sends false when nothing call-centre is verified", () => {
    const invoices = summarizeInvoices([verifiedInvoice("0123891", 242.71, false)]);
    expect(
      build({ invoices, form: form({ call_center_verified: false }) }).call_center_verified,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The value a save writes                                                     */
/* -------------------------------------------------------------------------- */

describe("order value in the payload", () => {
  it("keeps what the agent typed while nothing is verified", () => {
    expect(build({ form: form({ invoice_value: "1000" }) }).invoice_value).toBe(1000);
  });

  it("overrides a manual figure with the verified total", () => {
    // Part 11: a manual value must not permanently outrank a verified invoice.
    const invoices = summarizeInvoices([verifiedInvoice("0123892", 1261.4)]);
    expect(build({ invoices, form: form({ invoice_value: "1000" }) }).invoice_value).toBe(1261.4);
  });

  it("sums several verified invoices rather than taking one", () => {
    const invoices = summarizeInvoices([
      verifiedInvoice("0123891", 242.71, false),
      verifiedInvoice("0123892", 1261.4, true),
    ]);
    expect(build({ invoices, form: form({ invoice_value: "1000" }) }).invoice_value).toBe(1504.11);
  });

  it("leaves an untouched empty value null rather than zero", () => {
    expect(build({ form: form({ invoice_value: "" }) }).invoice_value).toBeNull();
  });
});
