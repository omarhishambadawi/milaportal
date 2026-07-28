import {
  KSA_BOUNDS,
  boundsOf,
  centerOf,
  formatLatLng,
  isWithin,
  parseCoordinatePair,
  rankByDistance,
  type DistanceProvider,
  type LatLng,
  type Ranked,
} from "@/lib/geo";
import { foldText } from "./normalize";
import type { BranchView } from "./types";

/**
 * Turning "where is the customer" into a point, and a point into five branches.
 *
 * Both halves are pure and synchronous-in-spirit but async by signature, for the
 * reason set out in `@/lib/geo/ranking`: the Routes API and a real geocoder both
 * arrive later, and neither should force a change above this file.
 */

/** The nearest branches to show. Five, per the brief. */
export const LOCATOR_LIMIT = 5;

export type LocatorResult = Ranked<BranchView>;

/**
 * How an origin was arrived at, which the panel states plainly.
 *
 * An agent reading a distance to a customer needs to know what it was measured
 * *from*. "2.3 km from the pin they sent" and "2.3 km from the middle of Riyadh"
 * are different claims, and only one of them is worth repeating on a call.
 */
export type OriginKind = "coordinates" | "map-link" | "directory-area";

export interface ResolvedOrigin {
  point: LatLng;
  /** The point itself, formatted for display. */
  label: string;
  kind: OriginKind;
  /** One line describing how this was derived, shown under the input. */
  detail: string;
}

export interface OriginResolution {
  origin: ResolvedOrigin | null;
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
/* Falling back to the directory's own geography                              */
/* -------------------------------------------------------------------------- */

/**
 * A coarse origin derived from the branches that match the words typed.
 *
 * Not a geocoder, and the UI never calls it one. It exists because "الحزم" and
 * "Jeddah" are the two things an agent types when they do not have a pin, and
 * the directory already knows roughly where those are — every branch carries a
 * folded haystack of its city, district and address. The centre of the branches
 * that match is a defensible "somewhere around there".
 *
 * Two guards keep it honest. A query matching *every* branch has told us
 * nothing, so it is refused rather than answered with the centre of the country.
 * And the result is labelled with how many branches backed it, so an agent can
 * see at a glance whether it was one street or a whole region.
 */
function directoryAreaOrigin(text: string, branches: readonly BranchView[]): ResolvedOrigin | null {
  const tokens = foldText(text).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  const mappable = branches.filter((branch) => branch.hasCoords);
  if (mappable.length === 0) return null;

  const matches = mappable.filter((branch) =>
    tokens.every((token) => branch.haystack.includes(token)),
  );
  if (matches.length === 0 || matches.length === mappable.length) return null;

  const box = boundsOf(
    matches.map((branch) => ({ lat: branch.latitude as number, lng: branch.longitude as number })),
  );
  if (!box) return null;

  const point = centerOf(box);
  return {
    point,
    label: formatLatLng(point, 4),
    kind: "directory-area",
    detail:
      matches.length === 1
        ? `Approximate area of ${matches[0].branch_no} — no exact address lookup available yet`
        : `Approximate centre of ${matches.length} matching branches — not an exact address`,
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

const OUT_OF_RANGE =
  "Those coordinates are outside Saudi Arabia. Check that latitude comes first — a swapped pair still looks plausible.";

const UNPLACEABLE =
  "Could not place that. Paste coordinates (24.5372, 46.6456) or a Google Maps link, or type a city or district.";

/**
 * Where the customer is.
 *
 * Ordered by how much the answer can be trusted: an explicit pair beats a link,
 * a link beats a geocoder, and a geocoder beats guessing from the directory.
 */
export async function resolveOrigin(
  text: string,
  branches: readonly BranchView[],
  geocode?: Geocoder,
): Promise<OriginResolution> {
  const trimmed = text.trim();
  if (!trimmed) return { origin: null, error: null };

  const pasted = parsePastedPoint(trimmed);
  if (pasted.outOfRange) return { origin: null, error: OUT_OF_RANGE };
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
      error: null,
    };
  }

  if (geocode) {
    const located = await geocode(trimmed);
    if (located && isWithin(located, KSA_BOUNDS)) {
      return {
        origin: {
          point: located,
          label: formatLatLng(located, 5),
          kind: "coordinates",
          detail: "Geocoded address",
        },
        error: null,
      };
    }
  }

  const area = directoryAreaOrigin(trimmed, branches);
  if (area) return { origin: area, error: null };

  return { origin: null, error: UNPLACEABLE };
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
