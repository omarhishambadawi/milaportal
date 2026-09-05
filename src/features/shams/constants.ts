/**
 * Shared constants for the Shams MIS page.
 *
 * Separate from `components/states.tsx` so that file exports only components —
 * which keeps React Fast Refresh working for it, and matches the feature-module
 * shape used elsewhere in `src/features`.
 */

/** Shared table cell padding, matching the Call Lookup table. */
export const TH = "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4";
export const TD = "px-3 py-3 first:pl-4 last:pr-4";

/**
 * User-facing failure copy, chosen by the server function's failure `kind`.
 *
 * The browser's wording is owned here rather than printed from the server's
 * `message`. Both are safe today, but rendering copy the client controls means
 * no future change to a server-side string — and no unexpected error shape —
 * can put an upstream detail on screen. Nothing here names a URL, a status code
 * or an upstream response.
 */
const FAILURE_COPY: Record<string, string> = {
  not_configured: "The Shams MIS connection is not configured for this deployment.",
  timeout: "Shams MIS took too long to respond. Please try again.",
  unavailable: "Unable to reach Shams MIS. Please try again.",
  http_error: "Unable to load Shams data. Please try again.",
  malformed: "Shams MIS returned an unexpected response. Please try again.",
  auth_failed: "Shams MIS rejected the portal's credentials. Contact an administrator.",
  invalid_query: "That search could not be run. Check the values and try again.",
  /*
   * MilaPortal's own catalogue, not Shams'. The wording says so: an agent told
   * "unable to reach Shams" during a local database incident escalates to the
   * wrong people, and — worse on a call — may tell a customer the product does
   * not exist.
   */
  catalog_unavailable: "The product catalogue could not be read. Please try again.",
  catalog_empty: "The product catalogue is empty. Contact an administrator.",
  /*
   * MilaPortal's own offer tables, not Shams'. Same reasoning as the catalogue
   * copy above, and one consequence worth stating: an empty offer column is
   * never "no offer". An agent told the discount is unavailable quotes the list
   * price and says so; an agent told there is no discount quotes it as final.
   */
  offers_unavailable: "Offer data could not be read. Prices shown are list prices.",
};

const FALLBACK_COPY = "Unable to load Shams data. Please try again.";

export function failureMessage(kind: string | null | undefined): string {
  return (kind && FAILURE_COPY[kind]) || FALLBACK_COPY;
}
