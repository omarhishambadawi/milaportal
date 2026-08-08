import { describe, expect, it } from "vitest";
import { summarizeFulfillment } from "@/features/orders/fulfillment";
import {
  averageOrderValue,
  buildDeliveryInsights,
  rankMethods,
  type DeliveryMethodRow,
} from "../delivery-analytics";

/**
 * The section is asserted against the live figures it was designed on.
 *
 * AlShrouq 611 / Store Pickup 74 / Branch Scooter 46 completed orders, which is
 * 731 in total and splits 657 delivered against 74 collected. Azman is in the
 * data with nothing completed, which is exactly the row the section must not
 * render — so it is in the fixture rather than left out of it.
 */
const METHODS: DeliveryMethodRow[] = [
  { name: "AlShrouq", completed: 611, sales: 166572.02, rate: 82.6 },
  { name: "Store Pickup", completed: 74, sales: 28979.12, rate: 81.3 },
  { name: "Branch Scooter", completed: 46, sales: 6547.06, rate: 95.8 },
  { name: "Azman", completed: 0, sales: 0, rate: 0 },
];

const MIX_INPUT = [
  {
    name: "AlShrouq",
    completedCount: 611,
    completedCash: 178,
    completedWasfaty: 433,
    completedSales: 166572.02,
  },
  {
    name: "Store Pickup",
    completedCount: 74,
    completedCash: 10,
    completedWasfaty: 64,
    completedSales: 28979.12,
  },
  {
    name: "Branch Scooter",
    completedCount: 46,
    completedCash: 10,
    completedWasfaty: 36,
    completedSales: 6547.06,
  },
];

describe("rankMethods", () => {
  const ranked = rankMethods(METHODS);

  it("ranks by completed orders, biggest first", () => {
    expect(ranked.map((m) => m.name)).toEqual(["AlShrouq", "Store Pickup", "Branch Scooter"]);
    expect(ranked.map((m) => m.orders)).toEqual([611, 74, 46]);
  });

  it("drops a method that completed nothing rather than showing a permanent zero", () => {
    expect(ranked.some((m) => m.name === "Azman")).toBe(false);
  });

  it("reconciles to the total completed orders", () => {
    expect(ranked.reduce((sum, m) => sum + (m.orders ?? 0), 0)).toBe(731);
    // Each order is counted once: the shares come to exactly 100.
    expect(ranked.reduce((sum, m) => sum + m.share, 0)).toBeCloseTo(100, 10);
  });

  it("derives average order value from completed sales over completed orders", () => {
    expect(ranked[0].avgOrderValue).toBeCloseTo(166572.02 / 611, 6); // ≈ 272.62
    expect(ranked[1].avgOrderValue).toBeCloseTo(28979.12 / 74, 6); // ≈ 391.61
    expect(ranked[2].avgOrderValue).toBeCloseTo(6547.06 / 46, 6); // ≈ 142.33
  });

  it("carries each method's own completion rate through untouched", () => {
    expect(ranked.map((m) => m.rate)).toEqual([82.6, 81.3, 95.8]);
  });

  it("keeps an unavailable completed count null rather than rendering it as zero", () => {
    // Before the fulfillment migration, `completed_count` is absent. A courier
    // with sales but an unknown count must not read as one that delivered none.
    const ranked = rankMethods([{ name: "AlShrouq", completed: null, sales: 1000, rate: 80 }]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].orders).toBeNull();
    expect(ranked[0].avgOrderValue).toBeNull();
  });

  it("breaks a tie on orders by sales, so the order is not the database's", () => {
    const ranked = rankMethods([
      { name: "Quiet", completed: 10, sales: 100, rate: 50 },
      { name: "Loud", completed: 10, sales: 900, rate: 50 },
    ]);
    expect(ranked.map((m) => m.name)).toEqual(["Loud", "Quiet"]);
  });

  it("returns nothing for a period with no completed orders", () => {
    expect(rankMethods([{ name: "AlShrouq", completed: 0, sales: 0, rate: 0 }])).toEqual([]);
  });
});

describe("the fulfillment split", () => {
  const mix = summarizeFulfillment(MIX_INPUT);

  it("splits 731 completed orders into 657 delivered and 74 collected", () => {
    expect(mix.delivery.count).toBe(657);
    expect(mix.pickup.count).toBe(74);
    expect(mix.total.count).toBe(731);
    expect(mix.delivery.percent).toBeCloseTo(89.9, 1);
    expect(mix.pickup.percent).toBeCloseTo(10.1, 1);
    expect(mix.delivery.percent + mix.pickup.percent).toBeCloseTo(100, 10);
  });

  it("carries completed sales through the cut", () => {
    expect(mix.delivery.sales).toBeCloseTo(166572.02 + 6547.06, 2); // 173,119.08
    expect(mix.pickup.sales).toBeCloseTo(28979.12, 2);
    expect(mix.total.sales).toBeCloseTo(166572.02 + 6547.06 + 28979.12, 2);
  });

  it("carries the Cash and Wasfaty composition of each side", () => {
    expect(mix.delivery.cash).toBe(188);
    expect(mix.delivery.wasfaty).toBe(469);
    expect(mix.pickup.cash).toBe(10);
    expect(mix.pickup.wasfaty).toBe(64);
    expect(mix.delivery.cash + mix.delivery.wasfaty).toBe(mix.delivery.count);
    expect(mix.pickup.cash + mix.pickup.wasfaty).toBe(mix.pickup.count);
  });

  it("averages each side over its own completed orders", () => {
    expect(averageOrderValue(mix.delivery.sales, mix.delivery.count)).toBeCloseTo(
      173119.08 / 657,
      6,
    ); // ≈ 263.50
    expect(averageOrderValue(mix.pickup.sales, mix.pickup.count)).toBeCloseTo(28979.12 / 74, 6);
    expect(averageOrderValue(0, 0)).toBeNull();
  });
});

describe("buildDeliveryInsights", () => {
  it("reads the split and the average order values off the data", () => {
    const insights = buildDeliveryInsights(summarizeFulfillment(MIX_INPUT));
    expect(insights).toHaveLength(2);
    expect(insights[0]).toEqual({
      id: "fulfillment-share",
      value: "89.9%",
      label: "of completed orders are delivered",
    });
    // Store Pickup averages ~392 against Delivery's ~264.
    expect(insights[1].id).toBe("aov-comparison");
    expect(insights[1].value).toBe("Store Pickup");
    expect(insights[1].label).toBe("Higher average order value — SAR 392 against SAR 263");
  });

  it("names store pickup when collection leads", () => {
    const insights = buildDeliveryInsights(
      summarizeFulfillment([
        {
          name: "Store Pickup",
          completedCount: 90,
          completedCash: 90,
          completedWasfaty: 0,
          completedSales: 900,
        },
        {
          name: "AlShrouq",
          completedCount: 10,
          completedCash: 10,
          completedWasfaty: 0,
          completedSales: 100,
        },
      ]),
    );
    expect(insights[0].value).toBe("90.0%");
    expect(insights[0].label).toBe("of completed orders are collected in store");
  });

  it("emits nothing for an empty period", () => {
    expect(buildDeliveryInsights(summarizeFulfillment([]))).toEqual([]);
  });

  it("skips the comparison when only one side has orders", () => {
    const insights = buildDeliveryInsights(
      summarizeFulfillment([
        {
          name: "AlShrouq",
          completedCount: 5,
          completedCash: 5,
          completedWasfaty: 0,
          completedSales: 500,
        },
      ]),
    );
    expect(insights.map((i) => i.id)).toEqual(["fulfillment-share"]);
  });
});
