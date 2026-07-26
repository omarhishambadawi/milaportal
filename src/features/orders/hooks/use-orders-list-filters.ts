import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, isAdministrator } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import type { OrdersFilters } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, PAGE_SIZE_STORAGE_KEY } from "../constants";
import type { OrdersFilterCache } from "../types";
import { applyOrderFilters, normalizeSearchTerm, toISO } from "../utils";

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
  const [mineOnly, setMineOnly] = useState<boolean>(initial?.mineOnly ?? false);
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
    mineOnly,
    page,
  };

  const term = normalizeSearchTerm(debouncedQ);
  const searching = term.length > 0;

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
    mineOnly,
    term,
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
      isAdmin,
      agent,
      term,
    });

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  // Reset to first page when filters change
  const onFilterChange = (fn: () => void) => {
    fn();
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
    mineOnly,
    setMineOnly,
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
    onFilterChange,
    applyFilters,
    // lookups
    filteredAgentOpts,
    namesById,
    cities,
  };
}
