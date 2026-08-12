/**
 * The Dashboard's animation contract.
 *
 * These are the properties that make ten panels read as one movement rather than
 * ten independent ones, and every one of them was previously only checkable by
 * watching the page. The presets are a pure function of `reduced` and
 * `forceStill`, so the contract is assertable without a renderer.
 */
import { describe, it, expect } from "vitest";
import { buildChartMotion, __motionTiming, type ChartMotion } from "../chart-motion";

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

  it("keeps every duration inside the 900-1200ms band", () => {
    // Each panel now waits for the reader to scroll to it, so the entrance is
    // the first thing they look at rather than something between them and the
    // numbers. Below ~900ms it was over before the eye had settled; past
    // ~1200ms it would stop being motion and become a wait.
    for (const key of SERIES) {
      expect(moving[key].animationDuration, `${key} duration`).toBeGreaterThanOrEqual(900);
      expect(moving[key].animationDuration, `${key} duration`).toBeLessThanOrEqual(1200);
    }
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

describe("settle window", () => {
  it("outlasts the longest entrance, so nothing is cut short", () => {
    // `useSettledChartMotion` disarms on one timer for every panel. If that
    // timer were shorter than the slowest series, the flip to static would snap
    // a half-drawn chart to its final size — the exact glitch it exists to stop.
    const longest = Math.max(...Object.values(__motionTiming.DURATION));
    expect(__motionTiming.SETTLE_MS).toBeGreaterThan(longest);
    expect(__motionTiming.SETTLE_MS - longest).toBe(__motionTiming.SETTLE_SLACK_MS);
  });

  it("still settles promptly — the arm window is not a second animation budget", () => {
    expect(__motionTiming.SETTLE_MS).toBeLessThanOrEqual(1800);
  });
});
