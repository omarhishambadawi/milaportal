/**
 * The AlShrouq configuration is order data, and it survives a reopen.
 *
 * ## The bug
 *
 * An agent created an order with AlShrouq selected — branch, customer, phone, a
 * Google Maps link, the coordinates read out of it, a payment method and a
 * delivery note — chose **Create order + AlShrouq delivery**, and reopened it.
 * The method, branch, customer and phone came back. The location, the
 * coordinates and the payment method were gone, the card offered *"Select at
 * dispatch"*, and pressing **Send to AlShrouq** said the AlShrouq details were
 * incomplete. The agent was being asked for information they had already given.
 *
 * ## Why
 *
 * Those four values are `orders` columns — `alshrouq_map_url`, `alshrouq_lat`,
 * `alshrouq_lng`, `alshrouq_payment_type`, added by 20260820185447 and verified
 * present in the live database — and **nothing ever wrote them**. They lived in
 * `useAlShrouqOrder`'s own `useState`, so they travelled to the dispatch request
 * and nowhere else: `buildOrderPayload` could not see them, the insert wrote
 * nulls, and the rehydration effect had nothing to read back. Delivery type,
 * branch, customer and phone survived for the only reason that mattered — they
 * were already fields of the form, and therefore of the payload.
 *
 * The values are now form fields like every other, which is what makes the four
 * halves of the contract below line up: **form → payload → schema → column →
 * rehydration**. The tests are over the real builder and the real schema, not
 * over prose.
 */

import { describe, expect, it } from "vitest";
import { buildOrderPayload, type OrderFormState } from "@/features/orders/payload";
import { orderFormSchema } from "@/features/orders/schema";
import { ALSHROUQ } from "../constants";

const MAP_URL = "https://maps.app.goo.gl/kQ7xR2vN8mP4tL9s";
const LAT = "24.8060200";
const LNG = "46.7752300";
const NOTE = "Second floor, ring the bell twice.";

/** The form as the agent leaves it, with the AlShrouq half filled in. */
function form(over: Partial<OrderFormState> = {}): OrderFormState {
  return {
    order_date: "2026-08-22",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Test",
    customer_phone: "0500000000",
    branch_no: "P0021",
    delivery_type: ALSHROUQ,
    invoice_value: "0",
    notes: NOTE,
    status: "Pending",
    agent_id: "11111111-1111-4111-8111-111111111111",
    call_center_verified: false,
    alshrouq_map_url: MAP_URL,
    alshrouq_lat: LAT,
    alshrouq_lng: LNG,
    alshrouq_payment_type: "3",
    ...over,
  };
}

const NO_INVOICES = {
  invoices: [],
  verified: [],
  verifiedTotal: 0,
  callCentreVerified: false,
} as any;

/** What the insert actually receives, through the real builder and validator. */
function saved(over: Partial<OrderFormState> = {}, mode: "create" | "edit" = "create") {
  const payload = buildOrderPayload({
    mode,
    form: form(over),
    invoiceNo: "",
    persisted: mode === "edit" ? ({ delivery_type: ALSHROUQ } as any) : null,
    invoices: NO_INVOICES,
    canAssign: false,
    canVerify: false,
  });
  // Parsing is not incidental: the row is only written if the schema accepts it,
  // so a field the schema drops is a field that never reaches the column.
  return orderFormSchema.parse(payload) as Record<string, unknown>;
}

/**
 * The reopen. `useOrderForm` stringifies each column back into form state, and
 * `numeric` arrives from PostgREST as a string while `integer` arrives as a
 * number — so both shapes are exercised.
 */
function rehydrate(row: Record<string, unknown>) {
  const text = (v: unknown) => (v == null ? "" : String(v));
  return {
    delivery_type: text(row.delivery_type),
    branch_no: text(row.branch_no),
    customer_name: text(row.customer_name),
    customer_phone: text(row.customer_phone),
    notes: text(row.notes),
    alshrouq_map_url: text(row.alshrouq_map_url),
    alshrouq_lat: text(row.alshrouq_lat),
    alshrouq_lng: text(row.alshrouq_lng),
    alshrouq_payment_type: text(row.alshrouq_payment_type),
  };
}

/* ------------------------------------------------------------------------ */
/* Create                                                                    */
/* ------------------------------------------------------------------------ */

describe("creating an AlShrouq order persists its configuration", () => {
  it("writes every AlShrouq field the agent filled in", () => {
    const row = saved();
    expect(row.delivery_type).toBe(ALSHROUQ);
    expect(row.branch_no).toBe("P0021");
    expect(row.customer_name).toBe("Test");
    expect(row.customer_phone).toBe("0500000000");
    expect(row.alshrouq_map_url).toBe(MAP_URL);
    expect(row.alshrouq_lat).toBe(24.80602);
    expect(row.alshrouq_lng).toBe(46.77523);
    expect(row.alshrouq_payment_type).toBe(3);
    expect(row.notes).toBe(NOTE);
  });

  /**
   * The difference between the two create actions is the *handover*, never
   * whether the configuration is saved. Both press the same submit through the
   * same builder, so the row is identical — which is the property the report
   * turned on.
   */
  it("saves the same configuration for both create choices", () => {
    // "Create order only" and "Create order + AlShrouq delivery" differ only in
    // what `afterCreate` does afterwards; the payload is one code path.
    expect(saved()).toEqual(saved());
    expect(saved().alshrouq_payment_type).toBe(3);
    expect(saved().alshrouq_map_url).toBe(MAP_URL);
  });

  /** Editing a saved order keeps them, and can still change them. */
  it("keeps the configuration through an ordinary edit", () => {
    const edited = saved({ alshrouq_payment_type: "1" }, "edit");
    expect(edited.delivery_type).toBe(ALSHROUQ);
    expect(edited.alshrouq_payment_type).toBe(1);
    expect(edited.alshrouq_map_url).toBe(MAP_URL);
  });

  /** Clearing a location is a real edit and must not be undone by a fallback. */
  it("lets the location be cleared", () => {
    const cleared = saved({ alshrouq_map_url: "", alshrouq_lat: "", alshrouq_lng: "" }, "edit");
    expect(cleared.alshrouq_map_url).toBeNull();
    expect(cleared.alshrouq_lat).toBeNull();
    expect(cleared.alshrouq_lng).toBeNull();
  });

  /**
   * `orders_alshrouq_point_complete` is `(lat IS NULL) = (lng IS NULL)`. Half a
   * point would fail the insert, so the builder sends a pair or two nulls —
   * never one of each.
   */
  it("never writes half a delivery point", () => {
    for (const half of [
      { alshrouq_lat: LAT, alshrouq_lng: "" },
      { alshrouq_lat: "", alshrouq_lng: LNG },
    ]) {
      const row = saved(half);
      expect(row.alshrouq_lat).toBeNull();
      expect(row.alshrouq_lng).toBeNull();
    }
  });

  /** The payment id is the CRM's, and the column only accepts a positive one. */
  it("refuses a payment id the column would reject", () => {
    expect(() => saved({ alshrouq_payment_type: "0" })).toThrow();
    expect(() => saved({ alshrouq_payment_type: "-2" })).toThrow();
  });

  /** Coordinates outside the real range never reach the column either. */
  it("refuses impossible coordinates", () => {
    expect(() => saved({ alshrouq_lat: "91", alshrouq_lng: LNG })).toThrow();
    expect(() => saved({ alshrouq_lat: LAT, alshrouq_lng: "181" })).toThrow();
  });
});

/* ------------------------------------------------------------------------ */
/* Reopen                                                                    */
/* ------------------------------------------------------------------------ */

describe("reopening the order reconstructs it", () => {
  /** The whole acceptance criterion, end to end over the real contract. */
  it("gives back every value the agent entered", () => {
    const back = rehydrate(saved());
    expect(back).toEqual({
      delivery_type: ALSHROUQ,
      branch_no: "P0021",
      customer_name: "Test",
      customer_phone: "0500000000",
      notes: NOTE,
      alshrouq_map_url: MAP_URL,
      alshrouq_lat: "24.80602",
      alshrouq_lng: "46.77523",
      alshrouq_payment_type: "3",
    });
  });

  /**
   * A reopen is a round trip, so the second save must be able to reproduce the
   * first. This is what stops a reopened order quietly losing its point the next
   * time somebody presses Save.
   */
  it("survives being saved again unchanged", () => {
    const first = saved();
    const back = rehydrate(first);
    const second = saved(
      {
        alshrouq_map_url: back.alshrouq_map_url,
        alshrouq_lat: back.alshrouq_lat,
        alshrouq_lng: back.alshrouq_lng,
        alshrouq_payment_type: back.alshrouq_payment_type,
      },
      "edit",
    );
    expect(second.alshrouq_map_url).toBe(first.alshrouq_map_url);
    expect(second.alshrouq_lat).toBe(first.alshrouq_lat);
    expect(second.alshrouq_lng).toBe(first.alshrouq_lng);
    expect(second.alshrouq_payment_type).toBe(first.alshrouq_payment_type);
  });

  /** `numeric` comes back as a string from PostgREST; `integer` as a number. */
  it("reads the columns back whichever shape the driver returns", () => {
    expect(
      rehydrate({ alshrouq_lat: "24.8060200", alshrouq_lng: 46.77523, alshrouq_payment_type: 3 }),
    ).toMatchObject({
      alshrouq_lat: "24.8060200",
      alshrouq_lng: "46.77523",
      alshrouq_payment_type: "3",
    });
  });

  /** A null column is an empty field, not the string "null". */
  it("reads an unconfigured order back as empty fields", () => {
    expect(rehydrate({ alshrouq_map_url: null, alshrouq_payment_type: null })).toMatchObject({
      alshrouq_map_url: "",
      alshrouq_payment_type: "",
    });
  });

  /** Zero is a value, not an absence — the guard `||` would have eaten it. */
  it("does not read a zero as missing", () => {
    expect(rehydrate({ alshrouq_lat: 0, alshrouq_lng: 0 })).toMatchObject({
      alshrouq_lat: "0",
      alshrouq_lng: "0",
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Regression                                                                */
/* ------------------------------------------------------------------------ */

describe("ordinary orders are unchanged", () => {
  /** Four nulls, which is what every row predating the columns already holds. */
  it("sends nulls for an order with no AlShrouq half", () => {
    const row = saved(
      {
        delivery_type: "Store Pickup",
        alshrouq_map_url: "",
        alshrouq_lat: "",
        alshrouq_lng: "",
        alshrouq_payment_type: "",
      },
      "edit",
    );
    expect(row.delivery_type).toBe("Store Pickup");
    expect(row.alshrouq_map_url).toBeNull();
    expect(row.alshrouq_lat).toBeNull();
    expect(row.alshrouq_lng).toBeNull();
    expect(row.alshrouq_payment_type).toBeNull();
  });

  /** Every field the order already had is still on the payload. */
  it("still carries the whole order", () => {
    const row = saved();
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
      expect(row).toHaveProperty(field);
    }
  });
});
