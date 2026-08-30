/**
 * The Dashboard's animation contract.
 *
 * These are the properties that make ten panels read as one movement rather than
 * ten independent ones, and every one of them was previously only checkable by
 * watching the page. The presets are a pure function of `reduced` and
 * `forceStill`, so the contract is assertable without a renderer.
 */
import { describe, it, expect } from "vitest";
import {
  buildChartMotion,
  isGenuineAnimationEnd,
  __motionTiming,
  type ChartMotion,
} from "../chart-motion";

const SERIES = ["line", "area", "bar", "pie"] as const;

const moving = buildChartMotion(false, false);

describe("buildChartMotion", () => {
  it("covers every series type the Dashboard draws", () => {
    // A missing preset is a panel that silently keeps a Recharts default —
    // which for a Pie is 1500ms behind a 400ms delay.
    expect(Object.keys(moving).sort()).toEqual([...SERIES].sort());
  });

  it("starts every series at the same instant", () => {
    // The bug this fixes: Recharts defaults `animationBegin` to 400 for Pie and
    // 0 for everything else, so a preset that set only the duration left the pie
    // starting four tenths of a second after the rest of the page.
    for (const key of SERIES) {
      expect(moving[key].animationBegin, `${key} must not be delayed`).toBe(0);
    }
  });

  it("keeps every duration inside the 1200-1600ms band", () => {
    // Each panel waits for the reader to scroll to it and the KPI figures do not
    // wait behind any of this, so the entrance is the first thing they look at
    // rather than something between them and the numbers. Below ~1200ms it was
    // over before the eye had finished travelling to the card — visible, but
    // quick rather than considered. Past ~1600ms it would stop being motion and
    // become a wait.
    for (const key of SERIES) {
      expect(moving[key].animationDuration, `${key} duration`).toBeGreaterThanOrEqual(1200);
      expect(moving[key].animationDuration, `${key} duration`).toBeLessThanOrEqual(1600);
    }
  });

  it("ranks the series types by how long each one takes to read", () => {
    // A line travels furthest; an area is a line with a fill following it; a pie
    // sweeps round rather than up; a stacked bar animates its segments in
    // sequence and would otherwise add up. Asserted as an ordering rather than
    // as four numbers so retuning the band cannot silently invert it.
    const { DURATION } = __motionTiming;
    expect(DURATION.line).toBeGreaterThan(DURATION.area);
    expect(DURATION.area).toBeGreaterThan(DURATION.pie);
    expect(DURATION.bar).toBeGreaterThan(DURATION.pie);
  });

  it("shares ONE easing curve, and one that decelerates into rest", () => {
    // A single curve across every panel is what makes ten charts read as one
    // system. It must also be asymmetric: react-smooth's own 'ease-out' is
    // cubic-bezier(0.42, 0, 0.58, 1) — the same easing at both ends, so it
    // arrives with speed still on it, which is what read as abrupt.
    const curve = moving.line.animationEasing;
    expect(curve).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
    for (const key of SERIES) {
      expect(moving[key].animationEasing, `${key} easing`).toBe(curve);
      expect(moving[key].isAnimationActive).toBe(true);
    }
  });

  it("spends most of the curve decelerating, and never overshoots", () => {
    // y2 = 1 pins the curve to its endpoint, so nothing overshoots or bounces;
    // x2 < 0.5 puts the bulk of the time in the tail rather than the attack.
    const [x1, y1, x2, y2] = (moving.bar.animationEasing as string)
      .replace(/cubic-bezier\(|\)/g, "")
      .split(",")
      .map((n) => Number(n));
    expect(y2).toBe(1);
    expect(x2).toBeLessThan(0.5);
    expect(y1).toBe(0);
    expect(x1).toBeGreaterThan(0);
    for (const n of [x1, y1, x2, y2]) expect(n).toBeGreaterThanOrEqual(0);
    for (const n of [x1, y1, x2, y2]) expect(n).toBeLessThanOrEqual(1);
  });

  it("goes completely still for prefers-reduced-motion", () => {
    const reduced = buildChartMotion(true, false);
    for (const key of SERIES) {
      expect(reduced[key]).toEqual<ChartMotion>({
        isAnimationActive: false,
        animationDuration: 0,
        animationEasing: moving[key].animationEasing,
        animationBegin: 0,
      });
    }
  });

  it("goes still when forced, whatever the OS says", () => {
    // The PDF export. A printed page is one instant and would capture whatever
    // frame the animation happened to be on — for a bar, no bar at all.
    for (const key of SERIES) {
      expect(buildChartMotion(false, true)[key].isAnimationActive).toBe(false);
      expect(buildChartMotion(true, true)[key].isAnimationActive).toBe(false);
    }
  });

  it("returns one shared still object, so a still page allocates nothing", () => {
    // Spreading a fresh object per render would hand Recharts new props every
    // time and defeat the memoisation upstream.
    expect(buildChartMotion(true, false)).toBe(buildChartMotion(false, true));
  });
});

describe("the disarm fallback", () => {
  /**
   * The disarm itself is `onAnimationEnd` — Recharts' own completion signal,
   * which cannot fire early. What is left to assert is that the timer behind it
   * is a fallback and not a second deadline.
   *
   * The bug this replaced: the disarm was `longest + 300ms` on a `setTimeout`,
   * which is a wall-clock guess about a `requestAnimationFrame` animation.
   * Instrumented on a real load, the revenue trend's last painted frame was
   * `stroke-dasharray: 39.2px / 568.4px` — the line 7% drawn — and the next
   * mutation was the static path replacing it. The timer had won the race.
   */
  it("is far enough clear of the animation that it cannot win the race", () => {
    const { LONGEST_MS, SETTLE_FALLBACK_MS, SETTLE_FALLBACK_FACTOR } = __motionTiming;
    expect(LONGEST_MS).toBe(Math.max(...Object.values(__motionTiming.DURATION)));
    // A multiple, not a margin: a fixed slack is a race on a slow enough device.
    expect(SETTLE_FALLBACK_FACTOR).toBeGreaterThanOrEqual(2);
    expect(SETTLE_FALLBACK_MS).toBeGreaterThanOrEqual(LONGEST_MS * 2);
  });

  it("still eventually disarms, so a resize cannot restart an old entrance", () => {
    // Unbounded arming would leave every panel one `ResponsiveContainer`
    // measurement away from replaying its entrance for the rest of the session.
    expect(__motionTiming.SETTLE_FALLBACK_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("isGenuineAnimationEnd", () => {
  /**
   * The line the whole scroll-triggered reveal rests on.
   *
   * `onAnimationEnd` is not only a completion signal: react-smooth calls it from
   * `Animate.componentWillUnmount` as well, and Recharts unmounts that
   * `<Animate>` on any width or height change, because it keys it by the chart's
   * `updateId`. So a single `ResponsiveContainer` measurement during an entrance
   * used to disarm the panel permanently — measured in headless Chrome, the
   * daily-trend area was 2% drawn when a resize landed and every sample after it
   * was the final frame.
   *
   * The only thing separating a real end from an unmount is how long the
   * entrance actually ran, so these assertions are about the clock.
   */
  const { END_TOLERANCE_MS, DURATION } = __motionTiming;

  it("believes an end that arrives after the series has had its full budget", () => {
    expect(isGenuineAnimationEnd(1000, 1000 + DURATION.line, DURATION.line)).toBe(true);
    expect(isGenuineAnimationEnd(1000, 1000 + DURATION.line + 500, DURATION.line)).toBe(true);
  });

  it("refuses an end from an <Animate> that unmounted mid-draw", () => {
    // The measured case: 400ms into a 1500ms area entrance.
    expect(isGenuineAnimationEnd(0, 400, DURATION.area)).toBe(false);
    // And the pathological one — a double-mount, ended in the same frame.
    expect(isGenuineAnimationEnd(0, 0, DURATION.area)).toBe(false);
  });

  it("refuses an end for an animation that never started", () => {
    // No `onAnimationStart` has been seen, so there is nothing for this to be
    // the end of. The panel stays armed and `SETTLE_FALLBACK_MS` covers the case
    // where a start never comes at all.
    expect(isGenuineAnimationEnd(null, 10_000, DURATION.bar)).toBe(false);
  });

  it("allows one frame of slack, and not a whole entrance of it", () => {
    // The timestamp is taken inside a callback rather than by the animation
    // manager, and a frame is 16.7ms at best. The tolerance is slack for that —
    // it must stay far smaller than the gap it is separating, which is the
    // entrance itself.
    expect(END_TOLERANCE_MS).toBeGreaterThan(0);
    expect(END_TOLERANCE_MS).toBeLessThan(Math.min(...Object.values(DURATION)) / 10);
    expect(isGenuineAnimationEnd(0, DURATION.bar - END_TOLERANCE_MS, DURATION.bar)).toBe(true);
    expect(isGenuineAnimationEnd(0, DURATION.bar - END_TOLERANCE_MS - 1, DURATION.bar)).toBe(false);
  });

  it("judges each series against its own budget, not the longest on the page", () => {
    // A pie finishing at 1200ms is finished; a line at 1200ms is 400ms short of
    // it. Sharing one deadline would settle the trend panel mid-draw, which is
    // the bug this file already carries a fallback test for.
    const t = 1200;
    expect(isGenuineAnimationEnd(0, t, DURATION.pie)).toBe(true);
    expect(isGenuineAnimationEnd(0, t, DURATION.line)).toBe(false);
  });
});
