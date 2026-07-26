import { useCallback, useMemo, useState } from "react";
import {
  EMPTY_FILTERS,
  cityOptions,
  computeStats,
  dutyHourOptions,
  filterBranches,
  type BranchFilters,
  type ScooterFilter,
} from "../search";
import type { BranchView } from "../types";
import { useFavourites, useRecentSearches } from "./use-branch-prefs";

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

  const toggleFavouritesOnly = useCallback(
    () => setFilters((current) => ({ ...current, favouritesOnly: !current.favouritesOnly })),
    [],
  );

  const reset = useCallback(() => setFilters(EMPTY_FILTERS), []);

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

  return {
    filters,
    results,
    stats,
    cities,
    dutyHours,
    favourites,
    toggleFavourite,
    recent,
    rememberSearch,
    clearRecent,
    setQuery,
    toggleCity,
    toggleScooter,
    toggleDutyHours,
    toggleFavouritesOnly,
    reset,
  };
}
