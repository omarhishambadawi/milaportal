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
  /**
   * The optional city scope, as written in the directory. Empty means "anywhere".
   *
   * Held here rather than in the panel because every consumer of it is here:
   * suggestions, resolution and the OpenStreetMap query text all narrow by it,
   * and a scope that lived in the component would have to be passed back down
   * into each of them.
   */
  const [city, setCity] = useState("");
  const [origin, setOrigin] = useState<ResolvedOrigin | null>(null);
  const [results, setResults] = useState<LocatorResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  /** Non-empty when the typed name belongs to places in several cities. */
  const [choices, setChoices] = useState<LocationEntry[]>([]);

  const index = useMemo(() => buildLocationIndex(branches), [branches]);

  /**
   * Cities that actually have a branch, for the dropdown.
   *
   * Read off the gazetteer rather than the branch array so the list is already
   * deduplicated and carries the English alias; sorted by that alias where there
   * is one, since that is the label the dropdown shows.
   */
  const cities = useMemo(
    () =>
      index.entries
        .filter((entry) => entry.kind === "city")
        .sort((a, b) => (a.english ?? a.name).localeCompare(b.english ?? b.name)),
    [index],
  );

  /** Incremented per search; a continuation that no longer holds it is stale. */
  const token = useRef(0);

  const scope = useMemo(() => ({ city: city || null }), [city]);

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
    return searchLocations(index, trimmed, SUGGESTION_LIMIT, scope).map((match) => match.entry);
  }, [index, query, scope]);

  /** Rank the directory around a point that is already decided. */
  const rankAround = useCallback(
    async (next: ResolvedOrigin, mine: number) => {
      const ranked = await rankNearestBranches(next.point, branches, {
        limit: LOCATOR_LIMIT,
        // Passed, not dropped: without it every result is ranked and banded on
        // kilometres alone, which is the whole point of having resolved a
        // neighbourhood in the first place.
        locality: next.locality,
      });
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
      const resolution = await resolveOrigin(trimmed, index, geocodeWithOpenStreetMap, scope);
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
    [index, rankAround, scope],
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
    setCity("");
    setOrigin(null);
    setResults([]);
    setChoices([]);
    setError(null);
    setSearching(false);
  }, []);

  /**
   * Change the city scope and, if a search has already run, redo it.
   *
   * Re-running is the behaviour the dropdown is for: an agent sets the city
   * *because* the answer they got was for the wrong one, and making them press
   * Find again to apply it would be a second step for a decision they have
   * already made. Nothing is re-run before the first search, when there is no
   * result on screen to correct.
   */
  const selectCity = useCallback(
    (next: string) => {
      setCity(next);
      const pending = query.trim();
      if (!pending) return;
      const mine = ++token.current;
      setSearching(true);
      void (async () => {
        const resolution = await resolveOrigin(pending, index, geocodeWithOpenStreetMap, {
          city: next || null,
        });
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
      })();
    },
    [index, query, rankAround],
  );

  return {
    active,
    query,
    setQuery,
    city,
    setCity: selectCity,
    cities,
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
