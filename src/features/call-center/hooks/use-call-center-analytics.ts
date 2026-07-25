import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import type { Team, Direction } from "../types";
import { hourLabel } from "../utils";

interface UseCallCenterAnalyticsArgs {
  from: string;
  to: string;
  team: Team;
  agentId: string;
  direction: Direction;
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
  jobId: string;
  jobIdRef: { current: string };
  search: string;
}

/**
 * The single analytics query that feeds every Call Center section, plus the live
 * progress polling and every derived slice (totals, agent rows, day/hour
 * buckets, team comparison, conversion, hourly-12 labelling, agent search).
 *
 * A faithful move of the route's analytics query + effects + memos: same query
 * key, same server fn args, same staleTime/refetch overrides, same loading /
 * error derivation, same progress polling against /api/public/cdr-progress.
 */
export function useCallCenterAnalytics({
  from, to, team, agentId, direction, canAll, canView, authLoading, jobId, jobIdRef, search,
}: UseCallCenterAnalyticsArgs) {
  // Analytics query — one call feeds every section.
  // Gate on auth readiness + permissions to prevent duplicate/premature fetches.
  const analyticsFn = useServerFn(getCallCenterAnalytics);
  const q = useQuery({
    queryKey: queryKeys.callCenter.analytics({ from, to, team, agentId, direction }),
    queryFn: () => analyticsFn({
      data: {
        from, to, team,
        agentId: canAll && agentId !== "all" ? agentId : null,
        direction, status: "all",
        includeOrders: true,
        jobId: jobIdRef.current,
      },
    }),
    enabled: !authLoading && canView,
    // Overrides that are NOT covered by the global defaults: a full CDR sweep
    // can page through millions of records, so this query opts out of remount
    // and reconnect refetches entirely and holds data for 5 min rather than 1.
    // (`refetchOnWindowFocus: false` was dropped — it is now the global default.)
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // Progress polling — track live server progress during any fetch.
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  useEffect(() => {
    if (!q.isFetching || !jobId) { setProgress(null); return; }
    let stop = false;
    const tick = async () => {
      try {
        // The progress endpoint reads via service_role, so it requires a
        // bearer token — send the current session's access token.
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const res = await fetch(`/api/public/cdr-progress/${jobId}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok) return;
        const j = await res.json();
        if (!stop) setProgress({ percent: j.percent ?? 0, message: j.message ?? "Loading…" });
      } catch { /* ignore */ }
    };
    tick();
    const iv = setInterval(tick, 800);
    return () => { stop = true; clearInterval(iv); };
  }, [q.isFetching, jobId]);

  const data = q.data;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;
  // Use isFetching so the loading state persists across every fetch (initial + refetches),
  // and treat auth loading as loading too to avoid a flash of empty KPIs.
  const isLoading = authLoading || q.isFetching || (q.isPending && (q.fetchStatus !== "idle"));
  const errored = (data && data.ok === false) || !!q.error;
  const errMsg = q.error instanceof Error ? q.error.message
    : errored ? (configured ? "Call analytics are temporarily unavailable." : "Call analytics are not configured yet.") : null;

  const totals = ok ? data.totals : null;
  const rows = ok ? data.agents : [];
  const byDay = ok ? data.byDay : [];
  const byHour = ok ? data.byHour : [];
  const teamCompare = ok ? data.teamCompare : [];
  const conv = ok ? data.conversion : null;

  const hourly12 = useMemo(() => byHour.map((h) => ({
    ...h,
    label: hourLabel(h.hour),
  })), [byHour]);

  const searchedAgents = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.ext.toLowerCase().includes(s));
  }, [rows, search]);

  return {
    q,
    progress,
    ok,
    isLoading,
    errMsg,
    totals,
    rows,
    byDay,
    byHour,
    teamCompare,
    conv,
    hourly12,
    searchedAgents,
  };
}
