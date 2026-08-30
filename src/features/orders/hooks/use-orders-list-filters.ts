import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DateRange } from "react-day-picker";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, isAdministrator } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import type { OrdersFilters } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, PAGE_SIZE_STORAGE_KEY } from "../constants";
import type { OrdersFilterCache } from "../types";
import { applyOrderFilters, describeDateRange, normalizeSearchTerm, toISO } from "../utils";
import { useStarredOrders } from "./use-starred-orders";

// In-memory filter cache. Survives SPA navigation (e.g. edit an order and come
// back) but is wiped on a full page refresh because the JS module reloads.
let ordersFilterCache: OrdersFilterCache | null = null;

/**
 * Orders list filter + permission state.
 *
 * Owns the search / team / agent / status / date / mine-only / pagination
 * controls, the debounce, the module-level filter cache, the permission flags,
 * and the agent-directory + city lookups. Exposes the derived filter key and a
 * pre-bound `applyFilters` so the data fetch and the export share one filter
 * implementation. Extracted verbatim from the route.
 */
export function useOrdersListFilters() {
  const { user, role, profile } = useAuth();
  const isAdmin = isAdministrator(role);
  const canView = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canEditAll = isAdmin || hasPerm(role, profile?.permissions as any, "edit_all_orders");
  const canEditOwn = hasPerm(role, profile?.permissions as any, "edit_orders");
  const canVerifyAll = isAdmin || hasPerm(role, profile?.permissions as any, "verify_all_orders");
  const canVerifyOwn = hasPerm(role, profile?.permissions as any, "verify_own_orders");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");
  /**
   * Who may narrow the list to one agent.
   *
   * `view_all_agents` rather than `isAdmin`, which is what it was. An Auditor's
   * entire job is reviewing other people's work and the role holds this
   * permission by default, yet the filter was hidden from them — so the one role
   * that most needs to look at a single agent's day was the one role that
   * could not. Supervisor holds it too. The two agent roles do not, which is the
   * line that was actually intended.
   */
  const canFilterAgents = hasPerm(role, profile?.permissions as any, "view_all_agents");

  const today = new Date();
  const initial = ordersFilterCache;
  const [range, setRange] = useState<DateRange | undefined>(() => {
    if (initial?.range?.from) {
      return {
        from: new Date(initial.range.from),
        to: initial.range.to ? new Date(initial.range.to) : undefined,
      };
    }
    return { from: today, to: today };
  });
  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  const [q, setQ] = useState(initial?.q ?? "");
  const [team, setTeam] = useState<string>(initial?.team ?? "all");
  const [agent, setAgent] = useState<string>(initial?.agent ?? "all");
  const [status, setStatus] = useState<string>(initial?.status ?? "all");
  const [fulfillment, setFulfillment] = useState<string>(initial?.fulfillment ?? "all");
  const [verification, setVerification] = useState<string>(initial?.verification ?? "all");
  const [mineOnly, setMineOnly] = useState<boolean>(initial?.mineOnly ?? false);
  const [starredOnly, setStarredOnly] = useState<boolean>(initial?.starredOnly ?? false);
  const [page, setPage] = useState(initial?.page ?? 0);
  const [pageSize, setPageSizeState] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
    const v = Number(window.sessionStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return PAGE_SIZE_OPTIONS.includes(v as any) ? v : DEFAULT_PAGE_SIZE;
  });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(0);
    if (typeof window !== "undefined")
      window.sessionStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
  };

  // Debounce the search input so we don't fire a query per keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Persist filter state on every render so returning from edit restores it.
  ordersFilterCache = {
    range: range?.from
      ? { from: range.from.toISOString(), to: range.to?.toISOString() }
      : undefined,
    q,
    team,
    agent,
    status,
    fulfillment,
    verification,
    mineOnly,
    starredOnly,
    page,
  };

  const term = normalizeSearchTerm(debouncedQ);
  const searching = term.length > 0;

  /**
   * The signed-in agent's starred orders.
   *
   * Read here rather than in the route because *Starred only* is a filter like
   * any other: the ids have to be in hand where `applyFilters` is built, so the
   * list, the export and the KPI strip all narrow to the same set. The lookups
   * below are fetched here for the same reason.
   */
  const { starred, toggleStar, canStar, starsLoading } = useStarredOrders(user?.id);
  /** Sorted so the query key is stable regardless of the order rows came back in. */
  const starredIds = useMemo(() => [...starred].sort(), [starred]);

  // Shared agent directory (profiles + user_roles). Powers both the admin filter
  // dropdown and the per-row name/code enrichment below, so it stays enabled for
  // every user (RLS scopes non-admins to their own row, as before).
  const { data: agentOpts } = useAgentDirectory();

  // Filter agent list: only operational agents (exclude admin/auditor), further narrow by selected team
  const filteredAgentOpts = useMemo(() => {
    if (!agentOpts) return [];
    const base = agentOpts.filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    if (team === "all") return base;
    return base.filter((a: any) => a.role === team);
  }, [agentOpts, team]);

  // Name lookup for row enrichment, derived from the shared directory.
  const namesById = useMemo(
    () => new Map((agentOpts ?? []).map((p: any) => [p.id, p])),
    [agentOpts],
  );

  /**
   * The agents whose name or code matches what is being searched for.
   *
   * `agent_name` and `agent_code` are joined from `profiles` — there is no column
   * on `orders` to `ilike` — so searching for a colleague's name is expressed as
   * `agent_id.in.(…)` over ids resolved here, against the directory the page has
   * already fetched for the filter dropdown. No extra round trip, and the same
   * approach Complaints takes for the same reason.
   *
   * Sorted, so the query key is stable whichever order the directory came back
   * in, and empty unless something is actually being searched for.
   */
  const searchAgentIds = useMemo(() => {
    if (!term || !agentOpts) return [] as string[];
    const needle = term.toLowerCase();
    return agentOpts
      .filter(
        (a: any) =>
          String(a.full_name ?? "")
            .toLowerCase()
            .includes(needle) ||
          String(a.agent_code ?? "")
            .toLowerCase()
            .includes(needle),
      )
      .map((a: any) => a.id as string)
      .sort();
  }, [agentOpts, term]);

  // City lookup for branch enrichment (small table).
  const { data: cities } = useQuery({
    queryKey: queryKeys.lookups.ordersDirectory(),
    queryFn: async () => {
      const { data: branches } = await supabase.from("branches").select("branch_no,city");
      return new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
    },
  });

  const filterKey: OrdersFilters = {
    from,
    to,
    team,
    agent,
    status,
    fulfillment,
    verification,
    mineOnly,
    starredOnly,
    starKey: starredOnly ? starredIds.join(",") : "",
    term,
    agentKey: searchAgentIds.join(","),
    userId: user?.id,
  };

  // Apply the shared filter set to a PostgREST query builder.
  const applyFilters = (qb: any) =>
    applyOrderFilters(qb, {
      searching,
      from,
      to,
      team,
      status,
      mineOnly,
      userId: user?.id,
      canFilterAgents,
      agent,
      term,
      fulfillment,
      verification,
      starredOnly,
      starredIds,
      searchAgentIds,
    });

  /** Weekday and date, split so the header can emphasise the day name. */
  const dateParts = useMemo(() => describeDateRange(range?.from, range?.to), [range]);
  const dateLabel = dateParts.weekday ? `${dateParts.weekday}, ${dateParts.date}` : dateParts.date;

  // Reset to first page when filters change
  const onFilterChange = (fn: () => void) => {
    fn();
    setPage(0);
  };

  /**
   * How many of the narrowing dropdowns are currently set.
   *
   * Counts only the controls *Clear* puts back, so the button's label and the
   * thing it does cannot drift apart. Deliberately excluded:
   *
   *   * the **date range**, which is never "off" — clearing it would have to mean
   *     picking some other range, and silently moving an agent off the day they
   *     chose is not clearing a filter;
   *   * the **scope** (All / My / Starred), which names the set being looked at
   *     rather than narrowing it, and has its own visible control;
   *   * the **search box**, which clears itself with the × inside it.
   */
  const activeFilterCount =
    (team !== "all" ? 1 : 0) +
    (agent !== "all" && canFilterAgents ? 1 : 0) +
    (status !== "all" ? 1 : 0) +
    (fulfillment !== "all" ? 1 : 0) +
    (verification !== "all" ? 1 : 0);

  /**
   * Put every dropdown back to "all", in one commit.
   *
   * One state update per control and a single `setPage(0)` — React batches them,
   * so the list refetches once rather than five times, and no intermediate
   * combination is ever queried.
   */
  const resetFilters = () => {
    setTeam("all");
    setAgent("all");
    setStatus("all");
    setFulfillment("all");
    setVerification("all");
    setPage(0);
  };

  return {
    // identity
    userId: user?.id,
    // permissions
    isAdmin,
    canView,
    canCreate,
    canEditAll,
    canEditOwn,
    canVerifyAll,
    canVerifyOwn,
    canExport,
    canFilterAgents,
    // filter state + setters
    range,
    setRange,
    q,
    setQ,
    team,
    setTeam,
    agent,
    setAgent,
    status,
    setStatus,
    fulfillment,
    setFulfillment,
    verification,
    setVerification,
    mineOnly,
    setMineOnly,
    starredOnly,
    setStarredOnly,
    page,
    setPage,
    pageSize,
    setPageSize,
    // derived
    from,
    to,
    term,
    searching,
    filterKey,
    dateLabel,
    dateParts,
    onFilterChange,
    activeFilterCount,
    resetFilters,
    applyFilters,
    searchAgentIds,
    // stars
    starred,
    toggleStar,
    canStar,
    starsLoading,
    // lookups
    filteredAgentOpts,
    namesById,
    cities,
  };
}
