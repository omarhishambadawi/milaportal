import { useCallback, useEffect, useState } from "react";
import {
  FAVOURITES_KEY,
  MAX_RECENT_BRANCHES,
  MAX_RECENT_SEARCHES,
  RECENT_BRANCHES_KEY,
  RECENT_SEARCHES_KEY,
} from "../constants";

/**
 * Per-device conveniences: starred branches and recent searches.
 *
 * Deliberately localStorage rather than a table. Both are personal shortcuts
 * with no operational meaning — nobody reports on them, nobody else reads them,
 * and losing them costs a re-star. Putting them in Postgres would mean a
 * migration, RLS policies and a write round trip on every star, to store a
 * preference that is arguably per-device anyway (the branches you keep to hand
 * on the call-floor machine are not the ones you want on your phone).
 *
 * Reads are hydrated after mount, never during render: this app server-renders,
 * and touching localStorage while rendering produces markup the client cannot
 * match.
 */

function readList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    // Private-mode storage denial, a quota error, or hand-edited JSON. A broken
    // shortcut list must never break the directory.
    return [];
  }
}

function writeList(key: string, value: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort */
  }
}

export function useFavourites() {
  const [favourites, setFavourites] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setFavourites(new Set(readList(FAVOURITES_KEY)));
  }, []);

  const toggle = useCallback((branchNo: string) => {
    setFavourites((current) => {
      const next = new Set(current);
      if (next.has(branchNo)) next.delete(branchNo);
      else next.add(branchNo);
      writeList(FAVOURITES_KEY, [...next]);
      return next;
    });
  }, []);

  return { favourites, toggleFavourite: toggle };
}

/**
 * Branch codes this device opened most recently, newest first.
 *
 * The shortcut a call-floor agent actually needs and the directory did not have:
 * the same handful of branches come up all afternoon, and finding one again meant
 * retyping its code. Recorded on *open* rather than on hover or render, so the
 * list holds branches somebody actually looked at.
 */
export function useRecentBranches() {
  const [recentBranches, setRecentBranches] = useState<string[]>([]);

  useEffect(() => {
    setRecentBranches(readList(RECENT_BRANCHES_KEY));
  }, []);

  const remember = useCallback((branchNo: string) => {
    if (!branchNo) return;
    setRecentBranches((current) => {
      if (current[0] === branchNo) return current;
      const next = [branchNo, ...current.filter((entry) => entry !== branchNo)].slice(
        0,
        MAX_RECENT_BRANCHES,
      );
      writeList(RECENT_BRANCHES_KEY, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecentBranches([]);
    writeList(RECENT_BRANCHES_KEY, []);
  }, []);

  return { recentBranches, rememberBranch: remember, clearRecentBranches: clear };
}

export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    setRecent(readList(RECENT_SEARCHES_KEY));
  }, []);

  /**
   * Record a search.
   *
   * Called on commit (Enter, or a result being opened) rather than on every
   * keystroke — otherwise the list fills with "r", "ri", "riy" and the feature
   * remembers nothing useful.
   */
  const remember = useCallback((query: string) => {
    const term = query.trim();
    if (term.length < 2) return;
    setRecent((current) => {
      const next = [
        term,
        ...current.filter((entry) => entry.toLowerCase() !== term.toLowerCase()),
      ].slice(0, MAX_RECENT_SEARCHES);
      writeList(RECENT_SEARCHES_KEY, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecent([]);
    writeList(RECENT_SEARCHES_KEY, []);
  }, []);

  return { recent, rememberSearch: remember, clearRecent: clear };
}
