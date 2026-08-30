/** Chart palette + per-status colors used by the Dashboard charts. */

/**
 * The categorical ramp, in the order a chart should reach for it.
 *
 * Five steps of the portal's own turquoise → teal → navy family (see the
 * `--chart-*` tokens in `styles.css`), which is what keeps a page of ten panels
 * looking like one product. Nothing here is a hue chosen for a single chart.
 */
export const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

/**
 * Order status, coloured by what the status *means* rather than by hue.
 *
 * These were five hard-coded hex literals — `#eab308`, `#16a34a`, `#dc2626`,
 * `#2563eb`, `#6b7280` — and they were the last place on the Dashboard where a
 * colour was not a token. Three consequences, all visible:
 *
 *   - **They did not follow the theme.** Every one was picked against a white
 *     card. `#6b7280` for "No Answer" measures about 2.4:1 on the dark surface,
 *     which is below the floor for a legend swatch, let alone a slice.
 *   - **They said the same things twice, differently.** Completed, Pending and
 *     Cancelled are exactly the portal's positive / attention / negative
 *     semantics, and every table on the page already paints them with those
 *     tokens. The pie was the one surface answering in a second vocabulary.
 *   - **`#2563eb` was a sixth hue** in a palette built from three, which is what
 *     made the status pie read as belonging to a different dashboard than the
 *     charts either side of it.
 *
 * The mapping is unchanged in meaning: warm for waiting, green for done, red for
 * cancelled. Only the source of the colour has moved.
 */
export const STATUS_COLORS: Record<string, string> = {
  Pending: "var(--attention)",
  Completed: "var(--positive)",
  Cancelled: "var(--negative)",
  /** Live, but not yet either outcome — the ramp's mid navy, not a fresh blue. */
  "Follow-up": "var(--color-chart-3)",
  /** Deliberately neutral: an absence is not an outcome. */
  "No Answer": "var(--color-muted-foreground)",
};
