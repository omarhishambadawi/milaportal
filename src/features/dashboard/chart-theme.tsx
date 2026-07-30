import type { CSSProperties, ReactNode } from "react";

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
export const AXIS_TICK = { fontSize: 11, fill: "var(--color-muted-foreground)" } as const;

export const GRID_STROKE = "var(--color-border)";

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

export const LEGEND_STYLE: CSSProperties = { fontSize: 12, paddingTop: 4 };

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

/** One row of a tooltip, as Recharts hands it over. */
interface TooltipEntry {
  name?: ReactNode;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: { fill?: string };
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
}

/**
 * The tooltip for every dashboard chart.
 *
 * `bg-popover` with no alpha, deliberately: a translucent tooltip over a chart
 * lets grid lines and bars ghost through the numbers, which is most of why this
 * read as low-contrast in dark mode. The swatch keeps the link to the series that
 * colouring the text used to provide, without spending the text's contrast on it.
 */
export function ChartTooltip({ active, payload, label, format, hideLabel }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const render = (value: number | string | undefined) => {
    if (value == null) return "—";
    return format ? format(value) : String(value);
  };

  return (
    <div className="min-w-[9rem] rounded-lg border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-xl shadow-black/10 dark:shadow-black/40">
      {!hideLabel && label != null && label !== "" && (
        <div className="mb-1.5 border-b border-border/60 pb-1.5 text-[11px] font-semibold text-foreground">
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
    </div>
  );
}
