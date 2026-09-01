import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Knowing that every deferred chart has actually mounted, before the writer is
 * called.
 *
 * ---------------------------------------------------------------------------
 * What this replaces
 * ---------------------------------------------------------------------------
 * A chart panel does not render until it has been scrolled to — see
 * `useChartReveal`, and the Recharts lifecycle note there for why it mounts
 * nothing rather than mounting something still. `ChartPrintContext` releases
 * that gate for an export, but releasing it is a React state change: the panels
 * mount on the *next* commit, measure themselves on the one after that, and
 * `window.print()` is synchronous and takes whatever is in the DOM at the
 * instant it is called.
 *
 * `usePrintExport` used to bridge that with four animation frames — enough for
 * a panel that was already on screen to re-measure at the paper's width, and a
 * guess for everything else. On the Monthly Report the guess was not even
 * reached: that page never provided `ChartPrintContext` at all, so the two
 * ranked panels (Revenue by city, Top branches) were never released from the
 * viewport gate and printed as empty cards unless the manager had scrolled past
 * them first.
 *
 * ---------------------------------------------------------------------------
 * How this is deterministic
 * ---------------------------------------------------------------------------
 * Every deferred panel registers with the tracker **when it mounts**, not when
 * printing starts — the card is in the DOM the whole time; it is the chart
 * inside it that is deferred. So at the moment the export button is pressed the
 * tracker already knows exactly how many panels exist and which of them have
 * rendered a chart. `whenAllReady()` resolves when the last one reports in.
 *
 * That is a fact about the page rather than a duration: a report with nothing
 * deferred resolves immediately, and a report whose panels are all four screens
 * down waits exactly as long as they take.
 *
 * The timeout is not the mechanism. It exists so that a panel which can never
 * become ready — one whose data never arrives, a browser that never fires the
 * effect — cannot leave the export button spinning forever. Reaching it means
 * printing a page that may carry an empty card, which is what the old behaviour
 * did unconditionally.
 */

/**
 * How long `whenAllReady` will wait before printing anyway.
 *
 * Generous relative to what it is waiting for — a React commit and a
 * `ResizeObserver` callback, both of which are frames — and short enough that a
 * genuinely stuck panel does not hold a person in front of a disabled button.
 */
const READY_TIMEOUT_MS = 3000;

/** One deferred panel's registration. Opaque to the panel that holds it. */
export interface PrintReadyEntry {
  ready: boolean;
}

export interface PrintReadyTracker {
  register(ready: boolean): PrintReadyEntry;
  release(entry: PrintReadyEntry): void;
  setReady(entry: PrintReadyEntry, ready: boolean): void;
  /** Resolves once every registered panel has rendered, or on the timeout. */
  whenAllReady(timeoutMs?: number): Promise<void>;
}

export function createPrintReadyTracker(): PrintReadyTracker {
  const entries = new Set<PrintReadyEntry>();
  const waiters = new Set<() => void>();

  const allReady = (): boolean => {
    for (const entry of entries) if (!entry.ready) return false;
    return true;
  };

  const settle = (): void => {
    if (!allReady()) return;
    for (const wake of waiters) wake();
    waiters.clear();
  };

  return {
    register(ready) {
      const entry: PrintReadyEntry = { ready };
      entries.add(entry);
      return entry;
    },
    release(entry) {
      entries.delete(entry);
      // A panel leaving may be the last thing anyone was waiting on.
      settle();
    },
    setReady(entry, ready) {
      if (entry.ready === ready) return;
      entry.ready = ready;
      settle();
    },
    whenAllReady(timeoutMs = READY_TIMEOUT_MS) {
      if (allReady()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const wake = () => finish();
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(wake);
      });
    },
  };
}

/**
 * The tracker for this subtree, or null where nobody is exporting.
 *
 * Null is the ordinary case — a panel on a page with no export button costs
 * nothing and registers nothing.
 */
export const ChartPrintReadyContext = createContext<PrintReadyTracker | null>(null);

/**
 * Report this panel's render state to the export, for as long as it is mounted.
 *
 * Called by `useChartReveal`, so every deferred panel in the app participates
 * without its component having to know that an export exists.
 */
export function usePrintReadyGate(ready: boolean): void {
  const tracker = useContext(ChartPrintReadyContext);
  const entry = useRef<PrintReadyEntry | null>(null);
  /** The value to register *with*, without re-registering when it changes. */
  const latest = useRef(ready);
  latest.current = ready;

  useEffect(() => {
    if (!tracker) return;
    const registered = tracker.register(latest.current);
    entry.current = registered;
    return () => {
      entry.current = null;
      tracker.release(registered);
    };
  }, [tracker]);

  useEffect(() => {
    if (!tracker || !entry.current) return;
    tracker.setReady(entry.current, ready);
  }, [tracker, ready]);
}
