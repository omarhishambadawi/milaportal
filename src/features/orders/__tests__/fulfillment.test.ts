import { describe, expect, it } from "vitest";
import { DELIVERY_TYPES } from "@/lib/branches";
import {
  FULFILLMENT_OPTIONS,
  classifyFulfillment,
  isFulfillmentGroup,
  summarizeFulfillment,
  type MethodCompletedCounts,
} from "../fulfillment";
import { applyOrderFilters, type OrderFilterState } from "../utils";

/**
 * The value table both implementations answer against.
 *
 * `public.order_fulfillment()` in
 * supabase/migrations/20260808120000_orders_fulfillment.sql is the SQL mirror of
 * `classifyFulfillment`, and it exists only because a PostgREST filter cannot
 * call into TypeScript. This table is what keeps the two honest: change one and
 * this suite says so.
 */
const CASES: Array<[string | null | undefined, "delivery" | "pickup" | null]> = [
  ["AlShrouq", "delivery"],
  ["Azman", "delivery"],
  ["Branch Scooter", "delivery"],
  ["Store Pickup", "pickup"],
  // Case and padding, because the sheet and the form have both produced them.
  ["store pickup", "pickup"],
  ["  Store Pickup  ", "pickup"],
  ["STORE PICKUP", "pickup"],
  // A courier nobody has signed yet is a delivery the day it appears — the whole
  // reason the rule tests for the closed half of the cut.
  ["NewCourierCo", "delivery"],
  // Nothing recorded is neither. Both halves of this used to be wrong, in
  // opposite directions, in two different files.
  [null, null],
  [undefined, null],
  ["", null],
  ["   ", null],
];

describe("classifyFulfillment", () => {
  it.each(CASES)("classifies %j as %s", (input, expected) => {
    expect(classifyFulfillment(input)).toBe(expected);
  });

  it("classifies every method the order form can produce", () => {
    // Guards the pairing between the form's options and the filter: a method
    // added to DELIVERY_TYPES that classified as null would be invisible to both
    // groups and silently missing from the Dashboard mix.
    for (const method of DELIVERY_TYPES) {
      expect(classifyFulfillment(method), `${method} must classify`).not.toBeNull();
    }
  });
});

describe("FULFILLMENT_OPTIONS", () => {
  it("offers both groups and every individual method", () => {
    expect(
      FULFILLMENT_OPTIONS.filter((o) => o.group === "fulfillment").map((o) => o.value),
    ).toEqual(["delivery", "pickup"]);
    expect(FULFILLMENT_OPTIONS.filter((o) => o.group === "method").map((o) => o.value)).toEqual([
      ...DELIVERY_TYPES,
    ]);
  });

  it("labels the methods the way the floor says them", () => {
    const label = (value: string) => FULFILLMENT_OPTIONS.find((o) => o.value === value)?.label;
    // The stored name, verbatim. It had been relabelled "El Shorouk" here and
    // nowhere else, so the filter named a courier no other surface knew.
    expect(label("AlShrouq")).toBe("AlShrouq");
    expect(label("Branch Scooter")).toBe("Scooter");
    expect(label("Azman")).toBe("Azman");
    expect(label("Store Pickup")).toBe("Store Pickup");
  });

  it("tells a group from a method", () => {
    expect(isFulfillmentGroup("delivery")).toBe(true);
    expect(isFulfillmentGroup("pickup")).toBe(true);
    expect(isFulfillmentGroup("Azman")).toBe(false);
    expect(isFulfillmentGroup("all")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The Orders filter                                                          */
/* -------------------------------------------------------------------------- */

/** Records the PostgREST calls a filter makes, in order. */
function recorder() {
  const calls: string[] = [];
  const qb: any = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push(`${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
          return qb;
        },
    },
  );
  return { qb, calls };
}

function filterState(fulfillment: string, overrides: Partial<OrderFilterState> = {}) {
  return {
    searching: false,
    from: "2026-08-01",
    to: "2026-08-08",
    team: "all",
    status: "all",
    mineOnly: false,
    userId: undefined,
    canFilterAgents: false,
    agent: "all",
    term: "",
    fulfillment,
    verification: "all",
    starredOnly: false,
    starredIds: [],
    ...overrides,
  } satisfies OrderFilterState;
}

describe("applyOrderFilters — Delivery & Pickup", () => {
  const fulfillmentCalls = (value: string) => {
    const { qb, calls } = recorder();
    applyOrderFilters(qb, filterState(value));
    return calls.filter((c) => c.includes("delivery_type"));
  };

  it("does not touch delivery_type when the filter is off", () => {
    expect(fulfillmentCalls("all")).toEqual([]);
  });

  it("selects pickups by the same marker the classifier uses", () => {
    expect(fulfillmentCalls("pickup")).toEqual(['ilike("delivery_type","%pickup%")']);
  });

  it("excludes unrecorded methods from Delivery explicitly, not by accident", () => {
    // The bug: `not(delivery_type, ilike, …)` alone reads as "not a pickup" but
    // means "known not to be a pickup" — NULL NOT ILIKE x is NULL, so the row was
    // dropped, while the KPI RPC's COALESCE(...) counted it. Stating the null and
    // blank cases makes the two agree by construction.
    expect(fulfillmentCalls("delivery")).toEqual([
      'not("delivery_type","is",null)',
      'neq("delivery_type","")',
      'not("delivery_type","ilike","%pickup%")',
    ]);
  });

  it("selects one method by equality, so a group can never disagree with it", () => {
    for (const method of DELIVERY_TYPES) {
      expect(fulfillmentCalls(method)).toEqual([`eq("delivery_type",${JSON.stringify(method)})`]);
    }
  });

  it("narrows to the agent's starred ids, server-side, only when asked", () => {
    const idCalls = (state: OrderFilterState) => {
      const { qb, calls } = recorder();
      applyOrderFilters(qb, state);
      return calls.filter((c) => c.startsWith("in("));
    };

    // Off: the list is untouched, so an ordinary page never pays for the filter.
    expect(idCalls(filterState("all"))).toEqual([]);

    // On: an `id IN (…)` on the same query builder every other filter narrows,
    // which is what keeps pagination and counting server-side.
    expect(idCalls(filterState("all", { starredOnly: true, starredIds: ["a", "b"] }))).toEqual([
      'in("id",["a","b"])',
    ]);

    // No stars is not "no filter". Falling through to the unfiltered list would
    // show an agent every order in the range the moment they turned it on.
    expect(idCalls(filterState("all", { starredOnly: true, starredIds: [] }))).toEqual([
      'in("id",[])',
    ]);
  });

  it("composes starred with the date range and the delivery method", () => {
    // The combination the feature is judged on: Starred + a range + Delivery has
    // to be all three predicates, not the last one to win.
    const { qb, calls } = recorder();
    applyOrderFilters(
      qb,
      filterState("AlShrouq", {
        starredOnly: true,
        starredIds: ["a"],
        mineOnly: true,
        userId: "u",
      }),
    );
    expect(calls).toEqual([
      'gte("order_date","2026-08-01")',
      'lte("order_date","2026-08-08")',
      'eq("agent_id","u")',
      'in("id",["a"])',
      'eq("delivery_type","AlShrouq")',
    ]);
  });

  it("keeps Delivery spanning every courier", () => {
    // The reported symptom: selecting Delivery must not quietly drop Azman or
    // Branch Scooter for being a different provider from El Shorouk. Nothing in
    // the delivery predicate names a courier at all, which is what guarantees it.
    const predicate = fulfillmentCalls("delivery").join(" ");
    for (const method of DELIVERY_TYPES.filter((m) => classifyFulfillment(m) === "delivery")) {
      expect(predicate).not.toContain(method);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The Dashboard analytic                                                     */
/* -------------------------------------------------------------------------- */

const method = (
  name: string,
  completedCount: number,
  completedCash: number,
  completedWasfaty: number,
): MethodCompletedCounts => ({ name, completedCount, completedCash, completedWasfaty });

describe("summarizeFulfillment", () => {
  it("splits completed orders into delivery and store pickup", () => {
    // The brief's worked example: 1,000 completed, 800 delivered, 200 collected.
    const mix = summarizeFulfillment([
      method("AlShrouq", 500, 300, 200),
      method("Azman", 200, 120, 80),
      method("Branch Scooter", 100, 60, 40),
      method("Store Pickup", 200, 150, 50),
    ]);

    expect(mix.delivery.count).toBe(800);
    expect(mix.pickup.count).toBe(200);
    expect(mix.delivery.percent).toBe(80);
    expect(mix.pickup.percent).toBe(20);
    expect(mix.total.count).toBe(1000);
  });

  it("keeps the two shares summing to 100", () => {
    // Deliberately indivisible, where a naive "100 - other" would drift.
    const mix = summarizeFulfillment([
      method("AlShrouq", 1, 1, 0),
      method("Store Pickup", 2, 0, 2),
    ]);
    expect(mix.delivery.percent + mix.pickup.percent).toBeCloseTo(100, 10);
  });

  it("carries the Cash and Wasfaty composition through the split", () => {
    const mix = summarizeFulfillment([
      method("AlShrouq", 500, 300, 200),
      method("Azman", 200, 120, 80),
      method("Store Pickup", 200, 150, 50),
    ]);

    expect(mix.delivery.cash).toBe(420);
    expect(mix.delivery.wasfaty).toBe(280);
    expect(mix.pickup.cash).toBe(150);
    expect(mix.pickup.wasfaty).toBe(50);
    // Cash + Wasfaty reconciles to the row's own count.
    expect(mix.delivery.cash + mix.delivery.wasfaty).toBe(mix.delivery.count);
    expect(mix.total.cash + mix.total.wasfaty).toBe(mix.total.count);
  });

  it("reports orders with no method on their own line, outside the percentages", () => {
    // "—" is what the RPC substitutes for a NULL delivery_type. Folding it into
    // either side would invent the answer; folding it into the denominator would
    // stop Delivery% + Pickup% reaching 100.
    const mix = summarizeFulfillment([
      method("AlShrouq", 80, 50, 30),
      method("Store Pickup", 20, 10, 10),
      method("—", 7, 4, 3),
    ]);

    expect(mix.unknown.count).toBe(7);
    expect(mix.classified.count).toBe(100);
    expect(mix.delivery.percent).toBe(80);
    expect(mix.pickup.percent).toBe(20);
    expect(mix.delivery.percent + mix.pickup.percent).toBe(100);
    // The total still reconciles to every completed order, so the card can be
    // read against the KPI above it.
    expect(mix.total.count).toBe(107);
  });

  it("returns zeroes rather than NaN for a range with nothing completed", () => {
    const mix = summarizeFulfillment([method("AlShrouq", 0, 0, 0)]);
    expect(mix.delivery.percent).toBe(0);
    expect(mix.pickup.percent).toBe(0);
    expect(mix.total.count).toBe(0);
    expect(Number.isNaN(mix.delivery.percent)).toBe(false);
  });

  it("counts an unrecognised courier as a delivery", () => {
    const mix = summarizeFulfillment([method("NewCourierCo", 10, 6, 4)]);
    expect(mix.delivery.count).toBe(10);
    expect(mix.unknown.count).toBe(0);
    expect(mix.delivery.percent).toBe(100);
  });
});
