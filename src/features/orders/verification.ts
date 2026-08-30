/**
 * Invoice verification — one definition of the states, for the filter and the row.
 *
 * An order carries two flags, and neither means anything without the other:
 *
 *   `invoices_verified`     the MIS answered for this order's invoice numbers.
 *   `call_center_verified`  and at least one of those documents was raised
 *                           through the call centre (`-Call Centre` on the MIS
 *                           customer label).
 *
 * `components/call-centre-cell` already reads that pair into the three states
 * the table paints — plus `cancelled`, which outranks them for display only.
 * This module is the same reading expressed as a *filter*, so the dropdown, the
 * list query, the KPI cards and the export all narrow to the sets the column
 * shows rather than to a second, separately-invented idea of "verified".
 *
 * The SQL mirror is the `_verification` branch of `public.orders_kpi_summary`
 * (migration `20260830120000_orders_invoice_verification_filter.sql`); it exists
 * only because a PostgREST filter cannot call into TypeScript, and
 * `__tests__/verification.test.ts` pins the two to one table of values.
 */

/** The filter's values. "all" is the unfiltered default. */
export type VerificationFilter = "all" | "verified" | "pending" | "call_centre" | "non_call_centre";

export interface VerificationOption {
  value: VerificationFilter;
  label: string;
  /** The one-line explanation shown under the label in the dropdown. */
  hint: string;
}

/**
 * The dropdown's options, in the order an agent reaches for them.
 *
 * *Verified* and *Not verified* answer the coarse question — has the MIS said
 * anything about this order yet — and the two below them split the verified half
 * by channel, which is the question the Call Centre column exists to answer.
 * Both resolutions in one control, for the same reason Delivery & Pickup puts
 * its groups and its methods in one list.
 */
export const VERIFICATION_OPTIONS: readonly VerificationOption[] = [
  { value: "all", label: "Any verification", hint: "No verification filter" },
  { value: "verified", label: "Verified", hint: "The MIS has answered for this order" },
  { value: "pending", label: "Not verified", hint: "No invoice verified yet" },
  { value: "call_centre", label: "Call Centre", hint: "A verified Call Centre invoice" },
  {
    value: "non_call_centre",
    label: "Non Call Centre",
    hint: "Verified, but not a Call Centre invoice",
  },
];

export function isVerificationFilter(value: string): value is VerificationFilter {
  return VERIFICATION_OPTIONS.some((o) => o.value === value);
}

/** The label the toolbar shows for an active selection. */
export function verificationLabel(value: string): string {
  return VERIFICATION_OPTIONS.find((o) => o.value === value)?.label ?? "Any verification";
}

/** The two flags a row is judged on. Named so the predicate below reads. */
export interface VerificationFlags {
  invoices_verified?: boolean | null;
  call_center_verified?: boolean | null;
}

/**
 * Does this order fall inside the selected verification filter?
 *
 * Pure, and the reference the SQL is written against. `call_center_verified` is
 * only ever set by `record_invoice_verification` alongside `invoices_verified`,
 * so `call_centre` needs no second condition — but `non_call_centre` does, or it
 * would sweep in every order the MIS has not answered for yet, which is the
 * whole distinction the third state was introduced to make.
 */
export function matchesVerification(value: string, order: VerificationFlags): boolean {
  const verified = order.invoices_verified === true;
  const callCentre = order.call_center_verified === true;
  switch (value) {
    case "verified":
      return verified;
    case "pending":
      return !verified;
    case "call_centre":
      return callCentre;
    case "non_call_centre":
      return verified && !callCentre;
    default:
      return true;
  }
}
