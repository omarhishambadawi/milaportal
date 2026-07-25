import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type DirectoryAgent = {
  id: string;
  full_name: string | null;
  agent_code: string | null;
  role: string | null;
};

/**
 * Shared React Query key for the agent directory.
 *
 * A single key means the profiles + user_roles fetch is de-duplicated and its
 * cache reused across every consumer (Dashboard, Orders, Call Center) instead of
 * each route holding its own copy under a private key.
 */
export const AGENT_DIRECTORY_KEY = ["agent-directory"] as const;

/**
 * Loads the agent directory, joined with each user's role.
 *
 * What each half returns is NOT symmetric, and the difference is deliberate:
 *
 *   - profiles: every active user sees every row. The directory has to resolve
 *     any agent's name, so row-level access is open by design and the
 *     confidentiality boundary is the column-level SELECT grant — only
 *     (id, full_name, agent_code, active, created_at) are readable at all.
 *   - user_roles: scoped. Only `manage_users` / `view_all_agents` holders read
 *     other people's roles; everyone else gets their own row, so `role` comes
 *     back null for the rest and consumers must tolerate that.
 *
 * This comment previously claimed profiles was scoped the same way as
 * user_roles. It never was: the scoped policy was shadowed by an
 * `USING (true)` directory policy from the day after it was written, and
 * 20260725200000 removed the dead policy rather than the access.
 */
async function fetchAgentDirectory(): Promise<DirectoryAgent[]> {
  const [{ data: profiles }, { data: roles }] = await Promise.all([
    supabase.from("profiles").select("id,full_name,agent_code").order("full_name"),
    supabase.from("user_roles").select("user_id,role"),
  ]);
  const roleById = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
  return (profiles ?? []).map((p: any) => ({ ...p, role: roleById.get(p.id) ?? null }));
}

/**
 * Single reusable source for the agent directory.
 *
 * This exact query was previously copy-pasted into three routes under three
 * different keys ("dashboard-agents", "orders-agents", "cc-agents"), plus the
 * profiles half was fetched a fourth time by the Orders row-enrichment query.
 * They now all read through this one hook / key.
 *
 * @param options.enabled Gate the fetch on a permission flag (defaults to true,
 *   for consumers such as Orders enrichment that need it for every user).
 */
export function useAgentDirectory(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: AGENT_DIRECTORY_KEY,
    queryFn: fetchAgentDirectory,
    enabled: options?.enabled ?? true,
  });
}
