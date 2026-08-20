import { describe, expect, it } from "vitest";
import {
  clientOrderIdFor,
  coveredBranchId,
  dispatchBlockers,
  dispatchInputFor,
  numberOrNull,
  toDispatchRecord,
  type BranchCoverage,
  type OrderForDispatch,
} from "@/lib/alshrouq/dispatch";

const order = (over: Partial<OrderForDispatch> = {}): OrderForDispatch => ({
  id: "11111111-1111-1111-1111-111111111111",
  display_no: "#4321",
  team: "customer_care",
  agent_id: "22222222-2222-2222-2222-222222222222",
  branch_no: "P0001",
  customer_name: "Sara",
  customer_phone: "0551234567",
  invoice_value: 240,
  notes: "Two boxes",
  delivery_type: "AlShrouq",
  status: "Pending",
  alshrouq_map_url: "https://maps.app.goo.gl/aBcDeF",
  alshrouq_lat: 24.71355,
  alshrouq_lng: 46.67529,
  alshrouq_payment_type: 1,
  alshrouq_scheduled_at: null,
  alshrouq_historical: false,
  ...over,
});

const covered: BranchCoverage = { kind: "covered", alshrouqBranchId: "9999927657121" };
const notCovered: BranchCoverage = {
  kind: "not_covered",
  name: "Not Covered",
  note: "Not Covered",
};
const unmapped: BranchCoverage = { kind: "unmapped" };

describe("the reference AlShrouq is given", () => {
  /**
   * The regression this pins. The CRM's own dispatch history holds bare numbers
   * — "6529", "6527", "06441" — and the previous implementation sent
   * `formatOrderNo`, i.e. "CC-4321". That is a *display* rendering: it would
   * have made every Portal order unmatchable against the ones the Desktop
   * created, and broken the duplicate lookup that depends on recognising it.
   */
  it("is the order's operational number, with no team prefix", () => {
    expect(clientOrderIdFor(order())).toBe("4321");
    expect(clientOrderIdFor(order({ team: "telesales" }))).toBe("4321");
  });

  it("strips the stored '#' that display_no carries", () => {
    expect(clientOrderIdFor(order({ display_no: "#06441" }))).toBe("06441");
  });
});

describe("branch coverage", () => {
  it("yields the AlShrouq id only when the CRM says the branch is covered", () => {
    expect(coveredBranchId(covered)).toBe("9999927657121");
    expect(coveredBranchId(notCovered)).toBeNull();
    expect(coveredBranchId(unmapped)).toBeNull();
  });
});

describe("what blocks a dispatch", () => {
  it("passes a complete order on a covered branch", () => {
    expect(dispatchBlockers(order(), covered)).toEqual([]);
  });

  it("refuses a branch the CRM marks as not covered, and names it", () => {
    const message = dispatchBlockers(order(), notCovered).join(" ");
    expect(message).toContain("AlShrouq does not cover Not Covered");
  });

  it("refuses a branch the CRM's mapping has never heard of", () => {
    expect(dispatchBlockers(order(), unmapped).join(" ")).toContain("AlShrouq");
  });

  it("reports the customer fields the courier requires", () => {
    const blockers = dispatchBlockers(
      order({ customer_name: null, customer_phone: "  " }),
      covered,
    );
    expect(blockers).toHaveLength(2);
    expect(blockers.join(" ")).toContain("customer name");
    expect(blockers.join(" ")).toContain("phone");
  });

  /**
   * The delivery now lives on the order rather than in a panel, so these are
   * real requirements rather than stubs — and an order missing them is refused
   * before anything reaches the courier.
   */
  it("requires the payment method the order form collects", () => {
    expect(dispatchBlockers(order({ alshrouq_payment_type: null }), covered).join(" ")).toContain(
      "payment method",
    );
  });

  it("requires the delivery point", () => {
    const blockers = dispatchBlockers(
      order({ alshrouq_lat: null, alshrouq_lng: null }),
      covered,
    ).join(" ");
    expect(blockers).toContain("latitude");
    expect(blockers).toContain("longitude");
  });

  it("catches a transposed latitude and longitude", () => {
    const blockers = dispatchBlockers(
      order({ alshrouq_lat: 46.67529, alshrouq_lng: 24.71355 }),
      covered,
    ).join(" ");
    expect(blockers).toContain("outside Saudi Arabia");
  });

  /**
   * Historical orders — every AlShrouq order created before the delivery fields
   * existed — carry no location and no payment method, so they are refused
   * rather than silently resubmitted to the courier.
   */
  it("refuses a historical order that predates the delivery fields", () => {
    const historical = order({
      alshrouq_map_url: null,
      alshrouq_lat: null,
      alshrouq_lng: null,
      alshrouq_payment_type: null,
    });
    expect(dispatchBlockers(historical, covered).length).toBeGreaterThan(0);
  });
});

describe("the payload the order produces", () => {
  it("carries the map link, the point and the numeric payment id", () => {
    const input = dispatchInputFor(order(), coveredBranchId(covered));
    expect(input.mapUrl).toBe("https://maps.app.goo.gl/aBcDeF");
    expect(input.lat).toBeCloseTo(24.71355, 5);
    expect(input.lng).toBeCloseTo(46.67529, 5);
    expect(input.paymentType).toBe(1);
    expect(input.clientOrderId).toBe("4321");
  });

  it("reads the numeric columns Postgres returns as strings", () => {
    const input = dispatchInputFor(
      order({ alshrouq_lat: "24.71355", alshrouq_lng: "46.67529", alshrouq_payment_type: "3" }),
      coveredBranchId(covered),
    );
    expect(input.lat).toBeCloseTo(24.71355, 5);
    expect(input.paymentType).toBe(3);
  });
});

describe("reading a stored dispatch row", () => {
  it("coerces the numeric columns Postgres returns as strings", () => {
    expect(numberOrNull("240.50")).toBe(240.5);
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull(null)).toBeNull();
  });

  it("treats a row with no cancellation as live, and keeps both references", () => {
    const record = toDispatchRecord(
      {
        id: "d1",
        order_id: order().id,
        client_order_id: "4321",
        local_id: "2887",
        external_order_id: "5648616",
        status: "Order Created",
        payment_type: 1,
        alshrouq_branch_id: "9999927657121",
        customer_address: "https://maps.app.goo.gl/aBcDeF",
        tracking_url: "https://alshrouqdelivery.com/tracking/abc",
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
    expect(record.localId).toBe("2887");
    expect(record.externalOrderId).toBe("5648616");
    expect(record.paymentType).toBe(1);
    expect(record.mapUrl).toBe("https://maps.app.goo.gl/aBcDeF");
  });
});
