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

/**
 * What kind of place an entry is, in the order a tie between them is broken.
 *
 * `street` and `landmark` were one `area` kind until the resolution priority was
 * specified as city → district → street → landmark: a single bucket cannot
 * express the last two steps. The split is cheap because the address segment
 * already says which it is — "ش علي النقيب" and "طريق الملك فهد" announce
 * themselves with a classifier, and "حراج الصواريخ" (a market) does not.
 */
export type LocationKind = "city" | "district" | "street" | "landmark" | "branch";

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
  /** Set on a `branch` entry: the code, so a hit can name the branch itself. */
  branchNo?: string;
  /** Folded, prefix-stripped primary name. The key exact and prefix tests use. */
  key: string;
  /** Every folded string that should match this entry, `key` included. */
  terms: readonly string[];
}

export interface LocationIndex {
  entries: readonly LocationEntry[];
  /**
   * Bigram → indices into `entries`, built once so a keystroke costs a handful
   * of map lookups instead of a pass over every entry and every one of its
   * terms. See `candidateIndices` for how the lists are combined — the short
   * answer is "rarest first", because "ال" is in nearly every Saudi place name
   * and its list is therefore almost the whole gazetteer.
   */
  byBigram: ReadonlyMap<string, readonly number[]>;
  /** First character → entry indices, for one-character queries. */
  byFirstChar: ReadonlyMap<string, readonly number[]>;
  /**
   * Every folded term that names a city → that city as the directory writes it.
   *
   * Built here rather than derived per query because `splitCityQualifier` runs on
   * every keystroke and every submission, and scanning the entries for city kinds
   * each time would undo the point of having postings lists at all. Includes the
   * curated English aliases, so "riyadh" qualifies a query exactly as "الرياض"
   * does.
   */
  cityByTerm: ReadonlyMap<string, string>;
}

/** Overlapping two-character windows: "riyadh" → ri, iy, ya, ad, dh. */
function bigrams(text: string): string[] {
  if (text.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
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
/**
 * Words that mark an address segment as a street rather than a landmark.
 *
 * Tested against the **raw** segment, not the normalized one: `normalizePlace`
 * strips exactly these as noise, which is correct for matching ("شارع فلسطين"
 * and "فلسطين" are the same street) and useless for classifying. So the
 * classifier reads the text before that happens.
 */
const STREET_WORDS: ReadonlySet<string> = new Set(
  ["شارع", "ش", "طريق", "street", "st", "str", "road", "rd", "avenue", "ave", "highway", "hwy"].map(
    foldText,
  ),
);

/** Street or landmark, from the classifier the sheet already wrote. */
function segmentKind(segment: string): "street" | "landmark" {
  const words = foldText(segment.replace(/[-_.،,/\\|()]+/g, " ")).split(" ");
  return words.some((word) => STREET_WORDS.has(word)) ? "street" : "landmark";
}

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
  /** Extra folded strings this bucket answers to — a branch's code and address. */
  extraTerms?: string[];
  branchNo?: string;
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
 *   - **branch** — the branch itself, answering to its code and its full written
 *     address. This is the "search the uploaded dataset" step: an agent who
 *     types "P0021" or pastes the whole address line has named a location just
 *     as precisely as a district, and its point is exact rather than a centroid.
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
      add(segmentKind(segment), segment, branch.city, point);
    }

    // The branch itself. Keyed by code so two branches never share a bucket,
    // and answering to its full address so pasting an address line works.
    buckets.set(`branch::${normalizePlace(branch.branch_no)}`, {
      name: branch.branch_no,
      city: branch.city,
      points: [point],
      branchNo: branch.branch_no,
      // Address only. Deliberately *not* the manager's name or the phone
      // number: matching a location query against those is what the crude
      // fallback this replaced used to do, and "الحزم" hitting a branch because
      // its area manager is called Hazem is a wrong answer that looks right.
      extraTerms: [branch.address, branch.addressLine].filter((value): value is string =>
        Boolean(value),
      ),
    });
  }

  const entries: LocationEntry[] = [];
  for (const [id, bucket] of buckets) {
    const point = centroidOf(bucket.points);
    if (!point) continue;

    const kind = id.split(":")[0] as LocationKind;
    const key = normalizePlace(bucket.name);

    const terms = new Set<string>([key, withoutArticle(key)]);
    for (const extra of bucket.extraTerms ?? []) {
      const normalized = normalizePlace(extra);
      if (normalized) terms.add(normalized);
    }

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
      branchNo: bucket.branchNo,
      key,
      terms: [...terms].filter(Boolean),
    });
  }

  // Postings. Built once here so a keystroke costs a few map lookups instead of
  // a pass over every entry and every one of its terms.
  const byBigram = new Map<string, number[]>();
  const byFirstChar = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, gram: string, index: number) => {
    const list = map.get(gram);
    if (list) {
      // Terms of one entry share bigrams constantly; the list is append-ordered
      // so the duplicate is always the tail.
      if (list[list.length - 1] !== index) list.push(index);
    } else {
      map.set(gram, [index]);
    }
  };

  entries.forEach((entry, index) => {
    for (const term of entry.terms) {
      if (term.length > 0) push(byFirstChar, term[0], index);
      for (const gram of bigrams(term)) push(byBigram, gram, index);
    }
  });

  // City terms, for reading a city out of the middle of a typed query.
  const cityByTerm = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "city") continue;
    for (const term of entry.terms) {
      // First writer wins: two cities never share a term in practice, and if the
      // dataset ever produced one, silently reassigning it per iteration order
      // would make the split non-deterministic across rebuilds.
      if (term && !cityByTerm.has(term)) cityByTerm.set(term, entry.name);
    }
  }

  return { entries, byBigram, byFirstChar, cityByTerm };
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

/**
 * Cities first when everything else ties: they are curated, areas are guessed.
 *
 * `branch` sits last not because it is least trustworthy — its point is exact —
 * but because it is the most specific: someone who types a name matching both a
 * district and a branch inside it almost always means the district. An exact
 * code match scores 0 and outranks any of this regardless.
 */
const KIND_RANK: Record<LocationKind, number> = {
  city: 0,
  district: 1,
  street: 2,
  landmark: 3,
  branch: 4,
};

export interface LocationMatch {
  entry: LocationEntry;
  score: number;
  /** True when a city scope was supplied and this entry sits in it. */
  inScope: boolean;
}

/** Optional narrowing applied to a search. */
export interface SearchScope {
  /**
   * Restrict attention to one city, as written in the directory.
   *
   * A *preference*, not a filter, and the difference matters on a call. An agent
   * who has set the city to Riyadh and types a district that only exists in
   * Jeddah should still be shown the Jeddah district — labelled with its city, at
   * the bottom of the list — rather than told nothing matches. Silence would
   * leave them re-typing a name that was correct all along.
   */
  city?: string | null;
  /**
   * Treat `city` as a filter rather than a preference.
   *
   * Set only when the city came from the **query text itself** — "حي النخيل،
   * الرياض" — never from the dropdown. The two are different statements: the
   * dropdown is a standing hint the agent set once and may have forgotten, so
   * out-of-city matches stay visible underneath it; a city typed into this
   * particular query is that query's answer to "which one", and showing the
   * Buraydah النخيل underneath it would re-open the exact question the agent just
   * closed.
   */
  strictCity?: boolean;
}

/**
 * A place name and the city that qualified it, pulled apart.
 *
 * The single fix for the largest class of wrong answer this feature had. Every
 * term in the gazetteer is *one* place — the district "النخيل", the city
 * "الرياض" — but Saudi addresses are dictated as both at once, so "حي النخيل،
 * الرياض" arrived as the seven-character-longer string `"النخيل الرياض"` and
 * matched nothing: not the district (whose term is six characters shorter than
 * the query, so even the fuzzy budget rejects it on length alone), not the city,
 * not any branch. The search then fell through to OpenStreetMap, whose answer for
 * a bare Arabic district name is the coin-flip that put a customer in النخيل
 * 50 km from the branch that is actually 3 km away.
 *
 * Splitting first turns that into two facts the gazetteer already holds
 * precisely, and it generalizes: any "<place> <city>" or "<city> <place>" a Saudi
 * agent dictates resolves the same way, with no per-neighbourhood knowledge.
 */
export interface CityQualifiedQuery {
  /** The place being searched for, folded, with the city name removed. */
  text: string;
  /** The city named inside the query, as the directory writes it. */
  city: string | null;
}

/**
 * Longest city name worth testing, in words.
 *
 * "مكة المكرمة" and "المدينة المنورة" are two; three is one word of headroom.
 * Bounding it keeps the scan O(words) rather than O(words²) and, more usefully,
 * stops a long address from having its first three-quarters tested as a city name.
 */
const MAX_CITY_WORDS = 3;

/**
 * Read a city out of a typed query, if one is in there.
 *
 * Both ends are tested because both are dictated: "حي النخيل، الرياض" puts the
 * city last and "الرياض، حي النخيل" — the order the master sheet's own addresses
 * use — puts it first. Longest run first, so "مكة المكرمة" is not truncated to
 * "مكة" while a stray "المكرمة" stays in the place name.
 *
 * A query that is *only* a city is left alone: the remainder would be empty, and
 * "الرياض" has always meant the city itself rather than a nameless place inside
 * it.
 */
export function splitCityQualifier(index: LocationIndex, query: string): CityQualifiedQuery {
  const normalized = normalizePlace(query);
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2) return { text: normalized, city: null };

  const longest = Math.min(words.length - 1, MAX_CITY_WORDS);
  for (let run = longest; run >= 1; run -= 1) {
    const tail = words.slice(words.length - run).join(" ");
    const tailCity = index.cityByTerm.get(tail);
    if (tailCity) return { text: words.slice(0, words.length - run).join(" "), city: tailCity };

    const head = words.slice(0, run).join(" ");
    const headCity = index.cityByTerm.get(head);
    if (headCity) return { text: words.slice(run).join(" "), city: headCity };
  }

  return { text: normalized, city: null };
}

/** Which city an entry belongs to, folded. A city entry is its own city. */
function cityKeyOf(entry: LocationEntry): string {
  return normalizePlace(entry.city ?? entry.name);
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
 * Entries worth scoring for this query.
 *
 * Uses the query's **rarest** bigrams, not all of them, and that detail is the
 * whole value of the index in Arabic. "ال" opens most Saudi place names, so its
 * posting list is very nearly the entire gazetteer; a union over every gram is
 * therefore barely narrower than a full scan. Measured over a synthetic set of
 * typical queries: ~65% of the index with every gram, ~30% with the rarest ones.
 * The remaining 30% is Arabic's fault rather than the index's — place names here
 * share a great deal of surface, and no bigram scheme escapes that entirely.
 *
 * Correctness of dropping the common grams:
 *
 *   - An exact, prefix or substring match contains the query verbatim, so it
 *     appears in the posting list of *every* query gram — including whichever
 *     one is rarest. Never missed.
 *   - A match within `budget` edits has at most `2 * budget` of its bigrams
 *     disturbed, since one edit touches two overlapping windows. Taking
 *     `2 * budget + 1` lists therefore guarantees at least one survives intact,
 *     so the entry is still a candidate.
 *
 * When the query has fewer grams than that, all of them are used — which is the
 * most that can be done, and matches what a full scan would have found anyway.
 */
function candidateIndices(index: LocationIndex, query: string, budget: number): readonly number[] {
  if (query.length < 2) return index.byFirstChar.get(query[0]) ?? [];

  const lists: (readonly number[])[] = [];
  for (const gram of new Set(bigrams(query))) {
    const postings = index.byBigram.get(gram);
    // A gram absent from the index means no term contains it. For an exact or
    // substring match that would be disqualifying, but a fuzzy match may still
    // be within budget, so this only skips the list rather than the query.
    if (postings) lists.push(postings);
  }
  if (lists.length === 0) return [];

  lists.sort((a, b) => a.length - b.length);
  const needed = Math.min(lists.length, 2 * budget + 1);

  const seen = new Set<number>();
  for (let i = 0; i < needed; i += 1) {
    for (const entry of lists[i]) seen.add(entry);
  }
  return [...seen];
}

/**
 * Places matching what has been typed, best first.
 *
 * Runs on every keystroke — it backs the autocomplete as well as submission —
 * so it scores only the entries the postings lists put in front of it.
 */
export function searchLocations(
  index: LocationIndex,
  query: string,
  limit = 8,
  scope?: SearchScope,
): LocationMatch[] {
  // A city typed into the query outranks the dropdown, and narrows harder: the
  // agent named it for *this* search, which is a more specific instruction than a
  // scope they set earlier and may not still be looking at.
  const qualified = splitCityQualifier(index, query);
  const normalized = qualified.text;
  if (!normalized) return [];

  const city = qualified.city ?? scope?.city ?? null;
  const strict = qualified.city != null || scope?.strictCity === true;

  const scopeKey = city ? normalizePlace(city) : null;
  const budget = tolerance(normalized.length);
  const matches: LocationMatch[] = [];

  for (const position of candidateIndices(index, normalized, budget)) {
    const entry = index.entries[position];
    if (!entry) continue;
    const score = scoreEntry(entry, normalized, budget);
    if (score == null) continue;
    const inScope = scopeKey == null || cityKeyOf(entry) === scopeKey;
    if (strict && !inScope) continue;
    matches.push({ entry, score, inScope });
  }

  matches.sort((a, b) => {
    // The selected city outranks match quality itself. "الروضة" typed with Riyadh
    // chosen means the Riyadh one even if the Jeddah one is spelled slightly
    // closer to what was typed — the agent has already answered the question the
    // score is guessing at.
    if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    // city → district → street → landmark → branch.
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
 *
 * A city named in the query settles it before the question is ever reached:
 * `searchLocations` has already dropped every other city's candidates, so the
 * surviving tie spans one city and resolves. "حي النخيل" asks; "حي النخيل،
 * الرياض" answers — which is the difference the agent typed.
 */
export function resolvePlace(
  index: LocationIndex,
  query: string,
  scope?: SearchScope,
): PlaceResolution {
  const matches = searchLocations(index, query, 12, scope);
  if (matches.length === 0) return { status: "none" };

  const leader = matches[0];
  const tied = matches
    .filter((match) => match.score === leader.score && match.inScope === leader.inScope)
    .map((match) => match.entry);

  // A chosen city *is* the answer to "which one". Asking anyway would be asking
  // the agent to repeat themselves, which is the entire point of the dropdown —
  // so ambiguity is only raised among equally-scoped candidates.
  if (tied.length > 1 && leader.score <= SCORE.alias) {
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

/** What an entry's point was derived from, for the origin line. */
export function describeLocationSource(entry: LocationEntry): string {
  // A branch entry is not a centroid at all — it is one recorded coordinate, so
  // "centre of 1 branch" would understate what is actually known.
  if (entry.kind === "branch") return "Exact position of this branch, from the directory";
  // "on this street" but "in this city" — the preposition has to follow the kind.
  const scope =
    entry.kind === "street"
      ? "on this street"
      : entry.kind === "city"
        ? "in this city"
        : entry.kind === "district"
          ? "in this district"
          : "at this location";
  const backing = entry.branchCount === 1 ? "1 branch" : `${entry.branchCount} branches`;
  return `Centre of the ${backing} ${scope} — approximate, from the directory`;
}
