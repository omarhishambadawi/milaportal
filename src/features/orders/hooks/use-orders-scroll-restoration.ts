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

/**
 * The order the agent last opened, waiting to be pointed at when they come back.
 *
 * Deliberately a second slot rather than a read of `anchor`, because the two
 * answer different questions and have different lifetimes. `anchor` is consumed
 * by the scroll restore in the one commit where it decides where to put the
 * viewport, and it is only honoured when the row is in the DOM *at that moment*.
 * Tying the highlight to it meant the mark was skipped whenever the restore took
 * any other branch — the row arriving a commit later, the list already settled,
 * or the browser's own scroll restoration having handled the back button — which
 * is most of the ways a return actually happens.
 */
interface PendingReturn {
  orderId: string;
  /**
   * Has the agent actually left the list yet?
   *
   * The whole bug lived in the absence of this flag. Opening an order re-mounts
   * the Orders list once *during the outgoing transition* — the router keeps the
   * old route rendered while the lazily-split detail component loads — so a
   * claim that ran on mount consumed the id immediately, on the way out. The row
   * duly flashed, on a list the agent was already leaving, and by the time they
   * came back there was nothing left to claim. Measured: `parked` at t=13084,
   * `claimed` 101ms later at t=13185, and at t=13350 the mark was live and
   * animating while `location.pathname` was already the detail route.
   *
   * Set by the order page mounting — see `armOrderReturn`, which records why
   * the two cheaper discriminators (arming on unmount, guarding on pathname)
   * were both measured racing this same transition.
   */
  armed: boolean;
}

let pendingReturn: PendingReturn | null = null;

/**
 * Where the id is parked while the agent is away.
 *
 * `sessionStorage` as well as the module variable, because module state is not
 * as durable as it looks: it is wiped by a full document load, and the route
 * back to the list is not guaranteed to be a client-side one — a hard refresh
 * from the order page, a middle-click, or any navigation that reloads the
 * document takes the variable with it. `sessionStorage` is per-tab and survives
 * exactly that, which is the difference between a mark that usually appears and
 * one that always does.
 */
const RETURN_KEY = "milaserv.orders.returnedFrom";

/**
 * Dev-only trace of the return-state lifecycle.
 *
 * Kept rather than removed after the fact. This mechanism spans a navigation,
 * a module variable, a storage key and a mount, and when it fails it fails
 * silently and looks identical to a styling problem — which cost three rounds
 * of diagnosis aimed at the wrong layer. Two log lines make "was it written"
 * and "was it read" answerable in one reproduction. Stripped from production
 * builds by the `import.meta.env.DEV` guard.
 */
function trace(event: string, detail: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.info(`[orders/return] ${event}`, detail);
}

function persist(value: PendingReturn | null): void {
  try {
    if (value) sessionStorage.setItem(RETURN_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Private mode, or storage disabled. The module variable still covers the
    // ordinary client-side navigation, which is the common path.
  }
}

function restore(): PendingReturn | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingReturn;
    return typeof parsed?.orderId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parkReturnedOrderId(orderId: string): void {
  pendingReturn = { orderId, armed: false };
  persist(pendingReturn);
  trace("parked", { orderId, armed: false });
}

/**
 * The order page has mounted, so the agent genuinely got there.
 *
 * Called by the order form. This is the only signal in the round trip that
 * cannot be raced, and both of the cheaper ones were measured failing:
 *
 *   * *claim on mount* — the router re-mounts the Orders list during the
 *     outgoing transition, so the id was consumed on the way out (`parked`
 *     t=9701, `claimed` t=9807, mark live at t=9967 while `location.pathname`
 *     was already the detail route);
 *   * *arm on unmount* — that transition is a full unmount/remount cycle, so
 *     the unmount armed it and the very next mount claimed it, 6ms later;
 *   * *guard on pathname* — at t=9967 the Orders table was still rendered with
 *     `rows: 25` under the detail route's own pathname, so the two are not
 *     ordered with respect to each other either.
 *
 * The order page mounting is downstream of all of that: it cannot happen until
 * the list has actually been left behind.
 */
export function armOrderReturn(): void {
  if (!pendingReturn) pendingReturn = restore();
  if (!pendingReturn || pendingReturn.armed) return;
  pendingReturn = { ...pendingReturn, armed: true };
  persist(pendingReturn);
  trace("armed", { orderId: pendingReturn.orderId, by: "order page mounted" });
}

/**
 * Take the order to highlight, if there is one. Reading it clears it, so one
 * return produces exactly one mark however many times the list re-renders.
 */
export function takeReturnedOrderId(): string | null {
  if (!pendingReturn) pendingReturn = restore();
  // Parked but not armed: this is the mount that happens *while leaving*, not a
  // return. Leave it where it is — the trip is not over yet.
  if (!pendingReturn || !pendingReturn.armed) {
    trace("claim-skipped", {
      reason: pendingReturn ? "not armed — still leaving" : "nothing parked",
    });
    return null;
  }
  const id = pendingReturn.orderId;
  pendingReturn = null;
  persist(null);
  trace("claimed", { orderId: id });
  return id;
}

/**
 * Is there a trip in progress that has not reached the order page yet?
 *
 * True exactly during the mount the router performs while *leaving* the list.
 * The scroll restore has to ask this for the same reason the highlight does: it
 * consumes `anchor` and latches `restored`, so running it on that mount threw
 * away the position and left the real return with nothing to restore — which is
 * why coming back landed at the top of the list rather than on the row.
 */
export function isLeaving(): boolean {
  if (!pendingReturn) pendingReturn = restore();
  return !!pendingReturn && !pendingReturn.armed;
}

/** Test seam: arrange the module as though an order had just been opened. */
export function setReturnedOrderId(orderId: string | null, armed = true): void {
  pendingReturn = orderId ? { orderId, armed } : null;
  persist(pendingReturn);
}

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
  // Same trip, separate lifetime — see `returnedOrderId`. Recorded on the way
  // *out* so it covers every way back in: saving, cancelling, the browser's
  // back button, or closing the form.
  parkReturnedOrderId(orderId);
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
export const RETURN_HIGHLIGHT_MS = 3000;

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

  // Claim the mark once per mount of the list, independently of where the scroll
  // restore ends up. The row does not have to exist yet: the class is applied by
  // id while rendering, so a row that arrives in a later commit still gets it,
  // and still gets it if a save re-sorted it or the list refetched underneath.
  const claimed = useRef(false);
  useLayoutEffect(() => {
    if (!claimed.current) {
      claimed.current = true;
      const id = takeReturnedOrderId();
      if (id) setHighlighted(id);
    }
  }, []);

  /**
   * Drop the mark after its moment — but only start counting once the row it
   * marks is actually on screen.
   *
   * The claim above happens on mount, which is routinely *before* the list has
   * rows: a return that invalidates the orders query lands on an empty or
   * refetching table. Counting from mount spent the window on an empty table
   * and, on a slow page, cleared the state before the row had ever rendered —
   * the mark was live the whole time and had nothing to attach to.
   *
   * `rowsKey` is the ids of the rows currently rendered, so this waits for the
   * commit that actually contains the row and starts the clock there. Keyed on
   * the id too, so a second return re-arms rather than inheriting the remains of
   * the first one's timer.
   */
  const rowOnScreen = !!highlightedOrderId && rowsKey.split(",").includes(highlightedOrderId);
  useEffect(() => {
    if (!highlightedOrderId || !rowOnScreen) return;
    const timer = setTimeout(() => setHighlighted(null), RETURN_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedOrderId, rowOnScreen]);

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
    // The mount that happens while leaving must not consume the anchor or latch
    // `restored` — see `isLeaving`. Without this the position was thrown away on
    // the way out and the real return had nothing left to restore.
    if (isLeaving()) return;

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
