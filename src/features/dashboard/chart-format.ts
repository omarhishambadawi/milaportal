/**
 * Number formatting for chart axes.
 *
 * Separate from `chart-theme.tsx` so that file exports components and styling
 * constants only — mixing pure helpers into a module that exports components
 * breaks React Fast Refresh for the whole module, and the axis formatters are
 * imported by charts that have nothing else in common.
 *
 * Exact currency belongs to `fmtSAR` in `@/lib/branches`, which the tooltips and
 * tables use. Nothing here should reimplement it.
 */

/** `1.20` → `1.2`, `3.00` → `3`. One decimal, only when it carries meaning. */
function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Money on a value axis: `1.2M`, `840K`, `520`.
 *
 * Axis ticks were printing the full `fmtSAR` output — `1,234,567.89 SAR` — five
 * or six times down the side of a chart, which is both unreadable at 11px and
 * wide enough to eat the plot area it is labelling. The currency belongs in the
 * tooltip, where there is room to say it once and say it exactly; an axis only
 * has to convey magnitude.
 */
export function fmtAxisSAR(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n == null || !Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimZero(n / 1_000)}K`;
  return String(Math.round(n));
}
