import { useMemo, useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { useAgentDirectory } from "@/lib/directory";
import { toISO } from "../utils";

/**
 * Dashboard filter + permission state.
 *
 * Owns the date range / team / agent / mine-only controls, resolves the
 * permission flags, and derives the `effectiveAgent`/`effectiveTeam` scope and
 * the two query-key filter objects every dashboard query is identified by.
 * Extracted from the route unchanged — same permission logic, same scope
 * resolution, same query-key shapes.
 */
export function useDashboardFilters() {
  const { user, role, profile } = useAuth();
  const canViewDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canViewTeamAnalytics = hasPerm(role, profile?.permissions as any, "view_team_analytics");
  const canViewAllAgents = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");
  const isAdmin = canViewAllAgents;
  const [mineOnly, setMineOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const [range, setRange] = useState<DateRange | undefined>({ from: monthStart, to: monthEnd });
  const from = range?.from ? toISO(range.from) : toISO(monthStart);
  const to = range?.to ? toISO(range.to) : from;

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const effectiveAgent = canViewAllAgents ? agentFilter : (!canViewTeamAnalytics && user?.id ? user.id : (mineOnly && user?.id ? user.id : "all"));
  const effectiveTeam = canViewTeamAnalytics ? teamFilter : "all";

  // Identity of every dashboard aggregation query. Complaints have no team
  // dimension, so those two queries use the `team`-less subset.
  const dashFilters = { from, to, agent: effectiveAgent, team: effectiveTeam };
  const cmpFilters = { from, to, agent: effectiveAgent };

  const { data: agents } = useAgentDirectory({ enabled: canViewAllAgents });

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const base = agents.filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    if (teamFilter === "all") return base;
    return base.filter((a: any) => a.role === teamFilter);
  }, [agents, teamFilter]);

  const selectedAgentLabel = canViewAllAgents && agentFilter !== "all"
    ? (agents?.find((a: any) => a.id === agentFilter)?.full_name ?? "agent")
    : null;

  // Caption reads the scope that was actually applied rather than `mineOnly`
  // alone. `effectiveAgent` narrows to the current user in two ways: via the
  // toggle, and implicitly for users without `view_team_analytics` — the latter
  // used to be labelled "Team performance" while showing only their own rows.
  // Display only; `effectiveAgent` itself is untouched.
  const scopedToSelf = !!user?.id && effectiveAgent === user.id;

  return {
    // permissions
    canViewDashboard, canViewTeamAnalytics, canViewAllAgents, canExport, isAdmin,
    userId: user?.id,
    // controls
    mineOnly, setMineOnly,
    agentFilter, setAgentFilter,
    teamFilter, setTeamFilter,
    range, setRange,
    // derived scope + query-key filter objects
    from, to, dateLabel,
    effectiveAgent, effectiveTeam,
    dashFilters, cmpFilters,
    // agent directory + labels
    filteredAgents, selectedAgentLabel, scopedToSelf,
  };
}
