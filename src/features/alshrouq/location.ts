/**
 * The customer's delivery location, as AlShrouq needs it. Pure, no I/O.
 *
 * ## The customer's own link is the authority
 *
 * A customer sends a Google Maps link over WhatsApp; the agent pastes it. That
 * link *is* the location — not an address someone retyped from it, and not a
 * geocoder's best guess at what the address meant. Preserving it verbatim is
 * what makes the delivery the one the customer asked for, and it is what the
 * CRM's own records do: 104 of the 126 real deliveries carry an unresolved
 * `maps.app.goo.gl` link as `customer_address`.
 *
 * ## But the coordinates must be extracted and kept
 *
 * A courier routes to `customer_lat`/`customer_lng`, and a short link carries
 * neither — only a redirect. So the link is resolved once, server-side, and the
 * numbers are stored. Storing only the URL and re-resolving later would make a
 * delivery depend on a shortener still being up months afterwards, on a request
 * nobody is watching.
 *
 * Nothing here fabricates a coordinate. A link that cannot be resolved to a
 * point is reported as unresolved and fails AlShrouq validation; it never
 * becomes a location with a plausible-looking pair attached.
 */

import type { LatLng } from "@/lib/geo/types";
import type { AlShrouqOrderFields } from "./order-fields";

/**
 * A delivery location that has actually been resolved.
 *
 * Shaped to drop straight into the future `payload_snapshot.location` without
 * reshaping — the scheduled worker reads the snapshot, never the order, so
 * whatever is frozen here is what a courier is eventually told.
 */
export interface AlShrouqLocation {
  /** Exactly what the agent pasted. Never rewritten. */
  originalUrl: string;
  /** Where it led. The same URL when nothing needed following. */
  resolvedUrl: string;
  latitude: number;
  longitude: number;
  /** The place name, when the resolved link names one. Never geocoded. */
  address: string | null;
}

export type AlShrouqLocationResult =
  | { kind: "resolved"; location: AlShrouqLocation }
  /** The chain ended at a real Maps page that simply carries no point. */
  | { kind: "no_coordinates"; resolvedUrl: string }
  /** Both numbers read, but outside Saudi Arabia — almost always a swapped pair. */
  | { kind: "out_of_range"; resolvedUrl: string }
  /** Not a link this resolver will touch: wrong host, wrong scheme, not a URL. */
  | { kind: "unsupported" }
  | { kind: "failed"; errorKind: string };

/** Whether a result is one an order may be dispatched on. */
export function isResolved(
  result: AlShrouqLocationResult | null | undefined,
): result is { kind: "resolved"; location: AlShrouqLocation } {
  return result?.kind === "resolved";
}

/**
 * Build the location from a resolved point.
 *
 * The only way an `AlShrouqLocation` is constructed, so there is exactly one
 * place a coordinate can enter the contract and it requires a real point.
 */
export function locationFrom(
  originalUrl: string,
  resolvedUrl: string,
  point: LatLng,
  address: string | null,
): AlShrouqLocation {
  return {
    originalUrl: originalUrl.trim(),
    resolvedUrl,
    latitude: point.lat,
    longitude: point.lng,
    address,
  };
}

/** `24.71360, 46.67530` — for display beside the link, never for entry. */
export function formatCoordinates(location: AlShrouqLocation): string {
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
}

/**
 * What to tell the agent, per outcome.
 *
 * Each names the thing they can actually do about it. "Unsupported" is a
 * different action from "no coordinates": one means paste a different kind of
 * link, the other means the link is fine but points at a named place rather
 * than a pin.
 */
export function describeLocationResult(result: AlShrouqLocationResult): string | null {
  switch (result.kind) {
    case "resolved":
      return null;
    case "no_coordinates":
      return "That link opens a place but carries no coordinates. Drop a pin on the exact spot and share that link instead.";
    case "out_of_range":
      return "Those coordinates fall outside Saudi Arabia. Check the link points at the delivery address.";
    case "unsupported":
      return "Paste a Google Maps link — that is what this accepts.";
    case "failed":
      return result.errorKind === "timeout"
        ? "Google Maps took too long to answer. Try again."
        : result.errorKind === "redirect_loop"
          ? "That link redirects back to itself."
          : result.errorKind === "too_many_hops"
            ? "That link redirects too many times."
            : "Could not reach Google Maps to check that link.";
  }
}

/**
 * The location, as the Phase 10D validator reads it.
 *
 * The bridge between the two: an unresolved link produces blank coordinates, so
 * `validateAlShrouqOrderFields` fails exactly as it would for a location nobody
 * entered — which is the intended behaviour. There is no path where an
 * unresolved link satisfies validation.
 */
export function locationFields(
  location: AlShrouqLocation | null,
): Pick<AlShrouqOrderFields, "customerLocation" | "latitude" | "longitude"> {
  if (!location) return { customerLocation: "", latitude: "", longitude: "" };
  return {
    // The customer's own link is what goes on the wire as `customer_address`.
    customerLocation: location.originalUrl,
    latitude: String(location.latitude),
    longitude: String(location.longitude),
  };
}
