/**
 * What an AlShrouq order must carry, and what every other method must not.
 *
 * Submitting an order to a courier over an API removes the person who used to
 * read the address down the phone, so three things the form has always treated
 * as optional — a name, a number, and a place — become mandatory. The rule is
 * deliberately narrow: it applies to AlShrouq and to nothing else, because
 * Store Pickup, Azman and Branch Scooter are still arranged by a human and
 * their forms must not change.
 *
 * The other half of the rule lives in the migration, which adds **no** CHECK
 * tying a location to `delivery_type`. Every AlShrouq order placed before this
 * existed has no location and never will, and a database constraint would make
 * those rows unupdatable. So: required of what an agent types now, not of what
 * is already stored.
 */

import { describe, expect, it } from "vitest";
import { orderFormSchema } from "../schema";
import { buildOrderPayload, type OrderFormState, type PersistedOrder } from "../payload";
import { summarizeInvoices } from "../invoice-verification";
import { ALSHROUQ } from "@/lib/branches";

/** A real branch coordinate from the master workbook, standing in for a home. */
const POINT = { lat: "24.5372826", lng: "46.6456098" };

function form(overrides: Partial<OrderFormState> = {}): OrderFormState {
  return {
    order_date: "2026-08-14",
    team: "customer_care",
    order_type: "Cash",
    customer_name: "Sara",
    customer_phone: "0500000000",
    alshrouq_map_url: "https://maps.app.goo.gl/aBcDeF",
    alshrouq_lat: POINT.lat,
    alshrouq_lng: POINT.lng,
    alshrouq_payment_type: "1",
    alshrouq_scheduled_at: "",
    branch_no: "P0008",
    delivery_type: ALSHROUQ,
    invoice_value: "120",
    notes: "",
    status: "Pending",
    agent_id: "11111111-1111-4111-8111-111111111111",
    call_center_verified: false,
    ...overrides,
  };
}

const persisted: PersistedOrder = {
  order_date: "2026-08-14",
  team: "customer_care",
  order_type: "Cash",
  branch_no: "P0008",
  delivery_type: ALSHROUQ,
  status: "Pending",
};

const build = (overrides: Partial<OrderFormState> = {}) =>
  buildOrderPayload({
    mode: "edit",
    form: form(overrides),
    invoiceNo: "0123892",
    persisted,
    invoices: summarizeInvoices([]),
    canAssign: true,
    canVerify: true,
  });

/** The field paths zod reported, so a test can name the control that failed. */
function issuePaths(payload: Record<string, unknown>): string[] {
  const result = orderFormSchema.safeParse(payload);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
}

describe("an AlShrouq order", () => {
  it("saves when it has a name, a number and a place", () => {
    expect(issuePaths(build())).toEqual([]);
  });

  it("is refused without a delivery location", () => {
    expect(issuePaths(build({ alshrouq_lat: "", alshrouq_lng: "" }))).toContain("alshrouq_lat");
  });

  it("is refused with half a coordinate", () => {
    // Half a pair is not a location — it would route a courier to the equator.
    expect(issuePaths(build({ alshrouq_lng: "" }))).toContain("alshrouq_lat");
  });

  it("is refused without a payment method", () => {
    expect(issuePaths(build({ alshrouq_payment_type: "" }))).toContain("alshrouq_payment_type");
  });

  it("is refused without a customer name", () => {
    expect(issuePaths(build({ customer_name: "" }))).toContain("customer_name");
    expect(issuePaths(build({ customer_name: "   " }))).toContain("customer_name");
  });

  it("is refused without a customer phone", () => {
    expect(issuePaths(build({ customer_phone: "" }))).toContain("customer_phone");
  });

  it("names every missing field at once rather than one at a time", () => {
    // An agent who pasted nothing should not have to save four times to find
    // out what is needed.
    const paths = issuePaths(
      build({ customer_name: "", customer_phone: "", alshrouq_lat: "", alshrouq_lng: "" }),
    );
    expect(paths).toEqual(
      expect.arrayContaining(["customer_name", "customer_phone", "alshrouq_lat"]),
    );
  });

  it("is refused a location outside the country", () => {
    // A swapped pair: individually plausible numbers, Indian Ocean on a map.
    expect(
      issuePaths(build({ alshrouq_lat: POINT.lng, alshrouq_lng: POINT.lat })).length,
    ).toBeGreaterThan(0);
  });
});

describe("every other delivery method", () => {
  for (const method of ["Store Pickup", "Branch Scooter", "Azman"]) {
    it(`saves ${method} with none of them, exactly as before`, () => {
      const payload = build({
        delivery_type: method,
        customer_name: "",
        customer_phone: "",
        alshrouq_map_url: "",
        alshrouq_lat: "",
        alshrouq_lng: "",
      });
      expect(issuePaths(payload)).toEqual([]);
    });
  }
});

describe("the stored location", () => {
  it("survives a change of method away from AlShrouq", () => {
    // Correcting a mis-picked method must not silently discard the customer's
    // address and force it to be re-entered to correct back.
    const payload = build({ delivery_type: "Store Pickup" });
    expect(payload.alshrouq_lat).toBe(POINT.lat);
    expect(payload.alshrouq_map_url).toBe("https://maps.app.goo.gl/aBcDeF");
  });

  it("is cleared when the agent clears it", () => {
    // Blank means blank for an optional field — the same rule the customer name
    // and notes follow, so a location can be removed rather than being sticky.
    const payload = build({
      delivery_type: "Store Pickup",
      alshrouq_map_url: "",
      alshrouq_lat: "",
      alshrouq_lng: "",
    });
    expect(payload.alshrouq_lat).toBeNull();
    expect(payload.alshrouq_map_url).toBeNull();
  });
});
