import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_TICK_GUTTER, CATEGORY_TICK_SIZE } from "../chart-theme";
import { widestLabel } from "../text-metrics";

/**
 * The geometry every ranked (horizontal) bar panel on the Dashboard shares.
 *
 * Extracted from `horizontal-bar-panel.tsx` when the Complaints section grew a
 * second kind of ranked chart. The three numbers below decide whether a name is
 * clipped and whether ten rows read as a ranking or as a compressed block, and
 * they were previously readable in exactly one component — which is how the
 * three charts that preceded that one ended up with hard-coded axis widths of
 * 130, 80 and 90 chosen by eye.
 */

/**
 * Ceiling on the category axis, as a share of panel width.
 *
 * Without a ceiling one 40-character name would take the plot area to nothing
 * and the chart would stop being a chart. A third is the point where the bars
 * still carry the comparison; past it, ellipsis is the better trade.
 */
const MAX_AXIS_SHARE = 0.34;

/** Floor, so a panel of short names still has a tidy left margin. */
const MIN_AXIS_WIDTH = 64;

/** Per-bar vertical rhythm — bar plus the gap under it. */
export const RANKED_ROW_HEIGHT = 34;

/**
 * The same rhythm, tightened for a panel that is sharing a row on A4.
 *
 * The Dashboard's 34px assumes a half-width card on a wide monitor. The Monthly
 * Report puts the same panel in a ~345px column on paper, where ten rows at the
 * full rhythm is a card taller than it is wide and mostly gap.
 */
export const RANKED_COMPACT_ROW_HEIGHT = 26;

/** Chart chrome that is not plot area: the value axis and its labels. */
const CHART_CHROME = 56;

/**
 * Panel width, tracked so the axis can be capped against it.
 *
 * `ResponsiveContainer` knows this number but will not share it, and the axis
 * width has to be decided before the container renders. One `ResizeObserver` per
 * panel is the cheapest way to learn it.
 */
export function usePanelWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured synchronously, before the browser paints. A `ResizeObserver`
    // delivers its first entry in a later task, so waiting for it meant the
    // first painted frame used the 190px fallback ceiling and the axis — and
    // with it the whole plot area — resized underneath the bars while their
    // entrance was still running. That is a visible jump, not a resize.
    setWidth(Math.round(el.getBoundingClientRect().width));

    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      // Whole pixels only: a fractional resize storm during a CSS transition
      // would otherwise re-render the chart on every frame of it.
      setWidth((prev) => (Math.abs(prev - next) < 1 ? prev : Math.round(next)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/**
 * How much room the category axis needs for `labels`, measured rather than guessed.
 *
 * `YAxis width` is a number Recharts is given and anything wider than it is
 * silently clipped, so this is the difference between a full Arabic city name
 * and a name that runs off the left edge. See `text-metrics.ts`.
 */
export function useCategoryAxisWidth(labels: readonly string[], panelWidth: number): number {
  return useMemo(() => {
    const widest = widestLabel([...labels], CATEGORY_TICK_SIZE);
    const ceiling = panelWidth > 0 ? Math.round(panelWidth * MAX_AXIS_SHARE) : 190;
    return Math.min(
      Math.max(MIN_AXIS_WIDTH, Math.ceil(widest) + CATEGORY_TICK_GUTTER + 4),
      ceiling,
    );
  }, [labels, panelWidth]);
}

/**
 * Panel height as a function of row count, rather than a fixed `h-64`.
 *
 * Ten branches crammed into 256px gave each bar ~18px including its gap, which
 * is what made these panels read as compressed. Growing with the data keeps the
 * bar rhythm constant whether there are three rows or ten.
 */
export function rankedPanelHeight(rowCount: number, compact = false): number {
  const rowHeight = compact ? RANKED_COMPACT_ROW_HEIGHT : RANKED_ROW_HEIGHT;
  return Math.max(compact ? 180 : 232, rowCount * rowHeight + CHART_CHROME);
}
