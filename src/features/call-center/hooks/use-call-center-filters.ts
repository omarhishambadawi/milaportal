import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth";
import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { useAgentDirectory } from "@/lib/directory";
import { yeastarQueueOptions } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import type { Team, Direction } from "../types";
import { toISO } from "../utils";

interface UseCallCenterFiltersOptions {
  /**
   * Pin the dashboard to one team. Customer Care and Telesales are separate
   * dashboards precisely because their KPIs are computed differently — one is
   * queue-driven, the other extension-driven — so neither offers a team switch.
   */
  team?: Team;
  /** Enable the queue filter. Customer Care only; telesales joins no queue. */
  withQueue?: boolean;
}

/**
 * Call Center filter + permission state, shared by the Customer Care and
 * Telesales dashboards.
 *
 * Owns the date range / agent / direction / agent-search controls, the
 * permission flags, the admin agent dropdown source, and the per-query progress
 * job id that rotates whenever the analytics filters change.
 */
export function useCallCenterFilters(options: UseCallCenterFiltersOptions = {}) {
  const { team: fixedTeam, withQueue = false } = options;
  const queueOptionsFn = useServerFn(yeastarQueueOptions);
  const { role, profile, loading: authLoading } = useAuth();
  const canView = canViewCallCenter(role, profile?.permissions as any);
  const canAll = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");

  // Default: today
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({ from: today, to: today });
  const [ownTeam, setTeam] = useState<Team>("all");
  const team = fixedTeam ?? ownTeam;
  const [agentId, setAgentId] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [queue, setQueue] = useState<string>("all");
  const [search, setSearch] = useState("");

  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  // Agents dropdown (admin only) — reads the shared agent directory.
  const { data: agents } = useAgentDirectory({ enabled: canAll });
  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const operational = agents.filter(
      (a: any) => a.role === "customer_care" || a.role === "telesales",
    );
    return team === "all" ? operational : operational.filter((a: any) => a.role === team);
  }, [agents, team]);

  // Progress job id (rotates per query)
  const jobIdRef = useRef<string>("");
  const [jobId, setJobId] = useState<string>("");
  useEffect(() => {
    const id = crypto.randomUUID();
    jobIdRef.current = id;
    setJobId(id);
  }, [from, to, team, agentId, direction, queue]);

  // Queue options — fetched only where the queue filter is actually shown.
  const { data: queueData } = useQuery({
    queryKey: queryKeys.callCenter.queues(),
    queryFn: () => queueOptionsFn(),
    enabled: withQueue && !authLoading && canView,
    staleTime: 5 * 60_000,
  });
  const queues = queueData?.ok ? queueData.queues : [];

  return {
    // permissions
    authLoading,
    canView,
    canAll,
    canExport,
    // filter state + setters
    range,
    setRange,
    team,
    setTeam,
    agentId,
    setAgentId,
    direction,
    setDirection,
    queue,
    setQueue,
    search,
    setSearch,
    // derived
    from,
    to,
    filteredAgents,
    queues,
    // progress job id
    jobId,
    jobIdRef,
  };
}
