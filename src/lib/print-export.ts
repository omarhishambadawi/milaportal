import { useCallback, useState } from "react";

/**
 * "Print this page as a PDF", as one hook.
 *
 * ---------------------------------------------------------------------------
 * Why the wait
 * ---------------------------------------------------------------------------
 * `window.print()` is synchronous and hands the writer whatever is in the DOM at
 * that instant. Two things on these pages are not ready at that instant:
 *
 *   - **Chart geometry.** `ResponsiveContainer` learns its size from a
 *     `ResizeObserver`, whose callback is delivered before the *next* frame's
 *     paint. Narrowing a page to `PRINT_WIDTH_PX` and printing in the same tick
 *     gives the writer an SVG still carrying the screen's dimensions, which the
 *     browser then squeezes into the sheet — halving every axis label with it.
 *   - **Panels that were never scrolled to.** The Dashboard defers a chart until
 *     it comes into view, so the export has to mount the rest of them first (see
 *     `ChartPrintContext`). That is a React commit, then each container's own
 *     measure-and-re-render.
 *
 * Both are frame-bounded rather than time-bounded, so this waits frames rather
 * than guessing at milliseconds. Four covers the deepest chain there is —
 * commit, observer, chart re-render, paint — and costs about 60ms on a 60Hz
 * display, which nobody notices behind a print dialog.
 *
 * `printing` stays true across the call so the dialog previews the same geometry
 * it will write, and is released in `finally` because `print()` throws on a
 * cancelled dialog in some browsers — and a page left pinned at 703px would be a
 * worse bug than the one this exists to fix.
 */

/** The deepest ready-chain on these pages: commit → observer → re-render → paint. */
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

export function usePrintExport(): { printing: boolean; print: () => Promise<void> } {
  const [printing, setPrinting] = useState(false);

  const print = useCallback(async () => {
    setPrinting(true);
    try {
      await nextFrames(SETTLE_FRAMES);
      window.print();
    } finally {
      setPrinting(false);
    }
  }, []);

  return { printing, print };
}
