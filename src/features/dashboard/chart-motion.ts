import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  /**
   * Recharts' own "this series has finished" signal, when one is being listened
   * for.
   *
   * Absent from the still presets, and from `buildChartMotion`, which stays a
   * pure function of two booleans. `useSettledChartMotion` adds it — see the
   * long note there for why a timer could not do this job.
   *
   * It is **not** only a completion signal, which is the trap that cost this
   * page its animations; see `isGenuineAnimationEnd`.
   */
  onAnimationEnd?: () => void;
  /**
   * Recharts' "this series has begun" signal, paired with the one above.
   *
   * Only there to timestamp the entrance, so the end signal can be told apart
   * from the identical call react-smooth makes when an `<Animate>` unmounts.
   */
  onAnimationStart?: () => void;
}

/**
 * Per-series-type durations.
 *
 * The set has been raised twice. It began at 550-700ms, which is the right
 * budget for motion that fires on page load and must not delay reading; once
 * each panel waited for the reader to scroll to it that constraint was gone, and
 * it moved to 900-1200ms. At that band the entrances were *visible* but they
 * were over before the eye had finished travelling to the card — technically
 * animated, and read as quick rather than as considered.
 *
 * 1200-1600ms is where a chart drawing itself stops being an effect and becomes
 * the panel arriving. It is affordable because nothing here plays until its
 * panel is on screen and the numbers on this page — the KPI band — do not wait
 * behind any of it (`.dash-enter-instant`).
 *
 * The ordering is unchanged and for the same reasons: a line travels furthest
 * and carries the slowest read; an area is a line with a fill following it; a
 * pie sweeps round rather than up, which reads slower than it measures; a
 * stacked bar is shortest because its segments animate in sequence and would
 * otherwise add up.
 */
const DURATION = { line: 1600, area: 1500, bar: 1300, pie: 1200 } as const;

/**
 * The fallback disarm, as a multiple of the longest entrance.
 *
 * Not a deadline. The real disarm is `onAnimationEnd` — see
 * `useSettledChartMotion`. This exists only for the case where that signal never
 * arrives at all (a panel whose series render nothing, a tab hidden for the
 * whole life of the entrance), where staying armed forever would let a resize
 * restart an animation days later.
 *
 * Generous on purpose. Anything close to the animation's own length is a race
 * against it, and losing that race is precisely the bug this replaced.
 */
const SETTLE_FALLBACK_FACTOR = 3;
const SETTLE_FALLBACK_FLOOR_MS = 1500;

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

/**
 * How early a completion signal may still be believed, in milliseconds.
 *
 * Nominally zero would do: react-smooth runs `onAnimationStart`, then waits
 * `begin`, then the animation, then `duration`, then `onAnimationEnd`, so a
 * genuine end is never early. This is slack for the clock itself — a timestamp
 * taken inside a callback rather than by the animation manager, and a frame
 * budget that is 16.7ms at best.
 *
 * Small on purpose. It only has to be smaller than the gap this is separating,
 * and that gap is the whole entrance: an unmount is typically hundreds of
 * milliseconds early, never one frame.
 */
const END_TOLERANCE_MS = 32;

/** `performance.now()` where there is one; monotonic matters more than the epoch. */
const clock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * Did this `onAnimationEnd` come from an animation that actually ran?
 *
 * The signal is ambiguous — react-smooth fires it both when a tween completes
 * and from `Animate.componentWillUnmount` — and the difference between the two
 * is only ever visible in the timing. See `useSettledChartMotion` for what an
 * unmount mid-entrance did to this page.
 *
 * Pure, and exported, because it is the load-bearing line of the whole reveal:
 * get it wrong in the permissive direction and every panel snaps to its final
 * frame on the first resize; get it wrong in the strict direction and panels
 * stay armed and replay their entrance on a later one.
 *
 * @param startedAt When the entrance began, or null if none has started — in
 *                  which case there is no animation for this to be the end of.
 * @param now       The reading to compare against, on the same clock.
 * @param duration  The budget the series was given.
 */
export function isGenuineAnimationEnd(
  startedAt: number | null,
  now: number,
  duration: number,
): boolean {
  if (startedAt === null) return false;
  return now - startedAt >= duration - END_TOLERANCE_MS;
}

/** Longest entrance on the page. */
const LONGEST_MS = Math.max(...Object.values(DURATION));

/** The fallback disarm window. See `SETTLE_FALLBACK_FACTOR`. */
const SETTLE_FALLBACK_MS = LONGEST_MS * SETTLE_FALLBACK_FACTOR + SETTLE_FALLBACK_FLOOR_MS;

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
 * ---------------------------------------------------------------------------
 * Why the flip is `onAnimationEnd` and not a timer
 * ---------------------------------------------------------------------------
 * It used to be `setTimeout(disarm, longestDuration + 300)`, and that is a
 * wall-clock guess about an animation that does not run on wall-clock time.
 * react-smooth steps the tween on `requestAnimationFrame`; the timer does not
 * care. Whenever the two disagree — a busy main thread, a slow machine, exactly
 * the first seconds of this route while it mounts ten charts, resolves eleven
 * queries and pulls two lazy chunks — the timer wins and the series is switched
 * to its static render **mid-draw**.
 *
 * Instrumented on a real load, with a `MutationObserver` over the revenue
 * trend's `<path>`: the last `stroke-dasharray` written was
 * `39.2px / 568.4px` — the line **7% drawn** — and the next mutation was the
 * static path replacing it. That is the jump. It is not a Recharts bug and it
 * was not visible at 950-1200ms on an idle machine, which is why it survived the
 * first fix; raising the durations to 1200-1600ms would have made it routine.
 *
 * So the disarm is Recharts' own completion signal, spread onto every series
 * with the rest of the preset. `SETTLE_FALLBACK_MS` remains only for the case
 * where that signal never comes at all.
 *
 * ---------------------------------------------------------------------------
 * Why the completion signal is not, on its own, enough
 * ---------------------------------------------------------------------------
 * `onAnimationEnd` does not mean "this animation finished". react-smooth also
 * calls it from `Animate.componentWillUnmount`, unconditionally, and the
 * callback cannot tell the two apart:
 *
 *     componentWillUnmount() {
 *       ...
 *       if (onAnimationEnd) { onAnimationEnd(); }
 *     }
 *
 * And an `<Animate>` here unmounts *routinely*. Recharts keys it
 * `key={"bar-" + animationId}`, `animationId` is the chart's `updateId`, and
 * `getDerivedStateFromProps` increments `updateId` on any **width or height**
 * change. So a single `ResponsiveContainer` measurement during an entrance — a
 * window resize, a scrollbar arriving, React 19's StrictMode double-mount in
 * development — unmounted the running `<Animate>`, which called
 * `onAnimationEnd`, which disarmed the panel **permanently**. The replacement
 * series mounted still, and the chart was simply *there*.
 *
 * Measured in headless Chrome against these components: the daily-trend area's
 * clip was 11px wide of an eventual 606px — the panel **2% drawn** — when a
 * resize landed at t≈400ms. The next sample was 606px, and so was every sample
 * for the following two seconds. It is the same snap the timer used to cause,
 * reached from a different direction, and it is why the page read as having no
 * chart animation at all.
 *
 * ---------------------------------------------------------------------------
 * Telling a real end from an unmount
 * ---------------------------------------------------------------------------
 * By how long the entrance actually ran. react-smooth drives its sequence as
 * `[onAnimationStart, begin, start, duration, onAnimationEnd]`, so a *genuine*
 * end cannot arrive before `duration` has elapsed since the start it belongs
 * to — it can only ever be late. An unmount call arrives whenever the unmount
 * happens, which is almost always much earlier.
 *
 * So the entrance is timestamped from Recharts' `onAnimationStart`, and an end
 * that arrives too early to be one is ignored (`isGenuineAnimationEnd`). The
 * panel stays armed, the remounted `<Animate>` starts again from zero, and
 * *that* entrance is the one allowed to settle it.
 *
 * Note which direction the clock is used in, because it is the opposite of the
 * bug above. It can only ever *refuse* to settle; it can never settle anything
 * by itself. Nothing here can switch a series to its static render before
 * Recharts has said the series finished — which is exactly the property
 * `setTimeout(longest + 300)` did not have.
 *
 * @param identity The data this panel draws. Compared by reference, so it must
 *                 be the memoised array the chart is handed — a fresh literal
 *                 every render would re-arm on every render and defeat this.
 * @param gate     Whether the panel may animate at all yet. False holds every
 *                 preset still without arming anything, so a panel that is not
 *                 on screen keeps its entrance for when it is.
 */
export function useSettledChartMotion(
  identity: unknown,
  forceStill = false,
  gate = true,
): ChartMotionSet {
  const motion = useChartMotion(forceStill);
  const [armed, setArmed] = useState(true);

  /** When the entrance now on screen began. Null until one has started. */
  const startedAt = useRef<number | null>(null);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = useCallback(() => {
    if (fallback.current !== null) {
      clearTimeout(fallback.current);
      fallback.current = null;
    }
  }, []);

  const armFallback = useCallback(() => {
    clearFallback();
    fallback.current = setTimeout(() => setArmed(false), SETTLE_FALLBACK_MS);
  }, [clearFallback]);

  /*
   * Both stable, so attaching them to the presets below cannot hand Recharts a
   * new prop object on every render — which would be a new `<Animate>`, and a
   * restart.
   */
  const handleStart = useCallback(() => {
    startedAt.current = clock();
    // A restart is a new entrance, so the backstop restarts with it. Without
    // this, a series that remounted late could be disarmed mid-draw by a window
    // opened against an entrance that is no longer the one running.
    armFallback();
  }, [armFallback]);

  const handleEnd = useCallback(
    (duration: number) => {
      if (!isGenuineAnimationEnd(startedAt.current, clock(), duration)) return;
      clearFallback();
      setArmed(false);
    },
    [clearFallback],
  );

  useEffect(() => {
    if (!gate) return;
    // Re-arming on mount is a no-op: React bails out of a set to the same value.
    startedAt.current = null;
    setArmed(true);
    armFallback();
    return clearFallback;
  }, [identity, gate, armFallback, clearFallback]);

  /**
   * The moving presets with both lifecycle signals attached.
   *
   * Built here rather than in `buildChartMotion` so that function stays a pure
   * function of two booleans and its contract stays assertable without a
   * renderer. Memoised on what it depends on, for the reason above.
   */
  const listening = useMemo(() => {
    const listen = (preset: ChartMotion): ChartMotion => ({
      ...preset,
      onAnimationStart: handleStart,
      // The duration is closed over per series type, so a bar's end is judged
      // against a bar's budget rather than against the longest on the page.
      onAnimationEnd: () => handleEnd(preset.animationDuration),
    });
    return {
      line: listen(motion.line),
      area: listen(motion.area),
      bar: listen(motion.bar),
      pie: listen(motion.pie),
    };
  }, [motion, handleStart, handleEnd]);

  return gate && armed ? listening : ALL_STILL;
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

/** Test seam — the fallback window and the per-series budget. */
export const __motionTiming = {
  SETTLE_FALLBACK_MS,
  SETTLE_FALLBACK_FACTOR,
  SETTLE_FALLBACK_FLOOR_MS,
  LONGEST_MS,
  DURATION,
  END_TOLERANCE_MS,
};
