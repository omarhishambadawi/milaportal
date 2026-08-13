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

import type { InvoiceBranchMatch, ShamsBranchStock, ShamsProduct } from "./types";

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
  return wildcardProbes(fragments, minLength, 1)[0] ?? null;
}

/**
 * The fragments to send to the MIS, most selective first.
 *
 * One probe is *logically* sufficient — every match contains every fragment, so
 * a single-fragment search returns a superset — but only if the API hands back
 * everything it matched. It exposes no `limit`, `page` or `offset` (its whole
 * search signature is `?q=`), so whether it truncates a broad result server-side
 * cannot be established from the client, and a truncated superset is no longer a
 * superset: the product the agent wanted can be cut off before local matching
 * ever sees it.
 *
 * Several probes make that failure mode unlikely instead of invisible. Each
 * returns its own candidate set, the union is filtered, and a product only has
 * to survive *one* probe's truncation to be found. Bounded to `max` — this is
 * insurance against a cap nobody has measured, not a licence to sweep.
 *
 * Ordered longest-first (ties earliest) so the most selective probe runs first
 * and the ones after it are cheap corroboration.
 */
export function wildcardProbes(fragments: string[], minLength: number, max: number): string[] {
  const usable = fragments
    .map((fragment, index) => ({ fragment, index }))
    .filter((f) => f.fragment.length >= minLength);

  usable.sort((a, b) => b.fragment.length - a.fragment.length || a.index - b.index);

  const out: string[] = [];
  for (const { fragment } of usable) {
    if (out.length >= max) break;
    // Two probes where one contains the other retrieve nested sets; the shorter
    // adds nothing the longer did not already cover.
    if (out.some((chosen) => chosen.includes(fragment) || fragment.includes(chosen))) continue;
    out.push(fragment);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How well does this product answer what was typed?
 *
 * Higher is better. The bands are deliberately coarse — an agent is scanning,
 * not reading a relevance score — and each one answers a question the one below
 * it cannot:
 *
 *   exact name          they typed the product
 *   name starts with    they typed the beginning of the product
 *   name contains       they typed a piece of the product
 *   code match          they pasted an item code
 *   earliest first hit  everything else being equal, prefer the product whose
 *                       first fragment appears soonest, which is where a name
 *                       match sits rather than a match buried in a pack size
 *
 * A wildcard query has no meaningful "whole query" to compare, so for those the
 * first fragment plays that role.
 */
export function scoreProduct(product: ShamsProduct, query: string, fragments: string[]): number {
  const name = normalizeForSearch(product.itemName);
  const code = normalizeForSearch(product.itemCode);
  const whole = fragments.length > 0 ? fragments[0] : normalizeForSearch(query);
  if (whole === "") return 0;

  let score = 0;
  if (name === whole) score += 1000;
  else if (name.startsWith(whole)) score += 500;
  else if (name.includes(whole)) score += 250;

  if (code === whole) score += 900;
  else if (code.includes(whole)) score += 120;

  // Every fragment that lands in the name rather than only in the code is a
  // sign the agent is describing the product, not its identifier.
  for (const fragment of fragments) {
    if (name.includes(fragment)) score += 20;
  }

  const at = name.indexOf(whole);
  if (at >= 0) score += Math.max(0, 40 - at);

  return score;
}

/**
 * Rank matched products, best first.
 *
 * Stable: equal scores keep catalog order, so a repeated search does not
 * reshuffle the list under an agent's cursor.
 */
export function rankProducts(
  products: ShamsProduct[],
  query: string,
  fragments: string[],
): ShamsProduct[] {
  return products
    .map((product, index) => ({ product, index, score: scoreProduct(product, query, fragments) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.product);
}

/* -------------------------------------------------------------------------- */
/* Invoice branch ordering                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Call Centre matches first, then branch code.
 *
 * The agent is nearly always looking for the call-centre document; putting it
 * anywhere but the top means reading a list to find the row that mattered.
 * Everything after that is ordered by branch code — deterministic, and
 * deliberately *not* by city, total, or the order branches happened to answer
 * in, none of which are stable between two runs of the same search.
 */
export function compareInvoiceBranchMatches(a: InvoiceBranchMatch, b: InvoiceBranchMatch): number {
  if (a.isCallCentre !== b.isCallCentre) return a.isCallCentre ? -1 : 1;
  return a.branchCode.localeCompare(b.branchCode);
}

/** Sorted copy. Safe to call on a partially discovered list and again later. */
export function sortInvoiceBranchMatches(matches: InvoiceBranchMatch[]): InvoiceBranchMatch[] {
  return [...matches].sort(compareInvoiceBranchMatches);
}

/**
 * Merge sweep results as they arrive, keeping one row per branch.
 *
 * Progressive discovery renders partial answers, so the same branch can appear
 * again when a later part resolves; first write wins, which keeps the list from
 * flickering. The result is always fully sorted, so a late Call Centre match
 * still lands at the top rather than at the point it happened to arrive.
 */
export function mergeInvoiceBranchMatches(
  groups: (InvoiceBranchMatch[] | undefined)[],
): InvoiceBranchMatch[] {
  const byBranch = new Map<string, InvoiceBranchMatch>();
  for (const group of groups) {
    for (const match of group ?? []) {
      if (!byBranch.has(match.branchCode)) byBranch.set(match.branchCode, match);
    }
  }
  return sortInvoiceBranchMatches([...byBranch.values()]);
}

/* -------------------------------------------------------------------------- */
/* Branch row filtering                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A branch row and whatever the portal knows it is called.
 *
 * The MIS supplies `branchCode` only — its `branchName` merely repeats the code
 * — so the human-readable city comes from MilaServ's own directory and is
 * passed in rather than looked up here.
 */
export interface BranchRowText {
  branchCode: string;
  city?: string | null;
  cityEnglish?: string | null;
}

/**
 * Does this branch row match what the agent typed?
 *
 * A plain case-insensitive substring test across the labels an agent actually
 * knows a branch by: code (`P0221`), the bare number (`0221`, which is a
 * substring of the code), the English city (`Jeddah`) and the Arabic city
 * (`جدة`).
 *
 * The MIS `areaName` is deliberately **not** searched. It is a coarse region
 * label that duplicates the city for most branches and contradicts it for some,
 * so including it made queries match rows whose visible text had nothing to do
 * with what was typed. It is no longer displayed either; the field stays on the
 * model because it is what the API returns.
 */
export function matchesBranchQuery(row: BranchRowText, query: string): boolean {
  const needle = normalizeForSearch(query);
  if (needle === "") return true;
  const haystack = normalizeForSearch(
    [row.branchCode, row.city ?? "", row.cityEnglish ?? ""].join(" "),
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
      { branchCode: row.branchCode, city: label?.city, cityEnglish: label?.cityEnglish },
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
