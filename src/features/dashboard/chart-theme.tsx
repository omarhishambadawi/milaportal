import type { CSSProperties, ReactNode } from "react";
import { ellipsize } from "./text-metrics";

/**
 * Shared chrome for every Recharts panel on the dashboard.
 *
 * Recharts styles itself with hard-coded hex literals and inline styles, so
 * nothing in it inherits a theme token unless it is told to. Left alone the
 * defaults are built for a white page:
 *
 *   - **Axis ticks** come from `CartesianAxis.defaultProps.stroke = '#666'`,
 *     which the tick renderer also uses as the text `fill`. Every panel passed
 *     `tick={{ fontSize: 11 }}` and therefore inherited it — mid-grey text on a
 *     near-black card, around 2.3:1.
 *   - **The hover cursor** on a bar chart is a `Rectangle` that `Cursor` gives
 *     `stroke: '#ccc'` and no `fill` at all, so SVG falls back to *black*. That
 *     is the band that appears behind the hovered bar, and it is wrong in both
 *     themes — a dark slab in light mode, a light-outlined one in dark.
 *   - **The tooltip** defaults to `#fff` with a `#ccc` border. `contentStyle`
 *     fixed the box, but the label and item rows are separate elements and the
 *     value rows are painted in the *series* colour, which is chosen to read
 *     against the chart background rather than against a popover.
 *
 * So the tooltip is a real component here rather than three inline style
 * objects. Tailwind classes make it correct in both themes by construction
 * instead of by remembering to pass `contentStyle` at seven call sites — three
 * of the six panels had been added without it.
 */

/** Axis tick text. The `fill` is the whole point; without it, `#666`. */
export const AXIS_TICK = { fontSize: 11.5, fill: "var(--color-muted-foreground)" } as const;

export const GRID_STROKE = "var(--color-border)";

/**
 * Grid opacity, applied on top of `--color-border`.
 *
 * The border token is tuned for a 1px divider between two surfaces, and a full
 * grid drawn at that weight competes with the data. Pulling it back leaves the
 * gridlines readable as a reference without them reading as content.
 */
export const GRID_OPACITY = 0.55;

/** Type size for a category (name) axis. Slightly larger than the value axis:
 *  those labels are words, and words at 11px in Arabic are hard work. */
export const CATEGORY_TICK_SIZE = 12;

/** Gap between a category label and the plot area, in px. */
export const CATEGORY_TICK_GUTTER = 10;

/** One margin for every panel, so no two charts sit at different insets. */
export const CHART_MARGIN = { top: 8, right: 16, left: 0, bottom: 0 } as const;

/**
 * The band behind a hovered bar.
 *
 * Explicit `fill` because the default is black, and `stroke: "none"` because the
 * default `#ccc` outline is what makes it read as a bright box in dark mode.
 */
export const BAR_CURSOR = {
  fill: "var(--color-muted)",
  fillOpacity: 0.6,
  stroke: "none",
} as const;

/** The crosshair on an area/line chart, where the cursor is a stroke not a fill. */
export const POINT_CURSOR = {
  stroke: "var(--color-muted-foreground)",
  strokeOpacity: 0.5,
  strokeWidth: 1,
  strokeDasharray: "4 4",
} as const;

/**
 * Layering for the tooltip's positioned wrapper.
 *
 * Recharts puts the tooltip in a `position: absolute` div that is a sibling of
 * the SVG with no stacking context of its own, so a later-painted panel in the
 * grid can cover it. `outline: none` removes the focus ring the wrapper picks up
 * when the chart has `accessibilityLayer`.
 */
export const TOOLTIP_WRAPPER: CSSProperties = { zIndex: 40, outline: "none" };

/**
 * The tooltip's own motion.
 *
 * Recharts defaults a tooltip to a 400ms `ease` transition on its position, so
 * the box visibly trails the pointer across a chart and is still catching up
 * when the reader has moved to the next bar — which reads as lag, not as
 * polish. Short enough to feel attached to the cursor, long enough not to
 * snap; the curve is the page's own (`chart-motion`), stated here because a
 * Recharts tooltip takes its easing as a prop and not from a class.
 */
export const TOOLTIP_MOTION = {
  animationDuration: 180,
  animationEasing: "ease-out",
} as const;

/**
 * Legend text and the gap above it.
 *
 * 10px rather than 4: the legend sits directly under the plot area, and at 4px
 * a "Customer Care" swatch was closer to the x-axis labels it is not part of
 * than to the chart it names.
 */
export const LEGEND_STYLE: CSSProperties = { fontSize: 12, paddingTop: 10, lineHeight: 1.2 };

/**
 * Legend labels in body colour rather than the series colour.
 *
 * Recharts paints legend text in the colour of the series it names, which is a
 * duplicate of the swatch sitting immediately to its left and costs the label
 * all its contrast. The status palette makes the point: "No Answer" is `#6b7280`,
 * a mid-grey that is unreadable on the dark card and marginal on the light one.
 */
export function legendText(value: ReactNode): ReactNode {
  return <span className="text-xs text-muted-foreground">{value}</span>;
}

/** Pie slice labels, which default to the slice's own fill. */
export const PIE_LABEL = { fontSize: 11, fill: "var(--color-foreground)" } as const;

interface CategoryTickProps {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
  /** Px available for the label itself, gutter already subtracted. */
  maxWidth: number;
}

/**
 * A left-hand category label: vertically centred, ellipsised only if it must be,
 * and carrying its full text as a native tooltip when it was.
 *
 * Recharts' stock tick renders at the axis baseline rather than the band centre,
 * which is what made every horizontal bar chart look half a line out of step
 * with its own bars. `dy="0.32em"` is the correction — it centres the cap-height
 * box on the tick's y, which is the band centre.
 *
 * `unicodeBidi: "plaintext"` is the SVG equivalent of `dir="auto"`: it resolves
 * direction per string from its first strong character, so an Arabic city name
 * orders right-to-left and an English branch name left-to-right, in the same
 * axis, without either being reversed.
 *
 * The gutter is NOT applied here. Recharts has already moved `x` inward by
 * `tickSize + tickMargin` before handing it over, so the axis owns the gap and
 * this draws at the x it is given. Subtracting a gutter as well double-counted
 * it, which is exactly how a label that the axis had reserved room for still
 * ended up four pixels off the left edge. Callers pair this with
 * `tickSize={0} tickMargin={CATEGORY_TICK_GUTTER}`.
 */
export function CategoryTick({ x = 0, y = 0, payload, maxWidth }: CategoryTickProps) {
  const full = String(payload?.value ?? "");
  const shown = ellipsize(full, maxWidth, CATEGORY_TICK_SIZE);
  const clipped = shown !== full;

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy="0.32em"
        textAnchor="end"
        fontSize={CATEGORY_TICK_SIZE}
        fill="var(--color-muted-foreground)"
        style={{ unicodeBidi: "plaintext" }}
      >
        {/* Only when the label was actually shortened — a native tooltip that
            repeats what is already fully visible is noise on every hover. */}
        {clipped && <title>{full}</title>}
        {shown}
      </text>
    </g>
  );
}

/** One row of a tooltip, as Recharts hands it over. */
interface TooltipEntry {
  name?: ReactNode;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  /** The whole data row the point came from, which is where `footerKey` looks. */
  payload?: Record<string, unknown> & { fill?: string };
}

interface ChartTooltipProps {
  /** Recharts injects these three when it clones the element. */
  active?: boolean;
  payload?: TooltipEntry[];
  label?: ReactNode;
  /** How to render a value. Defaults to printing it as-is. */
  format?: (value: number | string) => string;
  /** Suppress the heading when the category is already the only row. */
  hideLabel?: boolean;
  /**
   * What the values are counted in — "orders", "calls". Appended to each value
   * rather than folded into the series name, so the name column stays the
   * series and the number column stays a number with its unit.
   */
  unit?: string;
  /**
   * Field on the hovered data row carrying a closing line — "vs Jun 2026",
   * "In progress".
   *
   * Data-driven rather than a render prop because the line differs per point:
   * a growth bar is measured against whichever month precedes *it*, and a
   * function prop would be a new identity on every render for a string the
   * series already knows.
   */
  footerKey?: string;
}

/**
 * The tooltip for every dashboard chart.
 *
 * `bg-popover` with no alpha, deliberately: a translucent tooltip over a chart
 * lets grid lines and bars ghost through the numbers, which is most of why this
 * read as low-contrast in dark mode. The swatch keeps the link to the series that
 * colouring the text used to provide, without spending the text's contrast on it.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  format,
  hideLabel,
  unit,
  footerKey,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const render = (value: number | string | undefined) => {
    if (value == null) return "—";
    const text = format ? format(value) : String(value);
    return unit ? `${text} ${unit}` : text;
  };

  // Every row of a Recharts tooltip carries the same source row, so the first
  // one is as good as any — and is the only one there is on a single series.
  const footer = footerKey ? payload[0]?.payload?.[footerKey] : undefined;

  return (
    <div className="min-w-[10rem] rounded-xl border border-border/80 bg-popover px-3 py-2.5 text-popover-foreground shadow-2xl shadow-black/15 ring-1 ring-black/5 dark:shadow-black/50 dark:ring-white/5">
      {!hideLabel && label != null && label !== "" && (
        <div className="mb-2 border-b border-border/60 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground">
          {label}
        </div>
      )}
      <ul className="space-y-1">
        {payload.map((entry, index) => (
          <li
            key={`${String(entry.dataKey ?? entry.name ?? index)}`}
            className="flex items-center gap-2 text-[11px] leading-4"
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: entry.color ?? entry.payload?.fill ?? "var(--color-chart-1)" }}
            />
            {entry.name != null && entry.name !== "" && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.name}</span>
            )}
            <span className="shrink-0 font-semibold tabular-nums text-foreground">
              {render(entry.value)}
            </span>
          </li>
        ))}
      </ul>
      {typeof footer === "string" && footer !== "" && (
        <div className="mt-1.5 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}
