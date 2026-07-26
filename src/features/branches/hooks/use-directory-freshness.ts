import { useMemo } from "react";
import type { BranchView } from "../types";

/**
 * How current the directory is, for the line under the page title.
 *
 * The question this answers is one an agent asks silently every time they read a
 * phone number off this page: *is this still right?* A directory with no visible
 * age is one people quietly stop trusting and start phoning the area manager to
 * double-check.
 *
 * The newest `updated_at` in the dataset the page already downloaded. An import
 * stamps every row it writes, so this is the last time the directory changed —
 * computed from data in hand, no extra request, and available to an agent holding
 * nothing but `view_branches`.
 *
 * It used to also fetch the last import record, to name the file the data came
 * from. That was dropped: the file name told a Customer Care agent nothing they
 * could act on, and asking for it cost an `admin_access`-gated round trip on
 * every page load to render a string most viewers were not allowed to see.
 */
export function useDirectoryFreshness(branches: BranchView[]) {
  return useMemo(() => {
    let newest: string | null = null;
    for (const branch of branches) {
      if (branch.updated_at && (newest == null || branch.updated_at > newest)) {
        newest = branch.updated_at;
      }
    }
    return { lastUpdated: newest };
  }, [branches]);
}
