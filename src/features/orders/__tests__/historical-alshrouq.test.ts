/**
 * Historical AlShrouq orders must stay out of the integration.
 *
 * An order raised before this integration existed was already delivered, by a
 * person, through the old manual workflow. If saving one could reach the courier
 * it would put a second driver at a customer's door for a delivery that happened
 * months ago — and the customer would be charged twice. This file exists to make
 * that regression loud.
 *
 * The rule under test: an AlShrouq order is historical when it carries no
 * delivery data (`alshrouq_lat`, `alshrouq_lng`, `alshrouq_payment_type` all
 * null) **and** the integration has never recorded a dispatch for it. Both
 * halves are persisted facts. `delivery_type` is deliberately not part of the
 * test for "new", because it reads `AlShrouq` on both kinds of order — which is
 * precisely the bug this fixes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchBlockers,
  isHistoricalAlShrouqOrder,
  type BranchCoverage,
  type OrderForDispatch,
} from "@/lib/alshrouq/dispatch";
import { historicalOrderFormSchema, orderFormSchema } from "../schema";
import { ALSHROUQ } from "@/lib/branches";

const autoSubmit = vi.fn();
vi.mock("@/lib/alshrouq.functions", () => ({
  alshrouqAutoSubmit: (...args: unknown[]) => autoSubmit(...args),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const { submitToAlShrouq } = await import("../submit-to-alshrouq");

/** An order as `loadEditableOrder` returns it. */
function order(over: Partial<OrderForDispatch> = {}): OrderForDispatch {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    display_no: "#4321",
    team: "customer_care",
    agent_id: "22222222-2222-2222-2222-222222222222",
    branch_no: "P0001",
    customer_name: "Sara",
    customer_phone: "0551234567",
    invoice_value: 240,
    notes: "Two boxes",
    delivery_type: ALSHROUQ,
    status: "Completed",
    // The shape of every AlShrouq order that existed before the integration:
    // the columns were added by its migration, so they are null on every one.
    alshrouq_map_url: null,
    alshrouq_lat: null,
    alshrouq_lng: null,
    alshrouq_payment_type: null,
    ...over,
  };
}

/** The same order, but created through the new form. */
const withDelivery: Partial<OrderForDispatch> = {
  alshrouq_map_url: "https://maps.app.goo.gl/aBcDeF",
  alshrouq_lat: 24.71355,
  alshrouq_lng: 46.67529,
  alshrouq_payment_type: 1,
};

describe("telling a historical AlShrouq order from a new one", () => {
  it("calls an old order with no delivery data and no dispatch historical", () => {
    expect(isHistoricalAlShrouqOrder(order(), false)).toBe(true);
  });

  it("does not call an order created through the new form historical", () => {
    expect(isHistoricalAlShrouqOrder(order(withDelivery), false)).toBe(false);
  });

  /**
   * The dispatch ledger settles it on its own. An order the integration has
   * already sent is in the integration whatever its columns say.
   */
  it("does not call an order the integration has already dispatched historical", () => {
    expect(isHistoricalAlShrouqOrder(order(), true)).toBe(false);
  });

  it("keeps a cancelled dispatch in the integration, so it can be re-sent", () => {
    // `hasEverDispatched` is true for a cancelled row too — that is the point.
    expect(isHistoricalAlShrouqOrder(order(withDelivery), true)).toBe(false);
  });

  it("is not about the delivery method — other methods are never historical", () => {
    for (const method of ["Store Pickup", "Azman", "Branch Scooter"]) {
      expect(isHistoricalAlShrouqOrder(order({ delivery_type: method }), false)).toBe(false);
    }
  });

  /**
   * A half-filled new order is not historical. It is a new order that is not
   * ready — it gets the ordinary "AlShrouq needs the delivery location", not a
   * silent exemption from the rules.
   */
  it("does not treat a partially filled new order as historical", () => {
    expect(isHistoricalAlShrouqOrder(order({ alshrouq_lat: 24.71355 }), false)).toBe(false);
    expect(isHistoricalAlShrouqOrder(order({ alshrouq_payment_type: 1 }), false)).toBe(false);
  });

  /** Postgres hands numerics back as strings through PostgREST often enough. */
  it("reads string-typed numerics the same way", () => {
    expect(
      isHistoricalAlShrouqOrder(
        order({ alshrouq_lat: "24.71355", alshrouq_lng: "46.67529", alshrouq_payment_type: "1" }),
        false,
      ),
    ).toBe(false);
  });
});

describe("saving a historical order never reaches the courier", () => {
  beforeEach(() => autoSubmit.mockReset());

  /**
   * The regression, stated directly: an agent opens an old AlShrouq order,
   * changes the notes, saves — and no AlShrouq call is made at all. Not a
   * refused one, not a failed one. None. Nothing is POSTed, no dispatch row is
   * written, and no `alshrouq_submission_started` lands on the timeline, because
   * the request that would have produced any of those is never issued.
   */
  it("makes no AlShrouq call when the order is historical", async () => {
    await submitToAlShrouq("11111111-1111-1111-1111-111111111111", ALSHROUQ, true);
    expect(autoSubmit).not.toHaveBeenCalled();
  });

  it("still submits a genuinely new AlShrouq order", async () => {
    autoSubmit.mockResolvedValue({ ok: true, dispatch: { externalOrderId: "5648616" } });
    await submitToAlShrouq("11111111-1111-1111-1111-111111111111", ALSHROUQ, false);
    expect(autoSubmit).toHaveBeenCalledTimes(1);
  });

  it("leaves every other delivery method alone, as before", async () => {
    for (const method of ["Store Pickup", "Azman", "Branch Scooter", null]) {
      await submitToAlShrouq("11111111-1111-1111-1111-111111111111", method, false);
    }
    expect(autoSubmit).not.toHaveBeenCalled();
  });
});

describe("the form a historical order is edited through", () => {
  const base = {
    order_date: "2026-03-14",
    team: "customer_care" as const,
    order_type: "Cash",
    customer_name: "",
    customer_phone: "",
    branch_no: "P0001",
    delivery_type: ALSHROUQ,
    invoice_no: null,
    invoice_value: "120",
    notes: "Corrected the spelling",
    status: "Completed",
    agent_id: "11111111-1111-4111-8111-111111111111",
    alshrouq_map_url: null,
    alshrouq_lat: "",
    alshrouq_lng: "",
    alshrouq_payment_type: "",
  };

  /**
   * The reported bug. An old order has no name, no number, no location and no
   * payment method; under the strict schema an agent could not save a one-word
   * change to its notes.
   */
  it("saves without the fields the order never had", () => {
    expect(historicalOrderFormSchema.safeParse(base).success).toBe(true);
  });

  it("still refuses the same order under the new-order rules", () => {
    const result = orderFormSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toEqual(
        expect.arrayContaining([
          "customer_name",
          "customer_phone",
          "alshrouq_lat",
          "alshrouq_payment_type",
        ]),
      );
    }
  });

  /** The exemption is only ever about AlShrouq — nothing else is relaxed. */
  it("does not relax any other rule", () => {
    expect(historicalOrderFormSchema.safeParse({ ...base, branch_no: "" }).success).toBe(false);
    expect(historicalOrderFormSchema.safeParse({ ...base, delivery_type: "" }).success).toBe(false);
  });
});

describe("defence in depth", () => {
  const covered: BranchCoverage = { kind: "covered", alshrouqBranchId: "9999927657121" };

  /**
   * Even if every guard above were bypassed and a historical order reached the
   * dispatch validator, it still cannot produce a payload: it has no location
   * and no payment method, so `buildAlShrouqCreatePayload` would throw before
   * anything was sent.
   */
  it("refuses a historical order at the dispatch validator too", () => {
    const blockers = dispatchBlockers(order(), covered);
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join(" ")).toContain("latitude");
    expect(blockers.join(" ")).toContain("payment method");
  });
});
