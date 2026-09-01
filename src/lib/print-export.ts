import { useCallback, useRef, useState } from "react";
import {
  createPrintReadyTracker,
  type PrintReadyTracker,
} from "@/features/dashboard/chart-print-ready";

/**
 * "Print this page as a PDF", as one hook.
 *
 * ---------------------------------------------------------------------------
 * Why the wait
 * ---------------------------------------------------------------------------
 * `window.print()` is synchronous and hands the writer whatever is in the DOM at
 * that instant. Two things on these pages are not ready at that instant:
 *
 *   - **Panels that were never scrolled to.** A chart is deferred until it comes
 *     into view, so the export has to mount the rest of them first (see
 *     `ChartPrintContext`). That is a React commit, and then each container's
 *     own measure-and-re-render.
 *   - **Chart geometry.** `ResponsiveContainer` learns its size from a
 *     `ResizeObserver`, whose callback is delivered before the *next* frame's
 *     paint. Narrowing a page to `PRINT_WIDTH_PX` and printing in the same tick
 *     gives the writer an SVG still carrying the screen's dimensions, which the
 *     browser then squeezes into the sheet — halving every axis label with it.
 *
 * The first is now waited for rather than estimated. Every deferred panel
 * registers with `readyTracker` while it is mounted and says whether it has
 * rendered a chart, so `whenAllReady()` resolves on the fact itself — the last
 * panel reporting in — instead of on a frame count that happened to be long
 * enough on the machine it was written on. A page with nothing deferred
 * resolves immediately.
 *
 * The second stays frame-bounded, because it genuinely is: what is being waited
 * for is an observer callback and a paint, and four frames covers that chain at
 * a cost of about 60ms behind a print dialog nobody sees.
 *
 * `printing` stays true across the call so the dialog previews the same geometry
 * it will write, and is released in `finally` because `print()` throws on a
 * cancelled dialog in some browsers — and a page left pinned at 703px would be a
 * worse bug than the one this exists to fix.
 *
 * ---------------------------------------------------------------------------
 * Wiring
 * ---------------------------------------------------------------------------
 * A page that exports charts wraps its content in `ChartExportProvider`, handing
 * it this hook's `printing` and `readyTracker`:
 *
 *     <ChartExportProvider printing={printing} tracker={readyTracker}>
 *
 * That one wrapper provides both contexts — the one that releases the viewport
 * gate, and the one that lets this hook know the release has actually landed.
 * They live together because either alone is wrong, and the Monthly Report
 * printed two empty chart cards by having neither: its ranked panels stayed
 * gated and the frame wait was waiting for nothing.
 */

/** The remaining chain once every panel is mounted: observer → re-render → paint. */
const SETTLE_FRAMES = 4;

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") {
      resolve();
      return;
    }
    let left = count;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

export function usePrintExport(): {
  printing: boolean;
  print: () => Promise<void>;
  /** Hand to `ChartExportProvider` around the content being exported. */
  readyTracker: PrintReadyTracker;
} {
  const [printing, setPrinting] = useState(false);
  const tracker = useRef<PrintReadyTracker | null>(null);
  if (tracker.current === null) tracker.current = createPrintReadyTracker();
  const readyTracker = tracker.current;

  const print = useCallback(async () => {
    setPrinting(true);
    try {
      // Mount whatever the reader never scrolled to, and wait for it to say so.
      await readyTracker.whenAllReady();
      // Then the measure-and-paint chain those mounts have just started.
      await nextFrames(SETTLE_FRAMES);
      window.print();
    } finally {
      setPrinting(false);
    }
  }, [readyTracker]);

  return { printing, print, readyTracker };
}
