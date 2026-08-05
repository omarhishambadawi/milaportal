/** Orders list pagination constants. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";

/**
 * Delivery & Pickup filter.
 *
 * The orders table stores the courier or hand-over method (`delivery_type`) —
 * "AlShrouq", "Azman", "Branch Scooter", "Store Pickup". The distinction users
 * ask for is coarser: was the order delivered, or collected at the branch.
 * Anything whose method names a pickup is a pickup; everything else is a
 * delivery. Matching on the name rather than an allow-list means a new courier
 * counts as a delivery automatically.
 */
export const FULFILLMENT_OPTIONS = [
  { value: "delivery", label: "Delivery" },
  { value: "pickup", label: "Pickup" },
] as const;

/** Case-insensitive marker of a pickup method inside `orders.delivery_type`. */
export const PICKUP_MATCH = "pickup";
