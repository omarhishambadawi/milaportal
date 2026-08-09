/** Orders list pagination constants. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";

/**
 * Prefix for one agent's starred orders. The authenticated user's id is
 * appended, which is what keeps two agents sharing a call-floor machine from
 * seeing each other's stars — see `hooks/use-starred-orders`.
 */
export const STARRED_ORDERS_KEY_PREFIX = "milaserv.orders.starred";

/**
 * Delivery & Pickup filter.
 *
 * Re-exported rather than declared: the classification, the labels and the
 * option list all live in `./fulfillment`, which is what the Dashboard analytic
 * and the KPI RPC read too. Two copies of "what counts as a delivery" is exactly
 * the state that let the list and the KPI cards disagree.
 */
export { FULFILLMENT_OPTIONS, type FulfillmentOption } from "./fulfillment";
