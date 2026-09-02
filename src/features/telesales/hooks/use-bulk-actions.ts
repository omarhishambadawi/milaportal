import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import {
  telesalesBulkArchive,
  telesalesBulkAssign,
  telesalesBulkRestore,
} from "@/lib/telesales.functions";

/**
 * Supervisor bulk operations on the queue.
 *
 * Every one of these sweeps `telesales.all()` on success, for the same reason
 * the single-lead mutations do: moving twenty leads changes the queue, the
 * counts on the management board, and the timeline of twenty leads. A targeted
 * invalidation would be three call sites that each have to remember the other
 * two.
 *
 * The results are reported rather than assumed. `bulkAssign` refuses archived
 * leads and no-op reassignments, and a supervisor who selected twenty rows and
 * changed eighteen is told so — silently succeeding on a partial result is how
 * somebody discovers two leads never moved a week later.
 */
export function useBulkLeadActions() {
  const qc = useQueryClient();
  const sweep = () => qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
  const fail = (err: unknown) =>
    toast.error(err instanceof Error ? err.message : "That bulk action failed.");

  /** Report what actually happened, including what was refused. */
  function report(verb: string, result: { changed: number; skipped: { reason: string }[] }) {
    if (result.changed === 0) {
      toast.warning(`No leads were ${verb}.`);
      return;
    }
    const skipped = result.skipped.length;
    toast.success(
      skipped > 0
        ? `${result.changed} lead${result.changed === 1 ? "" : "s"} ${verb} · ${skipped} skipped`
        : `${result.changed} lead${result.changed === 1 ? "" : "s"} ${verb}.`,
    );
  }

  const assign = useMutation({
    mutationFn: (input: { leadIds: string[]; assigneeId: string | null }) =>
      telesalesBulkAssign({ data: input }),
    onSuccess: (r, vars) => {
      sweep();
      report(vars.assigneeId ? "assigned" : "unassigned", r);
    },
    onError: fail,
  });

  const archive = useMutation({
    mutationFn: (input: { leadIds: string[]; reason: string }) =>
      telesalesBulkArchive({ data: input }),
    onSuccess: (r) => {
      sweep();
      report("archived", r);
    },
    onError: fail,
  });

  const restore = useMutation({
    mutationFn: (input: { leadIds: string[] }) => telesalesBulkRestore({ data: input }),
    onSuccess: (r) => {
      sweep();
      report("restored", r);
    },
    onError: fail,
  });

  return {
    assign,
    archive,
    restore,
    busy: assign.isPending || archive.isPending || restore.isPending,
  };
}

/**
 * Agents a lead can be assigned to.
 *
 * The telesales team, plus anyone who already holds a telesales lead — the same
 * union `telesales_agent_workload` uses, and for the same reason: a supervisor
 * covering the desk may hold leads without carrying the agent role, and they
 * have to be reassignable.
 *
 * Two queries rather than a join, because `user_roles` and `profiles` are
 * separate reads under RLS and PostgREST cannot embed across them here without
 * a declared relationship. Both are small and cached for five minutes.
 */
export function useAssignableAgents(enabled: boolean) {
  return useQuery<{ id: string; name: string }[]>({
    queryKey: [...queryKeys.telesales.all(), "assignable-agents"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [{ data: roles }, { data: holders }] = await Promise.all([
        supabase.from("user_roles").select("user_id").eq("role", "telesales"),
        (supabase as any)
          .from("telesales_leads")
          .select("assigned_to")
          .not("assigned_to", "is", null)
          .limit(2000),
      ]);

      const ids = new Set<string>();
      for (const r of (roles as { user_id: string }[]) ?? []) ids.add(r.user_id);
      for (const h of (holders as { assigned_to: string }[]) ?? []) ids.add(h.assigned_to);
      if (ids.size === 0) return [];

      const { data: profiles } = await supabase
        .from("profiles")
        .select("id,full_name")
        .eq("active", true)
        .in("id", [...ids]);

      return ((profiles as { id: string; full_name: string }[]) ?? [])
        .map((p) => ({ id: p.id, name: p.full_name ?? "Unnamed agent" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}
