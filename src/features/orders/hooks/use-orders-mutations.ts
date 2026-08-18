import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";

interface UseOrdersMutationsArgs {
  userId: string | undefined;
  canEditAll: boolean;
  canEditOwn: boolean;
}

/**
 * Row-level Orders mutations and the per-row permission predicates they enforce.
 * Moved verbatim from the route: same permission checks, same Supabase updates,
 * same cache invalidations (orders + dashboard) and toasts.
 */
export function useOrdersMutations({ userId, canEditAll, canEditOwn }: UseOrdersMutationsArgs) {
  const qc = useQueryClient();

  /**
   * Both are `useCallback`ed, and that is load-bearing rather than habit: every
   * row of the Orders table is a `memo`ised `OrderRow` that takes `onUpdateStatus`
   * as a prop, so a fresh function identity here would defeat the memo on all
   * 25–100 rows on every keystroke in the search box. The permission rule and the
   * write itself are unchanged.
   */
  const canEditOrder = useCallback(
    (order: any) => canEditAll || (userId === order.agent_id && canEditOwn),
    [canEditAll, canEditOwn, userId],
  );

  const updateStatus = useCallback(
    async (order: any, newStatus: string) => {
      if (!canEditOrder(order)) {
        toast.error("You don't have permission to edit this order");
        return;
      }
      const { error } = await supabase
        .from("orders")
        .update({ status: newStatus })
        .eq("id", order.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Status updated");
      qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
      qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
    },
    [canEditOrder, qc],
  );

  /**
   * `toggleVerified` and `canVerifyOrder` are both gone.
   *
   * The Call Center flag is no longer something an agent asserts from a table
   * row: it is derived from the MIS's own channel on a verified invoice, by
   * `record_invoice_verification`, and the list renders that. A checkbox beside
   * it could only ever disagree with the document — and, since the automation
   * re-derives the flag on every reconciliation, a manual tick would be
   * overwritten anyway, which is worse than not offering it.
   *
   * The predicate went with it rather than being left behind unused: the order
   * form still offers a manual tick, but it derives its own `canVerifyThis`
   * from the same two permissions, so nothing here was left to call this.
   */
  return { canEditOrder, updateStatus };
}
