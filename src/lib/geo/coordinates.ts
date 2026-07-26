import type { Bounds, LatLng } from "./types";

/**
 * Coordinate parsing, validation and formatting.
 *
 * The single definition in the app. It used to live inside the Branch Directory
 * feature, which was fine while branches were the only thing with a location;
 * customer addresses, delivery polygons and route waypoints all need the same
 * rules, and a second copy would be a second set of bounds to get wrong.
 */

/**
 * Bounding box for Saudi Arabia, generous at the edges.
 *
 * Coordinates outside it are rejected rather than stored. The failure this
 * catches is a latitude and longitude entered the wrong way round, which is
 * silent everywhere except on a map, where the branch lands in the Indian
 * Ocean — and because the country sits at roughly 24°N / 45°E, a swapped pair
 * is still a *plausible-looking* number, which is exactly why it survives
 * eyeballing and needs a machine check.
 */
export const KSA_BOUNDS: Bounds = { south: 15.0, west: 33.0, north: 33.5, east: 57.0 };

/** Geometric centre of the country, used as a default map camera. */
export const KSA_CENTER: LatLng = { lat: 24.0, lng: 45.0 };

/** Decimal places kept. 7 is ~1cm and matches the numeric(10,7) columns. */
const PRECISION = 7;

export function roundCoordinate(value: number): number {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
}

/** Is this a real point anywhere on earth? */
export function isValidLatLng(point: Partial<LatLng> | null | undefined): point is LatLng {
  if (!point) return false;
  const { lat, lng } = point;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isWithin(point: LatLng, bounds: Bounds): boolean {
  return (
    point.lat >= bounds.south &&
    point.lat <= bounds.north &&
    point.lng >= bounds.west &&
    point.lng <= bounds.east
  );
}

export interface CoordinateParse {
  point: LatLng | null;
  /** Set when both values parsed as numbers but fell outside the country. */
  outOfRange: boolean;
}

/**
 * Parse a latitude/longitude pair out of whatever a spreadsheet cell holds.
 *
 * Accepts numbers, numeric strings, and strings carrying stray degree symbols
 * or direction letters. Rejects anything outside {@link KSA_BOUNDS} — see the
 * note there for why an out-of-range pair is a swap rather than a typo.
 */
export function parseCoordinatePair(latRaw: unknown, lngRaw: unknown): CoordinateParse {
  const lat = toNumber(latRaw);
  const lng = toNumber(lngRaw);
  if (lat == null || lng == null) return { point: null, outOfRange: false };

  const point = { lat, lng };
  if (!isValidLatLng(point)) return { point: null, outOfRange: false };
  if (!isWithin(point, KSA_BOUNDS)) return { point: null, outOfRange: true };

  return {
    point: { lat: roundCoordinate(lat), lng: roundCoordinate(lng) },
    outOfRange: false,
  };
}

function toNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw).trim();
  if (!text) return null;
  // Strip everything that is not part of a signed decimal: degree marks,
  // N/S/E/W suffixes, thousands separators pasted in from a locale-formatted
  // sheet. Arabic-Indic digits are handled upstream by foldText.
  const cleaned = text.replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * "24.5372826, 46.6456098" — for display and for pasting into a search box.
 *
 * Note the space. Use {@link latLngParam} for anything going into a URL:
 * `URLSearchParams` renders a space as `+`, which Google Maps reads as part of
 * a place *name* rather than as a coordinate pair, and the link silently drops
 * you somewhere else.
 */
export function formatLatLng(point: LatLng, decimals = PRECISION): string {
  return `${point.lat.toFixed(decimals)}, ${point.lng.toFixed(decimals)}`;
}

/** "24.5372826,46.6456098" — the URL-parameter form. No space. */
export function latLngParam(point: LatLng): string {
  return `${point.lat},${point.lng}`;
}

/** Bounding box enclosing every point, or null when there are none. */
export function boundsOf(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let { lat: south, lng: west } = points[0];
  let { lat: north, lng: east } = points[0];
  for (const point of points) {
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;
    if (point.lng < west) west = point.lng;
    if (point.lng > east) east = point.lng;
  }
  return { south, west, north, east };
}

export function centerOf(bounds: Bounds): LatLng {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lng: (bounds.west + bounds.east) / 2,
  };
}

/** Grow a box by a margin in degrees, so markers are not flush to the frame. */
export function padBounds(bounds: Bounds, margin: number): Bounds {
  return {
    south: bounds.south - margin,
    west: bounds.west - margin,
    north: bounds.north + margin,
    east: bounds.east + margin,
  };
}

/**
 * Normalize a written address for comparison.
 *
 * Not for display — this exists so "الرياض/ حي الحزم /ش علي النقيب" and
 * "الرياض / حي الحزم / ش علي النقيب" compare equal when deduplicating customer
 * addresses or matching a geocoder result back to a stored one.
 */
export function normalizeAddress(address: string | null | undefined): string {
  if (!address) return "";
  return address
    .replace(/\s*[/،,]\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
