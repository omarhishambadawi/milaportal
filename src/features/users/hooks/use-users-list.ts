import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { adminListUsers } from "@/lib/admin.functions";
import { queryKeys } from "@/lib/query-keys";

import { USERS_STALE_TIME_MS } from "../constants";
import type { AdminUserRow } from "../types";

/**
 * The user list itself.
 *
 * One server call returns every account with its role, email and a signed avatar
 * URL already resolved, so there is nothing left to join on the client. `enabled`
 * mirrors the page's permission gate: without it React Query would fire a request
 * that the server refuses, producing an error toast on a screen the user is
 * already being told they cannot see.
 */
export function useUsersList(enabled: boolean) {
  const listFn = useServerFn(adminListUsers);
  const query = useQuery({
    queryKey: queryKeys.adminUsers.list(),
    queryFn: () => listFn() as Promise<AdminUserRow[]>,
    enabled,
    staleTime: USERS_STALE_TIME_MS,
  });

  return {
    users: (query.data ?? []) as AdminUserRow[],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
  };
}
