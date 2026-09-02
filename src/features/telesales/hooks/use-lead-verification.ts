import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { shamsGetInvoices, shamsGetProduct } from "@/lib/shams.functions";
import { branchStockState, type StockState } from "@/lib/shams/availability";
import {
  invoiceCheckability,
  reconcileInvoice,
  type HistoryDocument,
  type InvoiceVerification,
  type ReconcilableLead,
} from "@/lib/telesales/reconciliation";

/**
 * Invoice verification and branch stock for one lead.
 *
 * ===========================================================================
 * Two requests, both shared with the Shams module
 * ===========================================================================
 * `shamsGetInvoices` is the same server function the `/shams` Invoices tab
 * calls, and `shamsGetProduct` is the one behind its Stock tab. Neither is
 * wrapped or reimplemented, and — deliberately — both are stored under the
 * Shams module's **own** query keys:
 *
 *     queryKeys.shams.invoices(branchCode, docNo)
 *     queryKeys.shams.product(itemCode)
 *
 * So an agent who looks a document up on the Shams page and then opens the
 * telesales lead for it pays for one request, not two, and the two screens can
 * never show different answers about the same document. Using a
 * `telesales`-prefixed key would have produced a second cache entry for
 * identical data.
 *
 * ===========================================================================
 * Nothing here runs from the queue
 * ===========================================================================
 * Both queries are `enabled` only on a lead detail view and only when the lead
 * has something to check. The queue renders from Postgres alone and issues no
 * MIS request at all — a hundred rows would otherwise be a hundred invoice
 * lookups and a hundred stock lookups.
 *
 * Server-side, both endpoints already sit behind the integration's own TTL
 * caches (`stockCache` at 60s, the invoice sweep's `sweptDocuments`), so a
 * repeat view inside that window does not reach the MIS either.
 */

export type VerificationState = "idle" | "loading" | "unavailable" | "forbidden" | "ready";

export interface LeadStockResult {
  state: StockState;
  quantity: number | null;
  itemCode: string | null;
  itemName: string | null;
  branchNo: string | null;
  /** True when the product code itself could not be resolved in the catalogue,
   *  as opposed to the branch being absent from a real response. */
  productUnknown: boolean;
}

function isForbidden(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Forbidden");
}

/**
 * Invoice reconciliation.
 *
 * `historyDocuments` is the customer's CRM history, which the profile has
 * already loaded for Phase 2. Passing it in costs nothing and is what lets a
 * "not matched" answer say *"the customer's history shows this number at
 * P0027"* instead of stopping at "not found" — without the branch sweep's
 * fan-out across every warehouse.
 */
export function useInvoiceVerification(
  lead: ReconcilableLead | null,
  enabled: boolean,
  historyDocuments: readonly HistoryDocument[] = [],
): { state: VerificationState; verification: InvoiceVerification | null; refetch: () => void } {
  const gate = lead ? invoiceCheckability(lead) : ({ checkable: false } as const);
  const checkable = Boolean(lead) && gate.checkable;

  const branchCode = (lead?.branchNo ?? "").trim().toUpperCase();
  const docNo = (lead?.documentNo ?? "").trim();

  const query = useQuery({
    // The Shams module's key, on purpose. See the note above.
    queryKey: queryKeys.shams.invoices(branchCode, docNo),
    enabled: enabled && checkable,
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => shamsGetInvoices({ data: { branchCode, docNoStart: docNo } }),
  });

  if (!lead) return { state: "idle", verification: null, refetch: () => {} };

  // A lead that cannot be checked resolves immediately, without a request.
  if (!gate.checkable) {
    return {
      state: "ready",
      verification: reconcileInvoice({ lead, invoices: [] }),
      refetch: () => {},
    };
  }

  const state: VerificationState = query.isPending
    ? "loading"
    : query.isError
      ? isForbidden(query.error)
        ? "forbidden"
        : "unavailable"
      : !query.data?.configured || !query.data.ok
        ? "unavailable"
        : "ready";

  return {
    state,
    verification:
      state === "ready"
        ? reconcileInvoice({
            lead,
            invoices: query.data?.invoices ?? [],
            historyDocuments,
          })
        : null,
    refetch: () => void query.refetch(),
  };
}

/**
 * What the lead's branch holds of the lead's product.
 *
 * One request per *product*, shared with the Shams Stock tab, and the verdict
 * comes from `branchStockState` — the integration's own function, reused
 * verbatim rather than reimplemented. It already distinguishes the four states
 * that matter, including the one a naive implementation gets wrong: a branch
 * missing from a non-empty response is `unknown`, not `out_of_stock`.
 */
export function useLeadStock(
  input: { itemCode: string | null; itemName: string | null; branchNo: string | null },
  enabled: boolean,
): { state: VerificationState; stock: LeadStockResult | null; refetch: () => void } {
  const itemCode = (input.itemCode ?? "").trim();
  const branchNo = (input.branchNo ?? "").trim().toUpperCase();
  const checkable = Boolean(itemCode) && Boolean(branchNo);

  const query = useQuery({
    queryKey: queryKeys.shams.product(itemCode),
    enabled: enabled && checkable,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => shamsGetProduct({ data: { itemCode } }),
  });

  if (!checkable) {
    return {
      state: "ready",
      stock: {
        state: "unknown",
        quantity: null,
        itemCode: itemCode || null,
        itemName: input.itemName,
        branchNo: branchNo || null,
        productUnknown: !itemCode,
      },
      refetch: () => {},
    };
  }

  const state: VerificationState = query.isPending
    ? "loading"
    : query.isError
      ? isForbidden(query.error)
        ? "forbidden"
        : "unavailable"
      : !query.data?.configured || !query.data.ok
        ? "unavailable"
        : "ready";

  if (state !== "ready") return { state, stock: null, refetch: () => void query.refetch() };

  const resolved = branchStockState(query.data?.stock, branchNo);
  return {
    state,
    stock: {
      ...resolved,
      itemCode,
      // The catalogue's own name where it resolved one, so an agent can see
      // the product the stock figure is actually about.
      itemName: query.data?.product?.itemName ?? input.itemName,
      branchNo,
      productUnknown: query.data?.product == null,
    },
    refetch: () => void query.refetch(),
  };
}
