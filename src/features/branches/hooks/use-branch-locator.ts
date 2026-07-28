import { useCallback, useRef, useState } from "react";
import {
  LOCATOR_LIMIT,
  rankNearestBranches,
  resolveOrigin,
  type LocatorResult,
  type ResolvedOrigin,
} from "../locator";
import type { BranchView } from "../types";

/**
 * Locator mode: one origin, five branches, and nothing on the server.
 *
 * Searching runs on submit rather than per keystroke. A half-typed coordinate
 * pair is not a location — "24.5" resolves to a point in the Red Sea — so
 * ranking every keystroke would spend the whole search showing answers to
 * questions nobody asked, and the agent has a complete string in their clipboard
 * anyway.
 *
 * The request token is not defensive coding for a network that is not there. It
 * is what makes the eventual swap to the Routes API safe *without touching this
 * file*: `resolveOrigin` and `rankNearestBranches` are already async, so the
 * only thing that changes when they start taking 300ms is that two searches can
 * genuinely overlap — and this already refuses to let the slower one win.
 */
export function useBranchLocator(branches: BranchView[]) {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<ResolvedOrigin | null>(null);
  const [results, setResults] = useState<LocatorResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  /** Incremented per search; a continuation that no longer holds it is stale. */
  const token = useRef(0);

  const search = useCallback(
    async (text: string) => {
      const mine = ++token.current;
      const trimmed = text.trim();

      if (!trimmed) {
        setOrigin(null);
        setResults([]);
        setError(null);
        setSearching(false);
        return;
      }

      setSearching(true);
      const resolution = await resolveOrigin(trimmed, branches);
      if (mine !== token.current) return;

      if (!resolution.origin) {
        setOrigin(null);
        setResults([]);
        setError(resolution.error);
        setSearching(false);
        return;
      }

      const ranked = await rankNearestBranches(resolution.origin.point, branches, {
        limit: LOCATOR_LIMIT,
      });
      if (mine !== token.current) return;

      setOrigin(resolution.origin);
      setResults(ranked);
      // A resolved origin with nothing near it is not an error — it is the
      // honest answer for a point in the Empty Quarter, and the panel says so.
      setError(null);
      setSearching(false);
    },
    [branches],
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
    setError(null);
    setSearching(false);
  }, []);

  return {
    active,
    query,
    setQuery,
    origin,
    results,
    error,
    searching,
    search,
    open,
    close,
  };
}
