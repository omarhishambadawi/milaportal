import { describe, expect, it } from "vitest";
import {
  buildAlShrouqCreatePayload,
  findByClientOrderId,
  normalizeAlShrouqConfig,
  readAlShrouqState,
  validateAlShrouqOrder,
  type AlShrouqOrderInput,
} from "@/lib/shams-crm/alshrouq";

/**
 * The shapes in this file are the CRM's own, not invented for the test.
 *
 * They are trimmed copies of a live `GET /integrations/alshrouq/config` and a
 * live `GET /integrations/alshrouq/orders` captured from the PharmacyCRM Desktop
 * package's local cache. Credentials from that capture — the webhook auth value
 * in particular — are represented by an obvious placeholder and never the real
 * secret, and the assertions below check the reader drops it rather than
 * carrying it anywhere.
 */
const CONFIG_RESPONSE = {
  integration_base: "https://alshrouqdelivery.com/api/integration",
  management_base: "https://alshrouqdelivery.com/api/integration",
  webhook_url: "https://shams-crm.cloud/integrations/alshrouq/webhook",
  webhook_auth_header: "Authorization",
  webhook_auth_value: "PLACEHOLDER-NOT-THE-REAL-SECRET",
  branch_options: [
    {
      id: "9999927657121",
      label: "P0001 | Hazm RDHS",
      internal_code: "P0001",
      branch_name: "Hazm RDHS",
      covered: true,
      note: null,
    },
    {
      id: "9999927657127",
      label: "P0007 | Not Covered | Not Covered",
      internal_code: "P0007",
      branch_name: "Not Covered",
      covered: false,
      note: "Not Covered",
    },
    {
      id: "9999927657171",
      label: "P0111 | Khalidia RDHN",
      internal_code: "P0111",
      branch_name: "Khalidia RDHN",
      covered: true,
      note: null,
    },
  ],
  payment_options: [
    { id: 1, label: "COD" },
    { id: 2, label: "SPAN Machine" },
    { id: 3, label: "Paid" },
    { id: 4, label: "AlshrouqPay" },
  ],
  missing_secrets: [],
};

const ORDER_RECORD = {
  id: 2887,
  external_order_id: 5648616,
  client_order_id: "6529",
  branch_id: "9999927657171",
  customer_name: "Test Customer",
  customer_phone: "+966 50 779 3742",
  customer_address: "https://www.google.com/maps?q=21.206645,40.353675&z=17&hl=en",
  customer_lat: 21.206891,
  customer_lng: 40.353761,
  payment_type: 1,
  order_value: 50.48,
  preparation_time: 10,
  details: null,
  status_id: "23",
  status_label: "Order Created",
  tracking_url: "https://alshrouqdelivery.com/tracking/abc",
  driver_name: null,
  is_cancelled: false,
};

describe("reading the CRM's AlShrouq config", () => {
  const config = normalizeAlShrouqConfig(CONFIG_RESPONSE);

  /**
   * The regression this pins. The previous reader looked for `payment_types`,
   * `payment_methods`, `payments` and `paymentTypes` — none of which the CRM
   * sends. It therefore found no payment methods at all, and dispatch could
   * never be enabled on any deployment.
   */
  it("reads payment methods from `payment_options`, as numeric ids", () => {
    expect(config.paymentTypes).toEqual([
      { value: 1, label: "COD" },
      { value: 2, label: "SPAN Machine" },
      { value: 3, label: "Paid" },
      { value: 4, label: "AlshrouqPay" },
    ]);
  });

  it("reads the branch mapping the CRM publishes, keyed by Shams branch code", () => {
    expect(config.branches).toHaveLength(3);
    expect(config.branches.find((b) => b.code === "P0111")?.id).toBe("9999927657171");
  });

  /**
   * The 27-branch corruption in concrete terms. The dropped migration mapped
   * `9999927657171` to a fabricated `P0051`; the CRM says it is `P0111`.
   */
  it("maps 9999927657171 to P0111, not to the fabricated P0051", () => {
    const byId = config.branches.find((b) => b.id === "9999927657171");
    expect(byId?.code).toBe("P0111");
    expect(config.branches.some((b) => b.code === "P0051")).toBe(false);
  });

  it("keeps the CRM's `covered` flag, so an unserved branch can be refused", () => {
    expect(config.branches.find((b) => b.code === "P0007")?.covered).toBe(false);
    expect(config.branches.find((b) => b.code === "P0001")?.covered).toBe(true);
  });

  it("carries no secret out of the response", () => {
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("PLACEHOLDER-NOT-THE-REAL-SECRET");
    expect(serialized).not.toContain("webhook_auth");
  });

  it("yields nothing rather than a guess when the response is unreadable", () => {
    const empty = normalizeAlShrouqConfig({ nonsense: true });
    expect(empty.paymentTypes).toEqual([]);
    expect(empty.branches).toEqual([]);
  });
});

describe("the create payload", () => {
  const input = (over: Partial<AlShrouqOrderInput> = {}): AlShrouqOrderInput => ({
    alshrouqBranchId: "9999927657171",
    clientOrderId: "6529",
    customerName: "Test Customer",
    customerPhone: "0507793742",
    mapUrl: "https://maps.app.goo.gl/aBcDeF",
    paymentType: 1,
    details: null,
    lat: 24.71355,
    lng: 46.67529,
    value: 240,
    preparationTime: null,
    ...over,
  });

  it("sends the customer's map link as `customer_address`", () => {
    expect(buildAlShrouqCreatePayload(input()).customer_address).toBe(
      "https://maps.app.goo.gl/aBcDeF",
    );
  });

  /**
   * The defect this replaces: the previous panel captured coordinates into a
   * box labelled "Delivery location" and left `customer_address` empty — its own
   * comment conceded it was "usually nothing". Every CRM record has a link.
   */
  it("never sends an empty address — a typed point still yields a link", () => {
    const payload = buildAlShrouqCreatePayload(input({ mapUrl: null }));
    expect(payload.customer_address).toMatch(/^https?:\/\//);
    expect(payload.customer_address).toContain("24.71355");
  });

  it("sends the payment method as a number", () => {
    expect(buildAlShrouqCreatePayload(input()).payment_type).toBe(1);
  });

  it("omits preparation_time rather than inventing one", () => {
    expect(buildAlShrouqCreatePayload(input())).not.toHaveProperty("preparation_time");
  });

  it("refuses a non-numeric payment method", () => {
    const errors = validateAlShrouqOrder(input({ paymentType: null }));
    expect(errors.map((e) => e.field)).toContain("paymentType");
  });
});

describe("reading what the CRM says back", () => {
  const state = readAlShrouqState(ORDER_RECORD);

  it("keeps AlShrouq's own order number as well as the CRM's row id", () => {
    expect(state.localId).toBe("2887");
    expect(state.externalOrderId).toBe("5648616");
  });

  it("prefers the human status label over the bare status code", () => {
    expect(state.status).toBe("Order Created");
  });

  it("reads the tracking link and the cancellation flag", () => {
    expect(state.trackingUrl).toBe("https://alshrouqdelivery.com/tracking/abc");
    expect(state.cancelled).toBe(false);
  });

  it("produces all-nulls rather than an invented status for an unreadable body", () => {
    const unknown = readAlShrouqState({ unexpected: "shape" });
    expect(unknown.status).toBeNull();
    expect(unknown.externalOrderId).toBeNull();
  });
});

describe("finding our own order in the CRM's history", () => {
  const history = [ORDER_RECORD, { ...ORDER_RECORD, id: 2886, client_order_id: "6527" }];

  it("recognises the order we sent, so a timeout does not create a second one", () => {
    expect(findByClientOrderId(history, "6529")?.externalOrderId).toBe("5648616");
  });

  /**
   * The CRM's history holds zero-padded numbers for some orders ("06441") while
   * the Portal's own reference for the same order is "6441". A string compare
   * would miss it and dispatch a duplicate — which is a second driver at a
   * customer's door.
   */
  it("matches a zero-padded reference against an unpadded one", () => {
    const padded = [{ ...ORDER_RECORD, client_order_id: "06441" }];
    expect(findByClientOrderId(padded, "6441")).not.toBeNull();
  });

  it("returns null for an order the CRM has never seen, which is what allows a retry", () => {
    expect(findByClientOrderId(history, "9999")).toBeNull();
  });

  it("reads a wrapped list as well as a bare array", () => {
    expect(findByClientOrderId({ data: history }, "6527")).not.toBeNull();
  });
});
