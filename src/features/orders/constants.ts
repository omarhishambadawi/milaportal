/** Orders list pagination constants. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";

/**
 * The columns the Orders **table** reads, listed rather than `select("*")`.
 *
 * Every one of these is rendered or acted on by a row: the identity columns, the
 * two `callCentreState` flags, `agent_id` for `canEditOrder` and the directory
 * lookup, `branch_no` for the city lookup, `delivery_type` for the row's
 * Delivery/Pickup badge. The four left out are the ones the list never touches —
 * `created_at`, `created_by`, `updated_at` and, the one that matters, `notes`.
 *
 * `notes` is unbounded free text and was being shipped for every row of every
 * page: at 100 rows a page it is routinely the largest part of the response, for
 * a column that has no cell in the table. Sorting is unaffected — the ORDER BY
 * runs in Postgres on `order_date`/`created_at` whether or not they are
 * projected.
 */
export const ORDER_LIST_COLUMNS = [
  "id",
  "team",
  "display_no",
  "order_date",
  "customer_name",
  "customer_phone",
  "agent_id",
  "invoice_no",
  "order_type",
  "branch_no",
  // Read by the row's Delivery/Pickup badge through `classifyFulfillment`. It
  // used to be excluded because no cell rendered it; one does now, and it is a
  // short enum-like string rather than free text, so the row cost is negligible.
  "delivery_type",
  "invoice_value",
  "status",
  "invoices_verified",
  "call_center_verified",
].join(",");

/**
 * The columns the XLSX export maps, for the same reason as above.
 *
 * A superset of the list's: the sheet has "Delivery & Pickup", "Notes" and
 * "CC Verified" columns that the table does not. It still leaves out
 * `created_at`, `created_by`, `updated_at` and `invoices_verified`, which no
 * column of the workbook reads — and the export walks the *entire* filtered set
 * in 1000-row batches, so an unread column is paid for on every batch.
 */
export const ORDER_EXPORT_COLUMNS = [
  "team",
  "display_no",
  "order_date",
  "agent_id",
  "customer_name",
  "customer_phone",
  "order_type",
  "branch_no",
  "delivery_type",
  "invoice_no",
  "invoice_value",
  "call_center_verified",
  "notes",
  "status",
].join(",");

/**
 * Delivery & Pickup filter.
 *
 * Re-exported rather than declared: the classification, the labels and the
 * option list all live in `./fulfillment`, which is what the Dashboard analytic
 * and the KPI RPC read too. Two copies of "what counts as a delivery" is exactly
 * the state that let the list and the KPI cards disagree.
 */
export { FULFILLMENT_OPTIONS, type FulfillmentOption } from "./fulfillment";

/**
 * Invoice Verification filter.
 *
 * Re-exported for the same reason as the line above: the states, their labels
 * and the predicate that decides them live in `./verification`, which is what
 * the row's Call Centre column reads too.
 */
export {
  VERIFICATION_OPTIONS,
  type VerificationFilter,
  type VerificationOption,
} from "./verification";
