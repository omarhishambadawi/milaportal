import { useCallback, useMemo, useState } from "react";
import {
  EMPTY_FILTERS,
  cityOptions,
  computeStats,
  dutyHourOptions,
  filterBranches,
  managerOptions,
  tokenize,
  type BranchFilters,
  type ScooterFilter,
} from "../search";
import type { BranchView } from "../types";
import { useFavourites, useRecentBranches, useRecentSearches } from "./use-branch-prefs";

/**
 * In-memory filter state, surviving SPA navigation but not a refresh.
 *
 * Same device as `ordersFilterCache` in the orders list, and for the same
 * reason: an agent who opens a branch on the map, navigates to raise an order
 * and comes back should find their search still typed. A module-level variable
 * gives that without adding filters to the URL — which sounds appealing until
 * every keystroke becomes a history entry and the browser Back button walks
 * character by character out of a search box.
 */
let branchFilterCache: BranchFilters | null = null;

export function useBranchFilters(branches: BranchView[]) {
  const [filters, setFilters] = useState<BranchFilters>(() => branchFilterCache ?? EMPTY_FILTERS);
  const { favourites, toggleFavourite } = useFavourites();
  const { recent, rememberSearch, clearRecent } = useRecentSearches();
  const { recentBranches, rememberBranch, clearRecentBranches } = useRecentBranches();

  branchFilterCache = filters;

  const patch = useCallback((next: Partial<BranchFilters>) => {
    setFilters((current) => ({ ...current, ...next }));
  }, []);

  const setQuery = useCallback((query: string) => patch({ query }), [patch]);

  const toggleCity = useCallback(
    (city: string) =>
      setFilters((current) => ({
        ...current,
        cities: current.cities.includes(city)
          ? current.cities.filter((entry) => entry !== city)
          : [...current.cities, city],
      })),
    [],
  );

  /**
   * Scooter is a three-way toggle rather than two independent chips.
   *
   * The brief lists "Scooter Available" and "No Scooter" as separate chips, but
   * they are mutually exclusive: selecting both is a request for every branch,
   * which looks like a broken filter. Clicking the active one clears it.
   */
  const toggleScooter = useCallback(
    (value: Exclude<ScooterFilter, "any">) =>
      setFilters((current) => ({
        ...current,
        scooter: current.scooter === value ? "any" : value,
      })),
    [],
  );

  const toggleDutyHours = useCallback(
    (hours: number) =>
      setFilters((current) => ({
        ...current,
        dutyHours: current.dutyHours.includes(hours)
          ? current.dutyHours.filter((entry) => entry !== hours)
          : [...current.dutyHours, hours],
      })),
    [],
  );

  const toggleManager = useCallback(
    (manager: string) =>
      setFilters((current) => ({
        ...current,
        managers: current.managers.includes(manager)
          ? current.managers.filter((entry) => entry !== manager)
          : [...current.managers, manager],
      })),
    [],
  );

  const toggleFavouritesOnly = useCallback(
    () => setFilters((current) => ({ ...current, favouritesOnly: !current.favouritesOnly })),
    [],
  );

  const reset = useCallback(() => setFilters(EMPTY_FILTERS), []);

  /** Clear every chip but keep whatever is typed. */
  const clearFilters = useCallback(
    () => setFilters((current) => ({ ...EMPTY_FILTERS, query: current.query })),
    [],
  );

  /**
   * Jump straight to one branch.
   *
   * Backs the recently-viewed and favourites shortcuts, and it *replaces* the
   * filter state rather than adding to it: picking "P0021" out of a list must
   * show P0021, not "no branches match" because a city chip left over from ten
   * minutes ago excludes it.
   */
  const focusBranch = useCallback(
    (branchNo: string) => setFilters({ ...EMPTY_FILTERS, query: branchNo }),
    [],
  );

  // The whole point of the feature lives on this line: one pass over an array
  // of pre-decorated branches, recomputed only when the query, a chip or the
  // dataset changes.
  const results = useMemo(
    () => filterBranches(branches, filters, favourites),
    [branches, filters, favourites],
  );

  // Stats describe the whole directory, not the current filter — "Total
  // Branches: 3" while a search is typed answers a question nobody asked.
  const stats = useMemo(() => computeStats(branches), [branches]);
  const cities = useMemo(() => cityOptions(branches), [branches]);
  const dutyHours = useMemo(() => dutyHourOptions(branches), [branches]);
  const managers = useMemo(() => managerOptions(branches), [branches]);

  /**
   * The query's tokens, memoized so the cards can highlight their matches.
   *
   * Referential stability matters here rather than the arithmetic: `BranchCard`
   * is memoized, and a fresh array per render would defeat that for every
   * mounted card on every keystroke — the exact cost the memo exists to avoid.
   */
  const tokens = useMemo(() => tokenize(filters.query), [filters.query]);

  return {
    filters,
    results,
    tokens,
    stats,
    cities,
    dutyHours,
    managers,
    favourites,
    toggleFavourite,
    recent,
    rememberSearch,
    clearRecent,
    recentBranches,
    rememberBranch,
    clearRecentBranches,
    setQuery,
    toggleCity,
    toggleScooter,
    toggleDutyHours,
    toggleManager,
    toggleFavouritesOnly,
    focusBranch,
    clearFilters,
    reset,
  };
}
