import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { adminListActivity } from "@/lib/admin.functions";
import { ACTIVITY_MAX_ROWS, ACTIVITY_PAGE_SIZE } from "@/lib/audit-log";
import { queryKeys } from "@/lib/query-keys";

import type { AdminActivityEntry } from "../types";

/**
 * The administrative audit trail, optionally scoped to one account.
 *
 * Paging is a growing `limit` rather than an accumulating list of pages: the log
 * is append-only at the head, so an offset-based page 2 shifts under the reader
 * every time someone performs an audited action. Re-reading from the top is
 * exact, and React Query caches each limit separately with the previous page's
 * data kept via `placeholderData`, so "Load more" extends the list in place
 * rather than blanking it.
 *
 * `enabled` mirrors the caller's gate. The server refuses non-administrators, and
 * firing a request that is known to be refused only produces an error where the
 * UI already explains the restriction.
 */
export function useAdminActivity({
  targetUserId = null,
  enabled,
}: {
  targetUserId?: string | null;
  enabled: boolean;
}) {
  const listFn = useServerFn(adminListActivity);
  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE);

  const query = useQuery({
    queryKey: queryKeys.adminUsers.activity(targetUserId, limit),
    queryFn: () =>
      listFn({ data: { targetUserId: targetUserId ?? undefined, limit } }) as Promise<{
        entries: AdminActivityEntry[];
        hasMore: boolean;
      }>,
    enabled,
    // Keeps the already-rendered entries on screen while a larger page loads —
    // but ONLY when the window grew for the same account. Carrying data across a
    // change of `targetUserId` would render one person's history under another
    // person's heading, which in an audit log is not a cosmetic glitch.
    placeholderData: (previous, previousQuery) => {
      const previousTarget = (previousQuery?.queryKey?.[2] ?? null) as string | null;
      return previousTarget === targetUserId ? previous : undefined;
    },
  });

  const loadMore = useCallback(
    () => setLimit((n) => Math.min(n + ACTIVITY_PAGE_SIZE, ACTIVITY_MAX_ROWS)),
    [],
  );

  /** Reset the window — called when the dialog closes, so reopening starts fresh. */
  const reset = useCallback(() => setLimit(ACTIVITY_PAGE_SIZE), []);

  return {
    entries: query.data?.entries ?? [],
    // `hasMore` is the server's answer; the ceiling is this layer's, so a reader
    // at the cap is told the view is truncated rather than offered a dead button.
    hasMore: (query.data?.hasMore ?? false) && limit < ACTIVITY_MAX_ROWS,
    atCap: (query.data?.hasMore ?? false) && limit >= ACTIVITY_MAX_ROWS,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    loadMore,
    reset,
  };
}
