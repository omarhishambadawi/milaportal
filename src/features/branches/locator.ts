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
import { estimateDelivery, type DeliveryEstimate } from "./delivery-eta";
import {
  describeLocation,
  describeLocationSource,
  normalizePlace,
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

/**
 * How tightly an origin was pinned down.
 *
 * Declared here rather than in the OpenStreetMap module because it is part of
 * the `Geocoder` contract every provider answers against, not a Nominatim
 * detail — and putting it here is what keeps the dependency one-way.
 *
 * Coarse on purpose. Four buckets are all the ranking distinguishes, and a
 * numeric score would imply a resolution the underlying signal does not have.
 */
export type GeocodePrecision = "street" | "district" | "city" | "region" | "unknown";

/**
 * Where the customer is, as far as the resolver could tell.
 *
 * Every name is null for a pasted coordinate pair — a bare point carries no
 * district — which is exactly the case where the delivery band falls back to
 * distance alone rather than pretending to know more.
 */
export interface OriginLocality {
  city: string | null;
  district: string | null;
  /** The street or area the origin named, when it named one. */
  street: string | null;
  /**
   * How specific the resolved place is.
   *
   * Load-bearing rather than diagnostic: a hit that matched a whole city may
   * still carry a `district` name — the district the city centroid happens to
   * sit in — and treating that as "the customer's neighbourhood" would hand a
   * 20–30 minute band to a branch chosen by an accident of geometry. See
   * `namesLocality`.
   */
  precision: GeocodePrecision;
}

export type LocatorResult = Ranked<BranchView> & {
  /** Delivery band, computed once at ranking time rather than per render. */
  eta: DeliveryEstimate;
  /** The customer's neighbourhood is this branch's neighbourhood. */
  sameDistrict: boolean;
  sameCity: boolean;
  /** The origin's street is this branch's street — the finest signal there is. */
  sameStreet: boolean;
  /** 0 street, 1 district, 2 city, 3 neither. Breaks equal delivery bands. */
  localityRank: number;
};

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
  /**
   * The customer's city and neighbourhood when they are known.
   *
   * Drives both the delivery band and the locality tie-break. Empty for a bare
   * coordinate pair, which is the honest answer — a pin says where, not which
   * district, and inferring the district from the nearest branch would be
   * circular reasoning feeding the ranking that chose it.
   */
  locality: OriginLocality;
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
export interface GeocodeHit {
  point: LatLng;
  /** Names the provider resolved alongside the point, when it returns them. */
  city?: string | null;
  district?: string | null;
  street?: string | null;
  /** How specific the match was. Absent is treated as `unknown`. */
  precision?: GeocodePrecision;
}

/**
 * A provider may answer with a bare point or with a point plus the names around
 * it. The richer shape is what lets a geocoded origin still get a neighbourhood
 * tie-break and a same-district delivery band; the bare shape stays valid so a
 * minimal provider — and every existing test — keeps working.
 */
export type Geocoder = (text: string) => Promise<GeocodeHit | LatLng | null>;

function asHit(value: GeocodeHit | LatLng | null): GeocodeHit | null {
  if (!value) return null;
  return "point" in value ? value : { point: value };
}

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
    locality: localityOfEntry(entry),
  };
}

/**
 * What a gazetteer entry says about where the customer is.
 *
 * A city entry is its own city and names no neighbourhood. A district entry
 * names one. An `area` entry is a street, a market or a landmark — the index
 * does not distinguish them, so it is offered as a street match and nothing
 * more, which is the level at which a wrong guess costs a tie-break rather than
 * a delivery promise. A `branch` entry is an exact address, so it contributes
 * whatever that branch's own address parsed to.
 */
function localityOfEntry(entry: LocationEntry): OriginLocality {
  switch (entry.kind) {
    case "city":
      return { city: entry.name, district: null, street: null, precision: "city" };
    case "district":
      return { city: entry.city, district: entry.name, street: null, precision: "district" };
    case "area":
      return { city: entry.city, district: null, street: entry.name, precision: "street" };
    case "branch":
      return { city: entry.city, district: null, street: null, precision: "street" };
  }
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
        // A pin is a point, not a place name.
        locality: { city: null, district: null, street: null, precision: "unknown" },
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
    const hit = asHit(await geocode(trimmed));
    if (hit && isWithin(hit.point, KSA_BOUNDS)) {
      const named = [hit.district, hit.city].filter(Boolean).join(", ");
      return {
        origin: {
          point: hit.point,
          // Prefer the names the provider resolved: "Al Rawais, Jeddah" is what
          // an agent can read back, where a coordinate pair is not.
          label: named || formatLatLng(hit.point, 5),
          kind: "geocoded",
          detail: "Found on OpenStreetMap — outside the branch directory",
          locality: {
            city: hit.city ?? null,
            district: hit.district ?? null,
            street: hit.street ?? null,
            precision: hit.precision ?? "unknown",
          },
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
 * Whether an origin's district and street names describe the origin itself.
 *
 * A city-level or region-level hit resolves to a centroid, and the names that
 * come back with it belong to whatever happens to sit at that centroid — not to
 * the customer. Reading "Al Olaya" off the middle of Riyadh and then handing
 * every Al Olaya branch a same-neighbourhood delivery band would be inventing
 * information, so at those precisions only the city name is believed.
 */
function namesLocality(precision: GeocodePrecision): boolean {
  return precision !== "city" && precision !== "region";
}

/** How the customer's location relates to one branch's. Lower rank is closer. */
interface LocalityMatch {
  street: boolean;
  district: boolean;
  city: boolean;
  /** 0 street, 1 district, 2 city, 3 neither. */
  rank: number;
}

const NO_MATCH: LocalityMatch = { street: false, district: false, city: false, rank: 3 };

/**
 * Match the origin's names against one branch's.
 *
 * Three signals, finest first, all folded through the gazetteer's own rules so
 * that "شارع فلسطين" and "ش فلسطين" are one street. A street match implies the
 * district as far as ranking is concerned — two addresses on the same street in
 * the same city are in the same neighbourhood whatever the sheet wrote in the
 * حي segment, and the sheet does not always write one.
 */
function matchLocality(branch: BranchView, locality: OriginLocality | undefined): LocalityMatch {
  if (!locality) return NO_MATCH;

  const city = Boolean(locality.city && sameName(locality.city, branch.city));
  if (!namesLocality(locality.precision)) {
    return city ? { street: false, district: false, city: true, rank: 2 } : NO_MATCH;
  }

  // A street name only means the same neighbourhood if it is the same city's
  // street: "شارع الملك عبدالعزيز" exists in every city in the country.
  const street = Boolean(
    city && locality.street && branch.street && sameName(locality.street, branch.street),
  );
  const district = Boolean(
    locality.district && branch.district && sameName(locality.district, branch.district),
  );

  if (street) return { street: true, district: true, city: true, rank: 0 };
  if (district) return { street: false, district: true, city, rank: 1 };
  if (city) return { street: false, district: false, city: true, rank: 2 };
  return NO_MATCH;
}

/** Compare two place names through the index's own folding rules. */
function sameName(a: string, b: string): boolean {
  const folded = normalizePlace(a);
  return folded.length > 0 && folded === normalizePlace(b);
}

/**
 * The nearest branches to a point, with a delivery band on each.
 *
 * A thin adapter over the generic ranker: its only job is knowing that a branch
 * keeps its position in `latitude`/`longitude` and that `hasCoords` says whether
 * those are real. Swapping Haversine for Routes is a `provider` argument here
 * and nothing else anywhere.
 *
 * Two things happen on top of the distance sort:
 *
 *   - **A delivery band is attached**, computed once here rather than per render,
 *     from the distance *and* the locality the origin resolved to.
 *   - **The band decides the order**, with distance breaking equal bands.
 *
 * Ordering by the estimate rather than by raw kilometres is what "prefer a
 * branch in the same neighbourhood" actually requires, and it is the only
 * ordering the row can defend: the band is the number printed largest on it, so
 * a list sorted by anything else would visibly contradict itself. The effect is
 * bounded and always in the same direction — a same-neighbourhood branch can
 * overtake a marginally nearer one across the district boundary, because
 * crossing that boundary is precisely what the slower band is modelling. A
 * genuinely nearer branch keeps its place, since distance drives the band too.
 *
 * The generic ranker is asked for more than `limit` so locality has candidates
 * to reorder, then the list is cut. The over-fetch is bounded because a future
 * Routes provider is billed per element.
 */
export function rankNearestBranches(
  origin: LatLng,
  branches: readonly BranchView[],
  options: {
    limit?: number;
    provider?: DistanceProvider;
    /** Where the customer is, when the resolver knew. */
    locality?: OriginLocality;
  } = {},
): Promise<LocatorResult[]> {
  const limit = options.limit ?? LOCATOR_LIMIT;

  return rankByDistance(
    origin,
    branches,
    (branch) =>
      branch.hasCoords ? { lat: branch.latitude as number, lng: branch.longitude as number } : null,
    { limit: limit * 2 + 10, provider: options.provider },
  ).then((ranked) =>
    ranked
      .map((entry) => {
        const match = matchLocality(entry.item, options.locality);
        return {
          ...entry,
          eta: estimateDelivery({
            metres: entry.distance.metres,
            sameDistrict: match.district,
            sameCity: match.city,
          }),
          sameDistrict: match.district,
          sameCity: match.city,
          sameStreet: match.street,
          localityRank: match.rank,
        };
      })
      .sort(compareResults)
      .slice(0, limit),
  );
}

/**
 * Soonest arrival first.
 *
 * The open-ended top band ("60+") sorts last among equal minima, because "an
 * hour or more" is a weaker promise than "an hour at the outside". Locality
 * breaks a genuine tie ahead of distance so that two branches sharing a band
 * are offered nearest-neighbourhood-first, which is the one an agent should read
 * out even when the kilometres are a wash.
 */
function compareResults(a: LocatorResult, b: LocatorResult): number {
  if (a.eta.minMinutes !== b.eta.minMinutes) return a.eta.minMinutes - b.eta.minMinutes;
  const maxA = a.eta.maxMinutes ?? Number.POSITIVE_INFINITY;
  const maxB = b.eta.maxMinutes ?? Number.POSITIVE_INFINITY;
  if (maxA !== maxB) return maxA - maxB;
  if (a.localityRank !== b.localityRank) return a.localityRank - b.localityRank;
  return a.distance.metres - b.distance.metres;
}
