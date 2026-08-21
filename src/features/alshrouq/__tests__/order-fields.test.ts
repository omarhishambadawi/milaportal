/**
 * AlShrouq conditional order requirements, and the promise that they cannot
 * touch anything else.
 *
 * The load-bearing tests are the negative ones: every non-AlShrouq delivery
 * method must come back with an empty list, because the whole reason this lives
 * outside `orderFormSchema` is that the previous version's conditional rules sat
 * on the save path for orders that had nothing to do with AlShrouq.
 */

import { describe, expect, it } from "vitest";
import { DELIVERY_TYPES } from "@/lib/branches";
import {
  isAlShrouqOrderComplete,
  requiredFor,
  validateAlShrouqOrderFields,
  type AlShrouqOrderFields,
} from "@/features/alshrouq/order-fields";
import { orderFormSchema } from "@/features/orders/schema";

function fields(over: Partial<AlShrouqOrderFields> = {}): AlShrouqOrderFields {
  return {
    deliveryType: "AlShrouq",
    customerName: "Ahmed",
    customerPhone: "0500000000",
    customerLocation: "https://maps.app.goo.gl/AAA",
    latitude: "24.7136",
    longitude: "46.6753",
    ...over,
  };
}

const fieldsOf = (f: AlShrouqOrderFields) => validateAlShrouqOrderFields(f).map((i) => i.field);

describe("AlShrouq required fields", () => {
  it("accepts a complete order", () => {
    expect(validateAlShrouqOrderFields(fields())).toEqual([]);
    expect(isAlShrouqOrderComplete(fields())).toBe(true);
  });

  it("requires the customer name", () => {
    expect(fieldsOf(fields({ customerName: "   " }))).toContain("customer_name");
  });

  it("requires the customer phone", () => {
    expect(fieldsOf(fields({ customerPhone: "" }))).toContain("customer_phone");
  });

  it("requires the delivery location", () => {
    expect(fieldsOf(fields({ customerLocation: "" }))).toContain("customer_location");
  });

  it("requires the latitude", () => {
    expect(fieldsOf(fields({ latitude: "" }))).toContain("customer_lat");
  });

  it("requires the longitude", () => {
    expect(fieldsOf(fields({ longitude: "" }))).toContain("customer_lng");
  });

  it("refuses half a coordinate pair, naming the missing half", () => {
    expect(fieldsOf(fields({ longitude: "" }))).toEqual(["customer_lng"]);
    expect(fieldsOf(fields({ latitude: "" }))).toEqual(["customer_lat"]);
  });

  it("rejects a coordinate that is not a number", () => {
    expect(fieldsOf(fields({ latitude: "north-ish" }))).toContain("customer_lat");
  });

  it("accepts a zero coordinate rather than treating it as blank", () => {
    // Number("") is 0, which is why the check is explicit rather than falsy.
    expect(validateAlShrouqOrderFields(fields({ latitude: "0", longitude: "0" }))).toEqual([]);
  });

  it("reports everything missing at once", () => {
    expect(
      fieldsOf(
        fields({
          customerName: "",
          customerPhone: "",
          customerLocation: "",
          latitude: "",
          longitude: "",
        }),
      ),
    ).toEqual([
      "customer_name",
      "customer_phone",
      "customer_location",
      "customer_lat",
      "customer_lng",
    ]);
  });
});

describe("every other delivery method is untouched", () => {
  const others = DELIVERY_TYPES.filter((d) => d !== "AlShrouq");

  it.each(others)("%s requires nothing", (method) => {
    expect(requiredFor(method)).toEqual([]);
    // Entirely empty: not one field, not a coordinate, not a phone.
    expect(
      validateAlShrouqOrderFields({
        deliveryType: method,
        customerName: "",
        customerPhone: "",
        customerLocation: "",
        latitude: "",
        longitude: "",
      }),
    ).toEqual([]);
  });

  it("an unrecognised delivery method also requires nothing", () => {
    expect(requiredFor("Something New")).toEqual([]);
  });

  it("only AlShrouq has requirements at all", () => {
    expect(requiredFor("AlShrouq")).toHaveLength(5);
  });
});

/**
 * The regression guard. The previous integration broke saving by putting
 * conditional AlShrouq rules inside this schema; these assert that an order
 * still parses exactly as it did before, AlShrouq included.
 */
describe("orderFormSchema is unchanged by any of this", () => {
  const base = {
    order_date: "2026-08-21",
    team: "customer_care" as const,
    order_type: "Cash",
    branch_no: "P0127",
    delivery_type: "AlShrouq",
    invoice_value: "",
    status: "Pending",
  };

  it("saves an AlShrouq order with no customer name or phone", () => {
    // 3,993 existing AlShrouq orders look like this. The schema must still take
    // them, or editing history becomes impossible.
    expect(() => orderFormSchema.parse(base)).not.toThrow();
  });

  it("saves an AlShrouq order with no location or coordinates", () => {
    expect(() =>
      orderFormSchema.parse({ ...base, customer_name: "", customer_phone: "" }),
    ).not.toThrow();
  });

  it.each(DELIVERY_TYPES)("saves a %s order exactly as before", (method) => {
    expect(() => orderFormSchema.parse({ ...base, delivery_type: method })).not.toThrow();
  });

  it("still enforces the rules it always enforced", () => {
    expect(() => orderFormSchema.parse({ ...base, branch_no: "" })).toThrow();
    expect(() => orderFormSchema.parse({ ...base, delivery_type: "" })).toThrow();
    expect(() => orderFormSchema.parse({ ...base, order_type: "" })).toThrow();
  });
});
