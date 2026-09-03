import { normalizeItemCode, normalizeItemName } from "./products";

/**
 * Which catalogue product is this, whatever code the row happens to carry?
 *
 * ===========================================================================
 * The problem this exists to solve
 * ===========================================================================
 * The retention source uses **two code systems for the same medicines**. Of the
 * 745 imported rows, 652 carry the pharmacy's eight-digit catalogue codes and 88
 * carry a five- or six-digit number for products the catalogue already holds:
 * twenty distinct codes all naming `MOUNJARO KWIKPEN 12.5 MG`, twelve naming the
 * 5 MG pen, 112 codes across 23 product names. The import stored the file
 * faithfully -- that is its job -- and every consumer downstream that keyed on
 * the raw code inherited the split.
 *
 * Phase 7 fixed the *refill cycle* lookup by falling back to an exact product
 * name. It deliberately left purchase history alone, because changing which
 * purchases count as "the same product" is a behavioural change rather than a
 * defect fix. This module is that change, made once and in one place: a
 * customer who bought `519914` in June and appears on a lead for `10611028`
 * today has bought the same medicine twice, and the desk should be told so.
 *
 * ===========================================================================
 * An interpretation layer, never a rewrite
 * ===========================================================================
 * Nothing here modifies a stored value. `telesales_source_records.item_code`,
 * `item_name`, the lead's denormalised copy and every Shams MIS identifier stay
 * exactly as they arrived; they are the audit trail and the integration key.
 * This resolves a *reading* of them, computed on demand, and a mapping switched
 * off tomorrow reverts every answer without touching a row.
 *
 * ===========================================================================
 * Conservative by construction
 * ===========================================================================
 * There is no fuzzy match, no prefix match, no token overlap and no similarity
 * score, because the failure mode is a patient being called about the wrong
 * dose. `MOUNJARO KWIKPEN 5 MG`, `7.5 MG`, `10 MG`, `12.5 MG` and `15MG` are
 * five different medicines that share every word but one, and any matcher loose
 * enough to relate two of them is loose enough to relate all five.
 *
 * So exactly three things resolve an identity, in this order:
 *
 *   1. **The code is a live catalogue product.** It is its own canonical
 *      identity, and nothing else is consulted.
 *   2. **An active alias maps it.** A row somebody with `manage_telesales`
 *      created, recorded, and can switch off.
 *   3. **The whole normalised name matches exactly one live product.** Case and
 *      whitespace folded, nothing else -- the same compare the invoice
 *      reconciler and the lifecycle view already use.
 *
 * Anything else is *unresolved*, and unresolved is a real answer that callers
 * render honestly rather than a gap to fill with a guess. A name that matches
 * two catalogue products is `ambiguous_name` and resolves to nothing at all.
 *
 * ===========================================================================
 * Why the alias layer exists when rule 3 already works
 * ===========================================================================
 * Rule 3 is a *rule*: its answer changes silently if somebody edits a catalogue
 * name, and nothing records that a mapping was ever in effect. An alias is a
 * decision -- who made it, when, against which name, and switchable off. The
 * audited 88 are activated as aliases for that reason; rule 3 stays as the
 * safety net for a code nobody has mapped yet, which is what kept those 88
 * leads working between Phase 7 and now.
 *
 * Chains cannot occur. An alias's canonical must be in `telesales_products` and
 * its alias code must not be, so resolution is always a single step and
 * `A -> B -> C` is refused by the database rather than unwound here.
 */

/* ------------------------------------------------------------------------- */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------- */

/** A row of `telesales_products`, as this module needs it. */
export interface IdentityProduct {
  itemCode: string;
  itemName: string | null;
  refillDays?: number | null;
}

/** A row of `telesales_product_aliases`. */
export interface IdentityAlias {
  aliasItemCode: string;
  canonicalItemCode: string;
  active: boolean;
}

/** Anything carrying a product, which is every shape in this module. */
export interface ProductBearing {
  itemCode: string | null | undefined;
  itemName: string | null | undefined;
}

/* ------------------------------------------------------------------------- */
/* Output                                                                    */
/* ------------------------------------------------------------------------- */

/** How the identity was reached. Shown on screen, so it must be legible. */
export type IdentityVia = "item_code" | "alias" | "product_name";

/** Why it was not reached. */
export type IdentityUnresolved = "no_product" | "ambiguous_name" | "not_in_catalogue";

export const IDENTITY_VIA_LABELS: Record<IdentityVia, string> = {
  item_code: "Catalogue item code",
  alias: "Configured product identity mapping",
  product_name: "Exact product name, unique in the catalogue",
};

export const IDENTITY_UNRESOLVED_LABELS: Record<IdentityUnresolved, string> = {
  no_product: "No product on the row",
  ambiguous_name: "That product name matches more than one catalogue product",
  not_in_catalogue: "Not a catalogue product, and no mapping covers it",
};

export interface ProductIdentity {
  /** The catalogue item code this row means. Null when unresolved. */
  canonicalItemCode: string | null;
  /** The catalogue's own name for it. Never the row's name. */
  canonicalItemName: string | null;
  via: IdentityVia | null;
  unresolved: IdentityUnresolved | null;
  /**
   * The value two rows are compared by to decide they are the same product.
   *
   * The canonical code when the identity resolved; **the raw trimmed code when
   * it did not**, so a product the catalogue has never heard of still matches
   * itself exactly as it does today. That fallback is what makes canonical
   * matching a strict superset of code matching: no comparison that succeeds
   * now can start failing. Null only when there is no code at all, which is the
   * same "no match" the raw compare gives.
   */
  matchKey: string | null;
}

/* ------------------------------------------------------------------------- */
/* The index                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The three lookups, compiled once.
 *
 * Built per page load from two bounded reads -- 28 catalogue rows and 88 alias
 * rows today -- and then consulted in memory. Nothing in this module performs
 * I/O, and no caller may resolve an identity by asking the database per lead or
 * per customer.
 */
export interface ProductIdentityIndex {
  /** Live catalogue products, by trimmed item code. */
  readonly byCode: ReadonlyMap<string, IdentityProduct>;
  /** Active aliases whose canonical is a live product, by trimmed alias code. */
  readonly aliasToCanonical: ReadonlyMap<string, string>;
  /**
   * Normalised catalogue name to its item code. The value is `null` when the
   * name is carried by more than one live product, which is how ambiguity is
   * remembered rather than resolved arbitrarily.
   */
  readonly byName: ReadonlyMap<string, string | null>;
}

/** An index over nothing. Resolves everything to the raw code, which is
 *  precisely the behaviour before this module existed. */
export const EMPTY_IDENTITY_INDEX: ProductIdentityIndex = {
  byCode: new Map(),
  aliasToCanonical: new Map(),
  byName: new Map(),
};

/**
 * Compile the catalogue and its aliases.
 *
 * `products` must already be filtered to active rows -- every caller reads them
 * with `active = true`, and the lifecycle view joins with the same filter, so
 * re-deciding it here would be a second place for the two to disagree.
 *
 * An alias is dropped, silently and deliberately, when its canonical is not a
 * live product. A supervisor deactivating a product should stop it being an
 * identity target, and the alternative -- resolving to a product the desk no
 * longer sells -- is worse than resolving to nothing.
 */
export function buildProductIdentityIndex(
  products: readonly IdentityProduct[],
  aliases: readonly IdentityAlias[] = [],
): ProductIdentityIndex {
  const byCode = new Map<string, IdentityProduct>();
  const byName = new Map<string, string | null>();

  for (const p of products) {
    const code = normalizeItemCode(p.itemCode);
    if (!code) continue;
    byCode.set(code, p);
  }

  /*
   * Names are folded in a second pass, over `byCode` rather than the input, so
   * a catalogue that lists one code twice cannot make that code look like two
   * products sharing a name and thereby mark itself ambiguous.
   */
  for (const p of byCode.values()) {
    const name = normalizeItemName(p.itemName);
    if (!name) continue;
    const code = normalizeItemCode(p.itemCode);
    if (!byName.has(name)) byName.set(name, code);
    else if (byName.get(name) !== code) byName.set(name, null); // ambiguous, and stays so
  }

  const aliasToCanonical = new Map<string, string>();
  for (const a of aliases) {
    if (!a.active) continue;
    const alias = normalizeItemCode(a.aliasItemCode);
    const canonical = normalizeItemCode(a.canonicalItemCode);
    if (!alias || !canonical) continue;
    if (alias === canonical) continue; // refused by the database too
    if (!byCode.has(canonical)) continue; // canonical must be a live product
    if (byCode.has(alias)) continue; // an alias may never shadow a real product
    aliasToCanonical.set(alias, canonical);
  }

  return { byCode, aliasToCanonical, byName };
}

/* ------------------------------------------------------------------------- */
/* The resolver                                                              */
/* ------------------------------------------------------------------------- */

/**
 * The one product identity resolver.
 *
 * Lifecycle, recommendations, purchase history, cross-sell and the customer
 * profile all call this. There is no second implementation to drift from it,
 * which is the entire point: a lead that is "the same product" on one screen
 * and a different one on the next is the disagreement this module exists to
 * make impossible.
 */
export function resolveTelesalesProductIdentity(
  index: ProductIdentityIndex,
  input: ProductBearing,
): ProductIdentity {
  const code = normalizeItemCode(input.itemCode);
  const name = normalizeItemName(input.itemName);

  if (!code && !name) {
    return {
      canonicalItemCode: null,
      canonicalItemName: null,
      via: null,
      unresolved: "no_product",
      matchKey: null,
    };
  }

  // 1. The code is a live catalogue product.
  const direct = code ? index.byCode.get(code) : undefined;
  if (direct) return resolved(index, code, "item_code");

  // 2. An active alias maps it. Checked before the name, because an alias is a
  //    recorded human decision and the name rule is only an inference.
  const aliased = code ? index.aliasToCanonical.get(code) : undefined;
  if (aliased) return resolved(index, aliased, "alias");

  // 3. The whole normalised name matches exactly one live product.
  if (name && index.byName.has(name)) {
    const named = index.byName.get(name);
    if (named) return resolved(index, named, "product_name");
    // Present but null: the name belongs to several products. Refuse it.
    return {
      canonicalItemCode: null,
      canonicalItemName: null,
      via: null,
      unresolved: "ambiguous_name",
      matchKey: code || null,
    };
  }

  return {
    canonicalItemCode: null,
    canonicalItemName: null,
    via: null,
    unresolved: "not_in_catalogue",
    matchKey: code || null,
  };
}

function resolved(
  index: ProductIdentityIndex,
  canonicalCode: string,
  via: IdentityVia,
): ProductIdentity {
  const product = index.byCode.get(canonicalCode);
  return {
    canonicalItemCode: canonicalCode,
    canonicalItemName: product?.itemName ?? null,
    via,
    unresolved: null,
    matchKey: canonicalCode,
  };
}

/* ------------------------------------------------------------------------- */
/* Comparing                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The key two rows are compared by. `null` means "cannot be compared", which is
 * never equal to anything, including another `null`.
 */
export function productMatchKey(index: ProductIdentityIndex, input: ProductBearing): string | null {
  return resolveTelesalesProductIdentity(index, input).matchKey;
}

/**
 * Are these two rows the same CRM product?
 *
 * Two rows with no comparable code are **not** the same product. That is
 * deliberate and matches the behaviour this replaces: a pair of nulls is an
 * absence of evidence, and treating it as a match would make every
 * product-less row a repeat purchase of every other.
 */
export function sameProductIdentity(
  index: ProductIdentityIndex,
  a: ProductBearing,
  b: ProductBearing,
): boolean {
  const left = productMatchKey(index, a);
  if (left === null) return false;
  return left === productMatchKey(index, b);
}

/**
 * The refill cycle for whatever product this row means.
 *
 * Resolved through the same three rules, so the cycle a lead is judged by and
 * the purchases counted as that lead's product can never come from different
 * products. Returns `null` both for an unresolved row and for a catalogued
 * product whose cycle nobody has configured -- two different facts that the
 * lifecycle treats identically, and that `resolveTelesalesProductIdentity`
 * distinguishes for any caller that needs to.
 */
export function refillDaysFor(index: ProductIdentityIndex, input: ProductBearing): number | null {
  const identity = resolveTelesalesProductIdentity(index, input);
  if (!identity.canonicalItemCode) return null;
  return index.byCode.get(identity.canonicalItemCode)?.refillDays ?? null;
}

/**
 * Every raw code that resolves to one canonical product, including the
 * canonical code itself, sorted so the answer is a set rather than an order.
 *
 * Used where a caller has to *ask* for the codes rather than test them one at a
 * time -- the lifecycle view builds the same list in SQL to keep its purchase
 * lookup on the `(phone, item_code)` index instead of scanning.
 */
export function codesForCanonical(
  index: ProductIdentityIndex,
  canonicalItemCode: string,
): string[] {
  const canonical = normalizeItemCode(canonicalItemCode);
  if (!canonical || !index.byCode.has(canonical)) return [];
  const out = [canonical];
  for (const [alias, target] of index.aliasToCanonical) {
    if (target === canonical) out.push(alias);
  }
  return out.sort();
}
