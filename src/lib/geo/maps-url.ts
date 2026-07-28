import { latLngParam } from "./coordinates";
import type { LatLng, TravelMode } from "./types";

/**
 * Google Maps deep links.
 *
 * Keyless by design — these are the public `/maps/...?api=1` URLs, which need no
 * credential and work from any browser or phone. That matters more than it
 * sounds: "Open Google Maps" and "Start Navigation" are the two controls agents
 * press most, and building them from URLs rather than from the Maps SDK means
 * they keep working when the SDK is unconfigured, blocked, or still loading.
 *
 * Everything that needs a key lives in `@/lib/maps` instead.
 */

const BASE = "https://www.google.com/maps";

/** Show a point, or a named place when a stored place link is available. */
export function mapSearchUrl(target: LatLng | string): string {
  const query = typeof target === "string" ? target : latLngParam(target);
  return `${BASE}/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Turn-by-turn directions to a destination.
 *
 * `origin` is omitted deliberately when the caller does not supply one: Google
 * then uses the device's own location, which on an agent's phone is the right
 * answer and on a desktop prompts once. Passing a stale origin would be worse
 * than passing none.
 */
export function directionsUrl(
  destination: LatLng | string,
  options: { origin?: LatLng | string; mode?: TravelMode; waypoints?: LatLng[] } = {},
): string {
  const params = new URLSearchParams({ api: "1" });
  params.set(
    "destination",
    typeof destination === "string" ? destination : latLngParam(destination),
  );
  if (options.origin) {
    params.set(
      "origin",
      typeof options.origin === "string" ? options.origin : latLngParam(options.origin),
    );
  }
  if (options.mode) params.set("travelmode", options.mode);
  if (options.waypoints?.length) {
    params.set("waypoints", options.waypoints.map((point) => latLngParam(point)).join("|"));
  }
  return `${BASE}/dir/?${params.toString()}`;
}

/** Directions that start navigating immediately on a phone. */
export function navigationUrl(destination: LatLng | string, origin?: LatLng | string): string {
  return `${directionsUrl(destination, { origin, mode: "driving" })}&dir_action=navigate`;
}

/**
 * Maximum stops in one directions URL.
 *
 * Google silently truncates rather than erroring past its waypoint limit, so a
 * link naming 145 branches looks like it worked and quietly drops most of them.
 * Callers offering "open everything on the map" must cap and say so.
 */
export const MAX_WAYPOINTS = 10;

/**
 * A multi-stop route through several points, capped at {@link MAX_WAYPOINTS}.
 * Returns null when nothing has coordinates.
 */
export function multiStopUrl(points: readonly LatLng[]): string | null {
  const capped = points.slice(0, MAX_WAYPOINTS);
  if (capped.length === 0) return null;
  if (capped.length === 1) return mapSearchUrl(capped[0]);
  return directionsUrl(capped[capped.length - 1], {
    origin: capped[0],
    waypoints: capped.slice(1, -1),
  });
}

/**
 * Best map link for a record that may carry its own stored URL.
 *
 * Prefers the stored link — the master workbook's goo.gl links resolve to a
 * *named place*, which tells a driver "Ghodaf Pharmacy, Al Hazm" rather than
 * dropping an anonymous pin in a street — and falls back to coordinates.
 */
export function resolveMapUrl(record: {
  maps_url?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): string | null {
  const stored = record.maps_url?.trim();
  if (stored && /^https?:\/\//i.test(stored)) return stored;
  if (record.latitude != null && record.longitude != null) {
    return mapSearchUrl({ lat: record.latitude, lng: record.longitude });
  }
  return null;
}

/**
 * A short, readable stand-in for a map URL.
 *
 * A Google Maps link is between 40 and 300 characters of opaque machinery, and
 * printing it in full on a card buys nothing: nobody reads a URL, nobody types
 * one back in, and the two things anyone does with it — open it, or copy it —
 * are both buttons. What a reader does want to know is *which kind* of link it
 * is, because a stored place link ("maps.app.goo.gl") names the pharmacy when it
 * opens while a generated one only drops a pin.
 *
 * Returns null for anything that is not a URL, so callers can fall back rather
 * than render "".
 */
export function mapUrlLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, "");
    // Our own generated links are always a coordinate search; saying so is more
    // use than repeating the host every card already shares.
    if (host === "google.com" && pathname.startsWith("/maps/search"))
      return "Coordinates on Google Maps";
    return host;
  } catch {
    return null;
  }
}

/** Navigation link for a record, or null without coordinates. */
export function resolveNavUrl(record: {
  latitude?: number | null;
  longitude?: number | null;
}): string | null {
  if (record.latitude == null || record.longitude == null) return null;
  return navigationUrl({ lat: record.latitude, lng: record.longitude });
}
