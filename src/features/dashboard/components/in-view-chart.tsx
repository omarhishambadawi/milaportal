import { useRef, type ReactNode } from "react";
import { useInViewChartMotion, type ChartMotionSet } from "../chart-motion";

/**
 * A chart body that plays its entrance when it first scrolls into view.
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
 * The wrapper element
 * ---------------------------------------------------------------------------
 * `h-full w-full` so it fills the panel its parent already sized and adds no
 * layout of its own — `ResponsiveContainer` measures the same box either way, so
 * nothing moves and no card changes height when the animation starts. The
 * element exists only to give the observer something to watch.
 *
 * The panel renders its final structure while it waits (the presets are simply
 * still), so a chart scrolled past quickly is never blank and never half-drawn.
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
  const motion = useInViewChartMotion(identity, ref);
  return (
    <div ref={ref} className="h-full w-full">
      {children(motion)}
    </div>
  );
}
