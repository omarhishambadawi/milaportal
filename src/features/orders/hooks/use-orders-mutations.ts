import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";

interface UseOrdersMutationsArgs {
  userId: string | undefined;
  canEditAll: boolean;
  canEditOwn: boolean;
  canVerifyAll: boolean;
  canVerifyOwn: boolean;
}

/**
 * Row-level Orders mutations and the per-row permission predicates they enforce.
 * Moved verbatim from the route: same permission checks, same Supabase updates,
 * same cache invalidations (orders + dashboard) and toasts.
 */
export function useOrdersMutations({
  userId,
  canEditAll,
  canEditOwn,
  canVerifyAll,
  canVerifyOwn,
}: UseOrdersMutationsArgs) {
  const qc = useQueryClient();

  const canEditOrder = (order: any) => canEditAll || (userId === order.agent_id && canEditOwn);
  const canVerifyOrder = (order: any) =>
    canVerifyAll || (userId === order.agent_id && canVerifyOwn);

  const updateStatus = async (order: any, newStatus: string) => {
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
  };

  const toggleVerified = async (order: any, value: boolean) => {
    if (!canVerifyOrder(order)) {
      toast.error("You don't have permission to verify this order");
      return;
    }
    const { error } = await supabase
      .from("orders")
      .update({ call_center_verified: value } as any)
      .eq("id", order.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
    qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  return { canEditOrder, canVerifyOrder, updateStatus, toggleVerified };
}
