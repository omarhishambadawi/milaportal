import { describe, expect, it } from "vitest";
import {
  clientOrderIdFor,
  dispatchBlockers,
  numberOrNull,
  toDispatchRecord,
  type OrderForDispatch,
} from "@/lib/alshrouq/dispatch";

const order = (over: Partial<OrderForDispatch> = {}): OrderForDispatch => ({
  id: "11111111-1111-1111-1111-111111111111",
  display_no: "4321",
  team: "customer_care",
  agent_id: "22222222-2222-2222-2222-222222222222",
  branch_no: "P0001",
  customer_name: "Sara",
  customer_phone: "0551234567",
  invoice_value: 240,
  notes: "Two boxes",
  delivery_type: "AlShrouq",
  status: "Pending",
  ...over,
});

describe("the reference AlShrouq is given", () => {
  it("is the order's own display number, prefixed by team", () => {
    expect(clientOrderIdFor(order())).toBe("CC-4321");
    expect(clientOrderIdFor(order({ team: "telesales" }))).toBe("TS-4321");
  });
});

describe("what blocks a dispatch", () => {
  it("passes a complete order on a covered branch", () => {
    expect(dispatchBlockers(order(), "137")).toEqual([]);
  });

  it("names an uncovered branch rather than failing at the courier", () => {
    expect(dispatchBlockers(order(), null).join(" ")).toContain("AlShrouq does not cover it");
  });

  it("reports the customer fields the courier requires", () => {
    const blockers = dispatchBlockers(order({ customer_name: null, customer_phone: "  " }), "137");
    expect(blockers).toHaveLength(2);
    expect(blockers.join(" ")).toContain("customer name");
    expect(blockers.join(" ")).toContain("phone");
  });

  it("does not ask for the payment method or coordinates, which the panel collects", () => {
    expect(dispatchBlockers(order(), "137").join(" ")).not.toContain("payment");
  });
});

describe("reading a stored dispatch row", () => {
  it("coerces the numeric columns Postgres returns as strings", () => {
    expect(numberOrNull("240.50")).toBe(240.5);
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull(null)).toBeNull();
  });

  it("treats a row with no cancellation as live", () => {
    const record = toDispatchRecord(
      {
        id: "d1",
        order_id: order().id,
        client_order_id: "CC-4321",
        local_id: "98765",
        status: "assigned",
        payment_type: "cash",
        alshrouq_branch_id: "137",
        value: "240.00",
        customer_lat: "24.71355",
        customer_lng: "46.67529",
        dispatched_at: "2026-08-20T10:00:00Z",
      },
      [],
    );
    expect(record.cancelledAt).toBeNull();
    expect(record.value).toBe(240);
    expect(record.lat).toBeCloseTo(24.71355, 5);
  });
});
