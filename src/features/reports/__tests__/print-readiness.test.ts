/**
 * The Monthly Report's PDF must carry every chart, scrolled to or not.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * Open the Monthly Report, press **Export PDF** without scrolling, and the sheet
 * came out with a *Revenue by city* card and a *Top branches* card containing
 * nothing. Those two are the only charts on the report that defer their mount
 * until they come into view (`HorizontalBarPanel` → `useChartReveal`), and the
 * report route never provided `ChartPrintContext` — so the release that the
 * Dashboard's own export performs never happened here, and the export's frame
 * wait was waiting for a mount that was never going to occur.
 *
 * Two things had to be true, and this file asserts both:
 *
 *   1. the report releases the viewport gate for an export, and
 *   2. the export waits for the panels it has just released, on the fact of
 *      their rendering rather than on a frame count that happened to be long
 *      enough on the machine it was written on.
 *
 * The components cannot be rendered here — these tests run in Node, with no DOM
 * — so the readiness protocol is exercised directly and the wiring is asserted
 * against the source. That is the same split the SQL tests in this repository
 * use, and it covers exactly the two things that were wrong.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPrintReadyTracker } from "@/features/dashboard/chart-print-ready";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
}

describe("the export waits for the charts it mounts", () => {
  it("resolves immediately when nothing is deferred", async () => {
    const tracker = createPrintReadyTracker();
    let settled = false;
    await tracker.whenAllReady(50).then(() => (settled = true));
    expect(settled).toBe(true);
  });

  it("resolves immediately when every registered panel has already rendered", async () => {
    const tracker = createPrintReadyTracker();
    tracker.register(true);
    tracker.register(true);
    await expect(tracker.whenAllReady(50)).resolves.toBeUndefined();
  });

  /**
   * The scenario in the report: two panels on screen, two never scrolled to.
   *
   * The wait ends when the last of them says it has rendered — not on a timer,
   * and not before.
   */
  it("waits for a panel that has not rendered, and resolves when it does", async () => {
    const tracker = createPrintReadyTracker();
    tracker.register(true);
    const city = tracker.register(false);
    const branches = tracker.register(false);

    let settled = false;
    const wait = tracker.whenAllReady(1000).then(() => (settled = true));

    tracker.setReady(city, true);
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.setReady(branches, true);
    await wait;
    expect(settled).toBe(true);
  });

  /**
   * A panel that unmounts mid-export stops being something to wait for.
   *
   * Otherwise a tab switch during the export would hold the print dialog behind
   * a panel that no longer exists.
   */
  it("stops waiting on a panel that leaves", async () => {
    const tracker = createPrintReadyTracker();
    const leaving = tracker.register(false);
    const wait = tracker.whenAllReady(1000);
    tracker.release(leaving);
    await expect(wait).resolves.toBeUndefined();
  });

  /**
   * The timeout is a floor under the failure, not the mechanism.
   *
   * A panel that can never render — no data, an effect that never runs — must
   * not leave a person in front of a disabled Export button. Reaching it prints
   * a page that may carry an empty card, which is what the old behaviour did
   * unconditionally.
   */
  it("gives up rather than hanging when a panel never renders", async () => {
    const tracker = createPrintReadyTracker();
    tracker.register(false);
    await expect(tracker.whenAllReady(20)).resolves.toBeUndefined();
  });

  it("does not wake early on a panel reporting the state it already had", async () => {
    const tracker = createPrintReadyTracker();
    const stuck = tracker.register(false);
    let settled = false;
    const wait = tracker.whenAllReady(200).then(() => (settled = true));
    tracker.setReady(stuck, false);
    await Promise.resolve();
    expect(settled).toBe(false);
    tracker.setReady(stuck, true);
    await wait;
    expect(settled).toBe(true);
  });
});

describe("both report pages are wired for the export", () => {
  const reports = source("routes/_app.reports.tsx");
  const dashboard = source("routes/_app.dashboard.tsx");

  /**
   * The wrapper that was missing from this page, and the whole of the reported
   * bug: without it a deferred panel is never told to render for the sheet, and
   * the two ranked charts printed empty.
   */
  it("the Monthly Report wraps its report in the export provider", () => {
    expect(reports).toContain("<ChartExportProvider printing={printing} tracker={readyTracker}>");
  });

  it("the Dashboard goes through the same wrapper", () => {
    expect(dashboard).toContain("<ChartExportProvider printing={printing} tracker={readyTracker}>");
  });

  /**
   * Both contexts, or neither.
   *
   * Released panels that nothing waits for, and a wait for panels nothing
   * released, are both wrong in their own way — so the two providers live
   * together in one component and no page can half-do it.
   */
  it("the wrapper provides both contexts", () => {
    const wrapper = source("features/dashboard/chart-export.tsx");
    expect(wrapper).toContain("<ChartPrintContext.Provider value={printing}>");
    expect(wrapper).toContain("<ChartPrintReadyContext.Provider value={tracker}>");
  });

  /**
   * Lazy rendering on screen is untouched.
   *
   * The panel is still absent until it is seen; the export releases it, and
   * `printing` is false for every ordinary page view. If this stops being true
   * the fix has been paid for with the performance the deferral exists to buy.
   */
  it("keeps the on-screen deferral, released only for printing", () => {
    const motion = source("features/dashboard/chart-motion.ts");
    expect(motion).toContain("const seen = useInViewOnce(target, printing);");
    expect(motion).toContain("return { ready: seen, motion };");
    // Reported from the reveal itself, so every deferred panel participates.
    expect(motion).toContain("usePrintReadyGate(seen);");
  });

  it("prints only after the panels have reported, then after the paint chain", () => {
    const print = source("lib/print-export.ts");
    const order = [
      "await readyTracker.whenAllReady();",
      "await nextFrames(SETTLE_FRAMES);",
      "window.print();",
    ];
    let at = -1;
    for (const step of order) {
      const next = print.indexOf(step);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });
});
