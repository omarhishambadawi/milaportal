import type { Branch, BranchView } from "./types";
import {
  cityAliases,
  cityEnglish,
  foldText,
  formatE164,
  mapsLink,
  navLink,
  parsePhone,
  phoneSearchForms,
} from "./normalize";

/**
 * Search and filtering for the Branch Directory.
 *
 * The performance rule this file exists to enforce: **nothing is parsed inside
 * a filter callback.** Phone numbers, city aliases and the searchable text of
 * every branch are computed once, in `decorate`, when the query resolves. A
 * keystroke then costs one `includes` per branch per token over a string that
 * already exists — which is what makes the box feel instant at a thousand rows
 * rather than re-normalizing Arabic text a thousand times per character typed.
 */

/**
 * Build the per-branch derived data the directory reads on every keystroke.
 *
 * Call once per fetched dataset (memoized in `useBranchDirectory`), never per
 * render and never per filter pass.
 */
export function decorate(branches: Branch[]): BranchView[] {
  return branches.map((branch) => {
    const phone = parsePhone(branch.phone);
    const managerPhone = parsePhone(branch.area_manager_phone);
    const aliases = cityAliases(branch.city);

    // Every field an agent might search by, folded into one string. Phone
    // numbers contribute all of their written forms, so "599089497",
    // "0599089497" and "+966599089497" all find the same branch.
    const haystack = foldText(
      [
        branch.branch_no,
        ...aliases,
        branch.address ?? "",
        branch.area_manager ?? "",
        branch.email ?? "",
        branch.scooter_note ?? "",
        branch.working_hours ?? "",
        ...phoneSearchForms(phone),
        ...phoneSearchForms(managerPhone),
      ].join(" "),
    );

    return {
      ...branch,
      haystack,
      phoneDigits: `${phone.digits} ${managerPhone.digits}`.trim(),
      phoneE164: phone.e164,
      managerPhoneE164: managerPhone.e164,
      phoneDisplay: phone.e164 ? formatE164(phone.e164) : phone.display,
      managerPhoneDisplay: managerPhone.e164 ? formatE164(managerPhone.e164) : managerPhone.display,
      mapsLink: mapsLink(branch),
      navLink: navLink(branch),
      hasCoords: branch.latitude != null && branch.longitude != null,
      cityEnglish: cityEnglish(branch.city),
    };
  });
}

export type ScooterFilter = "any" | "yes" | "no";

export interface BranchFilters {
  query: string;
  /** Arabic city names, as stored. Empty means every city. */
  cities: string[];
  scooter: ScooterFilter;
  /** Duty-hour buckets to keep, e.g. [20, 24]. Empty means every duration. */
  dutyHours: number[];
  favouritesOnly: boolean;
}

export const EMPTY_FILTERS: BranchFilters = {
  query: "",
  cities: [],
  scooter: "any",
  dutyHours: [],
  favouritesOnly: false,
};

export function hasActiveFilters(filters: BranchFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.cities.length > 0 ||
    filters.scooter !== "any" ||
    filters.dutyHours.length > 0 ||
    filters.favouritesOnly
  );
}

/**
 * Split a query into tokens that must ALL match.
 *
 * "riyadh scooter" narrows rather than widens, which is what someone typing a
 * second word intends. Tokens are folded once here, not per branch.
 */
function tokenize(query: string): string[] {
  const folded = foldText(query);
  return folded.length > 0 ? folded.split(" ").filter(Boolean) : [];
}

/**
 * Relevance score, lower sorts first.
 *
 * The one case worth special-casing is typing a branch code: "P021" must put
 * that branch at the top even though the string also appears inside longer
 * codes and inside email addresses like "ph021@…". Everything else falls back
 * to code order, which is the ordering operators already have in their heads.
 */
function score(branch: BranchView, tokens: string[]): number {
  if (tokens.length === 0) return 3;
  const code = foldText(branch.branch_no);
  const joined = tokens.join(" ");
  if (code === joined) return 0;
  if (code.startsWith(joined)) return 1;
  if (foldText(branch.city) === joined || foldText(branch.cityEnglish ?? "") === joined) return 2;
  return 3;
}

/** Does this branch satisfy every token in the query? */
function matchesQuery(branch: BranchView, tokens: string[]): boolean {
  for (const token of tokens) {
    if (!branch.haystack.includes(token)) return false;
  }
  return true;
}

/**
 * Apply the search box and every filter chip in one pass.
 *
 * @param favourites Branch codes the current user has starred; only consulted
 *   when `filters.favouritesOnly` is set.
 */
export function filterBranches(
  branches: BranchView[],
  filters: BranchFilters,
  favourites: ReadonlySet<string>,
): BranchView[] {
  const tokens = tokenize(filters.query);
  const cities = filters.cities.length > 0 ? new Set(filters.cities) : null;
  const dutyHours = filters.dutyHours.length > 0 ? new Set(filters.dutyHours) : null;

  const matched: BranchView[] = [];
  for (const branch of branches) {
    if (cities && !cities.has(branch.city)) continue;
    if (filters.scooter === "yes" && !branch.scooter) continue;
    if (filters.scooter === "no" && branch.scooter) continue;
    if (dutyHours) {
      // Chips are whole hours; a 14.5-hour branch belongs to the 14 bucket.
      if (branch.duty_hours == null || !dutyHours.has(Math.floor(branch.duty_hours))) continue;
    }
    if (filters.favouritesOnly && !favourites.has(branch.branch_no)) continue;
    if (tokens.length > 0 && !matchesQuery(branch, tokens)) continue;
    matched.push(branch);
  }

  if (tokens.length === 0) return matched;

  return matched
    .map((branch) => ({ branch, rank: score(branch, tokens) }))
    .sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : a.branch.branch_no.localeCompare(b.branch.branch_no, undefined, { numeric: true }),
    )
    .map((entry) => entry.branch);
}

export interface BranchStats {
  total: number;
  cities: number;
  withScooter: number;
  withoutScooter: number;
}

export function computeStats(branches: BranchView[]): BranchStats {
  const cities = new Set<string>();
  let withScooter = 0;
  for (const branch of branches) {
    cities.add(branch.city);
    if (branch.scooter) withScooter++;
  }
  return {
    total: branches.length,
    cities: cities.size,
    withScooter,
    withoutScooter: branches.length - withScooter,
  };
}

/**
 * The city chips to offer, ordered by how many branches each holds.
 *
 * Derived from the data rather than hardcoded, so an import that opens a new
 * region gets a chip without a code change.
 */
export function cityOptions(
  branches: BranchView[],
): { city: string; english: string | null; count: number }[] {
  const counts = new Map<string, number>();
  for (const branch of branches) counts.set(branch.city, (counts.get(branch.city) ?? 0) + 1);
  return [...counts.entries()]
    .map(([city, count]) => ({ city, english: cityEnglish(city), count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
}

/**
 * The duty-hour chips to offer.
 *
 * Also derived: the brief asked for "20 Hours / 21 Hours / Open 24 Hours
 * (future ready)", and reading the buckets off the data is what makes it future
 * ready — 22-hour branches are the second most common shape in the current
 * sheet and would have been invisible behind three hardcoded chips.
 */
export function dutyHourOptions(branches: BranchView[]): { hours: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const branch of branches) {
    if (branch.duty_hours == null) continue;
    const bucket = Math.floor(branch.duty_hours);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hours, count]) => ({ hours, count }))
    .sort((a, b) => b.hours - a.hours);
}
