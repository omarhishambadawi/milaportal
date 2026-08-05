/**
 * The shared vocabulary every Calls chart is drawn in.
 *
 * Extracted from the Customer Care trend charts when Telesales and the Calls
 * Overview needed the same tooltip, the same legend, the same axis type and the
 * same two series colours. Three copies of a tooltip is three places a colour
 * drifts, and the whole point of the module's redesign is that a supervisor
 * moving between its pages is reading one interface rather than three.
 *
 * Everything here is presentational. No component in this file derives a KPI —
 * see the contract on `buildCustomerCareMetrics`.
 */

/** Inbound, and the primary series wherever there is only one. */
export const INBOUND = "var(--color-chart-1)";
/** Outbound, and the secondary series. */
export const OUTBOUND = "var(--color-chart-3)";

export const axisTick = { fontSize: 11, fill: "var(--color-muted-foreground)" };
export const gridStroke = "var(--color-border)";
export const gridDash = "2 5";

export const valueLabelStyle = {
  fontSize: 10,
  fontWeight: 600,
  fill: "var(--color-muted-foreground)",
} as const;

/**
 * Enter animation is off on every series in this module, deliberately.
 *
 * Two reasons, and the second settles it. Recharts replays the animation
 * whenever the `data` prop changes identity, so a background refresh re-draws
 * the whole chart from zero — on a month that is dozens of bars animating for
 * no new information. And `Bar` gates its `LabelList` on `isAnimationFinished`,
 * so an animated bar renders its value only once the transition has run and not
 * at all if it never completes; the value labels are the point of the redesign
 * and cannot be conditional on that.
 */
export const CHART_ANIMATION = false;

/** Recharts resize debounce. Enough to coalesce a drag, short enough to feel instant. */
export const CHART_RESIZE_DEBOUNCE = 80;

/**
 * `2026-07-29` → `29 Jul`. Formatting only — the bucket itself is the engine's.
 *
 * Falls back to the raw key for the normalizer's `—` bucket (a call with no
 * usable timestamp), which must still render rather than throw.
 */
export function shortDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * `3 PM` → `3p`, for an hourly axis.
 *
 * Twenty-four labels is the whole point of an hourly chart and also the thing
 * that breaks it: `12 AM` is about 34px at this type size, so a phone-width card
 * fits six of them and Recharts renders all twenty-four on top of each other.
 * Two characters fit everywhere, and nothing is lost — the tooltip and the peak
 * badge both carry the unabbreviated hour.
 */
export function compactHour(label: string): string {
  return label.replace(/\s*AM$/, "a").replace(/\s*PM$/, "p");
}

/**
 * Bar geometry for a daily series.
 *
 * Has to follow the window or the chart looks wrong at one end of the range: a
 * week's worth of bars at month spacing reads as scattered ticks, and a month's
 * worth at week spacing comes out about four pixels wide. Measured at the
 * half-width these cards actually get.
 */
export function barGeometry(pointCount: number) {
  const dense = pointCount > 10;
  return {
    barGap: dense ? 1 : 3,
    barCategoryGap: dense ? "6%" : "26%",
    maxBarSize: dense ? 14 : 28,
    /** Value labels collide past this; the tooltip is the better answer. */
    showLabels: pointCount <= 10,
  };
}

/** A colour key that reads as part of the card header rather than chart furniture. */
export function LegendSwatch({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value?: number | string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-xs">
      <span
        className="inline-block h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{label}</span>
      {value != null && <span className="font-semibold tabular-nums text-foreground">{value}</span>}
    </span>
  );
}

/** A single figure in the card header — a peak, an average, a total. */
export function HeaderStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

/** Shared shell for the custom tooltips, so every chart reads identically. */
export function TooltipShell({ title, rows }: { title: string; rows: React.ReactNode }) {
  return (
    <div className="min-w-[172px] rounded-lg border border-border bg-popover px-3 py-2.5 shadow-lg">
      <div className="mb-2 text-xs font-semibold text-foreground">{title}</div>
      <div className="space-y-1.5">{rows}</div>
    </div>
  );
}

export function TooltipRow({
  swatch,
  label,
  value,
  strong,
}: {
  swatch?: string;
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 text-xs leading-none">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={swatch ? { background: swatch } : undefined}
        aria-hidden="true"
      />
      <span className={strong ? "flex-1 text-foreground" : "flex-1 text-muted-foreground"}>
        {label}
      </span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

/**
 * Inbound / outbound / total, for every volume chart in the module.
 *
 * Reads as the queue panel does — one line per series, then the total under a
 * rule:
 *
 *     1 PM
 *     Inbound   5
 *     Outbound  2
 *     Total     7
 */
export function VolumeTooltip({ active, payload, label, formatTitle }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as { inbound?: number; outbound?: number; total?: number };
  const total = row.total ?? (row.inbound ?? 0) + (row.outbound ?? 0);
  return (
    <TooltipShell
      title={formatTitle ? formatTitle(label) : String(label)}
      rows={
        <>
          {payload.map((p: any) => (
            <TooltipRow
              key={p.dataKey}
              swatch={p.color}
              label={p.name}
              value={String(p.value ?? 0)}
            />
          ))}
          <div className="mt-2 border-t border-border/60 pt-2">
            <TooltipRow label="Total" value={String(total)} strong />
          </div>
        </>
      }
    />
  );
}

/** A single-series tooltip, formatted by the caller. */
export function SingleValueTooltip({
  active,
  payload,
  label,
  name,
  color,
  format,
  formatTitle,
}: any) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <TooltipShell
      title={formatTitle ? formatTitle(label) : String(label)}
      rows={
        <TooltipRow
          swatch={color ?? INBOUND}
          label={name ?? payload[0].name}
          value={format ? format(v) : String(v ?? 0)}
          strong
        />
      }
    />
  );
}
