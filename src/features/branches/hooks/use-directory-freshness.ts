import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { branchImportHistory } from "@/lib/branches.functions";
import { queryKeys } from "@/lib/query-keys";
import type { BranchView, ImportHistoryEntry } from "../types";

/**
 * How current the directory is, for the line under the page title.
 *
 * The question this answers is one an agent asks silently every time they read a
 * phone number off this page: *is this still right?* A directory with no visible
 * age is one people quietly stop trusting and start phoning the area manager to
 * double-check.
 *
 * Two sources, because two audiences have different access:
 *
 *   - **Everyone** gets `lastUpdated`, the newest `updated_at` in the dataset the
 *     page already downloaded. An import stamps every row it writes, so this is
 *     the last time the directory changed — computed from data in hand, no extra
 *     request, and available to an agent holding nothing but `view_branches`.
 *   - **Managers** additionally get the import record itself (file name, mode,
 *     who ran it). `branch_imports` is gated on `admin_access` in RLS *and* in
 *     the server function, because history rows carry a full snapshot of the
 *     table — so this half is asked for only when the viewer may see it.
 */
export function useDirectoryFreshness(branches: BranchView[], canManage: boolean) {
  const historyFn = useServerFn(branchImportHistory);

  const lastUpdated = useMemo(() => {
    let newest: string | null = null;
    for (const branch of branches) {
      if (branch.updated_at && (newest == null || branch.updated_at > newest)) {
        newest = branch.updated_at;
      }
    }
    return newest;
  }, [branches]);

  const query = useQuery({
    queryKey: queryKeys.branches.imports(1),
    queryFn: () => historyFn({ data: { limit: 1 } }) as Promise<ImportHistoryEntry[]>,
    enabled: canManage,
    // Same reasoning as the directory itself: this changes only when somebody
    // runs an import.
    staleTime: 5 * 60 * 1000,
  });

  return { lastUpdated, lastImport: query.data?.[0] ?? null };
}
