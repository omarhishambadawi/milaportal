import { useRef, type ReactNode } from "react";
import { useChartReveal, type ChartMotionSet } from "../chart-motion";

/**
 * A chart body that mounts and plays its entrance when it first scrolls into view.
 *
 * ---------------------------------------------------------------------------
 * What this replaces
 * ---------------------------------------------------------------------------
 * Every panel animated on MOUNT. The Dashboard is roughly four screens tall, so
 * eight of the ten entrances played against a viewport nobody was looking at and
 * were long finished by the time the reader scrolled down — which is why only
 * the top two charts ever appeared to animate at all. The motion was not broken;
 * it was being spent off-screen.
 *
 * It also meant ten Recharts animations starting on first paint, in the same
 * moment the route is resolving eleven queries and pulling in its lazy chart
 * chunk. Deferring the ones nobody can see takes that work off the critical
 * frame and spreads it across the scroll instead.
 *
 * ---------------------------------------------------------------------------
 * Deferred, not merely disarmed
 * ---------------------------------------------------------------------------
 * The first cut of this rendered the chart immediately and only withheld the
 * *presets* until the panel was seen. That is what made the Monthly revenue
 * trend jump: Recharts measures a line's path length in `componentDidMount` and
 * only when animation is already active, so a chart mounted still and armed
 * afterwards drew itself complete and then collapsed and redrew. See
 * `useChartReveal` for the full mechanism.
 *
 * So nothing is rendered until the panel is seen. The wrapper keeps the panel's
 * height either way — its parent sizes it — so no card changes height and
 * nothing reflows when the chart lands.
 *
 * ---------------------------------------------------------------------------
 * The wrapper element
 * ---------------------------------------------------------------------------
 * `h-full w-full` so it fills the panel its parent already sized and adds no
 * layout of its own — `ResponsiveContainer` measures the same box either way.
 * The element exists to give the observer something to watch and to carry the
 * reveal fade, which softens the arrival of the parts Recharts does not animate
 * itself: the axes, the grid and the legend.
 *
 * @param identity The memoised series this panel draws. A new reference means new
 *                 data and re-arms the entrance; see `useSettledChartMotion`.
 */
export function InViewChart({
  identity,
  children,
}: {
  identity: unknown;
  children: (motion: ChartMotionSet) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { ready, motion } = useChartReveal(identity, ref);
  return (
    <div ref={ref} className="h-full w-full">
      {ready && <div className="chart-reveal h-full w-full">{children(motion)}</div>}
    </div>
  );
}
