import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import {
  telesalesSaveProductRelation,
  telesalesSetProductRelationActive,
} from "@/lib/telesales.functions";
import { SAVE_PLAN_LABELS, type RelationProduct, type SavePlan } from "@/lib/telesales/relations";

/**
 * Cross-sell configuration: the management screen's data.
 *
 * Two small reads and two writes. The reads go straight from the browser under
 * RLS, which permits `view_telesales`; the writes go through server functions
 * running as `service_role` that check `manage_telesales` themselves, because
 * the table carries a SELECT policy and nothing else. That split is the
 * module's established pattern and is what makes hiding the buttons a
 * convenience rather than the security boundary.
 *
 * Nothing here touches the Shams MIS, and nothing here runs per lead — the
 * recommendation engine reads the same table once per page load.
 */

export interface ProductRelationRow {
  id: string;
  from_item_code: string;
  to_item_code: string;
  to_item_name: string;
  /** "cross_sell" | "up_sell". Defaulted in the database, so a row configured
   *  before the field existed reads as a cross-sell. */
  kind: string;
  note: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

/** Every configured pair, active first. */
export function useProductRelations(enabled: boolean) {
  return useQuery<ProductRelationRow[]>({
    queryKey: [...queryKeys.telesales.products(), "relations"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_product_relations")
        .select(
          "id,from_item_code,to_item_code,to_item_name,kind,note,active,created_by,created_at,updated_by,updated_at",
        )
        .order("active", { ascending: false })
        .order("from_item_code", { ascending: true })
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data as ProductRelationRow[]) ?? [];
    },
  });
}

/**
 * The product master, for both ends of the picker.
 *
 * Inactive products are returned too. A customer may have bought something the
 * desk has since stopped selling, and that purchase is still a real thing to
 * recommend *from* — the validator refuses an inactive product only as the
 * recommended one.
 */
export function useRelationProducts(enabled: boolean) {
  return useQuery<RelationProduct[]>({
    queryKey: [...queryKeys.telesales.products(), "catalog"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_products")
        .select("item_code,item_name,active,family")
        .order("item_name", { ascending: true });
      if (error) throw new Error(error.message);
      return ((data as any[]) ?? []).map((p) => ({
        itemCode: p.item_code,
        itemName: p.item_name,
        active: p.active,
      }));
    },
  });
}

export function useRelationMutations() {
  const qc = useQueryClient();
  /*
   * Sweeps the product root, which covers both the configuration list and the
   * relations the recommendation engine loaded. Switching a pair off has to
   * stop the recommendations it was producing, not just grey out a row.
   */
  const sweep = () => {
    qc.invalidateQueries({ queryKey: queryKeys.telesales.products() });
    qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
  };
  const fail = (err: unknown) =>
    toast.error(err instanceof Error ? err.message : "That change could not be saved.");

  const save = useMutation({
    mutationFn: (input: {
      fromItemCode: string;
      toItemCode: string;
      kind?: string;
      note?: string | null;
      /**
       * Report nothing and refetch nothing; the caller will.
       *
       * Applying one companion to six strengths is six calls, and each one
       * announcing itself produced six toasts and six cache sweeps before the
       * caller's own summary — so the supervisor read seven messages about one
       * action, and the list refetched underneath them while the writes were
       * still going. The bulk path says it once, at the end.
       */
      silent?: boolean;
    }) => {
      // Client-side only: the server function takes no such field.
      const { silent: _silent, ...payload } = input;
      return telesalesSaveProductRelation({ data: payload });
    },
    onSuccess: (r, vars) => {
      if (vars.silent) return;
      sweep();
      // Says which of the four things actually happened -- created, switched
      // back on, edited, or nothing at all.
      const plan = (r as { plan?: SavePlan }).plan ?? "created";
      if (plan === "unchanged") toast.info(SAVE_PLAN_LABELS[plan]);
      else toast.success(SAVE_PLAN_LABELS[plan]);
    },
    onError: (err, vars) => {
      if (vars.silent) return;
      fail(err);
    },
  });

  const setActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      telesalesSetProductRelationActive({ data: input }),
    onSuccess: (_r, vars) => {
      sweep();
      toast.success(vars.active ? "Recommendation switched on" : "Recommendation switched off");
    },
    onError: fail,
  });

  // `sweep` is exposed so a bulk caller can refetch once when it is done
  // rather than after every write.
  return { save, setActive, sweep, busy: save.isPending || setActive.isPending };
}
