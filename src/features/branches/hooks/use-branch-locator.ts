import { useCallback, useMemo, useRef, useState } from "react";
import { geocodeWithOpenStreetMap } from "../geocode-nominatim";
import { buildLocationIndex, searchLocations, type LocationEntry } from "../location-index";
import {
  LOCATOR_LIMIT,
  originFromPlace,
  rankNearestBranches,
  resolveOrigin,
  type LocatorResult,
  type ResolvedOrigin,
} from "../locator";
import type { BranchView } from "../types";

/** Autocomplete rows offered under the input. */
const SUGGESTION_LIMIT = 6;

/**
 * Locator mode: one origin, five branches, and nothing on the server.
 *
 * The gazetteer is built once per dataset and memoized on the branches array,
 * whose identity `useBranchDirectory` already stabilizes — so it is rebuilt when
 * an import lands and never on a keystroke. Building it eagerly rather than on
 * first activation is deliberate: it is one pass over ~150 rows, and paying it
 * while the agent is reading the directory costs nothing, whereas paying it on
 * the first character they type is the one moment they are watching.
 *
 * Searching runs on submit rather than per keystroke, but *suggestions* are
 * live: a half-typed coordinate pair is not a location — "24.5" resolves to a
 * point in the Red Sea — while a half-typed place name is exactly what
 * autocomplete is for.
 *
 * The request token is not defensive coding for a network that is not there. It
 * is what makes the eventual swap to a real geocoder safe *without touching this
 * file*: `resolveOrigin` is already async, so the only thing that changes when
 * it starts taking 300ms is that two searches can genuinely overlap — and this
 * already refuses to let the slower one win.
 */
export function useBranchLocator(branches: BranchView[]) {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<ResolvedOrigin | null>(null);
  const [results, setResults] = useState<LocatorResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /** Non-empty when the typed name belongs to places in several cities. */
  const [choices, setChoices] = useState<LocationEntry[]>([]);

  const index = useMemo(() => buildLocationIndex(branches), [branches]);

  /** Incremented per search; a continuation that no longer holds it is stale. */
  const token = useRef(0);

  /**
   * Live autocomplete.
   *
   * Suppressed once the text parses as a coordinate pair or a link, where a list
   * of place names underneath is noise — the agent has already given an exact
   * answer and is about to press Find.
   */
  const suggestions = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed || /\d[\s,;]+-?\d/.test(trimmed) || /https?:\/\//i.test(trimmed)) return [];
    return searchLocations(index, trimmed, SUGGESTION_LIMIT).map((match) => match.entry);
  }, [index, query]);

  /** Rank the directory around a point that is already decided. */
  const rankAround = useCallback(
    async (next: ResolvedOrigin, mine: number) => {
      const ranked = await rankNearestBranches(next.point, branches, { limit: LOCATOR_LIMIT });
      if (mine !== token.current) return;
      setOrigin(next);
      setResults(ranked);
      setChoices([]);
      // A resolved origin with nothing near it is not an error — it is the
      // honest answer for a point in the Empty Quarter, and the panel says so.
      setError(null);
      setSearching(false);
    },
    [branches],
  );

  const search = useCallback(
    async (text: string) => {
      const mine = ++token.current;
      const trimmed = text.trim();

      if (!trimmed) {
        setOrigin(null);
        setResults([]);
        setChoices([]);
        setError(null);
        setSearching(false);
        return;
      }

      setSearching(true);
      // The geocoder is passed on every search but reached only when the local
      // index has nothing — `resolveOrigin` owns that ordering.
      const resolution = await resolveOrigin(trimmed, index, geocodeWithOpenStreetMap);
      if (mine !== token.current) return;

      if (resolution.choices.length > 0) {
        setOrigin(null);
        setResults([]);
        setChoices(resolution.choices);
        setError(null);
        setSearching(false);
        return;
      }

      if (!resolution.origin) {
        setOrigin(null);
        setResults([]);
        setChoices([]);
        setError(resolution.error);
        setSearching(false);
        return;
      }

      await rankAround(resolution.origin, mine);
    },
    [index, rankAround],
  );

  /**
   * Take a place straight from autocomplete or the disambiguation list.
   *
   * Skips resolution entirely — the entry *is* the answer — which is what makes
   * picking a suggestion feel instant and what makes the ambiguity prompt
   * conclusive rather than another guess.
   */
  const chooseLocation = useCallback(
    (entry: LocationEntry) => {
      const mine = ++token.current;
      setQuery(entry.name);
      setSearching(true);
      void rankAround(originFromPlace(entry), mine);
    },
    [rankAround],
  );

  const open = useCallback(() => setActive(true), []);

  /**
   * Leave locator mode and forget everything it held.
   *
   * Bumping the token first is what stops a search that was in flight from
   * repopulating the panel a moment after it closed.
   */
  const close = useCallback(() => {
    token.current += 1;
    setActive(false);
    setQuery("");
    setOrigin(null);
    setResults([]);
    setChoices([]);
    setError(null);
    setSearching(false);
  }, []);

  return {
    active,
    query,
    setQuery,
    origin,
    results,
    choices,
    suggestions,
    error,
    searching,
    search,
    chooseLocation,
    open,
    close,
    /** Exposed for tests and for the future geocoder swap. */
    index,
  };
}
