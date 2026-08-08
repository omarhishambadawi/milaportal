import { useMemo, useSyncExternalStore } from "react";

/**
 * Enter animation for the Dashboard's charts, in one place.
 *
 * The panels had drifted into three different answers: the two daily-trend
 * areas animated at 500ms and 600ms, the ranked bars at 450ms, and the team bar
 * plus all four monthly panels had it switched off entirely. Nothing chose
 * those numbers — they accumulated — and the result was a page where some
 * charts drew themselves and some appeared.
 *
 * What the motion is *for*: a bar growing from the baseline says which
 * direction the axis runs and that the value is a magnitude, in the moment the
 * reader's eye is already on it. Past about 800ms that stops being information
 * and becomes a wait, which is why these are short and why nothing here loops,
 * bounces or scales.
 *
 * **It runs on mount and on a real data change, and at no other time.** Recharts
 * replays a series' animation when the `data` prop changes *identity*, so the
 * charts memoise their series and their container is `memo`'d — otherwise a
 * background refetch or an unrelated tab click would redraw the whole panel from
 * zero. That is the trap the Calls module documented when it turned its own
 * animation off (see `call-center/components/chart-primitives.tsx`); the fix
 * here is stable data rather than no motion.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Module scope, so `useSyncExternalStore` sees one stable subscriber. */
function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getSnapshot = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(REDUCED_MOTION).matches
    : false;

/** SSR has no media query to read; the client corrects it on hydration. */
const getServerSnapshot = () => false;

/**
 * Whether the viewer has asked their OS for less motion.
 *
 * The portal already honours this for the theme flip (`lib/theme.tsx`) and the
 * sales map, so charts that ignored it were the odd one out.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Recharts animation props, ready to spread onto a series. */
export interface ChartMotion {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: "ease-out";
}

/**
 * Per-series-type durations.
 *
 * A line has further to travel than a bar and reads better slightly slower; a
 * stacked bar is the shortest because two segments animating in sequence would
 * otherwise add up.
 */
const DURATION = { line: 700, area: 600, bar: 550 } as const;

const STILL: ChartMotion = {
  isAnimationActive: false,
  animationDuration: 0,
  animationEasing: "ease-out",
};

/**
 * The three motion presets, memoised so spreading them cannot hand Recharts a
 * new prop object on every render.
 */
export function useChartMotion(): Record<keyof typeof DURATION, ChartMotion> {
  const reduced = usePrefersReducedMotion();

  return useMemo(() => {
    if (reduced) return { line: STILL, area: STILL, bar: STILL };
    return {
      line: {
        isAnimationActive: true,
        animationDuration: DURATION.line,
        animationEasing: "ease-out",
      },
      area: {
        isAnimationActive: true,
        animationDuration: DURATION.area,
        animationEasing: "ease-out",
      },
      bar: {
        isAnimationActive: true,
        animationDuration: DURATION.bar,
        animationEasing: "ease-out",
      },
    };
  }, [reduced]);
}
