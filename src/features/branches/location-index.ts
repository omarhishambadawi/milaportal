import { centroidOf, type LatLng } from "@/lib/geo";
import { addressSegments, isCitySegment } from "./district";
import { cityAliases, cityEnglish, foldText } from "./normalize";
import type { BranchView } from "./types";

/**
 * The Saudi location index.
 *
 * A geocoder built out of the directory the portal already has, rather than a
 * call to one. Every branch carries a city, a district read out of its address,
 * and coordinates; grouping those gives a gazetteer of exactly the places this
 * business operates in, which is the only geography the Branch Locator is ever
 * asked about. It costs one pass over ~150 rows, holds a few hundred entries,
 * answers a keystroke in microseconds, and needs no key, no quota and no
 * network.
 *
 * What it deliberately is not: a general geocoder. It knows the districts that
 * contain a branch and nothing else, so a customer in a district with no branch
 * resolves to their city instead. That is the honest failure mode — the answer
 * is coarser, never wrong — and it is why every resolved origin says what it
 * was derived from and how many branches backed it.
 *
 * The whole module is pure. `buildLocationIndex` is called once per dataset and
 * memoized by the caller; `searchLocations` allocates nothing per query beyond
 * its result array.
 */

export type LocationKind = "city" | "district" | "area";

export interface LocationEntry {
  /** Stable across rebuilds of the same dataset; used as a React key. */
  id: string;
  kind: LocationKind;
  /** As written in the sheet, for display. */
  name: string;
  /** English name, for cities we have an alias table for. Null otherwise. */
  english: string | null;
  /** The city this sits in. Null on a city entry, which is its own city. */
  city: string | null;
  cityEnglish: string | null;
  /** Centre of mass of the branches that back this place. */
  point: LatLng;
  branchCount: number;
  /** Folded, prefix-stripped primary name. The key exact and prefix tests use. */
  key: string;
  /** Every folded string that should match this entry, `key` included. */
  terms: readonly string[];
}

export interface LocationIndex {
  entries: readonly LocationEntry[];
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Words that classify a place rather than name it.
 *
 * "حي الحزم" and "الحزم" are the same district, and an agent will type either.
 * Dropping the classifier from both the index and the query is what makes them
 * meet. Stored folded, because `foldText` rewrites ة to ه — "مدينة" is "مدينه"
 * by the time anything is compared.
 *
 * The Arabic list is the one the brief specifies; the English half exists
 * because the same agent types "Al Hazm district" half an hour later.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set(
  [
    "حي",
    "شارع",
    "ش",
    "طريق",
    "مدينة",
    "محافظة",
    "المملكة",
    "السعودية",
    "العربية",
    "حارة",
    "منطقة",
    "district",
    "street",
    "st",
    "road",
    "rd",
    "city",
    "province",
    "governorate",
    "neighborhood",
    "neighbourhood",
    "area",
    "saudi",
    "arabia",
    "ksa",
    "al",
  ].map(foldText),
);

/**
 * Fold a place name to the form the index compares on.
 *
 * `foldText` already does the Arabic work — hamza forms, ta marbuta, alef
 * maqsura, harakat, tatweel, Arabic-Indic digits, lowercasing. This adds the
 * place-specific half: dropping the classifier words above, and collapsing the
 * punctuation that separates a compound name.
 */
export function normalizePlace(text: string): string {
  return foldText(text.replace(/[-_.،,/\\|()]+/g, " "))
    .split(" ")
    .filter((word) => word.length > 0 && !NOISE_WORDS.has(word))
    .join(" ");
}

/**
 * The same name without its definite articles.
 *
 * Indexed as an *extra* term rather than replacing the primary one: an agent
 * types "روضة" for "الروضة" constantly, but "ال" is also the first two letters
 * of real names, so stripping it everywhere would merge places that differ.
 * Only applied to words long enough that what remains is still a name.
 */
function withoutArticle(normalized: string): string {
  return normalized
    .split(" ")
    .map((word) => (word.length > 4 && word.startsWith("ال") ? word.slice(2) : word))
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Fuzzy matching                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`.
 *
 * Two rows rather than a full matrix, and a length check before any work: the
 * index is searched on every keystroke against a few hundred entries, so the
 * common case — a candidate that is nowhere near — has to cost almost nothing.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      if (current[j] < rowBest) rowBest = current[j];
    }
    // Every future row is at least this large, so nothing below can come back
    // under the budget.
    if (rowBest > max) return max + 1;
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/** How many edits a query of this length may be wrong by. */
function tolerance(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

interface Bucket {
  name: string;
  city: string | null;
  points: LatLng[];
}

function positionOf(branch: BranchView): LatLng | null {
  return branch.hasCoords
    ? { lat: branch.latitude as number, lng: branch.longitude as number }
    : null;
}

function bucketKey(kind: LocationKind, city: string | null, name: string): string {
  return `${kind}:${city ?? ""}:${normalizePlace(name)}`;
}

/**
 * Turn the directory into a gazetteer.
 *
 * Three kinds, in decreasing confidence:
 *
 *   - **city** — the `city` column, which is curated and comes with an English
 *     alias table.
 *   - **district** — `branch.district`, already read out of the address by
 *     `extractDistrict` when the dataset was decorated. Reused rather than
 *     re-derived, so the index and the branch card agree about what a district
 *     is by construction.
 *   - **area** — any other address segment: streets, markets, landmarks. Noisy,
 *     ranked last, and included because "حراج الصواريخ" is a real thing a
 *     customer says and the sheet does record it.
 *
 * Only branches with coordinates contribute. A place backed by nothing
 * locatable cannot be an origin, so indexing it would offer the agent a
 * suggestion that resolves to nowhere.
 */
export function buildLocationIndex(branches: readonly BranchView[]): LocationIndex {
  const buckets = new Map<string, Bucket>();

  const add = (kind: LocationKind, name: string, city: string | null, point: LatLng) => {
    const normalized = normalizePlace(name);
    // A segment that is only a classifier ("حي") normalizes to nothing.
    if (!normalized) return;
    const id = bucketKey(kind, city, name);
    const existing = buckets.get(id);
    if (existing) {
      existing.points.push(point);
      return;
    }
    buckets.set(id, { name, city, points: [point] });
  };

  for (const branch of branches) {
    const point = positionOf(branch);
    if (!point) continue;

    add("city", branch.city, null, point);
    if (branch.district) add("district", branch.district, branch.city, point);

    // Everything in the address that is neither the city nor the district.
    for (const segment of addressSegments(branch.address)) {
      if (isCitySegment(segment, branch.city)) continue;
      if (branch.district && normalizePlace(segment) === normalizePlace(branch.district)) continue;
      if (segment.length > 40) continue;
      add("area", segment, branch.city, point);
    }
  }

  const entries: LocationEntry[] = [];
  for (const [id, bucket] of buckets) {
    const point = centroidOf(bucket.points);
    if (!point) continue;

    const kind = id.split(":")[0] as LocationKind;
    const key = normalizePlace(bucket.name);

    const terms = new Set<string>([key, withoutArticle(key)]);

    // Cities carry a curated English/transliteration table. Districts do not —
    // the sheet writes them in Arabic only — which is the main reason English
    // input resolves to a city rather than a district.
    const english = kind === "city" ? cityEnglish(bucket.name) : null;
    if (kind === "city") {
      for (const alias of cityAliases(bucket.name)) {
        const normalized = normalizePlace(alias);
        if (normalized) terms.add(normalized);
      }
    }

    entries.push({
      id,
      kind,
      name: bucket.name,
      english,
      city: bucket.city,
      cityEnglish: bucket.city ? cityEnglish(bucket.city) : english,
      point,
      branchCount: bucket.points.length,
      key,
      terms: [...terms].filter(Boolean),
    });
  }

  return { entries };
}

/* -------------------------------------------------------------------------- */
/* Searching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Match quality, lower is better. The tiers are ordered by how much the match
 * can be trusted, not by how it was computed.
 */
const SCORE = {
  exact: 0,
  alias: 1,
  prefix: 2,
  contains: 3,
  /** Fuzzy adds the edit distance on top, so one typo beats two. */
  fuzzy: 4,
} as const;

/** Cities first when everything else ties: they are curated, areas are guessed. */
const KIND_RANK: Record<LocationKind, number> = { city: 0, district: 1, area: 2 };

export interface LocationMatch {
  entry: LocationEntry;
  score: number;
}

function scoreEntry(entry: LocationEntry, query: string, budget: number): number | null {
  let best: number | null = null;
  const consider = (value: number) => {
    if (best == null || value < best) best = value;
  };

  for (const term of entry.terms) {
    if (term === query) {
      consider(term === entry.key ? SCORE.exact : SCORE.alias);
      continue;
    }
    if (term.startsWith(query)) consider(SCORE.prefix);
    else if (term.includes(query)) consider(SCORE.contains);
    // A typo is only worth chasing when nothing better already matched, and
    // only against terms of comparable length.
    else if (budget > 0 && (best == null || best > SCORE.contains)) {
      const distance = editDistance(query, term, budget);
      if (distance <= budget) consider(SCORE.fuzzy + distance);
    }
  }

  return best;
}

/**
 * Places matching what has been typed, best first.
 *
 * Runs on every keystroke — it backs the autocomplete as well as submission —
 * so it is one pass over the index with an early bail per entry.
 */
export function searchLocations(index: LocationIndex, query: string, limit = 8): LocationMatch[] {
  const normalized = normalizePlace(query);
  if (!normalized) return [];

  const budget = tolerance(normalized.length);
  const matches: LocationMatch[] = [];

  for (const entry of index.entries) {
    const score = scoreEntry(entry, normalized, budget);
    if (score != null) matches.push({ entry, score });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const kind = KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind];
    if (kind !== 0) return kind;
    // More branches behind a place makes it both a likelier target and a more
    // meaningful centroid.
    if (a.entry.branchCount !== b.entry.branchCount) {
      return b.entry.branchCount - a.entry.branchCount;
    }
    return a.entry.name.localeCompare(b.entry.name);
  });

  return matches.slice(0, limit);
}

export type PlaceResolution =
  | { status: "found"; entry: LocationEntry }
  /** The name belongs to several places; the agent has to say which. */
  | { status: "ambiguous"; choices: LocationEntry[] }
  | { status: "none" };

/**
 * Resolve a typed place to exactly one entry, or ask.
 *
 * "الروضة" is a district in Riyadh, in Jeddah and in Dammam, and picking the
 * one with the most branches would silently send an agent to the wrong city.
 * Ambiguity is only raised when the tie is a *good* match in more than one
 * city — two fuzzy near-misses are not a question worth asking, they are just
 * a weak result.
 */
export function resolvePlace(index: LocationIndex, query: string): PlaceResolution {
  const matches = searchLocations(index, query, 12);
  if (matches.length === 0) return { status: "none" };

  const best = matches[0].score;
  const tied = matches.filter((match) => match.score === best).map((match) => match.entry);

  if (tied.length > 1 && best <= SCORE.alias) {
    const cities = new Set(tied.map((entry) => entry.city ?? entry.name));
    if (cities.size > 1) return { status: "ambiguous", choices: tied };
  }

  return { status: "found", entry: tied[0] };
}

/** "Al Hazm · Riyadh" — how an entry reads in a list. */
export function describeLocation(entry: LocationEntry): string {
  const parts = [entry.name];
  if (entry.english && entry.english !== entry.name) parts.push(entry.english);
  const label = parts.join(" · ");
  if (entry.kind === "city") return label;
  const city = entry.cityEnglish ?? entry.city;
  return city ? `${label} — ${city}` : label;
}

/** What an entry's centroid was derived from, for the origin line. */
export function describeLocationSource(entry: LocationEntry): string {
  const scope = entry.kind === "city" ? "city" : entry.kind === "district" ? "district" : "area";
  const backing = entry.branchCount === 1 ? "1 branch" : `${entry.branchCount} branches`;
  return `Centre of the ${backing} in this ${scope} — approximate, from the directory`;
}
