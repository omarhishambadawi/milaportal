import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

/**
 * Row windowing for the branch list.
 *
 * Hand-rolled rather than pulling in a virtualization library, because the
 * problem this list actually has is much narrower than the general one. Cards
 * are a **uniform** height — the address is line-clamped precisely so they are —
 * which means every row position is arithmetic rather than a measurement. The
 * one exception is the single expanded card, and one exception is cheap to model
 * exactly: rows above it are unaffected, rows below it all shift by the same
 * delta.
 *
 * A general virtualizer would measure all N rows to rediscover a layout that is
 * already known by construction, and would add a dependency to do it.
 */

export interface VirtualRow {
  index: number;
  /** Pixel offset of this row from the top of the scrolled content. */
  start: number;
}

interface Options {
  /** Number of items, not rows. */
  count: number;
  /** Items rendered side by side. Rows = ceil(count / itemsPerRow). */
  itemsPerRow: number;
  /** Height of one collapsed card, excluding the gap below it. */
  rowHeight: number;
  gap: number;
  /** Index of the item whose card is open, or null. */
  expandedIndex: number | null;
  /** Extra height the open card adds, measured from the DOM. */
  expandedExtra: number;
  /** Rows rendered beyond the viewport on each side, to cover fast scrolling. */
  overscan?: number;
}

export interface VirtualResult {
  /**
   * Attach to the element that *contains* the rows.
   *
   * Note what changed: this used to be the element that scrolled. The list no
   * longer scrolls — the page does — so this is now the measuring reference, and
   * how far it has travelled past the top of the viewport is what stands in for
   * the old `scrollTop`.
   *
   * Still a callback ref rather than a ref object, and for the same reason as
   * `useColumnCount` below: the element does not exist on the first render. The
   * list shows skeletons while the directory loads and an empty state when
   * nothing matches, and neither of those contains rows. A mount effect reading
   * `ref.current` therefore finds null, bails, and never runs again — leaving no
   * listener and no measured viewport for the rest of the session, which is a
   * list frozen on its first screenful of rows above a full-height spacer. That
   * is the blank area.
   */
  scrollRef: (element: HTMLDivElement | null) => void;
  /** Height the inner spacer must have for the page's scrollbar to be honest. */
  totalHeight: number;
  rows: VirtualRow[];
  /** Scroll the page so a given item sits in the middle of the viewport. */
  scrollToIndex: (index: number) => void;
  /** False until the container has been measured, so callers can report failure. */
  canScroll: boolean;
}

export function useVirtualRows({
  count,
  itemsPerRow,
  rowHeight,
  gap,
  expandedIndex,
  expandedExtra,
  overscan = 4,
}: Options): VirtualResult {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const pitch = rowHeight + gap;
  const rowCount = itemsPerRow > 0 ? Math.ceil(count / itemsPerRow) : 0;
  const expandedRow =
    expandedIndex != null && itemsPerRow > 0 ? Math.floor(expandedIndex / itemsPerRow) : null;
  const extra = expandedRow != null ? expandedExtra : 0;

  /**
   * Track the page's scroll instead of a container's.
   *
   * The list used to be its own scroll port, which is what trapped the wheel: a
   * reader who reached the end of the cards had nowhere for the gesture to go,
   * because the element that consumed it was not the element that needed to move.
   * Virtualizing against the window removes the inner port entirely — there is
   * one scrollbar on the page and the cards are part of it.
   *
   * `-rect.top` is the substitute for `scrollTop`: how far the container's own
   * top edge has travelled above the viewport's. Clamped at zero, because while
   * the container is still below the fold the first row is the right one to draw.
   *
   * Read straight through with no rAF throttle, for the reason the element
   * version documented: `requestAnimationFrame` does not run in a hidden
   * document, so a throttled handler would queue a frame that never arrives and
   * freeze the list on its first screenful. The spec already fires `scroll` from
   * the same "update the rendering" step, so at most one event per frame gets
   * here, and React drops the re-render when the derived value has not changed.
   */
  useLayoutEffect(() => {
    const element = scroller;
    if (!element) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      setScrollTop(Math.max(0, -rect.top));
      setViewport(window.innerHeight);
    };

    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);

    // The container's own geometry moves when the locator opens or collapses
    // above it, which is a layout change rather than a scroll — no scroll event
    // fires, so without this the window of drawn rows would be stale.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);

    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [scroller]);

  /** Top offset of a row, accounting for the one expanded card above it. */
  const rowStart = useCallback(
    (row: number) => row * pitch + (expandedRow != null && row > expandedRow ? extra : 0),
    [pitch, expandedRow, extra],
  );

  const totalHeight = rowCount > 0 ? rowCount * pitch - gap + extra : 0;

  const rows = useMemo(() => {
    if (rowCount === 0) return [];
    // Invert rowStart: subtract the expanded delta first when the scroll
    // position is already past the open card, so the arithmetic stays a single
    // division rather than a search.
    const adjusted =
      expandedRow != null && scrollTop > rowStart(expandedRow + 1) ? scrollTop - extra : scrollTop;
    const first = Math.max(0, Math.floor(adjusted / pitch) - overscan);
    // A viewport of 0 means the container has not been measured yet (first
    // paint, or a hidden tab). Render a screenful anyway rather than nothing —
    // otherwise the list is empty until a resize happens to fire.
    const visibleRows = Math.ceil((viewport || 800) / pitch) + overscan * 2;
    const last = Math.min(rowCount - 1, first + visibleRows);

    const out: VirtualRow[] = [];
    for (let row = first; row <= last; row++) out.push({ index: row, start: rowStart(row) });
    return out;
  }, [rowCount, scrollTop, viewport, pitch, overscan, expandedRow, extra, rowStart]);

  /**
   * Scroll the page so a row sits in the middle of the viewport.
   *
   * Computed arithmetically rather than by calling `scrollIntoView` on the card,
   * and that is forced by virtualization: the target card is very often not
   * mounted at the moment the jump is requested — it is thirty rows down and
   * outside the drawn window — so there is no element to ask. Row geometry is
   * known by construction here, so the destination can be worked out without it,
   * and the rows render as the page passes them.
   *
   * Centring rather than top-aligning is what stops the jump "halfway": a
   * top-aligned card sits flush against the viewport edge, and anything taller
   * than the remaining space is cut off with nothing to say so. The slack is
   * split evenly instead, so the whole card is visible whenever the viewport can
   * hold it, and it reads as a deliberate destination. `max(0, …)` covers the
   * case of a viewport shorter than one card, where flush-to-top is the best
   * available answer.
   *
   * Returns nothing but reports through `canScroll` whether it could act, so the
   * caller can tell the user instead of appearing to ignore the click.
   */
  const scrollToIndex = useCallback(
    (index: number) => {
      if (!scroller || itemsPerRow <= 0) return;
      const rect = scroller.getBoundingClientRect();
      const documentTop = rect.top + window.scrollY;
      const start = rowStart(Math.floor(index / itemsPerRow));
      const slack = Math.max(0, window.innerHeight - rowHeight);
      const top = Math.max(0, documentTop + start - slack / 2);
      window.scrollTo({ top, behavior: "smooth" });
    },
    [scroller, itemsPerRow, rowStart, rowHeight],
  );

  return { scrollRef: setScroller, totalHeight, rows, scrollToIndex, canScroll: scroller != null };
}

/**
 * How many cards fit side by side, measured rather than guessed.
 *
 * The column count cannot come from a Tailwind breakpoint here: the list pane is
 * a quarter of the screen narrower when the map is open, and narrower again when
 * the map is dragged wider, so the same viewport width yields different column
 * counts. The virtualizer needs the real number to compute row positions, so it
 * is derived from the element's own width.
 *
 * Returns a **callback ref**, not a ref object, and that is the whole point. The
 * grid element does not exist for the first render — the list shows skeletons
 * while the directory loads, and an empty state when a search matches nothing —
 * so a `ref.current` read in a mount effect finds null, bails, and never looks
 * again: the observer is never attached and the list stays at one column for the
 * rest of the session. A callback ref fires whenever the element appears or is
 * replaced, which is exactly when the measurement has to be redone.
 */
export function useColumnCount(minCardWidth: number) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      setColumns(Math.max(1, Math.floor(width / minCardWidth)) || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, minCardWidth]);

  return { gridRef: setElement, columns };
}
