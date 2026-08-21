import { latLngParam, parseCoordinatePair } from "./coordinates";
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

/* -------------------------------------------------------------------------- */
/* Reading a location back out of a link                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything above builds Maps URLs. Everything below reads one.
 *
 * Restored from the reverted integration (`3917274`), which had this working:
 * it went out with the wholesale AlShrouq revert rather than for any defect of
 * its own. What it lacked was a reason to exist — Phase 4 established that the
 * CRM stores the customer's link verbatim, so nothing needed *resolving* to send
 * an address. Coordinates changed that: `customer_lat`/`customer_lng` are what a
 * courier routes to, and a `maps.app.goo.gl` link carries neither.
 */

/** Google's map hosts, including the country domains a shared link can land on. */
const MAPS_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl)$/i;

/** The shorteners, which hold a redirect and nothing else. */
const SHORTENER_HOSTS = /(^|\.)goo\.gl$/i;

/** The dropped pin inside a `/data=` blob — the place the person actually chose. */
const PLACE_PIN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;

/** The map camera. Where the view was, which is close but not the pin. */
const CAMERA = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

const PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Query parameters Maps uses to carry a point. */
const COORDINATE_PARAMS = ["query", "q", "ll", "center", "destination", "daddr"] as const;

export interface MapsUrlParse {
  /** The location, when the link carries one and it falls inside the country. */
  point: LatLng | null;
  /** Both numbers parsed but landed outside KSA — very likely a swapped pair. */
  outOfRange: boolean;
  /**
   * A Google shortener, which holds nothing but a redirect.
   *
   * Distinct from "no coordinates" because it is *recoverable*: following the
   * redirect server-side yields the real link. The browser cannot follow it —
   * the shortener sends no CORS headers — so the caller must ask the server.
   */
  needsResolution: boolean;
}

const NOTHING: MapsUrlParse = { point: null, outOfRange: false, needsResolution: false };

function fromPair(latRaw: string, lngRaw: string): MapsUrlParse {
  const { point, outOfRange } = parseCoordinatePair(latRaw, lngRaw);
  return { point, outOfRange, needsResolution: false };
}

/**
 * Pull the location out of a Google Maps link.
 *
 * Pure and keyless: no SDK, no geocoding call, no credential. An agent pasting a
 * link the customer sent over WhatsApp is the common case, and it should not
 * cost a Places lookup to read coordinates already sitting in the URL.
 *
 * Forms are tried in order of how well each means "the place the person
 * intended" — the `/data=` pin first, then a coordinate-bearing query parameter,
 * then the camera. Anything else, including a link naming a place by name only,
 * yields no point rather than a guess.
 *
 * Range checking is delegated to `parseCoordinatePair`, so a pasted link is held
 * to exactly the same bounds as a typed coordinate or an imported spreadsheet
 * cell.
 */
export function parseMapsUrl(raw: string | null | undefined): MapsUrlParse {
  const text = raw?.trim();
  if (!text) return NOTHING;

  // `geo:` is what a phone's "share location" produces outside Google Maps.
  const geo = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(text);
  if (geo) return fromPair(geo[1]!, geo[2]!);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Not a URL. A bare "24.71, 46.67" is still a location an agent may paste.
    const pair = PAIR.exec(text);
    return pair ? fromPair(pair[1]!, pair[2]!) : NOTHING;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (!MAPS_HOSTS.test(host)) return NOTHING;

  const pin = PLACE_PIN.exec(url.href);
  if (pin) return fromPair(pin[1]!, pin[2]!);

  for (const key of COORDINATE_PARAMS) {
    const value = url.searchParams.get(key);
    const pair = value ? PAIR.exec(value) : null;
    if (pair) return fromPair(pair[1]!, pair[2]!);
  }

  const camera = CAMERA.exec(url.href);
  if (camera) return fromPair(camera[1]!, camera[2]!);

  // A shortener that got this far genuinely holds nothing but the redirect.
  if (SHORTENER_HOSTS.test(host)) return { ...NOTHING, needsResolution: true };

  return NOTHING;
}
