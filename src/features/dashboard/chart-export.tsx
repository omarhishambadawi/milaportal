import { ChartPrintContext } from "./chart-motion";
import { ChartPrintReadyContext, type PrintReadyTracker } from "./chart-print-ready";

/**
 * Everything a page's charts need to know about an export in progress, as one
 * wrapper.
 *
 * The two contexts are only correct together, and that is the whole reason this
 * component exists rather than two providers at each call site:
 *
 *   * `ChartPrintContext` releases the viewport gate, so a panel that was never
 *     scrolled to renders (and renders still) for the sheet.
 *   * `ChartPrintReadyContext` is how those panels tell the export they have
 *     done it, so `print()` waits for the fact rather than for a frame count.
 *
 * The Monthly Report provided **neither**, which is why *Revenue by city* and
 * *Top branches* — its only two deferred panels — printed as empty cards for
 * anyone who pressed Export PDF without scrolling. A page that remembers one
 * provider and forgets the other lands somewhere just as wrong: released panels
 * nothing waits for, or a wait for panels nothing released. One wrapper takes
 * both from `usePrintExport` and there is nothing left to half-do.
 */
export function ChartExportProvider({
  printing,
  tracker,
  children,
}: {
  /** True for the duration of the export. False on every ordinary page view. */
  printing: boolean;
  /** `readyTracker` from `usePrintExport`, on the same page as `printing`. */
  tracker: PrintReadyTracker;
  children: React.ReactNode;
}) {
  return (
    <ChartPrintContext.Provider value={printing}>
      <ChartPrintReadyContext.Provider value={tracker}>{children}</ChartPrintReadyContext.Provider>
    </ChartPrintContext.Provider>
  );
}
