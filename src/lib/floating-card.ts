/**
 * Where to put a floating card so it stays on screen.
 *
 * Pure arithmetic, deliberately separated from the component that uses it. The
 * positioning of a hover card is the part that is easy to get subtly wrong — the
 * failure mode is a card half off the bottom of the screen for one city out of
 * thirty, which nobody notices until a screenshot arrives — and it is also the
 * part that needs no DOM to verify. Everything here is numbers in, numbers out,
 * so the awkward cases (a marker in a corner, a card taller than the window) are
 * covered by tests rather than by hovering thirty cities by hand.
 *
 * Viewport coordinates throughout, because the consumer is `position: fixed`.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface FloatingPlacement {
  left: number;
  top: number;
  /** Which side of the anchor the card ended up on. */
  side: "above" | "below";
}

export interface PlaceOptions {
  /** The thing being described, in viewport coordinates. */
  anchor: Rect;
  /**
   * The card's *layout* size.
   *
   * Must come from `offsetWidth`/`offsetHeight`, not `getBoundingClientRect()`.
   * The card animates in with a `scale(0.95)` transform, and a client rect is
   * post-transform: measuring during the animation reports the card 5% smaller
   * than it will settle at, so the flip-and-clamp below decides it fits when it
   * does not, and the last few pixels end up off screen. Layout metrics ignore
   * transforms and are stable from the first frame.
   */
  card: { width: number; height: number };
  viewport: Viewport;
  /** Minimum breathing room between the card and the window edge. */
  margin?: number;
  /** Distance between the card and the anchor it describes. */
  gap?: number;
}

/**
 * Place the card above the anchor, or below it, whichever fits.
 *
 * Above is preferred when it fits: a card that opens upward leaves the thing you
 * are pointing at visible beneath your cursor, which is what makes a hover card
 * feel attached to its marker rather than dropped on top of it.
 *
 * When neither side fits — a short window, or a tall card — the side with more
 * room wins and the result is clamped into the viewport. That deliberately allows
 * the card to overlap its own marker in the worst case: showing all of the
 * information and covering the dot is better than showing three quarters of the
 * information, and the card is `pointer-events: none` so the marker underneath
 * still works.
 */
export function placeFloatingCard({
  anchor,
  card,
  viewport,
  margin = 12,
  gap = 14,
}: PlaceOptions): FloatingPlacement {
  const anchorBottom = anchor.top + anchor.height;
  const roomAbove = anchor.top - margin;
  const roomBelow = viewport.height - anchorBottom - margin;
  const needed = card.height + gap;

  let side: "above" | "below";
  if (needed <= roomAbove) side = "above";
  else if (needed <= roomBelow) side = "below";
  else side = roomAbove >= roomBelow ? "above" : "below";

  let top = side === "above" ? anchor.top - gap - card.height : anchorBottom + gap;

  // Clamp vertically. `Math.max(margin, …)` is what handles a card taller than
  // the window: the lower bound wins, so the card starts at the top margin and
  // runs off the bottom, showing its beginning rather than its middle.
  top = Math.max(margin, Math.min(top, viewport.height - margin - card.height));

  // Centre on the anchor, then clamp horizontally by the same rule.
  const centred = anchor.left + anchor.width / 2 - card.width / 2;
  const left = Math.max(margin, Math.min(centred, viewport.width - margin - card.width));

  return { left, top, side };
}
