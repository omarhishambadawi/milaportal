import {
  isWildcardQuery,
  looksLikeItemCode,
  matchesWildcard,
  normalizeForSearch,
  parseWildcardQuery,
} from "@/lib/shams/search";
import type { RelationProduct } from "./relations";

/**
 * Finding a product in the Telesales catalogue.
 *
 * ===========================================================================
 * The catalogue, not the MIS
 * ===========================================================================
 * `validateRelation` accepts nothing but a `telesales_products` code, so a
 * cross-sell can only ever be configured against the 28 rows this module
 * already loads. Searching the Shams MIS here would offer the supervisor
 * thousands of products, almost all of which the validator would then refuse —
 * an autocomplete whose suggestions are mostly wrong is worse than a dropdown.
 *
 * So this searches what can actually be chosen, in memory, over a list the
 * screen has already fetched. No request, no second catalogue, no second
 * search API.
 *
 * ===========================================================================
 * The matching is the Shams tab's own
 * ===========================================================================
 * `normalizeForSearch`, `looksLikeItemCode` and the wildcard pair come from
 * `@/lib/shams/search` unchanged. They are pure string functions with no I/O
 * and no client — importing them is reuse, not a dependency on the
 * integration — and using them means "mounjaro 5" finds the same thing here
 * that it finds on the Stock tab. A supervisor should not have to learn two
 * search boxes.
 *
 * ===========================================================================
 * Alias codes resolve too
 * ===========================================================================
 * The retention source uses two code systems for the same medicines, and a
 * supervisor holding a workbook is as likely to have `519914` in front of them
 * as `10611028`. Pasting either finds the 5 MG pen, because the identity
 * mappings the module already maintains are part of the haystack. The relation
 * is still configured against the canonical product — the alias is a way in,
 * never a thing to store.
 */

/** A catalogue product, plus the alias codes that also mean it. */
export interface SearchableProduct extends RelationProduct {
  /** Active alias codes resolving to this product. Searched, never displayed
   *  as the product's own code. */
  aliasCodes: string[];
}

/**
 * Attach each product's alias codes.
 *
 * Built once per page from the two reads the screen already makes, so the
 * search itself stays a filter over an array rather than a lookup per
 * keystroke.
 */
export function buildSearchIndex(
  products: readonly RelationProduct[],
  aliases: readonly {
    alias_item_code: string;
    canonical_item_code: string;
    active: boolean;
  }[] = [],
): SearchableProduct[] {
  const byCanonical = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.active) continue;
    const canonical = a.canonical_item_code?.trim();
    const alias = a.alias_item_code?.trim();
    if (!canonical || !alias) continue;
    const bucket = byCanonical.get(canonical);
    if (bucket) bucket.push(alias);
    else byCanonical.set(canonical, [alias]);
  }

  return products.map((p) => ({
    ...p,
    aliasCodes: (byCanonical.get(p.itemCode.trim()) ?? []).sort(),
  }));
}

/**
 * How well does this product answer what was typed?
 *
 * Higher is better, and the bands mirror the Stock tab's: the product they
 * typed, the product they started typing, a product containing what they typed,
 * a pasted code. An alias hit scores below a catalogue-code hit, because the
 * catalogue code is the product's own identity and the alias is a synonym.
 *
 * Returns `null` for no match at all, so the caller filters and ranks in one
 * pass.
 */
export function scoreProduct(product: SearchableProduct, query: string): number | null {
  const q = normalizeForSearch(query);
  if (!q) return 0;

  const name = normalizeForSearch(product.itemName);
  const code = normalizeForSearch(product.itemCode);

  if (isWildcardQuery(query)) {
    const fragments = parseWildcardQuery(query);
    if (fragments.length === 0) return 0;
    // Name and code as separate haystacks, for the reason `productWildcardHaystacks`
    // gives: a pattern must not be satisfied half by a name and half by digits
    // in a code the supervisor was not searching.
    if (matchesWildcard(product.itemName, fragments)) return 60;
    if (matchesWildcard(product.itemCode, fragments)) return 40;
    return null;
  }

  if (name === q) return 100;
  if (code === q) return 95;
  if (name.startsWith(q)) return 80;

  // A pasted code, exact or partial. Checked before the name contains, because
  // somebody typing digits means a code.
  if (looksLikeItemCode(q) && code.includes(q)) return 70;

  if (name.includes(q)) return 60;

  /*
   * An alias code, last. `519914` is a real way to arrive at the 5 MG pen and
   * must find it, but below every way of naming the product itself: a
   * supervisor who typed a product name wants products, not a synonym that
   * happens to contain those digits.
   */
  if (product.aliasCodes.some((a) => normalizeForSearch(a) === q)) return 50;
  if (looksLikeItemCode(q) && product.aliasCodes.some((a) => normalizeForSearch(a).includes(q))) {
    return 30;
  }

  return null;
}

export interface SearchResult {
  product: SearchableProduct;
  score: number;
  /** Set when the query matched an alias rather than the product's own code,
   *  so the row can say why it is in the list. */
  viaAlias: string | null;
}

/**
 * The matching products, best first.
 *
 * An empty query returns everything, in catalogue-name order — the screen opens
 * showing what is available rather than an empty box demanding a guess, which
 * is what the dropdown did well and is worth keeping.
 *
 * Ties break on name so the same query always lists the same order; without it
 * the five Mounjaro strengths would shuffle between renders.
 */
export function searchProducts(
  index: readonly SearchableProduct[],
  query: string,
  options: { limit?: number; includeInactive?: boolean } = {},
): SearchResult[] {
  const q = normalizeForSearch(query);
  const out: SearchResult[] = [];

  for (const product of index) {
    if (!options.includeInactive && !product.active) continue;
    const score = scoreProduct(product, query);
    if (score == null) continue;
    const viaAlias =
      q && product.aliasCodes.find((a) => normalizeForSearch(a).includes(q))
        ? (product.aliasCodes.find((a) => normalizeForSearch(a).includes(q)) ?? null)
        : null;
    out.push({ product, score, viaAlias });
  }

  out.sort((a, b) => b.score - a.score || a.product.itemName.localeCompare(b.product.itemName));
  return options.limit ? out.slice(0, options.limit) : out;
}

/* ------------------------------------------------------------------------- */
/* Grouping the configured pairs                                             */
/* ------------------------------------------------------------------------- */

export interface RelationRow {
  id: string;
  from_item_code: string;
  to_item_code: string;
  to_item_name: string;
  note: string | null;
  active: boolean;
}

export interface RelationGroup<T extends RelationRow = RelationRow> {
  fromItemCode: string;
  /** The catalogue's name for the source, or the bare code if it has gone. */
  fromItemName: string;
  targets: T[];
  activeCount: number;
}

/**
 * The configured pairs, gathered under the product they start from.
 *
 * A flat list answered "what pairs exist"; a supervisor asks "what does
 * Mounjaro 5 mg offer", and with several strengths each carrying two or three
 * companions the flat list made that a scan rather than a glance.
 *
 * Sources are ordered by name and targets within a source by name, so the list
 * is stable and reads alphabetically rather than by insertion.
 */
/*
 * Generic over the row, so grouping does not strip the audit columns the list
 * renders. `RelationRow` is the minimum this function reads; the caller's own
 * shape travels through untouched.
 */
export function groupBySource<T extends RelationRow>(
  rows: readonly T[],
  catalog: ReadonlyMap<string, RelationProduct>,
): RelationGroup<T>[] {
  const groups = new Map<string, RelationGroup<T>>();

  for (const row of rows) {
    const from = row.from_item_code.trim();
    const existing = groups.get(from);
    if (existing) {
      existing.targets.push(row);
      if (row.active) existing.activeCount++;
      continue;
    }
    groups.set(from, {
      fromItemCode: from,
      fromItemName: catalog.get(from)?.itemName ?? from,
      targets: [row],
      activeCount: row.active ? 1 : 0,
    });
  }

  const out = [...groups.values()];
  for (const group of out) {
    group.targets.sort(
      (a, b) => Number(b.active) - Number(a.active) || a.to_item_name.localeCompare(b.to_item_name),
    );
  }
  out.sort((a, b) => a.fromItemName.localeCompare(b.fromItemName));
  return out;
}

/* ------------------------------------------------------------------------- */
/* Applying one target to several sources                                    */
/* ------------------------------------------------------------------------- */

export type BulkOutcome =
  | { source: string; status: "queued" }
  | { source: string; status: "self"; reason: string }
  | { source: string; status: "exists"; reason: string };

/**
 * What applying one target to a set of sources would do, before it does it.
 *
 * The supervisor's actual task is "Mounjaro, all six strengths, offer the Libre
 * sensor" — six pairs that differ only in the source. Re-choosing the target
 * six times is the part worth removing, and this is what makes the button able
 * to say what it is about to do.
 *
 * Two of the three outcomes are refusals the server would also make, computed
 * here so they are visible *before* the click rather than as six toasts after
 * it. Neither relaxes anything: `validateRelation` still runs server-side for
 * every pair, and the unique key still arbitrates.
 */
export function planBulkAssign(input: {
  sources: readonly string[];
  target: string;
  existing: readonly RelationRow[];
}): BulkOutcome[] {
  const target = input.target.trim();
  /*
   * Active pairs only count as already-configured. A switched-off pair is
   * offered as a re-application on purpose — that is how reactivation happens,
   * and `planSave` turns it into one rather than a duplicate row.
   */
  const active = new Set(
    input.existing
      .filter((r) => r.active && r.to_item_code.trim() === target)
      .map((r) => r.from_item_code.trim()),
  );

  return [...new Set(input.sources.map((s) => s.trim()))]
    .filter(Boolean)
    .sort()
    .map((source) => {
      if (source === target) {
        return { source, status: "self" as const, reason: "A product is not its own cross-sell" };
      }
      if (active.has(source)) {
        return { source, status: "exists" as const, reason: "Already configured" };
      }
      return { source, status: "queued" as const };
    });
}

/** The sources a bulk apply would actually write. */
export function queuedSources(plan: readonly BulkOutcome[]): string[] {
  return plan.filter((p) => p.status === "queued").map((p) => p.source);
}
