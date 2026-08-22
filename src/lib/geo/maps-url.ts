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

/**
 * Google's map hosts, including the country domains a shared link can land on.
 *
 * Fully anchored, and **the single definition** — `short-link.server.ts` imports
 * this one rather than keeping its own, so what the parser calls a Maps link and
 * what the resolver is willing to fetch cannot drift apart.
 *
 * The previous pattern was `(^|\.)(google\.[a-z.]+|goo\.gl)$`, which accepts
 * `google.com.evil.example`: `[a-z.]+` happily swallows the rest of the name, so
 * any host with `google.` in it and letters after passed. The resolver's own
 * allow-list was already written this way and refused such a host, so nothing
 * could be *fetched* — but the parser calling it a Google link was wrong on its
 * own terms, and became worth fixing the moment a scheme-less string could be
 * normalised into one.
 */
export const MAPS_HOSTS =
  /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google(\.[a-z]{2,3}){1,2})$/i;

/** The shorteners, which hold a redirect and nothing else. */
const SHORTENER_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl)$/i;

/** The dropped pin inside a `/data=` blob — the place the person actually chose. */
const PLACE_PIN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;

/** The map camera. Where the view was, which is close but not the pin. */
const CAMERA = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

/**
 * A coordinate pair, as a query parameter carries one.
 *
 * Separated by a comma or by whitespace: `?query=24.53,46.64` is the documented
 * form, and `?query=24.53+46.64` is what arrives when the sharer's client
 * encoded the separator as a plus, which `URLSearchParams` decodes to a space.
 * An optional `loc:` prefix is Android's share format (`?q=loc:24.53,46.64`).
 */
const PAIR = /^\s*(?:loc:)?\s*(-?\d+(?:\.\d+)?)\s*(?:,|\s)\s*(-?\d+(?:\.\d+)?)\s*$/i;

/** Query parameters Maps uses to carry a point. */
const COORDINATE_PARAMS = ["query", "q", "ll", "center", "destination", "daddr"] as const;

/**
 * Something that could be a bare host, for the scheme-less case below.
 *
 * Deliberately narrow: a dotted label sequence, optionally followed by a path,
 * query or fragment. It is only ever used to *try* prefixing `https://`, and the
 * host that results is then held to {@link MAPS_HOSTS} like any other — so this
 * widens what can be typed, not what can be reached.
 */
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/i;

/** Longer than any real Maps link. `new URL` on unbounded input is free work. */
const MAX_URL_LENGTH = 2048;

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
  /**
   * The link as an absolute `https:` URL, when the text was one or could be read
   * as one — `null` otherwise.
   *
   * Exists for the scheme-less case. An agent pasting from WhatsApp very often
   * pastes `maps.app.goo.gl/aBcD`, with no scheme, because that is how the
   * message renders; `new URL` refuses it, so the whole link read as "not a map
   * link" and the coordinates never appeared. Prefixing `https://` is not
   * rewriting a destination — it is naming the one the text already meant — and
   * the result is still held to the host list.
   *
   * Callers that go on to *fetch* the link should send this rather than the raw
   * text, because the resolver requires an absolute HTTPS URL. What is stored
   * and sent to the courier stays exactly what the customer wrote.
   */
  normalizedUrl: string | null;
}

const NOTHING: MapsUrlParse = {
  point: null,
  outOfRange: false,
  needsResolution: false,
  normalizedUrl: null,
};

function fromPair(latRaw: string, lngRaw: string, normalizedUrl: string | null): MapsUrlParse {
  const { point, outOfRange } = parseCoordinatePair(latRaw, lngRaw);
  return { point, outOfRange, needsResolution: false, normalizedUrl };
}

/**
 * Read the text as a URL, supplying the scheme it omitted.
 *
 * `https` only, and never upgraded from an explicit `http` — a caller that
 * typed a scheme gets the one they typed, and a caller that typed none gets the
 * secure one rather than a guess.
 */
function asUrl(text: string): URL | null {
  if (text.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(text);
  } catch {
    // Not absolute. Only worth a second try when it looks like a bare host.
    if (!BARE_HOST.test(text)) return null;
    try {
      return new URL(`https://${text}`);
    } catch {
      return null;
    }
  }
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
  if (geo) return fromPair(geo[1]!, geo[2]!, null);

  const url = asUrl(text);
  if (!url) {
    // Not a URL at all. A bare "24.71, 46.67" is still a location an agent may
    // paste, and reading it costs nothing.
    const pair = PAIR.exec(text);
    return pair ? fromPair(pair[1]!, pair[2]!, null) : NOTHING;
  }

  // The hostname as it stands: the pattern names the `www.`/`maps.` prefixes it
  // allows, rather than stripping one and hoping the rest is safe.
  const host = url.hostname;
  if (!MAPS_HOSTS.test(host)) return NOTHING;

  /*
   * The absolute form, for a caller that has to fetch it.
   *
   * Only ever a Google Maps host, because we are past the check above; the
   * server's own allow-list is re-applied on every hop regardless, so this
   * widens nothing.
   */
  const normalizedUrl = url.protocol === "https:" ? url.href : null;

  const pin = PLACE_PIN.exec(url.href);
  if (pin) return fromPair(pin[1]!, pin[2]!, normalizedUrl);

  for (const key of COORDINATE_PARAMS) {
    const value = url.searchParams.get(key);
    const pair = value ? PAIR.exec(value) : null;
    if (pair) return fromPair(pair[1]!, pair[2]!, normalizedUrl);
  }

  const camera = CAMERA.exec(url.href);
  if (camera) return fromPair(camera[1]!, camera[2]!, normalizedUrl);

  /*
   * A shortener that got this far genuinely holds nothing but the redirect.
   *
   * Only recoverable when it can be handed to the resolver, which takes HTTPS
   * only — an `http:` shortener is reported as carrying no coordinates rather
   * than as something a "Check location" button could ever fix.
   */
  if (SHORTENER_HOSTS.test(host) && normalizedUrl) {
    return { ...NOTHING, needsResolution: true, normalizedUrl };
  }

  return { ...NOTHING, normalizedUrl };
}
