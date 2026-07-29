import {
  KSA_BOUNDS,
  formatLatLng,
  isWithin,
  parseCoordinatePair,
  rankByDistance,
  type DistanceProvider,
  type LatLng,
  type Ranked,
} from "@/lib/geo";
import {
  describeLocation,
  describeLocationSource,
  resolvePlace,
  type LocationEntry,
  type LocationIndex,
} from "./location-index";
import type { BranchView } from "./types";

/**
 * Turning "where is the customer" into a point, and a point into five branches.
 *
 * Both halves are pure and synchronous-in-spirit but async by signature, for the
 * reason set out in `@/lib/geo/ranking`: the Routes API and a real geocoder both
 * arrive later, and neither should force a change above this file.
 */

/** The nearest branches to show. */
export const LOCATOR_LIMIT = 10;

export type LocatorResult = Ranked<BranchView>;

/**
 * How an origin was arrived at, which the panel states plainly.
 *
 * An agent reading a distance to a customer needs to know what it was measured
 * *from*. "2.3 km from the pin they sent" and "2.3 km from the middle of Riyadh"
 * are different claims, and only one of them is worth repeating on a call.
 */
export type OriginKind = "coordinates" | "map-link" | "place" | "geocoded";

export interface ResolvedOrigin {
  point: LatLng;
  /** What the agent should read back: a place name, or the coordinates. */
  label: string;
  kind: OriginKind;
  /** One line describing how this was derived, shown under the input. */
  detail: string;
  /** The gazetteer entry behind a `place` origin, for the map and the chip. */
  entry?: LocationEntry;
}

export interface OriginResolution {
  origin: ResolvedOrigin | null;
  /**
   * Several places share the typed name and sit in different cities. The agent
   * picks; nothing is guessed on their behalf.
   */
  choices: LocationEntry[];
  /** Set only when the input was something we tried and failed to place. */
  error: string | null;
}

/**
 * The seam a real geocoder drops into.
 *
 * Phase 1 ships without one — the portal's geocoding runs through Google, which
 * this phase is explicitly not using, and which currently has no key configured
 * anyway. When one exists, pass it here: nothing above this signature changes.
 */
export type Geocoder = (text: string) => Promise<LatLng | null>;

/* -------------------------------------------------------------------------- */
/* Reading a point out of whatever was pasted                                 */
/* -------------------------------------------------------------------------- */

/**
 * Coordinates hidden inside a Google Maps URL.
 *
 * This is the common case in practice and not a nicety: a customer shares their
 * location on WhatsApp, the agent pastes the link, and every one of these forms
 * turns up depending on which app produced it. Ordered by reliability — `@` is
 * the map camera and `!3d!4d` is the resolved place, both of which beat a `q=`
 * parameter that may hold a place *name* rather than a pair.
 */
const URL_COORD_PATTERNS: RegExp[] = [
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /[?&](?:q|ll|query|center|destination|daddr|sll)=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i,
];

/**
 * A bare pair: "24.5372, 46.6456", "24.5372 46.6456", "24.5372;46.6456".
 *
 * Anchored end to end so it does not pick two numbers out of a street address —
 * "شارع 60, حي 4" must not resolve to a point off the coast of Somalia.
 */
const BARE_PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

interface PointParse {
  point: LatLng | null;
  kind: OriginKind | null;
  /** Both numbers read, but the pair is not in Saudi Arabia. */
  outOfRange: boolean;
}

function parsePastedPoint(text: string): PointParse {
  const trimmed = text.trim();
  if (!trimmed) return { point: null, kind: null, outOfRange: false };

  if (/https?:\/\//i.test(trimmed) || trimmed.includes("google.")) {
    for (const pattern of URL_COORD_PATTERNS) {
      const match = trimmed.match(pattern);
      if (!match) continue;
      const parsed = parseCoordinatePair(match[1], match[2]);
      if (parsed.point) return { point: parsed.point, kind: "map-link", outOfRange: false };
      if (parsed.outOfRange) return { point: null, kind: "map-link", outOfRange: true };
    }
    // A goo.gl short link carries no coordinates until it is followed, which is
    // a network call this phase does not make.
    return { point: null, kind: null, outOfRange: false };
  }

  const pair = trimmed.match(BARE_PAIR);
  if (pair) {
    const parsed = parseCoordinatePair(pair[1], pair[2]);
    if (parsed.point) return { point: parsed.point, kind: "coordinates", outOfRange: false };
    if (parsed.outOfRange) return { point: null, kind: "coordinates", outOfRange: true };
  }

  return { point: null, kind: null, outOfRange: false };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

const OUT_OF_RANGE =
  "Those coordinates are outside Saudi Arabia. Check that latitude comes first — a swapped pair still looks plausible.";

const UNPLACEABLE =
  "No city, district or area in the directory matches that. Try a city name, or paste coordinates or a Google Maps link.";

/** An origin built from a gazetteer entry. */
export function originFromPlace(entry: LocationEntry): ResolvedOrigin {
  return {
    point: entry.point,
    label: describeLocation(entry),
    kind: "place",
    detail: describeLocationSource(entry),
    entry,
  };
}

/**
 * Where the customer is.
 *
 * A strict cascade, and the order is the contract:
 *
 *   0. An explicit coordinate pair, or one read out of a pasted map link. The
 *      agent has already given an exact answer; nothing else is consulted.
 *   1. **The local resolver** — the gazetteer of cities, districts and areas
 *      built from the uploaded dataset.
 *   2. **The dataset itself** — branch codes and full written addresses, which
 *      the gazetteer carries as `branch` entries, so steps 1 and 2 are one
 *      lookup rather than two passes over the same index.
 *   3. **`geocode`** — OpenStreetMap today, Google tomorrow. Reached only when
 *      1 and 2 found nothing, which is what "never call OpenStreetMap if the
 *      location was already resolved locally" means in code.
 *
 * An *ambiguous* local result also stops the cascade. The place was found; the
 * only open question is which city, and asking a geocoder would replace a
 * question the agent can answer with a guess they cannot check.
 */
export async function resolveOrigin(
  text: string,
  index: LocationIndex,
  geocode?: Geocoder,
): Promise<OriginResolution> {
  const trimmed = text.trim();
  if (!trimmed) return { origin: null, choices: [], error: null };

  const pasted = parsePastedPoint(trimmed);
  if (pasted.outOfRange) return { origin: null, choices: [], error: OUT_OF_RANGE };
  if (pasted.point && pasted.kind) {
    return {
      origin: {
        point: pasted.point,
        label: formatLatLng(pasted.point, 5),
        kind: pasted.kind,
        detail:
          pasted.kind === "map-link"
            ? "Read from the pasted Google Maps link"
            : "Exact coordinates",
      },
      choices: [],
      error: null,
    };
  }

  // Steps 1 and 2.
  const place = resolvePlace(index, trimmed);
  if (place.status === "found") {
    return { origin: originFromPlace(place.entry), choices: [], error: null };
  }
  if (place.status === "ambiguous") {
    return { origin: null, choices: place.choices, error: null };
  }

  // Step 3. Only now, and only if a provider was supplied.
  if (geocode) {
    const located = await geocode(trimmed);
    if (located && isWithin(located, KSA_BOUNDS)) {
      return {
        origin: {
          point: located,
          label: formatLatLng(located, 5),
          kind: "geocoded",
          detail: "Found on OpenStreetMap — outside the branch directory",
        },
        choices: [],
        error: null,
      };
    }
  }

  return { origin: null, choices: [], error: UNPLACEABLE };
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The nearest branches to a point.
 *
 * A thin adapter over the generic ranker: its only job is knowing that a branch
 * keeps its position in `latitude`/`longitude` and that `hasCoords` says whether
 * those are real. Swapping Haversine for Routes is a `provider` argument here
 * and nothing else anywhere.
 */
export function rankNearestBranches(
  origin: LatLng,
  branches: readonly BranchView[],
  options: { limit?: number; provider?: DistanceProvider } = {},
): Promise<LocatorResult[]> {
  return rankByDistance(
    origin,
    branches,
    (branch) =>
      branch.hasCoords ? { lat: branch.latitude as number, lng: branch.longitude as number } : null,
    { limit: options.limit ?? LOCATOR_LIMIT, provider: options.provider },
  );
}
