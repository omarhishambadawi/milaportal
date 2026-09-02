import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { shamsGetCustomerHistory } from "@/lib/shams.functions";
import {
  classifyLookup,
  deriveCustomerIntelligence,
  historyWindow,
  type CustomerIntelligence,
  type IntelligenceState,
} from "@/lib/telesales/customer-intelligence";

/**
 * Shams MIS customer intelligence for one canonical phone number.
 *
 * ===========================================================================
 * This adds no integration
 * ===========================================================================
 * It calls `shamsGetCustomerHistory`, the server function the Shams MIS module
 * already exposes — the same one the `/shams` Customers tab uses. That function
 * owns the credential, the auth-token exchange, the timeout, the permission
 * check and the error taxonomy; none of it is repeated here. What this adds is
 * the *telesales* framing: one lookup per customer, derived into the four
 * things an agent needs mid-call.
 *
 * The phone conversion is likewise not reimplemented. The canonical
 * `0504630565` is handed to the server function unchanged and
 * `normalizeCrmMobile` — the integration's own established conversion — reduces
 * it to the nine digits `crm/data` wants. There is exactly one algorithm and it
 * is not in this file.
 *
 * ===========================================================================
 * Keyed on the customer, not the lead
 * ===========================================================================
 * The query key is the phone number. A customer holding a Mounjaro lead, an
 * Ozempic lead and a retention cycle has one entry in the cache, so opening all
 * three costs one request and the second and third are instant. That is the
 * Phase 1 consolidation paying for itself, and it is why this hook takes a phone
 * rather than a lead id.
 *
 * ===========================================================================
 * Caching
 * ===========================================================================
 * Browser-side only, and deliberately. `crm.server.ts` documents why it does not
 * cache server-side: a cache keyed on mobile number would be a server-side store
 * of identifiable customer data, which is a thing to add on purpose with a
 * reason rather than as a performance reflex. That decision is respected here —
 * React Query holds the answer for as long as the agent is looking at it, which
 * is where the repeat-view saving actually is.
 *
 * No automatic retry. The MIS is a third-party system on a metered credential,
 * and React Query's default of three silent attempts turns one agent opening a
 * lead into three upstream requests. A failure surfaces a Retry button instead.
 */

export interface CustomerIntelligenceResult {
  state: IntelligenceState;
  data: CustomerIntelligence | null;
  /** When the answer on screen was actually fetched. Real, not implied — it is
   *  React Query's own timestamp for this cache entry. */
  retrievedAt: number | null;
  isFetching: boolean;
  refetch: () => void;
}

/**
 * `Forbidden: …` is thrown rather than returned.
 *
 * `assertPermission` throws, and `toFailure` deliberately rethrows anything
 * starting with `Forbidden` instead of folding it into a `ShamsFailure` — so an
 * authorization refusal arrives here as a rejected promise, not as
 * `{ ok: false }`. Distinguished because "you may not see this" and "the system
 * is down" are different things to tell an agent.
 */
function isForbidden(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Forbidden");
}

export function useCustomerIntelligence(
  phone: string | null | undefined,
  enabled: boolean,
): CustomerIntelligenceResult {
  const query = useQuery({
    // The phone, not the lead. See the note above.
    queryKey: [...queryKeys.telesales.all(), "mis-intelligence", phone ?? ""],
    enabled: enabled && Boolean(phone),
    /*
     * Five minutes. Loyalty points and a purchase history do not change while an
     * agent is on one call, and re-asking a third-party system on every render
     * of a panel is exactly the traffic the integration's own caching note warns
     * about.
     */
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { fromDate, toDate } = historyWindow();
      return shamsGetCustomerHistory({
        data: { mobile: phone!, fromDate, toDate, perPage: 100 },
      });
    },
  });

  const state: IntelligenceState = query.isPending
    ? "loading"
    : query.isError
      ? isForbidden(query.error)
        ? "forbidden"
        : "error"
      : classifyLookup({
          configured: query.data?.configured ?? false,
          ok: query.data?.ok ?? false,
          errorKind: query.data?.error?.kind ?? null,
          history: query.data?.history ?? null,
        });

  return {
    state,
    data: state === "ready" ? deriveCustomerIntelligence(query.data?.history) : null,
    retrievedAt: query.dataUpdatedAt || null,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}
