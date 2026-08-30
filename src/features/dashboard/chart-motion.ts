import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

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

/**
 * The one easing curve every Dashboard series shares.
 *
 * `cubic-bezier(0.4, 0, 0.2, 1)` — eases gently out of rest, reaches speed
 * early, then spends most of its time decelerating into the final value. That
 * long tail is what reads as "settling" rather than "stopping", and the soft
 * start is what stops a longer duration feeling like a lurch.
 *
 * Not one of react-smooth's named curves, deliberately. Its `'ease-out'` is
 * `cubic-bezier(0.42, 0, 0.58, 1)` — symmetric, and the same amount of easing at
 * both ends, so it decelerates no harder than it accelerates and arrives with
 * speed still on it. That is the abruptness; the fix is the curve, not only the
 * duration.
 *
 * Named curves and `cubic-bezier(...)` strings take the same path through
 * react-smooth's `configEasing` (a bezier string is matched explicitly, ahead of
 * the warning branch), so this costs nothing and logs nothing.
 */
const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

/**
 * Recharts types `animationEasing` as its five named curves, but react-smooth —
 * which is what actually consumes the value — accepts a bezier string too. The
 * cast is confined to this one line so no call site has to know.
 */
const CHART_EASING = EASING as unknown as ChartMotion["animationEasing"];

/** Recharts animation props, ready to spread onto a series. */
export interface ChartMotion {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: "ease" | "ease-in" | "ease-out" | "ease-in-out" | "linear";
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
 * The whole set was previously 550-700ms, which is the right budget for motion
 * that fires on page load and must not delay reading. Once each panel waits for
 * the reader to scroll to it, that constraint is gone: the entrance is the first
 * thing they look at rather than something between them and the numbers, and at
 * half a second it was over before the eye had settled on the card.
 *
 * So the band moves to 900-1200ms. The ordering is unchanged and for the same
 * reasons: a line travels furthest and carries the slowest read; a pie sweeps
 * round rather than up, which reads slower than it measures; a stacked bar is
 * shortest because its segments animate in sequence and would otherwise add up.
 */
const DURATION = { line: 1200, area: 1100, bar: 950, pie: 1000 } as const;

/**
 * How long after the entrance to keep animation armed before settling.
 *
 * Scales with the animation rather than staying at the old flat 200ms: the flip
 * to static must land after the slowest series has finished, or it would snap a
 * still-drawing chart to its final size — the exact glitch the settle exists to
 * prevent.
 */
const SETTLE_SLACK_MS = 300;

const STILL: ChartMotion = {
  isAnimationActive: false,
  animationDuration: 0,
  animationEasing: CHART_EASING,
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
    animationEasing: CHART_EASING,
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
 * @param gate     Whether the panel may animate at all yet. False holds every
 *                 preset still without starting the settle timer, so a panel
 *                 that is not on screen keeps its entrance for when it is.
 */
export function useSettledChartMotion(
  identity: unknown,
  forceStill = false,
  gate = true,
): ChartMotionSet {
  const motion = useChartMotion(forceStill);
  const [armed, setArmed] = useState(true);

  useEffect(() => {
    if (!gate) return;
    // Re-arming on mount is a no-op: React bails out of a set to the same value.
    setArmed(true);
    const timer = setTimeout(() => setArmed(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [identity, gate]);

  return gate && armed ? motion : ALL_STILL;
}

/**
 * Has this element been on screen yet?
 *
 * ---------------------------------------------------------------------------
 * Why the charts needed this
 * ---------------------------------------------------------------------------
 * Every panel animated on MOUNT, and the Dashboard is about four screens tall.
 * So eight of the ten entrances played against a viewport nobody was looking at,
 * finished long before the reader scrolled down, and the panels they belonged to
 * were simply *there* when reached — which is why only the top two charts ever
 * appeared to animate. The motion was not broken; it was spent off-screen.
 *
 * It also meant ten simultaneous Recharts animations on first paint, at exactly
 * the moment the route is still resolving its queries and its lazy chunk.
 *
 * ---------------------------------------------------------------------------
 * Once, and only once
 * ---------------------------------------------------------------------------
 * The observer disconnects on the first intersection, so scrolling back up
 * cannot replay anything and there is no per-element listener left running for
 * the rest of the session. One observer per panel, no scroll handler anywhere,
 * and no state written while scrolling past an element that has already fired.
 *
 * `rootMargin` starts the entrance slightly before the panel's top edge appears,
 * so the motion is already underway as it comes into view rather than beginning
 * after it has arrived. The threshold is deliberately 0: a tall panel scrolled
 * into view one row at a time should start when its first pixels land, not wait
 * for a fraction of a chart that may be taller than the viewport.
 *
 * Returns true immediately where `IntersectionObserver` is unavailable — a
 * chart that cannot be observed must animate, never stay frozen.
 */
export function useInViewOnce(
  target: RefObject<HTMLElement | null>,
  /**
   * Count the panel as seen without waiting for the viewport.
   *
   * For the PDF export: a printed sheet has no scroll, so a panel that is four
   * screens down has never intersected anything and would print as an empty
   * card. Forcing it renders every panel for the writer.
   */
  force = false,
): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    if (force) {
      setSeen(true);
      return;
    }
    const el = target.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      // Expanded downwards rather than inset. The panel is not mounted until
      // this fires (see `useChartReveal`), so triggering *after* its top edge
      // had arrived meant the reader watched an empty card for a beat before
      // anything appeared. A little under a tenth of a viewport ahead is enough
      // for the entrance to already be underway as the card comes into view.
      { rootMargin: "0px 0px 8% 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, seen, force]);

  return seen;
}

/**
 * Whether charts inside this subtree are being laid out for the PDF writer.
 *
 * Read by every panel, provided once by the Dashboard route around its content.
 * Two things follow from it and they are only correct together: the panel is
 * rendered whether or not it has been scrolled to, and it is rendered still.
 */
export const ChartPrintContext = createContext(false);

/** True while this subtree is being laid out for print. */
export function useChartPrintMode(): boolean {
  return useContext(ChartPrintContext);
}

/**
 * The whole lifecycle for one panel: absent until seen, one entrance, then stable.
 *
 * ---------------------------------------------------------------------------
 * Why `ready` exists — the entrance that played twice
 * ---------------------------------------------------------------------------
 * This used to return presets only, and the panel rendered its chart from the
 * first frame with `isAnimationActive: false` until the observer fired. That is
 * a Recharts trap, and it is the "Monthly revenue trend jumps" report:
 *
 *   - `Line.componentDidMount` returns early when `isAnimationActive` is false,
 *     so `state.totalLength` — the path length its draw-on animation
 *     interpolates towards — is never measured and stays 0.
 *   - With the flag off, `renderCurve` takes `renderCurveStatically`, so the
 *     line is painted complete.
 *   - When the flag flips true, `renderCurve` switches to the animated path with
 *     `prevPoints` still undefined, so react-smooth runs `t: 0 → 1` from the
 *     start and `strokeDasharray` is computed against `totalLength = 0`.
 *     `componentDidUpdate` then measures the real length a frame later and the
 *     fully-drawn line **collapses to a stub and redraws itself**.
 *
 * `Bar` and `Area` fail the same way for the same reason — their animated paths
 * interpolate from zero height and zero clip width when there is no `prevData`
 * — so a bar panel blinked out and grew back.
 *
 * The fix is not to slow the animation or to hide it: it is to stop rendering a
 * finished chart that we intend to animate. Nothing mounts until the panel is
 * seen, and what mounts then has animation active from its very first frame —
 * which is the one arrangement Recharts' lifecycle is built for, and the
 * measurement happens in `componentDidMount` before the browser paints.
 *
 * @returns `ready` — mount the chart — and the presets to spread onto its series.
 */
export function useChartReveal(
  identity: unknown,
  target: RefObject<HTMLElement | null>,
  /** Force stillness for this panel alone; the print context does it for all. */
  forceStill = false,
): { ready: boolean; motion: ChartMotionSet } {
  const printing = useChartPrintMode();
  const still = forceStill || printing;
  const seen = useInViewOnce(target, printing);
  const motion = useSettledChartMotion(identity, still, seen);
  return { ready: seen, motion };
}

/** Test seam — the settle window and the per-series budget. */
export const __motionTiming = { SETTLE_MS, SETTLE_SLACK_MS, DURATION };
