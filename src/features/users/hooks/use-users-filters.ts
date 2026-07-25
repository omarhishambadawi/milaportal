import { useCallback, useEffect, useMemo, useState } from "react";

import { DEFAULT_PAGE_SIZE, SEARCH_DEBOUNCE_MS } from "../constants";
import type { AdminUserRow, UserSort, UserStatusFilter } from "../types";
import { compareUsers, computeStats, matchesUser, normalizeTerm } from "../utils";

/**
 * Search / role / status / sort / pagination state for the users table, plus the
 * derived rows.
 *
 * The three-stage derivation (filter → sort → slice) is split across three
 * `useMemo`s on purpose rather than fused into one: changing the page is by far
 * the most frequent interaction, and it must not re-run the filter and sort over
 * the whole list. Only the final slice depends on `page`.
 *
 * The search term is debounced even though filtering is local — on a few hundred
 * rows, re-filtering and re-rendering the table on every keystroke is what makes
 * an input feel laggy while typing.
 */
export function useUsersFilters(users: AdminUserRow[]) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [role, setRole] = useState<string>("all");
  const [status, setStatus] = useState<UserStatusFilter>("all");
  const [sort, setSort] = useState<UserSort>("recent");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q]);

  const term = normalizeTerm(debouncedQ);

  // Any change to what is being looked at returns to the first page — otherwise
  // narrowing a filter while on page 4 lands on an empty table.
  useEffect(() => { setPage(0); }, [term, role, status, sort, pageSize]);

  const filtered = useMemo(
    () => users.filter((u) => matchesUser(u, { term, role, status })),
    [users, term, role, status],
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareUsers(a, b, sort)),
    [filtered, sort],
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Clamp rather than store: a delete can shrink the list under the current page
  // while the page index is still valid state.
  const safePage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => sorted.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [sorted, safePage, pageSize],
  );

  // Over the full list, not the filtered one — see computeStats.
  const stats = useMemo(() => computeStats(users), [users]);

  const filtersActive = term.length > 0 || role !== "all" || status !== "all";

  const clearFilters = useCallback(() => {
    setQ("");
    setDebouncedQ("");
    setRole("all");
    setStatus("all");
  }, []);

  const setPageSize = useCallback((n: number) => setPageSizeState(n), []);

  return {
    // controls
    q, setQ,
    role, setRole,
    status, setStatus,
    sort, setSort,
    page: safePage, setPage,
    pageSize, setPageSize,
    // derived
    term, filtered, visible, pageCount, stats, filtersActive, clearFilters,
  };
}
