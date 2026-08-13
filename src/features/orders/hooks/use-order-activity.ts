/**
 * One order's activity log.
 *
 * Extracted from `OrderActivityTimeline` because it now has a second reader: the
 * invoice panel needs to know which invoices the log already records as verified,
 * and that is the same rows the timeline renders. Sharing the hook — and so the
 * query key — means the page fetches the history once and both surfaces agree on
 * it, rather than two queries racing on one key with two different shapes.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";

export interface OrderActivityEvent {
  id: string;
  action: string;
  details: Record<string, any> | null;
  created_at: string;
  actor_id: string | null;
  /** Resolved from `profiles`; "System" for the trigger's own rows. */
  actor_name: string;
}

export function useOrderActivity(orderId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.orders.activity(orderId ?? ""),
    enabled: enabled && !!orderId,
    queryFn: async (): Promise<OrderActivityEvent[]> => {
      const [{ data: events }, { data: profiles }] = await Promise.all([
        supabase
          .from("order_activity" as any)
          .select("*")
          .eq("order_id", orderId as string)
          .order("created_at", { ascending: false }),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      return ((events as any[]) ?? []).map((e: any) => ({
        ...e,
        actor_name: nm.get(e.actor_id) ?? "System",
      }));
    },
  });
}

/**
 * The invoice keys this order's timeline already records as verified.
 *
 * The idempotency check the client makes before asking the database to record
 * anything. The database enforces the same rule — see
 * `record_invoice_verification` — so this is an optimisation, not the guarantee:
 * an order whose invoices were verified yesterday makes no request today.
 */
export function recordedInvoiceKeys(
  events: readonly OrderActivityEvent[] | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const event of events ?? []) {
    if (event.action === "invoice_verified" && event.details?.invoice_key) {
      keys.add(String(event.details.invoice_key));
    }
  }
  return keys;
}
