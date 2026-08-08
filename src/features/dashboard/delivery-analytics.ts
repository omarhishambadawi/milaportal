import type { FulfillmentMix } from "@/features/orders/fulfillment";
import { formatCompactSAR, formatPercent } from "./format";

/**
 * Delivery-method analytics, as a value.
 *
 * Pure, and a rearrangement of figures the Dashboard already fetched: every
 * input here comes from the `orders_delivery` RPC rows that `useDashboardData`
 * has in memory, and the delivery-vs-pickup cut is `summarizeFulfillment` —
 * `classifyFulfillment`'s single definition, not a second one.
 *
 * **Completed orders only.** `completed_count` and `completed_sales` are the
 * only columns read; `order_count` on the same row counts every status. That
 * distinction is what the old table got wrong in its first column, and nothing
 * here reintroduces it.
 */

/** One method's row, exactly as `useDashboardData` derives it. */
export interface DeliveryMethodRow {
  name: string;
  /** Completed orders. `null` before the fulfillment migration lands. */
  completed: number | null;
  /** Completed sales. */
  sales: number;
  /** That method's own completion rate, 0–100. */
  rate: number;
}

export interface MethodPerformance {
  name: string;
  /** Completed orders. `null` when the RPC cannot yet answer for it. */
  orders: number | null;
  sales: number;
  rate: number;
  /** Completed sales per completed order. `null` with nothing to divide. */
  avgOrderValue: number | null;
  /** Share of all completed orders across the methods, 0–100. */
  share: number;
}

/**
 * The methods that actually moved something, biggest first.
 *
 * Two deliberate exclusions. A method with no completed orders **and** no
 * completed sales is dropped rather than shown as a permanent zero — the same
 * reasoning as the fulfillment mix's "Not recorded" line, which renders only
 * when it is non-empty. And a method the RPC returned no completed count for
 * (pre-migration `null`) keeps that null all the way to the cell instead of
 * being rendered as 0, which would read as a courier that delivered nothing.
 *
 * Ranked by completed orders, because volume is the question the section is
 * opened with; sales breaks a tie, so two couriers on the same count are not
 * ordered by whatever the database happened to return first.
 */
export function rankMethods(rows: readonly DeliveryMethodRow[]): MethodPerformance[] {
  const active = rows.filter((r) => (r.completed ?? 0) > 0 || r.sales > 0);
  const totalOrders = active.reduce((sum, r) => sum + (r.completed ?? 0), 0);

  return active
    .map((r) => ({
      name: r.name,
      orders: r.completed,
      sales: r.sales,
      rate: r.rate,
      avgOrderValue: r.completed && r.completed > 0 ? r.sales / r.completed : null,
      share: totalOrders > 0 ? ((r.completed ?? 0) / totalOrders) * 100 : 0,
    }))
    .sort((a, b) => (b.orders ?? 0) - (a.orders ?? 0) || b.sales - a.sales);
}

/** Completed sales per completed order for one side of the cut. */
export function averageOrderValue(sales: number, count: number): number | null {
  return count > 0 ? sales / count : null;
}

/* -------------------------------------------------------------------------- */
/* Insight                                                                     */
/* -------------------------------------------------------------------------- */

export interface DeliveryInsight {
  id: string;
  value: string;
  label: string;
}

/**
 * At most two readings of the split — computed, never written.
 *
 * The same figure-and-label shape the Monthly performance insights use, so the
 * two sections read as one dashboard. Each is emitted only when the calculation
 * behind it exists: an empty period produces none at all, and the average-order
 * comparison needs both sides to have orders to average.
 */
export function buildDeliveryInsights(mix: FulfillmentMix): DeliveryInsight[] {
  const insights: DeliveryInsight[] = [];
  if (mix.classified.count === 0) return insights;

  const leadsWithDelivery = mix.delivery.count >= mix.pickup.count;
  const leader = leadsWithDelivery ? mix.delivery : mix.pickup;
  insights.push({
    id: "fulfillment-share",
    value: formatPercent(leader.percent),
    label: `of completed orders ${leadsWithDelivery ? "are delivered" : "are collected in store"}`,
  });

  const deliveryAov = averageOrderValue(mix.delivery.sales, mix.delivery.count);
  const pickupAov = averageOrderValue(mix.pickup.sales, mix.pickup.count);
  if (deliveryAov != null && pickupAov != null && deliveryAov !== pickupAov) {
    const pickupLeads = pickupAov > deliveryAov;
    insights.push({
      id: "aov-comparison",
      value: pickupLeads ? mix.pickup.label : mix.delivery.label,
      label: `Higher average order value — ${formatCompactSAR(
        pickupLeads ? pickupAov : deliveryAov,
      )} against ${formatCompactSAR(pickupLeads ? deliveryAov : pickupAov)}`,
    });
  }

  return insights;
}
