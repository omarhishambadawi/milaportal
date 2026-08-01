import { AnalyticsCard } from "./analytics-card";

/**
 * Placeholder for the six chart panels while the Recharts chunk is in flight.
 *
 * Its own module, and that is the whole point: the dashboard route imports this
 * statically to use as a Suspense fallback, so if it lived in `sales-charts.tsx`
 * alongside the charts it would drag Recharts back into the route's chunk and
 * undo the split it exists to cover. `AnalyticsCard` is safe to import here —
 * it is card chrome and knows nothing about charting.
 *
 * Same grid and the same card as the real thing, so nothing reflows when the
 * charts land.
 */

/** Mirrors the plot height on the fixed-height panels. Changing one without the
 *  other makes the whole page jump when the charts arrive. */
export const CHART_PANEL_HEIGHT = "h-64";

/**
 * The three ranked panels size themselves from their row count, which is not
 * known until the data is in. This is the height of a typical ten-row chart —
 * near enough that the settle is imperceptible, and the alternative is holding
 * every panel to a fixed height and reintroducing the compression this sprint
 * set out to remove.
 */
const RANKED_PANEL_HEIGHT = 396;

const PANEL_HEIGHTS = [256, 256, 256, RANKED_PANEL_HEIGHT, RANKED_PANEL_HEIGHT, 300];

export function SalesChartsSkeleton() {
  return (
    <div className="grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
      {PANEL_HEIGHTS.map((height, index) => (
        <AnalyticsCard key={index} title="" loading>
          <div className="w-full animate-pulse rounded-lg bg-muted/50" style={{ height }} />
        </AnalyticsCard>
      ))}
    </div>
  );
}
