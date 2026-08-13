/**
 * Shams search and filter matching. Pure, synchronous, no I/O.
 *
 * Two agent-facing search behaviours live here so both are testable without a
 * network and neither is reimplemented in a component:
 *
 *   1. **Wildcard product search** — `mou*n*j*2.5`, run server-side against the
 *      catalog because the MIS API has no wildcard syntax of its own.
 *   2. **Branch row filtering** — narrowing an already-loaded stock result to
 *      one branch or city, run client-side because the rows are already there.
 */

import type { ShamsBranchStock, ShamsProduct } from "./types";

/* -------------------------------------------------------------------------- */
/* Text normalization                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lowercased, with runs of whitespace collapsed to one space.
 *
 * Applied to both sides of every comparison, which is what makes matching
 * case-insensitive and whitespace-tolerant: `MOUNJARO  2.5` and
 * `mounjaro 2.5` become the same string, so an agent's spacing never decides
 * whether a product is found.
 */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** What a product is matched against: its name and its item code. */
export function productSearchText(product: ShamsProduct): string {
  return `${product.itemName} ${product.itemCode}`;
}

/* -------------------------------------------------------------------------- */
/* Wildcard product search                                                     */
/* -------------------------------------------------------------------------- */

/** The character an agent types to mean "and then, somewhere later…". */
export const WILDCARD = "*";

export function isWildcardQuery(query: string): boolean {
  return query.includes(WILDCARD);
}

/**
 * Split a wildcard query into the fragments that must all appear, in order.
 *
 * `mou*n*j*2.5` → `["mou", "n", "j", "2.5"]`
 * `*26*gold*3*1800` → `["26", "gold", "3", "1800"]`
 *
 * Leading, trailing and doubled `*` contribute nothing but are not errors: they
 * are how an agent says "may start anywhere", and dropping the empty pieces is
 * exactly that meaning. A query of only asterisks yields no fragments, which
 * callers treat as "not a search" rather than as "match everything".
 */
export function parseWildcardQuery(query: string): string[] {
  return query
    .split(WILDCARD)
    .map((part) => normalizeForSearch(part))
    .filter((part) => part !== "");
}

/**
 * Do all fragments appear in `text`, in order?
 *
 * Each fragment is searched for *after* the previous one ended, so order is
 * enforced and arbitrary text may sit between fragments. Overlap is not allowed
 * — `a*a` needs two `a`s — which is what makes each fragment a distinct piece
 * of the name rather than the same piece counted twice.
 */
export function matchesWildcard(text: string, fragments: string[]): boolean {
  if (fragments.length === 0) return false;
  const haystack = normalizeForSearch(text);
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at === -1) return false;
    from = at + fragment.length;
  }
  return true;
}

export function matchesProductWildcard(product: ShamsProduct, fragments: string[]): boolean {
  return matchesWildcard(productSearchText(product), fragments);
}

/**
 * The fragment to send to the MIS as a plain search term.
 *
 * The API matches a substring and knows nothing about `*`, so a wildcard query
 * cannot be forwarded as typed. Instead one fragment is used to pull candidates
 * and the rest are applied here. Every product matching the whole expression
 * must contain *every* fragment, so any single fragment retrieves a superset —
 * which makes this a matter of selectivity, not correctness.
 *
 * The longest fragment is chosen because a longer substring matches fewer
 * products; ties go to the earliest, which tends to be the part of the name the
 * agent was surest about. `null` when nothing is long enough to search with, so
 * the caller can decline rather than sweep the catalog with one character.
 */
export function wildcardProbe(fragments: string[], minLength: number): string | null {
  let best: string | null = null;
  for (const fragment of fragments) {
    if (fragment.length < minLength) continue;
    if (best === null || fragment.length > best.length) best = fragment;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Branch row filtering                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A branch row and whatever the portal knows it is called.
 *
 * The MIS supplies `branchCode` and `areaName` only — its `branchName` merely
 * repeats the code — so the human-readable city comes from MilaServ's own
 * directory and is passed in rather than looked up here.
 */
export interface BranchRowText {
  branchCode: string;
  areaName: string;
  city?: string | null;
  cityEnglish?: string | null;
}

/**
 * Does this branch row match what the agent typed?
 *
 * A plain case-insensitive substring test across every label the row has: code
 * (`P0221`), the bare number (`0221`, which is a substring of the code), the
 * English city (`Jeddah`), the Arabic city (`جدة`) and the MIS area. One
 * concatenated haystack rather than four comparisons, so a query is allowed to
 * span nothing more clever than one of them.
 */
export function matchesBranchQuery(row: BranchRowText, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (needle === "") return true;
  const haystack = normalizeForSearch(
    [row.branchCode, row.areaName, row.city ?? "", row.cityEnglish ?? ""].join(" "),
  );
  return haystack.includes(needle);
}

/** A stock row plus its resolved labels, filtered by one query. */
export function filterBranchStock<T extends ShamsBranchStock>(
  rows: T[],
  query: string,
  labelsFor: (code: string) => { city?: string | null; cityEnglish?: string | null } | undefined,
): T[] {
  if (normalizeForSearch(query) === "") return rows;
  return rows.filter((row) => {
    const label = labelsFor(row.branchCode);
    return matchesBranchQuery(
      {
        branchCode: row.branchCode,
        areaName: row.areaName,
        city: label?.city,
        cityEnglish: label?.cityEnglish,
      },
      query,
    );
  });
}

/**
 * Counts for a set of stock rows.
 *
 * Deliberately computed from whatever array it is handed, so a filtered table
 * and its summary cannot disagree: filter the rows, summarise the same rows.
 */
export function summariseStock(rows: ShamsBranchStock[]): {
  branches: number;
  withStock: number;
  without: number;
  units: number;
} {
  let withStock = 0;
  let units = 0;
  for (const row of rows) {
    if (row.quantity > 0) {
      withStock++;
      units += row.quantity;
    }
  }
  return {
    branches: rows.length,
    withStock,
    without: rows.length - withStock,
    units: Math.round(units * 1000) / 1000,
  };
}
