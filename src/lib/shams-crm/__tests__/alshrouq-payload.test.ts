/**
 * The AlShrouq create-order payload builder.
 *
 * Entirely offline. Nothing here stubs a CRM because nothing here reaches one —
 * and one test enforces exactly that by failing if the builder ever touches
 * `fetch`.
 *
 * The fixtures mirror the real records captured in the PharmacyCRM Desktop
 * package: a bare-number `client_order_id`, an `order_value` of `0.0`, a
 * `maps.app.goo.gl` short link, and `preparation_time` of `10`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildAlshrouqOrderPayload,
  type AlShrouqBuildContext,
  type AlShrouqOrderSource,
} from "@/lib/shams-crm/alshrouq-payload";

/** As published by `GET /integrations/alshrouq/config`. Not an enum in the app. */
const PAYMENT_IDS = [1, 2, 3, 4] as const;

const BRANCH_ID = "9999927657121";

function order(over: Partial<AlShrouqOrderSource> = {}): AlShrouqOrderSource {
  return {
    display_no: "#9540",
    customer_name: "Test Customer",
    customer_phone: "0500798930",
    alshrouq_map_url: "https://maps.app.goo.gl/abc123",
    alshrouq_lat: 21.5558662,
    alshrouq_lng: 39.2905617,
    alshrouq_payment_type: 3,
    invoice_value: 105.02,
    notes: null,
    ...over,
  };
}

function context(over: Partial<AlShrouqBuildContext> = {}): AlShrouqBuildContext {
  return { alshrouqBranchId: BRANCH_ID, paymentOptionIds: PAYMENT_IDS, ...over };
}

function payloadOf(result: ReturnType<typeof buildAlshrouqOrderPayload>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.payload;
}

function errorFields(result: ReturnType<typeof buildAlshrouqOrderPayload>): string[] {
  if (result.ok || result.reason !== "invalid") throw new Error("expected invalid");
  return result.errors.map((e) => e.field);
}

describe("buildAlshrouqOrderPayload", () => {
  it("builds a normal order", () => {
    expect(payloadOf(buildAlshrouqOrderPayload(order(), context()))).toEqual({
      branch_id: BRANCH_ID,
      client_order_id: "9540",
      customer_name: "Test Customer",
      customer_phone: "0500798930",
      payment_type: 3,
      order_value: 105.02,
      customer_address: "https://maps.app.goo.gl/abc123",
      customer_lat: 21.5558662,
      customer_lng: 39.2905617,
    });
  });

  /**
   * 107 of the 127 real deliveries carry `0.0`. A `> 0` rule would refuse orders
   * the Desktop creates every day, which is why this test exists at all.
   */
  it("accepts an order value of zero", () => {
    const result = buildAlshrouqOrderPayload(order({ invoice_value: 0 }), context());
    expect(payloadOf(result).order_value).toBe(0);
  });

  it("accepts a zero order value arriving as the string Supabase returns", () => {
    const result = buildAlshrouqOrderPayload(order({ invoice_value: "0.00" }), context());
    expect(payloadOf(result).order_value).toBe(0);
  });

  it("keeps client_order_id a string and never parses it as a number", () => {
    // A real CRM value. `Number("9396####")` is NaN, and the trailing hashes are
    // part of the identity.
    const result = buildAlshrouqOrderPayload(order({ display_no: "#9396####" }), context());
    const id = payloadOf(result).client_order_id;
    expect(id).toBe("9396####");
    expect(typeof id).toBe("string");
  });

  it("strips only the stored leading marker, never adding a team prefix", () => {
    const result = buildAlshrouqOrderPayload(order({ display_no: "#06441" }), context());
    // Leading zero survives; no CC-/TS- is introduced.
    expect(payloadOf(result).client_order_id).toBe("06441");
  });

  it("passes preparation_time through when the caller has one", () => {
    const result = buildAlshrouqOrderPayload(order(), context({ preparationTime: 10 }));
    expect(payloadOf(result).preparation_time).toBe(10);
  });

  it("omits preparation_time rather than inventing the common value", () => {
    // 122 of 127 records show 10, but whether the client sends it is not
    // established, so the key is absent instead of guessed.
    expect(payloadOf(buildAlshrouqOrderPayload(order(), context()))).not.toHaveProperty(
      "preparation_time",
    );
  });

  it("includes coordinates when the order has them", () => {
    const p = payloadOf(buildAlshrouqOrderPayload(order(), context()));
    expect(p.customer_lat).toBe(21.5558662);
    expect(p.customer_lng).toBe(39.2905617);
  });

  it("omits coordinates entirely when the order has none", () => {
    const result = buildAlshrouqOrderPayload(
      order({ alshrouq_lat: null, alshrouq_lng: null }),
      context(),
    );
    const p = payloadOf(result);
    expect(p).not.toHaveProperty("customer_lat");
    expect(p).not.toHaveProperty("customer_lng");
  });

  it("refuses half a coordinate pair rather than completing it", () => {
    const result = buildAlshrouqOrderPayload(order({ alshrouq_lng: null }), context());
    expect(errorFields(result)).toEqual(["customer_lat"]);
  });

  it.each(PAYMENT_IDS)("accepts confirmed payment type %i", (id) => {
    const result = buildAlshrouqOrderPayload(order({ alshrouq_payment_type: id }), context());
    expect(payloadOf(result).payment_type).toBe(id);
  });

  it("refuses an unsupported payment type instead of substituting one", () => {
    const result = buildAlshrouqOrderPayload(order({ alshrouq_payment_type: 99 }), context());
    expect(errorFields(result)).toEqual(["payment_type"]);
    if (result.ok || result.reason !== "invalid") throw new Error("expected invalid");
    expect(result.errors[0]!.message).toContain("99");
  });

  it("honours the CRM's list rather than a list of its own", () => {
    // A deployment whose CRM adds a fifth method needs no code change here.
    const result = buildAlshrouqOrderPayload(
      order({ alshrouq_payment_type: 5 }),
      context({ paymentOptionIds: [1, 2, 3, 4, 5] }),
    );
    expect(payloadOf(result).payment_type).toBe(5);
  });

  it("reports every missing required field at once", () => {
    const result = buildAlshrouqOrderPayload(
      order({
        customer_name: "   ",
        customer_phone: null,
        alshrouq_payment_type: null,
        invoice_value: null,
      }),
      context(),
    );
    expect(errorFields(result)).toEqual([
      "customer_name",
      "customer_phone",
      "payment_type",
      "order_value",
    ]);
  });

  it("distinguishes an unresolved branch from an invalid order", () => {
    const unresolved = buildAlshrouqOrderPayload(order(), context({ alshrouqBranchId: null }));
    expect(unresolved).toEqual({ ok: false, reason: "branch_unresolved" });

    // Even a thoroughly broken order reports the branch first — "AlShrouq does
    // not cover this branch" is not something an agent can fix by typing.
    const alsoBroken = buildAlshrouqOrderPayload(
      order({ customer_name: null, customer_phone: null }),
      context({ alshrouqBranchId: "" }),
    );
    expect(alsoBroken).toEqual({ ok: false, reason: "branch_unresolved" });
  });

  it("emits no field outside the contract", () => {
    const result = buildAlshrouqOrderPayload(
      order({ notes: "Leave at reception" }),
      context({ preparationTime: 10 }),
    );
    expect(Object.keys(payloadOf(result)).sort()).toEqual([
      "branch_id",
      "client_order_id",
      "customer_address",
      "customer_lat",
      "customer_lng",
      "customer_name",
      "customer_phone",
      "details",
      "order_value",
      "payment_type",
      "preparation_time",
    ]);
  });

  it("passes a short link through untouched", () => {
    const link = "https://maps.app.goo.gl/XyZ987";
    const result = buildAlshrouqOrderPayload(order({ alshrouq_map_url: link }), context());
    expect(payloadOf(result).customer_address).toBe(link);
  });

  it("does not mutate its inputs", () => {
    const src = order({ notes: "note" });
    const ctx = context({ preparationTime: 10 });
    const srcBefore = structuredClone(src);
    const ctxBefore = structuredClone(ctx);

    buildAlshrouqOrderPayload(src, ctx);

    expect(src).toEqual(srcBefore);
    expect(ctx).toEqual(ctxBefore);
  });

  it("is deterministic", () => {
    const a = buildAlshrouqOrderPayload(order(), context());
    const b = buildAlshrouqOrderPayload(order(), context());
    expect(a).toEqual(b);
  });

  /**
   * The guarantee of this phase. If someone later wires `crmFetch` into the
   * builder, this fails.
   */
  it("performs no network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      buildAlshrouqOrderPayload(order(), context({ preparationTime: 10 }));
      buildAlshrouqOrderPayload(order(), context({ alshrouqBranchId: null }));
      buildAlshrouqOrderPayload(order({ alshrouq_payment_type: 99 }), context());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
