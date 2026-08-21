/**
 * The customer-location contract, and how it meets the Phase 10D validator.
 *
 * Pure — no HTTP anywhere. The resolver itself is tested in
 * `src/lib/geo/__tests__/short-link.test.ts` with every request mocked.
 */

import { describe, expect, it } from "vitest";
import {
  describeLocationResult,
  formatCoordinates,
  isResolved,
  locationFields,
  locationFrom,
  type AlShrouqLocationResult,
} from "@/features/alshrouq/location";
import { validateAlShrouqOrderFields } from "@/features/alshrouq/order-fields";

const SHORT = "https://maps.app.goo.gl/aBcDeF";
const RESOLVED = "https://www.google.com/maps/place/Al+Yasmin/@24.7136,46.6753,17z";

const LOCATION = locationFrom(SHORT, RESOLVED, { lat: 24.7136, lng: 46.6753 }, "Al Yasmin");

describe("the location contract", () => {
  it("preserves the customer's original link verbatim", () => {
    // What the customer sent is the location. It is never rewritten to the
    // resolved form, because the CRM stores the customer's own link.
    expect(LOCATION.originalUrl).toBe(SHORT);
  });

  it("preserves the resolved link separately", () => {
    expect(LOCATION.resolvedUrl).toBe(RESOLVED);
    expect(LOCATION.resolvedUrl).not.toBe(LOCATION.originalUrl);
  });

  it("persists the coordinates rather than the URL alone", () => {
    // Storing only the link would make a delivery depend on a shortener still
    // being up months later, on a request nobody is watching.
    expect(LOCATION.latitude).toBe(24.7136);
    expect(LOCATION.longitude).toBe(46.6753);
  });

  it("keeps the place name when the link names one", () => {
    expect(LOCATION.address).toBe("Al Yasmin");
  });

  it("trims the pasted link but changes nothing else", () => {
    const padded = locationFrom(`  ${SHORT}  `, RESOLVED, { lat: 1, lng: 2 }, null);
    expect(padded.originalUrl).toBe(SHORT);
  });

  it("formats coordinates for display, not for entry", () => {
    expect(formatCoordinates(LOCATION)).toBe("24.71360, 46.67530");
  });

  /** The shape the future snapshot freezes. */
  it("carries exactly the five fields the snapshot needs", () => {
    expect(Object.keys(LOCATION).sort()).toEqual([
      "address",
      "latitude",
      "longitude",
      "originalUrl",
      "resolvedUrl",
    ]);
  });
});

describe("isResolved", () => {
  it("is true only for a resolved result", () => {
    expect(isResolved({ kind: "resolved", location: LOCATION })).toBe(true);
  });

  it.each([
    { kind: "no_coordinates", resolvedUrl: RESOLVED },
    { kind: "out_of_range", resolvedUrl: RESOLVED },
    { kind: "unsupported" },
    { kind: "failed", errorKind: "timeout" },
  ] as AlShrouqLocationResult[])("is false for %o", (r) => {
    expect(isResolved(r)).toBe(false);
  });

  it("is false for nothing at all", () => {
    expect(isResolved(null)).toBe(false);
    expect(isResolved(undefined)).toBe(false);
  });
});

describe("describeLocationResult", () => {
  it("says nothing when there is nothing wrong", () => {
    expect(describeLocationResult({ kind: "resolved", location: LOCATION })).toBeNull();
  });

  it.each([
    ["no_coordinates", "Drop a pin"],
    ["unsupported", "Google Maps link"],
    ["out_of_range", "outside Saudi Arabia"],
  ])("%s explains what to do about it", (kind, fragment) => {
    const msg = describeLocationResult({ kind, resolvedUrl: RESOLVED } as AlShrouqLocationResult);
    expect(msg).toContain(fragment);
  });

  it.each([
    ["timeout", "too long"],
    ["redirect_loop", "redirects back"],
    ["too_many_hops", "too many times"],
    ["unavailable", "Could not reach"],
  ])("a %s failure is named specifically", (errorKind, fragment) => {
    expect(describeLocationResult({ kind: "failed", errorKind })).toContain(fragment);
  });
});

describe("integration with the Phase 10D validator", () => {
  const base = {
    deliveryType: "AlShrouq",
    customerName: "Ahmed",
    customerPhone: "0500000000",
  };

  it("passes AlShrouq validation once a location is resolved", () => {
    expect(validateAlShrouqOrderFields({ ...base, ...locationFields(LOCATION) })).toEqual([]);
  });

  it("sends the customer's own link as the location, not the resolved one", () => {
    expect(locationFields(LOCATION).customerLocation).toBe(SHORT);
  });

  /**
   * The load-bearing one. There is no path where an unresolved link satisfies
   * validation: it produces blank coordinates, which fail exactly as a location
   * nobody entered would.
   */
  it("fails AlShrouq validation when nothing has been resolved", () => {
    const issues = validateAlShrouqOrderFields({ ...base, ...locationFields(null) });
    expect(issues.map((i) => i.field)).toEqual([
      "customer_location",
      "customer_lat",
      "customer_lng",
    ]);
  });

  it("fabricates no coordinate for an unresolved link", () => {
    const fields = locationFields(null);
    expect(fields.latitude).toBe("");
    expect(fields.longitude).toBe("");
  });

  it("leaves every other delivery method alone", () => {
    // The same empty location that fails for AlShrouq must pass for the rest.
    for (const method of ["Store Pickup", "Branch Scooter", "Azman"]) {
      expect(
        validateAlShrouqOrderFields({
          deliveryType: method,
          customerName: "",
          customerPhone: "",
          ...locationFields(null),
        }),
      ).toEqual([]);
    }
  });
});
