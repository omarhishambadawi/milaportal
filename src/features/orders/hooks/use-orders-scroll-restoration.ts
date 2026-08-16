import { useLayoutEffect, useEffect, useRef, useState } from "react";

/**
 * Puts the agent back where they were after they open an order and come back.
 *
 * Module-scoped so the position survives SPA navigation into an order and back,
 * and is wiped on a full page refresh (module reload) — the same lifecycle as
 * the filter cache in use-orders-list-filters.ts.
 *
 * ---------------------------------------------------------------------------
 * Why this needs to exist at all, and why the obvious version does not work
 * ---------------------------------------------------------------------------
 * The router is configured with `scrollRestoration: true`. Its `onRendered`
 * subscriber looks the incoming location up in a sessionStorage cache keyed by
 * `location.state.__TSR_key`, and **when it finds nothing it calls
 * `window.scrollTo({top: 0})`** (see `@tanstack/router-core/scroll-restoration`).
 *
 * Saving an order ends in `navigate({ to: "/orders" })`, which is a *push* — a
 * brand-new history entry with a brand-new key, so the cache never has an entry
 * and the router scrolls to the top every single time. That is the bug, and no
 * amount of scrolling from this hook fixes it: restoring afterwards only turns
 * one jump into two. The navigations back to the list therefore pass
 * `resetScroll: false`, which makes the router skip that block entirely
 * (`router.resetNextScroll`), leaving the viewport for this hook to place.
 *
 * With nothing else moving the viewport, the restore runs in a **layout
 * effect** — before the browser paints the commit that first contains the row —
 * so the agent never sees an intermediate position. There is no timeout and no
 * requestAnimationFrame anywhere: both were only ever there to out-race the
 * router's scroll, and the race is gone.
 */

/** Where the list was scrolled to, tracked continuously while it is mounted. */
let savedScrollY = 0;

interface ReturnAnchor {
  orderId: string;
  /** Whole-page scroll offset when the agent left. The fallback. */
  scrollY: number;
  /**
   * Where the row sat on screen, in CSS pixels from the top of the viewport.
   *
   * Restoring *this* rather than `scrollY` is what makes the return seamless:
   * the row lands back under the agent's eye even if the rows above it changed
   * height, or the save moved it a few positions up or down the page.
   */
  viewportOffset: number;
}

let anchor: ReturnAnchor | null = null;

function findRow(orderId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(orderId)}"]`);
}

/**
 * Record which order is being opened, before navigating to it.
 *
 * Called by the Orders list's row action. Reading the geometry *here* is the
 * point: navigating to the much shorter edit form clamps `window.scrollY`, so
 * by the time the agent comes back the position they left is already gone.
 */
export function rememberOrderReturn(orderId: string): void {
  const row = findRow(orderId);
  anchor = {
    orderId,
    scrollY: window.scrollY,
    viewportOffset: row ? row.getBoundingClientRect().top : 0,
  };
}

/** What the restore should do with the state it finds on a given commit. */
export type RestoreAction =
  /** Nothing is renderable yet, or there is nothing to go back to. */
  | { kind: "none" }
  /** The row may still be on its way — leave the restore armed for a later commit. */
  | { kind: "wait" }
  /** The edited order is on screen; put it back where it was. */
  | { kind: "row" }
  /** It is not, and will not be. Fall back to where the list stood. */
  | { kind: "offset" };

/**
 * The whole policy, as a pure function, because it is the part with the rules in
 * it and the part a future change is most likely to get subtly wrong.
 *
 * The rule that matters is the third case: a missing row while the query is
 * still fetching means *not yet*, and a missing row once it has settled means
 * *not here*. Conflating them is what turns "wait one more commit" into
 * "scroll to an offset that the incoming rows are about to invalidate".
 */
export function decideRestore(state: {
  ready: boolean;
  settled: boolean;
  hasAnchor: boolean;
  rowFound: boolean;
  fallbackY: number;
}): RestoreAction {
  if (!state.ready) return { kind: "none" };
  if (state.rowFound) return { kind: "row" };
  if (state.hasAnchor && !state.settled) return { kind: "wait" };
  return state.fallbackY > 0 ? { kind: "offset" } : { kind: "none" };
}

/**
 * The scroll offset that puts a row back at the screen position it used to hold.
 *
 * Pure, and separated out because it is arithmetic that is easy to get sign-wrong
 * and impossible to eyeball in a browser: if the row currently sits lower than it
 * used to (`rowTop > targetOffset`) the page must scroll *down* by the
 * difference, and vice versa.
 */
export function scrollTopForRow(input: {
  scrollY: number;
  rowTop: number;
  targetOffset: number;
}): number {
  return Math.max(0, input.scrollY + (input.rowTop - input.targetOffset));
}

/** Is the row within the viewport, allowing for it being taller than the fold? */
export function isRowVisible(rowTop: number, rowHeight: number, viewportHeight: number): boolean {
  return rowTop >= 0 && rowTop + Math.min(rowHeight, viewportHeight) <= viewportHeight;
}

interface RestorationState {
  /** True once the list has rows to scroll to. */
  ready: boolean;
  /**
   * True when the list query has finished — nothing more is in flight.
   *
   * This is what replaces a timeout. A row that is missing while the query is
   * still fetching may simply not have arrived yet, so the restore waits for the
   * next commit; a row still missing once the query has settled is genuinely not
   * on this page, and the fallback runs.
   */
  settled: boolean;
  /**
   * Identity of the rows currently rendered. Changing it re-runs the effect
   * after React has committed those rows, which is how the restore knows the DOM
   * is worth searching again — no polling, no fixed delay.
   */
  rowsKey: string;
}

/**
 * How long the row the agent was just reviewing stays marked, in milliseconds.
 *
 * Long enough to find with the eye after the scroll lands, short enough that it
 * never reads as a selection. The fade itself is the row's existing
 * `transition-colors`, so removing the mark is as gradual as applying it.
 */
export const RETURN_HIGHLIGHT_MS = 2400;

export interface RestorationResult {
  /**
   * The order the agent has just come back from, while it is worth pointing at.
   *
   * Null except for the moment after a return. Carried as an id rather than an
   * index because the row it names may have moved — a save can re-sort it, and
   * the list may have refetched under it.
   */
  highlightedOrderId: string | null;
}

export function useOrdersScrollRestoration({
  ready,
  settled,
  rowsKey,
}: RestorationState): RestorationResult {
  const restored = useRef(false);
  const [highlightedOrderId, setHighlighted] = useState<string | null>(null);

  // Drop the mark after its moment. Keyed on the id so a second return re-arms
  // the timer rather than inheriting the remains of the first one's.
  useEffect(() => {
    if (!highlightedOrderId) return;
    const timer = setTimeout(() => setHighlighted(null), RETURN_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedOrderId]);

  // Continuously remember where the user is while they browse the list. This
  // covers returning from anywhere else in the app; the anchor above covers the
  // specific open-an-order round trip.
  useEffect(() => {
    const onScroll = () => {
      savedScrollY = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Layout effect, not an effect: this runs after the DOM holds the new rows but
  // *before* the browser paints them, so the first frame the agent sees is
  // already at the right offset. Re-runs on every commit that changes the rows.
  useLayoutEffect(() => {
    if (restored.current || !ready) return;

    const target = anchor;
    const fallbackY = target ? target.scrollY : savedScrollY;
    const row = target ? findRow(target.orderId) : null;

    const action = decideRestore({
      ready,
      settled,
      hasAnchor: !!target,
      rowFound: !!row,
      fallbackY,
    });

    // Stay armed: the row may arrive in a later commit, which will re-run this.
    if (action.kind === "wait") return;

    restored.current = true;
    anchor = null;
    if (action.kind === "none") return;

    if (action.kind === "row" && row && target) {
      // Found it, so say which one it was. Set here rather than in
      // `rememberOrderReturn` so an order that never comes back into view is
      // never marked — the mark is a pointer at something on screen.
      setHighlighted(target.orderId);
      const rect = row.getBoundingClientRect();
      window.scrollTo({
        top: scrollTopForRow({
          scrollY: window.scrollY,
          rowTop: rect.top,
          targetOffset: target.viewportOffset,
        }),
        left: 0,
        behavior: "auto",
      });
      // The page can be shorter than it was — the save may have filtered rows
      // out — in which case the browser clamps the scroll and the row can end up
      // off screen. Centring it is the honest second choice: the requirement is
      // that the agent can see the order they just edited.
      const after = row.getBoundingClientRect();
      if (!isRowVisible(after.top, after.height, window.innerHeight)) {
        row.scrollIntoView({ block: "center", behavior: "auto" });
      }
      return;
    }

    window.scrollTo({ top: fallbackY, left: 0, behavior: "auto" });
  }, [ready, settled, rowsKey]);

  return { highlightedOrderId };
}
