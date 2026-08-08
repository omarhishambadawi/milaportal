import {
  KSA_BOUNDS,
  directionsUrl,
  formatLatLng,
  haversineMetres,
  isWithin,
  parseCoordinatePair,
  rankByDistance,
  type DistanceProvider,
  type LatLng,
  type Ranked,
} from "@/lib/geo";
import { estimateDelivery, isWithinCoverage, type DeliveryEstimate } from "./delivery-eta";
import {
  describeLocation,
  describeLocationSource,
  normalizePlace,
  resolvePlace,
  splitCityQualifier,
  type LocationEntry,
  type LocationIndex,
  type SearchScope,
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
export const LOCATOR_LIMIT = 20;

/**
 * A row a customer can actually be sent to.
 *
 * The directory carries head office, the regional office and the warehouses
 * alongside the pharmacies, because agents need their switchboards — but they are
 * not branches, and a nearest-branch list is the one place where showing them is
 * actively harmful: the list exists to be read out to a caller, and "your nearest
 * branch is the warehouse" is a mistake an agent cannot un-make on the call.
 *
 * Keyed off `branch.reference`, which `referenceKind` already derives from the
 * branch code, rather than off a list of names spelled here. That is what makes
 * this hold for a facility nobody has added yet: any code that is not a numbered
 * pharmacy is a reference location, so a new warehouse row is excluded the day it
 * is imported without anyone remembering to come back here.
 */
export function isCustomerFacingBranch(branch: BranchView): boolean {
  return branch.reference == null;
}

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
  /**
   * Inside the 10 km normal delivery coverage.
   *
   * The primary sort key and the row's warning badge. Computed here rather than
   * in the panel so the order and the badge cannot disagree about the same
   * branch.
   */
  insideCoverage: boolean;
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
    case "street":
      return { city: entry.city, district: null, street: entry.name, precision: "street" };
    // A landmark is a market, a mosque or a shopping centre. It pins a point
    // precisely enough to measure from, but its *name* is not a street name and
    // must not be matched against one — "حراج الصواريخ" is not an address.
    case "landmark":
      return { city: entry.city, district: null, street: null, precision: "street" };
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
 *      location was already resolved locally" means in code. Its answer is
 *      checked against the city the agent named before it is believed; see
 *      `agreesWithCity`.
 *   4. **The named city itself.** When every step above failed but the query
 *      named a city the directory knows, that city's centroid is the answer. It
 *      is coarse and the origin line says so, which is strictly better than the
 *      "nothing matches that" this used to return for a real Saudi address whose
 *      district happens to have no branch in it.
 *
 * An *ambiguous* local result also stops the cascade. The place was found; the
 * only open question is which city, and asking a geocoder would replace a
 * question the agent can answer with a guess they cannot check.
 *
 * `scope.city`, when the agent has set the dropdown, is threaded into step 1 and
 * appended to the step-3 query. It is what turns "الروضة" from a question into an
 * answer, and it is optional throughout — the cascade behaves exactly as before
 * when nothing is selected.
 */
export async function resolveOrigin(
  text: string,
  index: LocationIndex,
  geocode?: Geocoder,
  scope?: SearchScope,
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
  const place = resolvePlace(index, trimmed, scope);
  if (place.status === "found") {
    return { origin: originFromPlace(place.entry), choices: [], error: null };
  }
  if (place.status === "ambiguous") {
    return { origin: null, choices: place.choices, error: null };
  }

  // The city the agent named, whether they typed it or chose it. Everything
  // below is about not throwing that away: it is the strongest signal in the
  // query, and the old cascade dropped it the moment the local index missed.
  const namedCity = splitCityQualifier(index, trimmed).city ?? scope?.city ?? null;
  const anchor = namedCity ? cityEntry(index, namedCity) : null;

  // Step 3. Only now, and only if a provider was supplied.
  if (geocode) {
    // The city goes into the query text rather than a parameter, because that is
    // the only place a geocoder can take it: "الروضة" alone is a name in a dozen
    // Saudi cities, and "الروضة الرياض" is one place. Appended rather than
    // prepended so the thing being searched for still leads the string.
    const query = scope?.city ? `${trimmed} ${scope.city}` : trimmed;
    const hit = asHit(await geocode(query));
    if (hit && isWithin(hit.point, KSA_BOUNDS) && agreesWithCity(hit, anchor)) {
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

  // The geocoder had nothing, or had something that contradicted the city the
  // agent named. That city is still a real answer: coarser than the district they
  // asked for, but in the right place — and a city centroid that says so on the
  // origin line beats a confident pin in the wrong half of the country.
  if (anchor) return { origin: originFromPlace(anchor), choices: [], error: null };

  return { origin: null, choices: [], error: UNPLACEABLE };
}

/** The gazetteer's entry for a city, by name as the directory writes it. */
function cityEntry(index: LocationIndex, city: string): LocationEntry | null {
  const key = normalizePlace(city);
  if (!key) return null;
  return index.entries.find((entry) => entry.kind === "city" && entry.key === key) ?? null;
}

/**
 * How far a geocoded point may sit from the centre of the city it claims to be
 * in before the claim is disbelieved.
 *
 * Generous on purpose. Riyadh is roughly 70 km across and the gazetteer's centre
 * is the mean of the branches in it rather than the municipal centroid, so a
 * legitimate outer-suburb district can be a long way from it. This is a sanity
 * bound against an answer in the *wrong city* — the failure that actually
 * happens, where a bare Arabic district name resolves to a same-named place a
 * region away — not an attempt to police which suburb is plausible.
 */
const CITY_SANITY_RADIUS_M = 75_000;

/**
 * Does a geocoder's answer agree with the city the agent named?
 *
 * Duplicate neighbourhood names are the norm here rather than the exception, and
 * a geocoder asked for one in Arabic answers with whichever it ranks highest —
 * which is how "حي النخيل" with Riyadh on the query resolved to a النخيل
 * elsewhere, and why the nearest branch came back 50 km away instead of 3.
 *
 * Two ways to agree, because the provider may or may not return names: the city
 * it resolved matches the one asked for, or — when it named no city, or named one
 * under a spelling the directory does not use — the point is at least in the
 * right part of the country. Nothing to check against means nothing to disagree
 * with, so an unqualified query passes untouched.
 */
function agreesWithCity(hit: GeocodeHit, anchor: LocationEntry | null): boolean {
  if (!anchor) return true;
  if (hit.city && sameName(hit.city, anchor.name)) return true;
  return haversineMetres(hit.point, anchor.point) <= CITY_SANITY_RADIUS_M;
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
 * Each result carries the two things the panel cannot work out for itself — a
 * delivery band and whether the branch is inside coverage — computed once here
 * rather than per render, and the list is then ordered by business relevance
 * rather than by kilometres alone. See `compareResults` for the rules.
 *
 * The generic ranker is asked for more than `limit` so the reordering has
 * candidates to work with, then the list is cut. The over-fetch is bounded
 * because a future Routes provider is billed per element.
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
    // Filtered before anything is measured, not after. Ranking the warehouses and
    // then dropping them would leave the over-fetch below short by however many
    // happened to be nearby, so a customer next door to head office would get a
    // list one branch shorter than everyone else's.
    branches.filter(isCustomerFacingBranch),
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
          insideCoverage: isWithinCoverage(entry.distance.metres),
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
 * Width of the band inside which two branches count as the same distance.
 *
 * 500m is inside the error of a district centroid and a straight-line
 * approximation, so within it the closer branch is not *meaningfully* closer —
 * which is what makes it safe to let an operational attribute decide instead.
 */
const TIE_BAND_METRES = 500;

/**
 * The branch most likely to actually serve this customer, first.
 *
 * Business relevance rather than raw geometry, in the order the rules state it:
 *
 *   1. **Inside the 10 km coverage.** A branch that can deliver beats one that
 *      cannot, at any distance. This is the one place where the list deliberately
 *      contradicts the kilometres printed on it, and it is the whole point: a
 *      9 km branch that delivers is a better answer than an 11 km branch that
 *      needs an exception, and sorting the 11 km one first would recommend it.
 *   2. **Nearest.** Within the same coverage class, distance decides.
 *   3. **Scooter, on a tie.** Two branches whose distances differ by under 500m
 *      are the same distance as far as anyone can tell, so the one with its own
 *      rider wins — it does not depend on partner capacity. The badge for this
 *      was removed from the row on purpose: it is an input to the ordering, not
 *      something an agent needs to read on every line.
 *   4. **Locality, then exact metres**, so the order is total and stable.
 */
function compareResults(a: LocatorResult, b: LocatorResult): number {
  if (a.insideCoverage !== b.insideCoverage) return a.insideCoverage ? -1 : 1;

  // Fixed 500m buckets rather than `|a - b| < 500`.
  //
  // The pairwise test is the obvious reading of the rule and it is not a valid
  // comparator: with branches at 0m, 400m and 800m it calls the first two equal
  // and the last two equal but the outer pair ordered, which is intransitive, and
  // `Array.prototype.sort` given an intransitive comparator produces an
  // implementation-defined order — the list would reshuffle for no visible
  // reason. Bucketing is transitive by construction. The cost is that 499m and
  // 501m land in different buckets despite being 2m apart, which is the standard
  // trade and invisible at the precision the distances are quoted to.
  const bandA = Math.floor(a.distance.metres / TIE_BAND_METRES);
  const bandB = Math.floor(b.distance.metres / TIE_BAND_METRES);
  if (bandA !== bandB) return bandA - bandB;

  if (a.item.scooter !== b.item.scooter) return a.item.scooter ? -1 : 1;
  if (a.localityRank !== b.localityRank) return a.localityRank - b.localityRank;
  return a.distance.metres - b.distance.metres;
}

/* -------------------------------------------------------------------------- */
/* Directions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A Google Maps directions link from the customer to a branch.
 *
 * The URL itself is built by `@/lib/geo`'s `directionsUrl`, which the portal
 * already uses everywhere else; this is only the branch-shaped wrapper around it.
 * It exists to hold the one thing that is specific to the locator and easy to get
 * wrong: the origin is **the resolved search location**, not the device's
 * position. An agent sitting in Riyadh needs the route from the customer in
 * Jeddah to the Jeddah branch, and the existing per-branch `navLink` — which
 * takes no origin at all — would quietly have routed from the call floor.
 *
 * Coordinates on both ends, never place names: a name is a fresh geocode at the
 * far end and can resolve somewhere else entirely.
 *
 * Returns null when the branch has no coordinates, so the caller renders a
 * disabled control rather than a link to a broken route.
 */
export function branchDirectionsUrl(origin: LatLng, branch: BranchView): string | null {
  if (!branch.hasCoords) return null;
  return directionsUrl(
    { lat: branch.latitude as number, lng: branch.longitude as number },
    { origin, mode: "driving" },
  );
}
