import { useEffect, useRef } from "react";

// Module-scoped so the position survives SPA navigation into an order and back,
// and is wiped on a full page refresh (module reload) — the same lifecycle as
// the filter cache in use-orders-list-filters.ts.
let savedScrollY = 0;

/**
 * Restores the Orders list scroll position when the user returns from viewing or
 * editing an order.
 *
 * The document/window is the scroll container (the app header is sticky, the
 * page itself scrolls). While the list is mounted we continuously record
 * `window.scrollY`; on a later mount we restore it once the list has rows to
 * scroll to. The router opens orders via a programmatic push (not browser Back),
 * so its built-in scroll restoration doesn't cover this flow — hence the manual
 * save/restore, scoped entirely to the Orders list.
 *
 * @param ready flip true once the first page of rows is available (so the page
 *   has enough height to scroll to the saved offset).
 */
export function useOrdersScrollRestoration(ready: boolean) {
  const restored = useRef(false);

  // Continuously remember where the user is while they browse the list.
  useEffect(() => {
    const onScroll = () => { savedScrollY = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Restore exactly once per mount, after content has painted its full height.
  useEffect(() => {
    if (restored.current || !ready || savedScrollY <= 0) return;
    restored.current = true;
    const y = savedScrollY;
    // Two frames: let the router's scroll-to-top for the new location run and
    // let the list paint its rows first, then restore the remembered offset.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => window.scrollTo(0, y));
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [ready]);
}
