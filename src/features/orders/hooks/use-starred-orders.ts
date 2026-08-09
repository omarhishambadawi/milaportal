import { useCallback, useEffect, useState } from "react";
import { STARRED_ORDERS_KEY_PREFIX } from "../constants";

/**
 * The orders one agent has starred.
 *
 * Stars are a personal shortcut — the handful of orders an agent is chasing this
 * shift — and they follow the pattern the branch directory already uses for
 * exactly this (`features/branches/hooks/use-branch-prefs`): localStorage rather
 * than a table. A `order_stars` table would mean a migration, RLS policies and a
 * write round trip per click to store something nobody reports on and nobody
 * else may read; losing it costs a re-star. Consequence worth knowing: stars are
 * per browser, so an agent who signs in on a second machine starts with none.
 *
 * Scoping is by the authenticated user's id, appended to the storage key. That
 * is the part that matters here and the part a bare key would get wrong: the
 * call floor shares machines, so an unkeyed list would show one agent another's
 * stars the moment they signed in on the same browser. Signing out leaves each
 * agent's list untouched under their own key, which is why a star survives
 * re-login.
 *
 * Reads happen after mount, never during render — this app server-renders, and
 * touching localStorage while rendering produces markup the client cannot match.
 */

function storageKey(userId: string): string {
  return `${STARRED_ORDERS_KEY_PREFIX}.${userId}`;
}

function readIds(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    // Private-mode storage denial, a quota error, or hand-edited JSON. A broken
    // shortcut list must never break the Orders list.
    return [];
  }
}

function writeIds(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

export function useStarredOrders(userId: string | undefined) {
  const [starred, setStarred] = useState<Set<string>>(() => new Set());

  // Re-hydrated when the signed-in user changes, so switching accounts in one
  // browser swaps the list rather than inheriting the previous agent's.
  useEffect(() => {
    setStarred(userId ? new Set(readIds(storageKey(userId))) : new Set());
  }, [userId]);

  const toggleStar = useCallback(
    (orderId: string) => {
      if (!userId || !orderId) return;
      setStarred((current) => {
        const next = new Set(current);
        if (next.has(orderId)) next.delete(orderId);
        else next.add(orderId);
        writeIds(storageKey(userId), [...next]);
        return next;
      });
    },
    [userId],
  );

  return { starred, toggleStar, canStar: !!userId };
}
