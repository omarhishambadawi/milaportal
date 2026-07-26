import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
  /** Attach to the element that scrolls. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Height the inner spacer must have for the scrollbar to be honest. */
  totalHeight: number;
  rows: VirtualRow[];
  /** Scroll a given item to the top of the viewport, allowing for the sticky offset. */
  scrollToIndex: (index: number) => void;
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const pitch = rowHeight + gap;
  const rowCount = itemsPerRow > 0 ? Math.ceil(count / itemsPerRow) : 0;
  const expandedRow =
    expandedIndex != null && itemsPerRow > 0 ? Math.floor(expandedIndex / itemsPerRow) : null;
  const extra = expandedRow != null ? expandedExtra : 0;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    // rAF-throttled: a scroll handler that calls setState on every event fires
    // far more often than the browser paints, and each call re-renders the list.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(element.scrollTop);
      });
    };

    setScrollTop(element.scrollTop);
    setViewport(element.clientHeight);
    element.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

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

  const scrollToIndex = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element || itemsPerRow <= 0) return;
      element.scrollTo({ top: rowStart(Math.floor(index / itemsPerRow)), behavior: "smooth" });
    },
    [itemsPerRow, rowStart],
  );

  return { scrollRef, totalHeight, rows, scrollToIndex };
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
