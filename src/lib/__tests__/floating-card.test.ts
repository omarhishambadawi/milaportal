import { describe, expect, it } from "vitest";
import { placeFloatingCard, type Rect } from "../floating-card";

/** A 1280x800 window, which is the smallest laptop the call floor runs. */
const VIEWPORT = { width: 1280, height: 800 };
/** The hover card's real measured size on desktop. */
const CARD = { width: 300, height: 240 };
const MARGIN = 12;
const GAP = 14;

/** A 20px marker with its centre at (x, y). */
function marker(x: number, y: number): Rect {
  return { left: x - 10, top: y - 10, width: 20, height: 20 };
}

/** Is the whole card inside the window? This is the acceptance criterion. */
function fullyVisible(place: { left: number; top: number }, viewport = VIEWPORT) {
  return (
    place.left >= 0 &&
    place.top >= 0 &&
    place.left + CARD.width <= viewport.width &&
    place.top + CARD.height <= viewport.height
  );
}

describe("placeFloatingCard", () => {
  it("opens above the marker when there is room", () => {
    // The default, and the one that keeps the marker visible under the cursor.
    const place = placeFloatingCard({ anchor: marker(640, 600), card: CARD, viewport: VIEWPORT });
    expect(place.side).toBe("above");
    expect(place.top + CARD.height).toBe(600 - 10 - GAP);
    // Horizontally centred on the marker.
    expect(place.left + CARD.width / 2).toBe(640);
    expect(fullyVisible(place)).toBe(true);
  });

  it("flips below when the marker is near the top edge", () => {
    const place = placeFloatingCard({ anchor: marker(640, 40), card: CARD, viewport: VIEWPORT });
    expect(place.side).toBe("below");
    expect(place.top).toBe(40 + 10 + GAP);
    expect(fullyVisible(place)).toBe(true);
  });

  it("stays above when the marker is near the bottom edge", () => {
    // This is the screenshot's case inverted: a marker low on the screen must not
    // push the card off the bottom.
    const place = placeFloatingCard({ anchor: marker(640, 770), card: CARD, viewport: VIEWPORT });
    expect(place.side).toBe("above");
    expect(fullyVisible(place)).toBe(true);
  });

  it("clamps to the left edge instead of hanging off it", () => {
    const place = placeFloatingCard({ anchor: marker(8, 400), card: CARD, viewport: VIEWPORT });
    expect(place.left).toBe(MARGIN);
    expect(fullyVisible(place)).toBe(true);
  });

  it("clamps to the right edge instead of hanging off it", () => {
    const place = placeFloatingCard({ anchor: marker(1274, 400), card: CARD, viewport: VIEWPORT });
    expect(place.left).toBe(VIEWPORT.width - MARGIN - CARD.width);
    expect(fullyVisible(place)).toBe(true);
  });

  it("keeps every corner fully visible", () => {
    for (const [x, y] of [
      [0, 0],
      [VIEWPORT.width, 0],
      [0, VIEWPORT.height],
      [VIEWPORT.width, VIEWPORT.height],
    ]) {
      const place = placeFloatingCard({ anchor: marker(x, y), card: CARD, viewport: VIEWPORT });
      expect(fullyVisible(place), `corner ${x},${y}`).toBe(true);
    }
  });

  it("keeps the card on screen for a marker anywhere in the window", () => {
    // The property the acceptance criteria actually state — "every city,
    // regardless of marker position" — asserted as a property rather than by
    // enumerating cities.
    for (let x = 0; x <= VIEWPORT.width; x += 40) {
      for (let y = 0; y <= VIEWPORT.height; y += 40) {
        const place = placeFloatingCard({ anchor: marker(x, y), card: CARD, viewport: VIEWPORT });
        expect(fullyVisible(place), `marker ${x},${y}`).toBe(true);
      }
    }
  });

  it("holds up on a short mobile-landscape window", () => {
    // 360 tall against a 240 card: above and below both fit only just, and the
    // clamp has to do the work.
    const shortViewport = { width: 740, height: 360 };
    for (let y = 0; y <= shortViewport.height; y += 20) {
      const place = placeFloatingCard({
        anchor: marker(370, y),
        card: CARD,
        viewport: shortViewport,
      });
      expect(fullyVisible(place, shortViewport), `y=${y}`).toBe(true);
    }
  });

  it("shows the top of a card too tall to fit rather than its middle", () => {
    // Nothing can make a 700px card fit in a 400px window. Pinning it to the top
    // margin at least shows the city name and the headline figure.
    const place = placeFloatingCard({
      anchor: marker(400, 200),
      card: { width: 300, height: 700 },
      viewport: { width: 800, height: 400 },
    });
    expect(place.top).toBe(MARGIN);
  });

  it("prefers the roomier side when neither fits", () => {
    const shortViewport = { width: 800, height: 300 };
    // Marker low down: more room above than below.
    expect(
      placeFloatingCard({ anchor: marker(400, 260), card: CARD, viewport: shortViewport }).side,
    ).toBe("above");
    // Marker high up: more room below.
    expect(
      placeFloatingCard({ anchor: marker(400, 40), card: CARD, viewport: shortViewport }).side,
    ).toBe("below");
  });
});
