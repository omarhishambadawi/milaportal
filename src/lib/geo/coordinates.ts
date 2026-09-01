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
  const lat = coordinateNumber(latRaw);
  const lng = coordinateNumber(lngRaw);
  if (lat == null || lng == null) return { point: null, outOfRange: false };

  const point = { lat, lng };
  if (!isValidLatLng(point)) return { point: null, outOfRange: false };
  if (!isWithin(point, KSA_BOUNDS)) return { point: null, outOfRange: true };

  return {
    point: { lat: roundCoordinate(lat), lng: roundCoordinate(lng) },
    outOfRange: false,
  };
}

/**
 * Characters a copy/paste carries that mean nothing to a number.
 *
 * Bidi marks and isolates (a WhatsApp copy out of an Arabic conversation brings
 * a right-to-left mark along, invisibly, and it is what makes an otherwise
 * perfect `24.53738` fail `Number()`), zero-width joiners, the byte-order mark,
 * the soft hyphen and the Arabic letter mark. Ordinary whitespace is separate
 * because JavaScript's `\s` already covers the non-breaking and en/em spaces.
 */
const INVISIBLE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Arabic-Indic and Extended Arabic-Indic digits, folded to ASCII. */
function foldDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** A signed decimal and nothing else. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * One coordinate, out of whatever a person or a spreadsheet supplied.
 *
 * ---------------------------------------------------------------------------
 * The one reader
 * ---------------------------------------------------------------------------
 * This is the single definition of "what counts as a coordinate" in the app,
 * and everything that reads one goes through it: the pair parser below, the
 * AlShrouq field validator, the order form's schema and the payload it builds.
 *
 * That is the point. The form used to say **Verified location** in green over a
 * pair that had been through the tolerant reader here, then save the *raw* text
 * through a bare `Number()` in `orderFormSchema` — so a latitude pasted as
 * `"24.53738,"`, with the comma left over from splitting `"24.53738, 46.64555"`,
 * verified on screen and then failed the save with a validation error naming
 * neither the field nor the character. Two readers disagreeing about one value.
 *
 * ---------------------------------------------------------------------------
 * What it repairs, and what it refuses
 * ---------------------------------------------------------------------------
 * It repairs damage that carries no meaning: surrounding whitespace, the
 * invisible characters a copy brings with it, a separator left at either end by
 * splitting a pair, a degree mark, a compass letter, the thousands separators a
 * locale-formatted sheet writes.
 *
 * It refuses everything else, and that is as important. What is left after the
 * cleaning must be a signed decimal on its own — so `"24,5"` (a European
 * decimal comma, which is 24.5 or 245 depending on who typed it) and
 * `"near 24.5"` are rejected rather than guessed at. The previous
 * implementation stripped every character that was not a digit, a dot or a
 * minus, which turned both of those into confident, wrong numbers.
 *
 * Range is deliberately **not** checked here: latitude and longitude have
 * different bounds and this function is not told which it is holding. The
 * callers apply them — `parseCoordinatePair` against the globe and the country,
 * `orderFormSchema` against ±90 and ±180.
 */
export function coordinateNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  let text = foldDigits(raw).replace(INVISIBLE, "").replace(/\s+/g, "");
  if (!text) return null;

  // A separator left at either end by splitting "24.53738, 46.64555", or a
  // trailing full stop from a sentence. An interior one is not touched: it is
  // either a thousands separator (handled below) or a genuine ambiguity.
  text = text.replace(/^[,;]+/, "").replace(/[,;]+$/, "");
  // Degree marks, and the minute/second primes a whole-degree value sometimes
  // carries. Decorative here — this reader takes decimal degrees only.
  text = text.replace(/[°º'"′″]/g, "");
  if (!text) return null;

  /*
   * A compass letter, as a sign.
   *
   * Previously stripped and discarded, which read `"24.53738 S"` as +24.53738 —
   * the northern hemisphere, and a real place — instead of the southern point
   * the agent typed. One letter, at one end, and never alongside an explicit
   * sign: `"-24.5S"` says two contradictory things and is refused rather than
   * resolved in somebody's favour.
   */
  let sign = 1;
  const compass = text.match(/^([nsew])|([nsew])$/i);
  if (compass) {
    const letter = (compass[1] ?? compass[2]).toLowerCase();
    if (letter === "s" || letter === "w") sign = -1;
    text = text.replace(/^[nsew]|[nsew]$/i, "");
    if (/[+-]/.test(text)) return null;
  }
  // Any letter still present means this was never a coordinate.
  if (/[a-z\u0600-\u06FF]/i.test(text)) return null;

  // Thousands separators, and only where the grouping is real: `1,234.5`, never
  // `24,5`.
  text = text.replace(/,(?=\d{3}(?:\D|$))/g, "");

  if (!DECIMAL.test(text)) return null;
  const value = Number(text) * sign;
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

/**
 * Centre of mass of a set of points.
 *
 * Distinct from `centerOf(boundsOf(points))`, and the difference matters for
 * the location index: the box centre is decided entirely by the two extreme
 * points, so one outlying branch on the edge of a district drags the "centre"
 * halfway out to it while the six clustered branches that actually define the
 * place get no say. The mean is what "the middle of this district" means.
 *
 * A plain arithmetic mean rather than a spherical one: over the few kilometres
 * a Saudi district spans, the difference is centimetres.
 */
export function centroidOf(points: readonly LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const point of points) {
    lat += point.lat;
    lng += point.lng;
  }
  return {
    lat: roundCoordinate(lat / points.length),
    lng: roundCoordinate(lng / points.length),
  };
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
