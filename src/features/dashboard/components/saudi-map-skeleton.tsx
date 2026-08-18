import { MapPin } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MAP_HEIGHT, MAP_WIDTH } from "@/lib/ksa-geo";

/**
 * Placeholder for the heat map while its chunk is in flight.
 *
 * Its own module for the same reason as `sales-charts-skeleton`: the dashboard
 * route imports this statically to use as a Suspense fallback, so if it lived in
 * `saudi-sales-map.tsx` it would pull the map straight back into the route chunk
 * and undo the split it exists to cover. `ksa-geo` is safe to import — it is
 * plain constants with no imports of its own, and it is where the real map gets
 * its viewBox, so the two cannot drift apart.
 *
 * The card chrome, the padding and the plot box are the real component's, and
 * the plot box carries the map's own aspect ratio and height caps. That is what
 * keeps the page from jumping when the map lands: the placeholder occupies the
 * height the map is about to occupy.
 */
export function SaudiMapSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3 border-b border-border/40">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/20">
              <MapPin className="h-4 w-4 text-primary" aria-hidden />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base font-semibold tracking-tight truncate">
                Sales by city — Saudi Arabia
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Geographic distribution of completed sales
              </p>
            </div>
          </div>
          {/* The city-count and total chips. They sit on the header's row at
              desktop width and wrap onto their own row on a phone, so leaving
              them out cost 60px of reserved height at 375px and nothing at
              1280px. */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="h-[26px] w-[74px] animate-pulse rounded-full border border-border/60 bg-muted/40" />
            <div className="hidden sm:block h-[26px] w-[104px] animate-pulse rounded-full border border-border/60 bg-muted/40" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-5">
        <div
          className="w-full animate-pulse rounded-2xl border border-border/60 bg-muted/40 max-h-[min(44vh,420px)] sm:max-h-[min(64vh,560px)]"
          style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
        />
        {/* The legend strip below the plot. Reserving the plot alone left the
            placeholder 47px short of the real card, which is a visible jump when
            the map lands — measured, not assumed. Same `mt-4`, same pill height
            as the legend it stands in for. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="h-[30px] w-[212px] animate-pulse rounded-full border border-border/50 bg-muted/40" />
          <span className="ml-auto text-[11px] text-transparent select-none">
            Bubble size ∝ completed sales
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
