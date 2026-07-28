import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Placeholder for the six chart panels while the Recharts chunk is in flight.
 *
 * Its own module, and that is the whole point: the dashboard route imports this
 * statically to use as a Suspense fallback, so if it lived in `sales-charts.tsx`
 * alongside the charts it would drag Recharts back into the route's chunk and
 * undo the split it exists to cover.
 *
 * Same grid and same panel height as the real thing, so nothing reflows when the
 * charts land.
 */

/** Mirrors the `h-64` on the real panels. Changing one without the other makes
 *  the whole page jump when the charts arrive. */
export const CHART_PANEL_HEIGHT = "h-64";

export function SalesChartsSkeleton() {
  return (
    <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index}>
          <CardHeader>
            <div className="h-4 w-36 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent className={CHART_PANEL_HEIGHT}>
            <div className="h-full w-full animate-pulse rounded-lg bg-muted/50" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
