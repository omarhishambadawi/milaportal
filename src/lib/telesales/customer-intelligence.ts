import type { ShamsCrmHistory, ShamsCrmSale } from "@/lib/shams/types";

/**
 * What the Shams MIS knows about a telesales customer.
 *
 * Pure. Given one page of `crm/data` — the shape the existing
 * `shamsGetCustomerHistory` already returns — this derives the four things an
 * agent needs on a call: who the MIS thinks this is, what they bought last,
 * what they have bought before, and what their loyalty balance is.
 *
 * ===========================================================================
 * Why this is a separate module and not a component
 * ===========================================================================
 * "The last purchase" and "which products has this customer bought" are rules,
 * and a rule that lives in JSX gets a second, slightly different copy the next
 * time somebody needs it — which is exactly what happens in the phase that adds
 * cross-sell recommendations on top of this data. The derivation is here, it is
 * unit tested against the real response shape, and the components format it.
 *
 * Nothing here fetches. Nothing here caches. The existing integration owns both.
 */

/** One row of the purchase table, already resolved for display. */
export interface PurchaseLine {
  /** `docNo` — the invoice/document number. Identifies a document only with the
   *  branch, which is why both travel together. */
  documentNo: string | null;
  /** ISO-8601 or the raw string the API gave. No timezone; see `toIsoDateTime`. */
  purchasedAt: string | null;
  /** `YYYY-MM-DD`, when the date could be read. The sortable half. */
  purchasedOn: string | null;
  branchCode: string | null;
  branchLabel: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantity: number;
}

/** A product the customer has bought before, folded across every line. */
export interface PurchasedProduct {
  itemCode: string | null;
  itemName: string;
  /** How many separate lines mention it. */
  timesPurchased: number;
  totalQuantity: number;
  /** The most recent date it was bought, `YYYY-MM-DD` where known. */
  lastPurchasedOn: string | null;
}

export interface CustomerIntelligence {
  /** The MIS's own identity for this number. `null` when it matched nobody. */
  misCustomerId: string | null;
  misName: string | null;
  misMobile: string | null;
  loyaltyPoints: number | null;
  loyaltyValue: number | null;
  /** Newest first. */
  purchases: PurchaseLine[];
  /** The newest line, or null when there are none. */
  lastPurchase: PurchaseLine | null;
  /** Distinct products, most recently purchased first. */
  products: PurchasedProduct[];
  /** True when this page filled up, so older history exists beyond it. */
  hasMore: boolean;
}

/**
 * `2026-08-28T00:00:00` → `2026-08-28`.
 *
 * Read off the string rather than through `Date`. The API supplies no timezone,
 * so constructing an instant would move a midnight purchase into the previous
 * day for anyone west of Riyadh — the same reasoning `saleMonthKey` already
 * documents for month grouping.
 */
export function purchaseDay(sale: { docDate: string | null }): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(sale.docDate ?? "");
  return match ? match[1] : null;
}

function toLine(sale: ShamsCrmSale): PurchaseLine {
  return {
    documentNo: sale.docNo,
    purchasedAt: sale.docDate,
    purchasedOn: purchaseDay(sale),
    branchCode: sale.branchCode,
    branchLabel: sale.branchLabel,
    itemCode: sale.itemCode,
    itemName: sale.itemName,
    quantity: sale.quantity,
  };
}

/**
 * Fold one page of history into the shape the profile renders.
 *
 * ### Ordering
 *
 * `normalize.ts` already sorts newest-first, and this preserves that order
 * rather than re-sorting: the API supplies dates with no timezone and some rows
 * with no parseable date at all, so a second sort here would be a second
 * opinion about the same ambiguous strings. Rows without a date keep their
 * position instead of being silently promoted to the top — which is what a
 * naive `sort` on `null` does in some engines.
 *
 * `lastPurchase` is therefore the first row **that has a date**. A dateless row
 * cannot be the most recent purchase, because nothing about it says when it
 * happened, and showing it as "last purchase · —" would tell an agent less than
 * showing the newest row that does have a date.
 */
export function deriveCustomerIntelligence(
  history: ShamsCrmHistory | null | undefined,
): CustomerIntelligence {
  const sales = history?.sales ?? [];
  const purchases = sales.map(toLine);

  return {
    misCustomerId: history?.customer?.customerId ?? null,
    misName: history?.customer?.name ?? null,
    misMobile: history?.customer?.mobile ?? null,
    /*
     * Loyalty is only reported when the MIS actually named a customer.
     *
     * `ShamsCrmCustomer.availablePoints` is a `number`, so a customer the API
     * did not return has no zero to read — and rendering "0 points" for a number
     * the MIS has never heard of would be an invented fact. Null means unknown
     * and the UI says so.
     */
    loyaltyPoints: history?.customer ? history.customer.availablePoints : null,
    loyaltyValue: history?.customer ? history.customer.pointsValue : null,
    purchases,
    lastPurchase: purchases.find((p) => p.purchasedOn !== null) ?? null,
    products: foldProducts(purchases),
    hasMore: history?.hasMore ?? false,
  };
}

/**
 * Distinct products, in the order they were most recently bought.
 *
 * Keyed on `itemCode` where there is one and on the trimmed name otherwise —
 * the Cash extract proves a code can be missing, and two rows naming the same
 * product should not become two products because one of them lost its code.
 *
 * A row with neither a code nor a name is skipped: it would render as a blank
 * chip that tells an agent nothing.
 */
function foldProducts(lines: readonly PurchaseLine[]): PurchasedProduct[] {
  const byKey = new Map<string, PurchasedProduct>();

  for (const line of lines) {
    const name = (line.itemName ?? "").trim();
    const code = (line.itemCode ?? "").trim();
    if (!name && !code) continue;

    const key = code || name.toUpperCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.timesPurchased += 1;
      existing.totalQuantity += line.quantity;
      // Lines arrive newest-first, so the first dated one wins.
      if (!existing.lastPurchasedOn && line.purchasedOn) {
        existing.lastPurchasedOn = line.purchasedOn;
      }
      continue;
    }

    byKey.set(key, {
      itemCode: code || null,
      itemName: name || code,
      timesPurchased: 1,
      totalQuantity: line.quantity,
      lastPurchasedOn: line.purchasedOn,
    });
  }

  // Insertion order is already "most recently purchased first", because the
  // lines were.
  return [...byKey.values()];
}

/* ------------------------------------------------------------------------- */
/* The lookup window                                                         */
/* ------------------------------------------------------------------------- */

/**
 * How far back a profile asks for.
 *
 * `crm/data` requires a `fromdt`/`todt` pair — there is no "everything" — so a
 * window has to be chosen and it may as well be chosen once, here, rather than
 * by each caller.
 *
 * Two years. Long enough to establish a purchase pattern for a chronic-therapy
 * customer on a 28-day refill cycle (roughly 26 fills), and short enough that
 * one page of 100 lines usually covers it. When it does not, `hasMore` says so
 * rather than the profile silently showing a truncated history.
 */
export const HISTORY_WINDOW_MONTHS = 24;

/** `YYYYMMDD`, the only format `crm/data` is confirmed to accept. */
function compact(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * The window to ask for, ending today.
 *
 * Built on `Date.UTC` for the same reason every other date in this module is:
 * the portal renders in a Worker and a browser, and a window whose edges move
 * with the host's timezone is a window that returns a different history
 * depending on where it was computed.
 *
 * `asOf` is injectable so the tests do not depend on the wall clock.
 */
export function historyWindow(
  asOf: Date = new Date(),
  months: number = HISTORY_WINDOW_MONTHS,
): { fromDate: string; toDate: string } {
  const to = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - Math.max(1, Math.trunc(months)));
  return { fromDate: compact(from), toDate: compact(to) };
}

/* ------------------------------------------------------------------------- */
/* What the UI is being told                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The state of a lookup, as one value the UI switches on.
 *
 * The distinction the brief insists on — and it is the important one in this
 * whole phase — is between `no_customer`/`no_purchases` and everything else. A
 * customer the MIS has never heard of and a MIS that could not be reached look
 * identical in a naive implementation: both produce an empty list. Telling an
 * agent "no purchase history" when the truth is "the lookup failed" invites
 * them to say something false to a customer who has been shopping there for
 * years.
 */
export type IntelligenceState =
  | "loading"
  | "not_configured"
  | "forbidden"
  | "error"
  | "no_customer"
  | "no_purchases"
  | "ready";

export interface IntelligenceMessage {
  title: string;
  detail: string;
  /** Whether offering a Retry makes sense. A missing credential does not fix
   *  itself on a second attempt; a timeout might. */
  retryable: boolean;
}

/**
 * User-facing copy per state.
 *
 * Never an upstream message, a status code, a URL or a stack. `ShamsFailure.kind`
 * is a closed set produced by `client.server.ts`, and it is mapped here rather
 * than rendered, so nothing the MIS says can reach an agent's screen verbatim.
 */
export const INTELLIGENCE_MESSAGES: Record<
  Exclude<IntelligenceState, "ready" | "loading">,
  IntelligenceMessage
> = {
  not_configured: {
    title: "Shams MIS is not connected",
    detail:
      "This deployment has no Shams MIS credentials configured, so customer history and loyalty cannot be retrieved. This does not mean the customer has never purchased.",
    retryable: false,
  },
  forbidden: {
    title: "You do not have access to Shams MIS",
    detail:
      "Customer purchase history and loyalty come from the pharmacy's own system, which is granted separately. Ask an administrator for Shams MIS access.",
    retryable: false,
  },
  error: {
    title: "Shams MIS is currently unavailable",
    detail:
      "Customer information could not be retrieved. This does not mean the customer has never purchased — try again, or continue the call without it.",
    retryable: true,
  },
  no_customer: {
    title: "No matching customer in Shams MIS",
    detail:
      "No customer is registered against this mobile number. They may have purchased without a loyalty account.",
    retryable: false,
  },
  no_purchases: {
    title: "No purchase history found",
    detail: "Shams MIS knows this customer but has no purchases in the last two years.",
    retryable: false,
  },
};

/**
 * Decide which state a completed lookup is in.
 *
 * Ordered deliberately: configuration before failure, failure before absence.
 * An unconfigured deployment is not an outage, and an outage is not an empty
 * history.
 */
export function classifyLookup(input: {
  configured: boolean;
  ok: boolean;
  errorKind: string | null;
  history: ShamsCrmHistory | null;
}): IntelligenceState {
  if (!input.configured) return "not_configured";
  if (!input.ok || input.errorKind) return "error";
  if (!input.history || !input.history.customer) return "no_customer";
  if (input.history.sales.length === 0) return "no_purchases";
  return "ready";
}
