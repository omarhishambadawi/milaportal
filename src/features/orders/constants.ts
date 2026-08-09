/** Orders list pagination constants. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";

/**
 * Delivery & Pickup filter.
 *
 * Re-exported rather than declared: the classification, the labels and the
 * option list all live in `./fulfillment`, which is what the Dashboard analytic
 * and the KPI RPC read too. Two copies of "what counts as a delivery" is exactly
 * the state that let the list and the KPI cards disagree.
 */
export { FULFILLMENT_OPTIONS, type FulfillmentOption } from "./fulfillment";
