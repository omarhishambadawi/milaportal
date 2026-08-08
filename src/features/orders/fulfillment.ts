import { DELIVERY_TYPES } from "@/lib/branches";

/**
 * How an order reached the customer — the one definition of it.
 *
 * `orders.delivery_type` records the *method*: "AlShrouq", "Azman", "Branch
 * Scooter", "Store Pickup". The question the business actually asks is coarser
 * and cuts across those — was the order taken to the customer, or did they come
 * and collect it — and that cut had been re-derived at every site that needed
 * it: an `ilike` in the list query, a differently-worded `ILIKE` inside the KPI
 * RPC, nothing at all on the Dashboard. They had already drifted (see
 * `classifyFulfillment` on blank values), which is how the list and the KPI cards
 * above it came to disagree about the same filter.
 *
 * This module is that definition, and every surface reads it: the Orders filter,
 * the Orders KPI summary, and the Dashboard's fulfillment mix. The mirror in SQL
 * is `public.order_fulfillment()`, which exists only because a PostgREST filter
 * cannot call into TypeScript — it is deliberately the same three cases in the
 * same order, and `__tests__/fulfillment.test.ts` pins both to one table of
 * values.
 */

export type Fulfillment = "delivery" | "pickup";

/**
 * The marker that names a hand-over at the branch counter.
 *
 * A substring test rather than an allow-list, and the asymmetry is deliberate:
 * *pickup* is a closed concept the business controls the wording of, while
 * *delivery* is open — a courier signed next quarter is a delivery the moment it
 * appears in the data, with no code change. So the rule tests for the closed half
 * and treats everything else that names a method as the open half.
 */
const PICKUP_MARKER = "pickup";

/**
 * Which side of the cut a stored `delivery_type` falls on.
 *
 * Returns **null** for a row that records no method at all. That is the case the
 * old implementations disagreed about: the list query's `not(...ilike)` dropped
 * such rows from Delivery (SQL's three-valued logic — `NULL NOT ILIKE x` is NULL,
 * not true), while the KPI RPC's `COALESCE(delivery_type,'') NOT ILIKE …` counted
 * them as deliveries. So the table showed one set of orders and the cards above it
 * totalled another.
 *
 * Neither bucket is the honest answer: a row with no method recorded is not a
 * known delivery and certainly not a pickup. Callers that must reconcile to a
 * total surface it separately rather than silently folding it into one side —
 * see `summarizeFulfillment`.
 */
export function classifyFulfillment(deliveryType: string | null | undefined): Fulfillment | null {
  const value = deliveryType?.trim();
  if (!value) return null;
  return value.toLowerCase().includes(PICKUP_MARKER) ? "pickup" : "delivery";
}

export const FULFILLMENT_LABEL: Record<Fulfillment, string> = {
  delivery: "Delivery",
  pickup: "Store Pickup",
};

/**
 * The Delivery & Pickup filter's options.
 *
 * Two groups in one list, because they answer the same question at two
 * resolutions and a second dropdown for "which courier" would be a second
 * control for a choice the agent has already started making. The grouped values
 * are the classification above; the individual values are the stored
 * `delivery_type` verbatim, so filtering by one is an equality test and can never
 * disagree with the group it belongs to.
 *
 * Individual options are derived from `DELIVERY_TYPES` — the same list the order
 * form offers — rather than spelled again here, so a method added to the form
 * becomes filterable without a second edit. The label is the business's word for
 * it where that differs from the stored value: the sheet says "AlShrouq" and the
 * floor says "El Shorouk".
 */
const METHOD_LABEL: Record<string, string> = {
  AlShrouq: "El Shorouk",
  "Branch Scooter": "Scooter",
};

export interface FulfillmentOption {
  /** Sent to the query: "delivery", "pickup", or a `delivery_type` verbatim. */
  value: string;
  label: string;
  /** Grouped options head the list; individual methods sit under them. */
  group: "fulfillment" | "method";
}

export const FULFILLMENT_OPTIONS: readonly FulfillmentOption[] = [
  { value: "delivery", label: FULFILLMENT_LABEL.delivery, group: "fulfillment" },
  { value: "pickup", label: FULFILLMENT_LABEL.pickup, group: "fulfillment" },
  ...DELIVERY_TYPES.map((method) => ({
    value: method,
    label: METHOD_LABEL[method] ?? method,
    group: "method" as const,
  })),
];

/** Is this filter value one of the two groups, rather than a single method? */
export function isFulfillmentGroup(value: string): value is Fulfillment {
  return value === "delivery" || value === "pickup";
}

/* -------------------------------------------------------------------------- */
/* The Dashboard analytic                                                      */
/* -------------------------------------------------------------------------- */

/** One method's completed orders, as `orders_delivery` returns them. */
export interface MethodCompletedCounts {
  /** The stored `delivery_type`, or "—" when the RPC found none. */
  name: string;
  completedCount: number;
  completedCash: number;
  completedWasfaty: number;
}

export interface FulfillmentRow {
  key: Fulfillment | "unknown";
  label: string;
  count: number;
  cash: number;
  wasfaty: number;
  /** Share of classified completed orders, 0–100. */
  percent: number;
}

export interface FulfillmentMix {
  delivery: FulfillmentRow;
  pickup: FulfillmentRow;
  /** Completed orders whose method was never recorded. Rendered only if > 0. */
  unknown: FulfillmentRow;
  /** Delivery + Pickup. The denominator the percentages are taken against. */
  classified: FulfillmentRow;
  /** Classified + unknown, so the card can reconcile to the KPI card above it. */
  total: FulfillmentRow;
}

function emptyRow(key: FulfillmentRow["key"], label: string): FulfillmentRow {
  return { key, label, count: 0, cash: 0, wasfaty: 0, percent: 0 };
}

/**
 * Completed orders, split delivery vs pickup, with the Cash/Wasfaty composition.
 *
 * Folds the per-method rows the Dashboard **already fetches** rather than asking
 * for anything new: `orders_delivery` returns one row per method — four of them —
 * so the whole analytic is a four-element reduce over data already in memory, and
 * costs neither a query nor a pass over the orders table.
 *
 * Percentages are taken against *classified* orders, not the grand total, which
 * is what makes Delivery% + Pickup% come to exactly 100 whenever there is
 * anything to divide. Orders with no method recorded cannot be assigned to either
 * side without inventing the answer, so they are reported on their own line and
 * excluded from the denominator instead of quietly rounding one side up.
 */
export function summarizeFulfillment(methods: readonly MethodCompletedCounts[]): FulfillmentMix {
  const delivery = emptyRow("delivery", FULFILLMENT_LABEL.delivery);
  const pickup = emptyRow("pickup", FULFILLMENT_LABEL.pickup);
  const unknown = emptyRow("unknown", "Not recorded");

  for (const method of methods) {
    const bucket = classifyFulfillment(method.name === "—" ? null : method.name) ?? "unknown";
    const row = bucket === "delivery" ? delivery : bucket === "pickup" ? pickup : unknown;
    row.count += method.completedCount;
    row.cash += method.completedCash;
    row.wasfaty += method.completedWasfaty;
  }

  const classified: FulfillmentRow = {
    key: "delivery",
    label: "Total",
    count: delivery.count + pickup.count,
    cash: delivery.cash + pickup.cash,
    wasfaty: delivery.wasfaty + pickup.wasfaty,
    percent: 100,
  };

  // Guarded rather than allowed to produce NaN: a range with no completed orders
  // is an ordinary Monday morning, and "NaN%" on a dashboard reads as broken.
  if (classified.count > 0) {
    delivery.percent = (delivery.count / classified.count) * 100;
    pickup.percent = (pickup.count / classified.count) * 100;
  } else {
    classified.percent = 0;
  }

  return {
    delivery,
    pickup,
    unknown,
    classified,
    total: {
      key: "delivery",
      label: "Total",
      count: classified.count + unknown.count,
      cash: classified.cash + unknown.cash,
      wasfaty: classified.wasfaty + unknown.wasfaty,
      percent: classified.percent,
    },
  };
}
