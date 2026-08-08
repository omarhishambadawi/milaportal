/**
 * Display formatting for the Dashboard's analytics sections.
 *
 * Its own module because two sections now share it — Monthly performance and
 * Delivery methods — and a formatter living in one section's analytics file
 * that the other imports is the kind of dependency that reads as accidental.
 *
 * The rule these encode: a card or a scan-first table conveys **magnitude**, and
 * exact figures belong in the chart tooltips (`fmtSAR` in `@/lib/branches`) and
 * in the export, where there is room to be precise. Eleven characters of
 * precision in a KPI tile is what makes a dashboard read as a spreadsheet.
 */

/** `1.20` → `1.2`, `3.00` → `3`. One decimal, only when it carries meaning. */
function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * A growth rate as text: `+56.0%`, `−3.1%`, or an em dash when there is none.
 *
 * One decimal. A second decimal on a percentage nobody will act on to that
 * precision is two more characters in every cell of every growth column.
 */
export function formatGrowth(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;
}

/** A plain share: `89.9%`. Unsigned — a share has no direction. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

/**
 * Money at a glance: `SAR 747.5K`, `SAR 1.2M`, `SAR 274`.
 *
 * The exact figure — `747,542.65 SAR`, via `fmtSAR` — is what a chart tooltip
 * shows and what an export carries.
 */
export function formatCompactSAR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `SAR ${trimZero(value / 1_000_000)}M`;
  if (abs >= 10_000) return `SAR ${trimZero(value / 1_000)}K`;
  return `SAR ${Math.round(value).toLocaleString()}`;
}

/** An order count: grouped, never abbreviated. `2,727`, not `2.7K`. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString();
}
