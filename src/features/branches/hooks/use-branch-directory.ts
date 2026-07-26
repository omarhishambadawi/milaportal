import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, isAdministrator } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { decorate } from "../search";
import type { Branch, BranchView } from "../types";

/** PostgREST caps a single response at 1000 rows regardless of the range asked for. */
const PAGE = 1000;

/**
 * Columns the directory reads, listed explicitly rather than `select("*")`.
 *
 * `branches.location` is a `geography(Point,4326)` generated column, and
 * PostgREST serializes it as a WKB hex string — around 100 bytes per row of
 * data the browser has no use for, since it already receives latitude and
 * longitude as numbers. At a few thousand branches that is a few hundred KB on
 * every load, spent on a column only the database's spatial index reads.
 */
const DIRECTORY_COLUMNS =
  "branch_no,city,phone,area_manager,area_manager_phone,email,address,maps_url," +
  "latitude,longitude,scooter,scooter_note,working_hours,friday_hours,duty_hours," +
  "active,created_at,updated_at";

async function fetchBranches(): Promise<Branch[]> {
  const rows: Branch[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await supabase
      .from("branches")
      .select(DIRECTORY_COLUMNS)
      // Deactivated branches are history, not directory. They stay in the table
      // because orders reference them; they do not belong in a search an agent
      // runs to tell a customer where to collect.
      .eq("active", true)
      .order("branch_no")
      .range(start, start + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Branch[]));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * The directory's dataset and the permissions that shape it.
 *
 * The whole table is fetched once and searched in the browser, rather than
 * issuing a query per keystroke. At the network's size — 145 branches today,
 * built to hold a few thousand — the entire dataset is smaller than a single
 * page of orders, and holding it locally is the only way to answer a keystroke
 * in under a frame. A server round trip per character could not be instant no
 * matter how the query were written.
 */
export function useBranchDirectory() {
  const { role, profile } = useAuth();
  const permissions = profile?.permissions;

  const canView =
    hasPerm(role, permissions, "view_branches") || hasPerm(role, permissions, "admin_access");
  /** Import and edit. Owner, Admin and Supervisor hold `admin_access`. */
  const canManage = hasPerm(role, permissions, "admin_access");
  /** Rollback. Administrators only — mirrors the server-side gate. */
  const canRollback = isAdministrator(role);
  const canExport = hasPerm(role, permissions, "export_reports") || canManage;

  const query = useQuery({
    queryKey: queryKeys.branches.directory(),
    queryFn: fetchBranches,
    enabled: canView,
    // Branches change when someone runs an import, which is a rare, deliberate
    // act — not something worth re-checking on every window focus.
    staleTime: 5 * 60 * 1000,
  });

  // The one place `decorate` is called. Keyed on the fetched array's identity,
  // so it re-runs when the data changes and never on a filter or a keystroke.
  const branches: BranchView[] = useMemo(() => decorate(query.data ?? []), [query.data]);

  return {
    branches,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    canView,
    canManage,
    canRollback,
    canExport,
  };
}
