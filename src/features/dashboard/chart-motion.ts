import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

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
  /**
   * Always zero, and stated rather than left to the default.
   *
   * Recharts defaults `animationBegin` to 0 for Bar, Area and Line but to **400**
   * for Pie. Spreading a preset that set only the duration therefore left the
   * pie sitting still for four tenths of a second after every other panel on the
   * page had started — the one panel that looked like it had stalled. Carrying
   * the delay in the preset is what makes "they all start together" a property of
   * this module instead of a per-series default nobody reads.
   */
  animationBegin: number;
}

/**
 * Per-series-type durations.
 *
 * A line has further to travel than a bar and reads better slightly slower; a
 * stacked bar is the shortest because two segments animating in sequence would
 * otherwise add up. A pie sweeps its slices round rather than up, which reads
 * slower at the same duration, so it sits between the two.
 */
const DURATION = { line: 700, area: 600, bar: 550, pie: 600 } as const;

/** How long after the entrance to keep animation armed before settling. */
const SETTLE_SLACK_MS = 200;

const STILL: ChartMotion = {
  isAnimationActive: false,
  animationDuration: 0,
  animationEasing: "ease-out",
  animationBegin: 0,
};

const ALL_STILL: Record<keyof typeof DURATION, ChartMotion> = {
  line: STILL,
  area: STILL,
  bar: STILL,
  pie: STILL,
};

export type ChartMotionSet = Record<keyof typeof DURATION, ChartMotion>;

/**
 * The presets themselves, as a pure function of the two things that decide them.
 *
 * Separated from the hook so the page's animation contract — every series starts
 * at the same instant, none runs long enough to become a wait, and reduced
 * motion means still — is assertable without a renderer. That contract is the
 * whole point of this module and it was previously only checkable by eye.
 */
export function buildChartMotion(reduced: boolean, forceStill: boolean): ChartMotionSet {
  if (reduced || forceStill) return ALL_STILL;
  const moving = (duration: number): ChartMotion => ({
    isAnimationActive: true,
    animationDuration: duration,
    animationEasing: "ease-out",
    animationBegin: 0,
  });
  return {
    line: moving(DURATION.line),
    area: moving(DURATION.area),
    bar: moving(DURATION.bar),
    pie: moving(DURATION.pie),
  };
}

/**
 * The motion presets, memoised so spreading them cannot hand Recharts a new
 * prop object on every render.
 */
export function useChartMotion(
  /**
   * Force every preset to `STILL`, whatever the OS says.
   *
   * For the PDF export. Recharts drives an enter animation from zero, and a
   * printed page is a single instant — it captures whatever frame the animation
   * happened to be on, which for a bar starting at the baseline is no bar at
   * all. Paper has no motion to carry information anyway.
   */
  forceStill = false,
): ChartMotionSet {
  const reduced = usePrefersReducedMotion();
  return useMemo(() => buildChartMotion(reduced, forceStill), [reduced, forceStill]);
}

/** Longest entrance on the page, plus slack. One timer length for every panel. */
const SETTLE_MS = Math.max(...Object.values(DURATION)) + SETTLE_SLACK_MS;

/**
 * The presets, but ARMED only around a genuine data change.
 *
 * ---------------------------------------------------------------------------
 * The restart this exists to stop
 * ---------------------------------------------------------------------------
 * Recharts wraps each animated series in `<Animate key={"bar-" + animationId}>`,
 * and `animationId` is the chart's internal `updateId`. That counter is
 * incremented by `generateCategoricalChart` whenever the chart's **width or
 * height** changes, not only when its data does — so every `ResponsiveContainer`
 * measurement replays the entrance. A new `key` unmounts the running `<Animate>`
 * and mounts a fresh one at `t = 0`, and at `t = 0` a bar has zero height and
 * `Rectangle` renders `null` outright. Dragging a window edge therefore made ten
 * panels blink out and redraw themselves, which is the "restarts unexpectedly"
 * and "jumps" this page was reported for.
 *
 * There is no prop that turns that off: `updateId` is internal.
 *
 * ---------------------------------------------------------------------------
 * What this does instead
 * ---------------------------------------------------------------------------
 * Animation is a property of *having just received data*, not a standing state.
 * The presets are live for one entrance after `identity` changes, then go still.
 * Once still, Recharts takes its `renderRectanglesStatically` path and draws the
 * series at full size on every subsequent render — so a resize, a hover, a
 * tooltip or a parent re-render repaints instantly and cannot restart anything.
 *
 * The flip is invisible: it happens after the entrance has finished, and the
 * static render's geometry is the frame the animation had already reached.
 *
 * A later data change re-arms it, and because Recharts holds the previous series
 * as `prevData`, that second animation interpolates from the old values to the
 * new ones rather than from zero — a transition, not a redraw.
 *
 * @param identity The data this panel draws. Compared by reference, so it must
 *                 be the memoised array the chart is handed — a fresh literal
 *                 every render would re-arm on every render and defeat this.
 */
export function useSettledChartMotion(identity: unknown, forceStill = false): ChartMotionSet {
  const motion = useChartMotion(forceStill);
  const [armed, setArmed] = useState(true);

  useEffect(() => {
    // Re-arming on mount is a no-op: React bails out of a set to the same value.
    setArmed(true);
    const timer = setTimeout(() => setArmed(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [identity]);

  return armed ? motion : ALL_STILL;
}

/** Test seam — the settle window and the per-series budget. */
export const __motionTiming = { SETTLE_MS, SETTLE_SLACK_MS, DURATION };
