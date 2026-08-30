import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One step of the Dashboard's entrance.
 *
 * The page reveals itself in a fixed order — header, then the KPI cards, then
 * the analytics sections — rather than every card appearing at once. That order
 * is the page's own hierarchy stated in time: what a reader is meant to look at
 * first is what settles first.
 *
 * The stagger is small and it stops early. Everything below the first screen is
 * being revealed to nobody, so a delay ladder that runs the full length of the
 * page only makes the last sections late; `DASH_DELAY` tops out well inside the
 * first viewport and the panels further down animate as they are scrolled to
 * instead (see `InViewChart`).
 *
 * A plain wrapper `div`, so it can replace a section's existing wrapper rather
 * than adding a box to the layout. The animation is `opacity` and `transform`
 * only — see `.dash-enter` in `styles.css` — so nothing shifts while it runs,
 * and `prefers-reduced-motion` and print both drop it to a plain element.
 */
export function Reveal({
  delay = 0,
  instant = false,
  className,
  children,
}: {
  /** Milliseconds after the page's own entrance. See `DASH_DELAY`. */
  delay?: number;
  /**
   * Reach full opacity almost immediately, and ignore the delay.
   *
   * For the KPI band, and only for it. Those three cards are the reason the page
   * was opened, and the standard entrance put 70ms of delay and 560ms of fade in
   * front of them — so on a connection where the `orders_kpis` round trip landed
   * quickly, the numbers were ready and the animation was still the thing
   * standing between the reader and them. That reads as a slow dashboard, and it
   * is not: it is a fast dashboard behind a decoration.
   *
   * The rise is kept, so the band still settles with the rest of the page rather
   * than snapping into a page that is fading. Only the opacity ramp is pulled
   * forward. See `.dash-enter-instant` in `styles.css`.
   */
  instant?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(instant ? "dash-enter-instant" : "dash-enter", className)}
      style={instant ? undefined : ({ "--dash-delay": `${delay}ms` } as CSSProperties)}
    >
      {children}
    </div>
  );
}

/**
 * The ladder, named rather than spelled as numbers at eight call sites.
 *
 * Roughly one step per 70ms against a 560ms entrance: fast enough that the page
 * does not feel withheld, slow enough that the steps are distinguishable as an
 * order rather than reading as one movement with jitter in it. The ladder is
 * about a third of the entrance, so consecutive sections overlap heavily and the
 * page reads as one wave rather than as eight separate arrivals.
 */
export const DASH_DELAY = {
  header: 0,
  kpis: 70,
  monthly: 140,
  verification: 200,
  charts: 250,
  map: 300,
  delivery: 340,
  complaints: 380,
} as const;
