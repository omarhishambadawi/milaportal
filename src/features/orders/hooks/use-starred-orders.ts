import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The orders the signed-in agent has starred.
 *
 * Backed by `public.order_stars` (migration `20260809120000_order_stars.sql`),
 * one row per (agent, order). This was localStorage, which made a star a
 * property of the *browser*: an agent who starred an order on the call-floor
 * machine saw nothing of it on their laptop. It follows the account now.
 *
 * Isolation is RLS, not this file. Every policy on the table is
 * `auth.uid() = user_id`, so the select below cannot return another agent's rows
 * and the insert cannot create one owned by somebody else — a bug here degrades
 * to showing the agent nothing, never to showing them someone else's shortlist.
 * The redundant `.eq("user_id")` states the same scope the policy enforces, so
 * the query reads as what it is rather than relying on the reader knowing the
 * policy.
 *
 * `as any` on the table name because `order_stars` is not in the generated
 * Supabase types — that file is re-emitted by Lovable and a hand-edit is lost on
 * the next sync, so the codebase casts instead (see the `orders_kpi_summary`
 * call in `use-orders-list-data`).
 */
export function useStarredOrders(userId: string | undefined) {
  const qc = useQueryClient();
  const key = queryKeys.orders.stars(userId);

  const { data, isLoading } = useQuery({
    queryKey: key,
    enabled: !!userId,
    // A shortlist changes only when this agent clicks a star, and the toggle
    // below keeps the cache exact. Re-reading it on every remount of the Orders
    // page would be a round trip that can only confirm what is already held.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("order_stars" as any)
        .select("order_id")
        .eq("user_id", userId as string);
      if (error) throw error;
      return (data ?? []).map((row: any) => row.order_id as string);
    },
  });

  const starred = useMemo(() => new Set(data ?? []), [data]);

  const mutation = useMutation({
    mutationFn: async ({ orderId, next }: { orderId: string; next: boolean }) => {
      if (!userId) return;
      if (next) {
        const { error } = await supabase
          .from("order_stars" as any)
          .insert({ user_id: userId, order_id: orderId } as any);
        // 23505 is the (user_id, order_id) unique constraint: the star this
        // click asked for already exists, which is the state the caller wanted.
        // Two tabs open on the same list should not raise an error between them.
        if (error && (error as any).code !== "23505") throw error;
        return;
      }
      const { error } = await supabase
        .from("order_stars" as any)
        .delete()
        .eq("user_id", userId)
        .eq("order_id", orderId);
      if (error) throw error;
    },

    // Applied to the cache before the request leaves, so the star fills in on
    // the click rather than a round trip later.
    onMutate: async ({ orderId, next }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<string[]>(key);
      qc.setQueryData<string[]>(key, (current) => {
        const ids = current ?? [];
        if (next) return ids.includes(orderId) ? ids : [...ids, orderId];
        return ids.filter((id) => id !== orderId);
      });
      return { previous };
    },

    onError: (_err, _vars, context) => {
      // Put the star back where it was. Leaving the optimistic value on screen
      // after a failed write is the one outcome worse than not starring: the
      // agent believes a shortlist holds an order that it does not.
      if (context?.previous !== undefined) qc.setQueryData(key, context.previous);
      toast.error("Could not update star");
    },

    // Deliberately no invalidate-on-settle. The write is one id added or one id
    // removed, which is exactly what `onMutate` already applied, so a refetch
    // could only re-fetch the answer the cache is holding. The error path
    // restores the truth instead.
  });

  /**
   * The current shortlist, for the toggle to read without depending on it.
   *
   * `toggleStar` is a prop of every `memo`ised `OrderRow`, so its identity has to
   * survive a render. Closing over `starred` directly would change it on every
   * star click — and on the first arrival of the query — re-rendering all 25–100
   * rows to flip one glyph. The ref is written during commit, before any click
   * can read it, so the value the toggle sees is the same one the closure would
   * have held.
   */
  const starredRef = useRef(starred);
  useEffect(() => {
    starredRef.current = starred;
  }, [starred]);

  const toggleStar = useCallback(
    (orderId: string) => {
      if (!userId || !orderId) return;
      mutation.mutate({ orderId, next: !starredRef.current.has(orderId) });
    },
    // `mutation.mutate` is stable across renders; the `mutation` object is not.
    [mutation.mutate, userId],
  );

  return {
    starred,
    toggleStar,
    canStar: !!userId,
    /** True until the agent's shortlist has been read at least once. */
    starsLoading: !!userId && isLoading,
  };
}
