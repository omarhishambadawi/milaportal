/**
 * The Invoice Verification filter — three states over one existing column.
 *
 * `orders.invoices_verified` is the field, already fetched by the list
 * (`ORDER_LIST_COLUMNS`) and already read by the row's Call Centre cell, which
 * uses it to tell "no answer from the MIS yet" apart from "answered, and it was
 * a walk-in". Nothing new is modelled here; this is that same column expressed
 * as a filter.
 *
 * Declared beside `fulfillment.ts` and for the same reason: the list query, the
 * KPI aggregation and the export all have to narrow to the same set, and a
 * second opinion about what "verified" means is how they come to disagree. The
 * SQL mirror is the `_verification` branch of `public.orders_kpi_summary`
 * (migration `20260830140000_orders_invoice_verification_filter.sql`).
 */

/** The filter's values. `all` is the unfiltered default. */
export type VerificationFilter = "all" | "verified" | "unverified";

export interface VerificationOption {
  value: VerificationFilter;
  label: string;
}

/** The three options the dropdown offers, in order. */
export const VERIFICATION_OPTIONS: readonly VerificationOption[] = [
  { value: "all", label: "All invoices" },
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Non verified" },
];

/**
 * Does this order fall inside the selected verification filter?
 *
 * Pure, and the reference both the PostgREST predicate and the SQL are written
 * against. The negative case is the one worth stating: `invoices_verified` is
 * nullable, and an order the MIS has never answered for holds NULL rather than
 * false — so *Non verified* has to mean "not true", not "= false", or it would
 * silently exclude most of the orders it is being asked for.
 */
export function matchesVerification(
  value: string,
  order: { invoices_verified?: boolean | null },
): boolean {
  if (value === "verified") return order.invoices_verified === true;
  if (value === "unverified") return order.invoices_verified !== true;
  return true;
}
