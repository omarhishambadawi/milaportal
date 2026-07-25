import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { yeastarRealtimeQueue } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";

interface UseRealtimeQueueArgs {
  authLoading: boolean;
  canView: boolean;
}

/**
 * Realtime queue widget — /queue/call_status + /queue/agent_status. Independent
 * of the historical analytics query; polls every 15s. Moved verbatim from the
 * route (same query key, enabled gate, intervals).
 */
export function useRealtimeQueue({ authLoading, canView }: UseRealtimeQueueArgs) {
  const realtimeFn = useServerFn(yeastarRealtimeQueue);
  return useQuery({
    queryKey: queryKeys.callCenter.realtime(),
    queryFn: () => realtimeFn(),
    enabled: !authLoading && canView,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
