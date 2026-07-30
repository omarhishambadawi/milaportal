import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Return-to-top, for a directory that is now genuinely long.
 *
 * It exists because removing the map made the page taller, not shorter: the cards
 * reclaimed the full width, the grid grew columns, and a filtered-to-nothing
 * search still leaves an agent several screens down with no fast way back to the
 * search box. Ctrl+Home does it, and roughly nobody uses Ctrl+Home.
 *
 * Deliberately a plain button rather than anything cleverer. It is `fixed`, so it
 * is outside every layout in the page and cannot shift anything; it is
 * `aria-hidden` and untabbable while invisible, so it never becomes a focus stop
 * that lands on nothing; and it fades rather than pops, because an element
 * appearing abruptly in the corner of the eye reads as an alert.
 */

/**
 * How far down before the button appears.
 *
 * One viewport, expressed as a viewport rather than a constant — the point is
 * "you have scrolled past everything that was on screen when you arrived", which
 * is a different pixel count on a laptop and on a phone.
 */
function threshold(): number {
  return window.innerHeight * 0.9;
}

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Read straight through rather than through rAF: the handler is a comparison
    // and a possible state set, React drops the render when the boolean has not
    // changed, and a hidden document never delivers the animation frame a
    // throttled version would be waiting for.
    const onScroll = () => setVisible(window.scrollY > threshold());
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      title="Back to top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={cn(
        "fixed bottom-5 right-5 z-40 grid h-11 w-11 place-items-center rounded-full",
        "border border-primary/25 bg-card/95 text-primary shadow-lg backdrop-blur-sm",
        "transition-[opacity,transform] duration-200 ease-out",
        "hover:border-primary/40 hover:bg-primary/10 hover:shadow-xl",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        // Translated down as well as faded so it reads as arriving from off-screen
        // rather than materialising in place. `pointer-events-none` is what stops
        // the invisible button from swallowing clicks on the card underneath it.
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0",
      )}
    >
      <ArrowUp className="h-5 w-5" aria-hidden />
    </button>
  );
}
