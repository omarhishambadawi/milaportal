import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { useAuth } from "@/lib/auth";
import { hasPerm, canViewCallCenter } from "@/lib/permissions";
import { useAgentDirectory } from "@/lib/directory";
import type { Team, Direction } from "../types";
import { toISO } from "../utils";

/**
 * Call Center filter + permission state.
 *
 * Owns the date range / team / agent / direction / agent-search controls, the
 * permission flags, the admin agent dropdown source, and the per-query progress
 * job id that rotates whenever the analytics filters change. Extracted verbatim
 * from the route.
 */
export function useCallCenterFilters() {
  const { role, profile, loading: authLoading } = useAuth();
  const canView = canViewCallCenter(role, profile?.permissions as any);
  const canAll = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");

  // Default: today
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({ from: today, to: today });
  const [team, setTeam] = useState<Team>("all");
  const [agentId, setAgentId] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
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
  }, [from, to, team, agentId, direction]);

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
    search,
    setSearch,
    // derived
    from,
    to,
    filteredAgents,
    // progress job id
    jobId,
    jobIdRef,
  };
}
