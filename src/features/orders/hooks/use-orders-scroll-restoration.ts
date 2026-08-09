import { useEffect, useRef } from "react";

/**
 * Puts the agent back where they were after they open an order and come back.
 *
 * Module-scoped so the position survives SPA navigation into an order and back,
 * and is wiped on a full page refresh (module reload) — the same lifecycle as
 * the filter cache in use-orders-list-filters.ts.
 */

/** Where the list was scrolled to, tracked continuously while it is mounted. */
let savedScrollY = 0;

/**
 * The order the agent left the list to open, and where the list stood at that
 * moment.
 *
 * Captured at the click rather than read back on return, because by then it is
 * gone: navigating to the (much shorter) edit form clamps `window.scrollY`, and
 * a position read after that is a position from a different page.
 */
let anchor: { orderId: string; scrollY: number } | null = null;

/**
 * Record which order is being opened, before navigating to it.
 *
 * Called by the Orders list's row action. The order id is what makes the return
 * robust: an offset describes a row's position in a list that a save may have
 * reordered, while the id describes the row itself.
 */
export function rememberOrderReturn(orderId: string): void {
  anchor = { orderId, scrollY: window.scrollY };
}

/** What the restore should do with the state it finds on a given commit. */
export type RestoreAction =
  /** Nothing is renderable yet, or there is nothing to go back to. */
  | { kind: "none" }
  /** The row may still be on its way — leave the restore armed for a later commit. */
  | { kind: "wait" }
  /** The edited order is on screen; bring it into view. */
  | { kind: "row" }
  /** It is not, and will not be. Fall back to where the list stood. */
  | { kind: "offset" };

/**
 * The whole policy, as a pure function, because it is the part with the rules in
 * it and the part a future change is most likely to get subtly wrong.
 *
 * The rule that matters is the third case: a missing row while the query is
 * still fetching means *not yet*, and a missing row once it has settled means
 * *not here*. Conflating them is what turns "wait one more commit" into "jump to
 * an offset that the incoming rows are about to invalidate" — the failure this
 * hook exists to prevent, and the reason there is no timeout anywhere in it.
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

export function useOrdersScrollRestoration({ ready, settled, rowsKey }: RestorationState) {
  const restored = useRef(false);

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

  // Runs after every commit that changes the rows, so when it looks for the row
  // element the DOM already holds whatever the latest render produced.
  useEffect(() => {
    if (restored.current || !ready) return;

    const target = anchor;
    const fallbackY = target ? target.scrollY : savedScrollY;
    const row = target
      ? document.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(target.orderId)}"]`)
      : null;

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

    // Two frames, as before: let the router finish its own scroll handling for
    // the new location, and let the rows paint, before moving the viewport.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (action.kind === "row" && row) {
          // `center` rather than `start`: the row the agent was working on ends
          // up in the middle of the viewport with its neighbours around it,
          // which is what "carry on where I was" looks like. "auto" because a
          // smooth scroll across a long list is a distraction, not an effect.
          row.scrollIntoView({ block: "center", behavior: "auto" });
        } else {
          window.scrollTo(0, fallbackY);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [ready, settled, rowsKey]);
}
