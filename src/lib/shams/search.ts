/**
 * Shams search and filter matching. Pure, synchronous, no I/O.
 *
 * Two agent-facing search behaviours live here so both are testable without a
 * network and neither is reimplemented in a component:
 *
 *   1. **Wildcard product search** — `mou*n*j*2.5`, run server-side against the
 *      full Shams CRM catalog, which is the only source that holds every
 *      product; neither backend offers a wildcard syntax of its own.
 *   2. **Branch row filtering** — narrowing an already-loaded stock result to
 *      one branch, city or district, run client-side because the rows are
 *      already there. Arabic is folded through the branch directory's own
 *      `foldText`, so `جده` finds `جدة` and the portal has one answer to what
 *      counts as the same word rather than two.
 */

import { foldText } from "@/features/branches/normalize";
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

/**
 * The two fields a wildcard expression may be matched against, separately.
 *
 * Deliberately not one joined `"<name> <code>"` string, which is what this used
 * to be. Joining let the fragments straddle the join: for `*omega*3*`, `omega`
 * landed in the name and `3` in the digits of the item code, so products whose
 * visible name has no `3` in it came back as matches for a pattern that plainly
 * asks for one. Every item code is digits, so any numeric fragment could be
 * satisfied by a field the agent was not searching.
 *
 * PharmacyCRM Desktop matches its wildcard against the item **name** only
 * (`docs/shams/api-discovery.md` §10). The code is kept as a second, whole
 * haystack rather than dropped, so a pattern that does describe a code still
 * matches a row the search already retrieved; what is no longer possible is one
 * match assembled from both. Retrieving a row *by* its code is a separate
 * question, and `product/search` cannot do it at all — see `searchProducts`.
 */
export function productWildcardHaystacks(product: ShamsProduct): [string, string] {
  return [product.itemName, product.itemCode];
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

/**
 * Does this product match the whole expression, in one field?
 *
 * The name is tried first because it is what an agent is describing; the item
 * code answers the pasted-fragments case. One field has to satisfy every
 * fragment — see `productWildcardHaystacks` for why a match may not be assembled
 * from both.
 */
export function matchesProductWildcard(product: ShamsProduct, fragments: string[]): boolean {
  return productWildcardHaystacks(product).some((text) => matchesWildcard(text, fragments));
}

/* -------------------------------------------------------------------------- */
/* Item codes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The shortest run of digits worth treating as an item code.
 *
 * Shams codes are eight digits (`10400746`). Four is the point below which a
 * number is far more likely to be part of a name — a pack size, a strength,
 * `400 G` — than an identifier, and probing `product/info` for those would be a
 * request per keystroke that never resolves.
 */
export const MIN_ITEM_CODE_LENGTH = 4;

/**
 * Could this query be an item code?
 *
 * Digits only, long enough to mean something. Deliberately *not* exclusive: a
 * query that looks like a code is still searched as a name too, because the
 * agent should never have to tell the field which one they meant. It only adds
 * a lookup, it never replaces one.
 */
export function looksLikeItemCode(query: string): boolean {
  const q = query.trim();
  return q.length >= MIN_ITEM_CODE_LENGTH && /^\d+$/.test(q);
}

/* -------------------------------------------------------------------------- */
/* Plain product matching                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Does this product answer a plain — non-wildcard — query?
 *
 * Three ways, and an agent never has to say which one they mean:
 *
 *   name contains        `mounjaro`, case- and whitespace-insensitively
 *   item code exactly    `10400746`, pasted from an invoice or a message
 *   item code prefix     `104007`, the first digits of a code read aloud
 *
 * The prefix rule is gated on `looksLikeItemCode`, which is what stops it firing
 * on ordinary text: a name search for `pro` must not also drag in every product
 * whose code happens to start `pro` — no code does, but the gate means the
 * question never arises, and it keeps short numeric fragments like a `500` in a
 * strength from being read as an identifier.
 *
 * Prefix rather than substring, matching PharmacyCRM Desktop, which does
 * `startswith` on the code (`docs/shams/api-discovery.md` §10.3). A code buried
 * in the middle of another code is a coincidence rather than a lookup, and the
 * agent who wants that already has `104*746`.
 *
 * Extracted here, next to the wildcard rules, so the local catalogue's SQL
 * retrieval and the in-process match are written against one statement of what a
 * match is rather than two.
 */
export function matchesProductQuery(product: ShamsProduct, query: string): boolean {
  const q = query.trim();
  if (q === "") return false;

  const needle = normalizeForSearch(q);
  if (needle !== "" && normalizeForSearch(product.itemName).includes(needle)) return true;
  if (product.itemCode === q) return true;
  return looksLikeItemCode(q) && product.itemCode.startsWith(q);
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
 * — so the human-readable labels come from MilaServ's own branch directory and
 * are passed in rather than looked up here. That directory is the single source:
 * the Arabic city is the stored `branches.city`, and the district is the حي
 * `extractDistrict` reads out of the same row's address. Nothing here maintains
 * a second list of places.
 */
export interface BranchRowText {
  branchCode: string;
  /** As stored, in Arabic — `جدة`. */
  city?: string | null;
  cityEnglish?: string | null;
  /** The حي, in Arabic — `حي الحزم`. Null when the address does not state one. */
  district?: string | null;
  /**
   * A precomputed `branchSearchText`, when the caller already has one.
   *
   * Folding four fields for ~140 rows on every keystroke is work with a known
   * answer, so the directory folds each branch once when it loads and hands the
   * result down. Absent, this is built on demand — the two paths call the same
   * function, so a precomputed haystack and a derived one cannot disagree.
   */
  search?: string | null;
}

/**
 * Everything a branch is searchable by, folded once.
 *
 * `foldText` is the portal's Arabic normalizer, borrowed from the branch
 * directory rather than re-written here — it is what makes `جده` find `جدة`,
 * `الحزم` find `الحزم` written with a hamza, and `٠٢٢١` find `0221`. Reusing it
 * is the point: two Arabic folds in one codebase is two answers to "does this
 * match", and the branch directory's is the one agents are already used to.
 */
export function branchSearchText(row: BranchRowText): string {
  return foldText(
    [row.branchCode, row.city ?? "", row.cityEnglish ?? "", row.district ?? ""].join(" "),
  );
}

/**
 * Does this branch row match what the agent typed?
 *
 * A substring test across the labels an agent actually knows a branch by: code
 * (`P0221`), the bare number (`0221`, which is a substring of the code), the
 * English city (`Jeddah`), the Arabic city (`جدة`) and the Arabic district
 * (`حي الحزم`).
 *
 * Both sides go through `foldText`, which is what makes the Arabic half work in
 * practice. A customer says `جده` and the sheet stores `جدة`; an agent types
 * `الاندلس` where the address writes `الأندلس`. Those are the same word, and
 * before this they were two different queries. Case-insensitivity and whitespace
 * collapsing are unchanged — `foldText` does both — so every existing Latin
 * match still holds.
 *
 * The MIS `areaName` is deliberately **not** searched. It is a coarse region
 * label that duplicates the city for most branches and contradicts it for some,
 * so including it made queries match rows whose visible text had nothing to do
 * with what was typed. It is not displayed either; the field stays on the model
 * because it is what the API returns.
 */
export function matchesBranchQuery(row: BranchRowText, query: string): boolean {
  const needle = foldText(query);
  if (needle === "") return true;
  return (row.search ?? branchSearchText(row)).includes(needle);
}

/** What the branch directory supplies for one code. */
export type BranchRowLabels = Omit<BranchRowText, "branchCode">;

/** A stock row plus its resolved labels, filtered by one query. */
export function filterBranchStock<T extends ShamsBranchStock>(
  rows: T[],
  query: string,
  labelsFor: (code: string) => BranchRowLabels | undefined,
): T[] {
  if (foldText(query) === "") return rows;
  return rows.filter((row) =>
    matchesBranchQuery({ ...labelsFor(row.branchCode), branchCode: row.branchCode }, query),
  );
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
