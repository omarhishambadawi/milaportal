/**
 * Shams CRM customer history (server-only).
 *
 * ```
 * GET /api/v2/crm/data?mobileno=<9 digits>&fromdt=YYYYMMDD&todt=YYYYMMDD
 *                     &page=<n>&per_page=<n>
 * ```
 *
 * A loyalty lookup keyed on a mobile number: it returns who the customer is and
 * what they bought in a date window. It is the only endpoint in this API that
 * takes a date range in a confirmed format and the only one that pages.
 *
 * ## Why this is not `sales.server.ts`
 *
 * Both read sales, but they are different questions with different shapes.
 * `sales/details` answers "what is on document N at branch B" and returns
 * header + item rows that must be folded into documents. `crm/data` answers
 * "what has this person bought" and returns a flat list of purchased lines with
 * the customer repeated on each one. Nothing is shared but the transport.
 *
 * ## Not cached
 *
 * Deliberately. The catalog caches exist because a per-keystroke search would
 * otherwise hammer the MIS; this is a deliberate, submitted lookup, no more
 * frequent than an invoice read — which is also uncached. And a cache here
 * would be a server-side store of identifiable customer data keyed by mobile
 * number, which is a thing to add on purpose with a reason, not as a
 * performance reflex. React Query holds the answer browser-side for as long as
 * the agent is looking at it, which is where the repeat-view saving actually
 * is.
 *
 * ## Privacy
 *
 * The mobile number is a query *value*, and `client.server.ts` never logs query
 * values — so it appears in no log line here. It must also never reach a URL in
 * the browser; the Customers tab keeps it in form state for that reason.
 */

import { shamsFetch } from "./client.server";
import { groupCrmHistory, normalizeCrmMobile } from "./normalize";
import { ShamsQueryError } from "./sales.server";
import type { RawCrmResponse, ShamsCrmHistory } from "./types";

/** `YYYYMMDD` — the format `crm/data` is confirmed to accept and echo. */
const DATE_PATTERN = /^\d{8}$/;

/**
 * Page size ceiling.
 *
 * 100 is the only value any capture demonstrates, and it is the default below.
 * The bound exists because `per_page` reaches the upstream query directly: an
 * unbounded value is a request for an unbounded response, and the browser does
 * not get to choose how much of the MIS a single call reads.
 */
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 100;

export interface CrmHistoryQuery {
  /** Any format an agent might type; normalized before it is sent. */
  mobile: string;
  /** `YYYYMMDD`. Required — the endpoint is always called with a window. */
  fromDate: string;
  toDate: string;
  /** 1-based, as the API numbers pages. */
  page?: number;
  perPage?: number;
}

/**
 * Validate and canonicalize a lookup before it reaches the network.
 *
 * Same reasoning as `validateInvoiceQuery`: the MIS answers `200` with an empty
 * result for a query it could not use as readily as for a customer who has
 * bought nothing, so an unchecked bad input is indistinguishable from a real
 * empty state. Throwing `ShamsQueryError` — the type `shams.functions.ts`
 * already maps to `invalid_query` — keeps that distinction all the way to the
 * UI.
 */
export function validateCrmHistoryQuery(query: CrmHistoryQuery): {
  mobile: string;
  fromDate: string;
  toDate: string;
  page: number;
  perPage: number;
} {
  const mobile = normalizeCrmMobile(query.mobile);
  if (!mobile) {
    throw new ShamsQueryError("Enter a Saudi mobile number, e.g. 0555555555.");
  }

  const fromDate = query.fromDate?.trim() ?? "";
  const toDate = query.toDate?.trim() ?? "";
  for (const value of [fromDate, toDate]) {
    if (!DATE_PATTERN.test(value)) {
      throw new ShamsQueryError("Dates must be formatted YYYYMMDD.");
    }
  }
  // String comparison is enough: `YYYYMMDD` sorts lexicographically.
  if (toDate < fromDate) {
    throw new ShamsQueryError("The date range ends before it starts.");
  }

  const page = Math.max(1, Math.floor(query.page ?? 1));
  const requested = Math.floor(query.perPage ?? DEFAULT_PER_PAGE);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, requested));

  return { mobile, fromDate, toDate, page, perPage };
}

/**
 * One page of a customer's purchase history.
 *
 * Returns a history with `customer: null` and no rows when the number matches
 * nobody — the API reports that with `200` and `count: 0`, so absence is data,
 * not failure, exactly as it is for a missing document.
 *
 * ## Knowing whether there is another page
 *
 * The `pagination` block carries `total: null` and `total_pages: null` in every
 * captured response — including one that returned rows — so the size of a
 * result set cannot be read off the API. `hasMore` is therefore inferred: a
 * full page suggests another, a short page cannot have one.
 *
 * "Full" is measured against the page size the API **echoed**, not the one that
 * was asked for. If the endpoint ever clamps `per_page`, comparing against the
 * request would call every clamped page "short" and hide the rest of the
 * history; comparing against the echo cannot.
 *
 * The cost of the inference is one empty page at the end of a history whose
 * length happens to be a multiple of the page size. That is the right way round
 * — the alternative is silently truncating a customer's history.
 */
export async function getCustomerHistory(query: CrmHistoryQuery): Promise<ShamsCrmHistory> {
  const { mobile, fromDate, toDate, page, perPage } = validateCrmHistoryQuery(query);

  const body = await shamsFetch<RawCrmResponse>("/api/v2/crm/data", {
    mobileno: mobile,
    fromdt: fromDate,
    todt: toDate,
    page,
    per_page: perPage,
  });

  const { customer, sales } = groupCrmHistory(body?.data);

  const echoedPerPage = Number(body?.pagination?.per_page);
  const effectivePerPage =
    Number.isFinite(echoedPerPage) && echoedPerPage > 0 ? echoedPerPage : perPage;

  return {
    customer,
    sales,
    page,
    perPage: effectivePerPage,
    hasMore: sales.length >= effectivePerPage,
  };
}
