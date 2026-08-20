import { describe, expect, it } from "vitest";
import { parseMapsUrl } from "..";

/**
 * Reading a location back out of a pasted link.
 *
 * The cases are real share-sheet output rather than invented URLs: the whole
 * point of the parser is that it copes with what a customer actually sends, and
 * a hand-written URL would not exercise the `/data=` blob or the `@` camera.
 */

/** A real branch coordinate from the master workbook. */
const HAZM = { lat: 24.5372826, lng: 46.6456098 };

describe("parseMapsUrl", () => {
  it("reads nothing from empty input", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(parseMapsUrl(value)).toEqual({
        point: null,
        outOfRange: false,
        needsResolution: false,
      });
    }
  });

  it("prefers the place pin over the camera", () => {
    // `@` sits one street away from `!3d/!4d` — this is the share-while-scrolled
    // case, and the pin is the location the person meant.
    const url =
      "https://www.google.com/maps/place/Ghodaf+Pharmacy/@24.5400000,46.6500000,17z/" +
      `data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d${HAZM.lat}!4d${HAZM.lng}`;
    expect(parseMapsUrl(url).point).toEqual(HAZM);
  });

  it("reads the camera when there is no pin", () => {
    const url = `https://www.google.com/maps/@${HAZM.lat},${HAZM.lng},15z`;
    expect(parseMapsUrl(url).point).toEqual(HAZM);
  });

  it("reads a coordinate-bearing query parameter", () => {
    const forms = [
      `https://www.google.com/maps/search/?api=1&query=${HAZM.lat},${HAZM.lng}`,
      `https://maps.google.com/?q=${HAZM.lat},${HAZM.lng}`,
      `https://www.google.com/maps?ll=${HAZM.lat},${HAZM.lng}`,
      `https://www.google.com/maps/dir/?api=1&destination=${HAZM.lat},${HAZM.lng}`,
    ];
    for (const url of forms) expect(parseMapsUrl(url).point).toEqual(HAZM);
  });

  it("round-trips a link the portal generated itself", () => {
    // `mapSearchUrl` percent-encodes the comma; the parser must still read it.
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${HAZM.lat},${HAZM.lng}`,
    )}`;
    expect(parseMapsUrl(url).point).toEqual(HAZM);
  });

  it("ignores a query parameter naming a place rather than a point", () => {
    const url = "https://www.google.com/maps/search/?api=1&query=Ghodaf+Pharmacy+Al+Hazm";
    expect(parseMapsUrl(url).point).toBeNull();
  });

  it("reads a geo: link from a phone's share sheet", () => {
    expect(parseMapsUrl(`geo:${HAZM.lat},${HAZM.lng}?z=17`).point).toEqual(HAZM);
  });

  it("accepts a bare pair, which is what a pasted coordinate looks like", () => {
    expect(parseMapsUrl(`${HAZM.lat}, ${HAZM.lng}`).point).toEqual(HAZM);
  });

  it("flags a shortener as resolvable rather than empty", () => {
    // The distinction the UI depends on: this link *has* a location, it just
    // takes a redirect to reach, and the browser cannot follow it.
    for (const url of ["https://maps.app.goo.gl/aBcDeF123", "https://goo.gl/maps/aBcDeF123"]) {
      expect(parseMapsUrl(url)).toEqual({
        point: null,
        outOfRange: false,
        needsResolution: true,
      });
    }
  });

  it("rejects a link that is not Google Maps", () => {
    const url = `https://example.com/maps/@${HAZM.lat},${HAZM.lng},15z`;
    expect(parseMapsUrl(url)).toEqual({
      point: null,
      outOfRange: false,
      needsResolution: false,
    });
  });

  it("reports a swapped pair as out of range rather than storing it", () => {
    // Longitude first puts the customer in the Indian Ocean. Both numbers are
    // individually plausible, which is why this needs the machine check.
    const url = `https://www.google.com/maps/@${HAZM.lng},${HAZM.lat},15z`;
    const parsed = parseMapsUrl(url);
    expect(parsed.point).toBeNull();
    expect(parsed.outOfRange).toBe(true);
  });
});
