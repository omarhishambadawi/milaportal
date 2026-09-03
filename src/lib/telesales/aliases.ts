import { normalizeItemCode, normalizeItemName } from "./products";
import { resolveTelesalesProductIdentity, type ProductIdentityIndex } from "./identity";

/**
 * Product identity mapping: the rules for what may be configured at all.
 *
 * ===========================================================================
 * What a mapping asserts, and what it does not
 * ===========================================================================
 * A row here says one thing: *these two item codes are the same medicine, under
 * two numbering systems*. It is a statement about identity, not about
 * similarity, not about substitution, and emphatically not about a companion
 * product. `telesales_product_relations` is the other concept and the two never
 * feed each other -- mapping a code must never create a cross-sell, and
 * configuring a cross-sell must never merge two identities.
 *
 * It is also not a merge. Both `telesales_products` rows survive, both source
 * records keep the code they arrived with, and switching the mapping off
 * restores every previous answer, because nothing was rewritten.
 *
 * ===========================================================================
 * Why the validator refuses so much
 * ===========================================================================
 * The expensive mistake is mapping `MOUNJARO KWIKPEN 5 MG` onto
 * `MOUNJARO KWIKPEN 15MG` -- five strengths that share every word but one, on a
 * screen that lists them next to each other. Nothing here can prevent a
 * supervisor asserting that deliberately; what it can do is refuse every
 * mapping that is structurally wrong, take the canonical product from the
 * catalogue rather than from the request, and make the sentence the supervisor
 * is agreeing to say exactly what it will do.
 *
 * Pure, like `relations.ts`, so the rules are testable without a database. The
 * server function applies the verdict and owns the transport; the database
 * repeats every rule as a constraint, because a validator is a courtesy and a
 * constraint is a guarantee.
 */

/** A product from `telesales_products`. The master, never re-typed. */
export interface AliasProduct {
  itemCode: string;
  itemName: string;
  active: boolean;
}

export interface AliasInput {
  aliasItemCode: string;
  canonicalItemCode: string;
  /** The name the alias code was seen under, for the audit trail. */
  aliasNameSnapshot?: string | null;
  note?: string | null;
}

/** Why a proposed mapping was refused. */
export type AliasRejection =
  | "missing_alias"
  | "missing_canonical"
  | "same_code"
  | "alias_is_catalogue_product"
  | "unknown_canonical"
  | "inactive_canonical";

export const ALIAS_REJECTION_LABELS: Record<AliasRejection, string> = {
  missing_alias: "Enter the source item code to map",
  missing_canonical: "Choose the catalogue product it refers to",
  same_code: "A code cannot be mapped to itself",
  alias_is_catalogue_product:
    "That code is already a product in the Telesales catalogue, so it is its own identity and cannot be an alias",
  unknown_canonical: "That product is not in the Telesales catalogue",
  inactive_canonical:
    "That product is switched off in the catalogue, so it cannot be a canonical identity",
};

export interface ValidatedAlias {
  aliasItemCode: string;
  canonicalItemCode: string;
  /** Taken from the catalogue, never from the request. */
  canonicalItemName: string;
  aliasNameSnapshot: string | null;
  note: string | null;
}

export type AliasValidation =
  | { ok: true; value: ValidatedAlias }
  | { ok: false; reason: AliasRejection };

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Can this mapping be configured?
 *
 * The two structural rules are the ones that matter, and together they make
 * resolution a single step forever:
 *
 *   * the canonical **must** be a live `telesales_products` row, and
 *   * the alias **must not** be any `telesales_products` row.
 *
 * A code that is both would be a chain -- `A -> B` where `B -> C` -- and every
 * consumer would then have to decide how far to follow it, which is a decision
 * nobody should have to make about a medicine. Refusing the second rule makes
 * the question impossible rather than answered.
 *
 * Unlike a cross-sell, the canonical may not be inactive. A cross-sell's source
 * is allowed to be a discontinued product because the customer really did buy
 * it; a canonical identity is the product every downstream answer will be
 * computed against, and pointing it at something the desk has switched off
 * would resolve live leads onto a dead row.
 */
export function validateAlias(
  input: AliasInput,
  catalog: ReadonlyMap<string, AliasProduct>,
): AliasValidation {
  const alias = normalizeItemCode(input.aliasItemCode);
  const canonical = normalizeItemCode(input.canonicalItemCode);

  if (!alias) return { ok: false, reason: "missing_alias" };
  if (!canonical) return { ok: false, reason: "missing_canonical" };

  // Checked first, because "a code cannot be mapped to itself" is the more
  // useful thing to say than "that code is already a catalogue product", and
  // the database CHECK constraint enforces the same rule underneath.
  if (alias === canonical) return { ok: false, reason: "same_code" };

  if (catalog.has(alias)) return { ok: false, reason: "alias_is_catalogue_product" };

  const target = catalog.get(canonical);
  if (!target) return { ok: false, reason: "unknown_canonical" };
  if (!target.active) return { ok: false, reason: "inactive_canonical" };

  const snapshot = clean(input.aliasNameSnapshot);
  const note = clean(input.note);
  return {
    ok: true,
    value: {
      aliasItemCode: alias,
      canonicalItemCode: canonical,
      canonicalItemName: target.itemName,
      aliasNameSnapshot: snapshot || null,
      note: note || null,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Saving over an existing mapping                                           */
/* ------------------------------------------------------------------------- */

/** What an existing row means for a save of the same alias code. */
export type AliasSavePlan = "created" | "reactivated" | "repointed" | "updated" | "unchanged";

export interface ExistingAlias {
  canonicalItemCode: string;
  active: boolean;
  note: string | null;
  aliasNameSnapshot: string | null;
}

export const ALIAS_SAVE_PLAN_LABELS: Record<AliasSavePlan, string> = {
  created: "Product identity mapping added",
  reactivated: "Product identity mapping switched back on",
  repointed: "Product identity mapping now points at a different product",
  updated: "Product identity mapping updated",
  unchanged: "No change — that mapping is already configured",
};

/**
 * What saving this mapping should actually do.
 *
 * The unique key is on the alias code alone and ignores both `active` and the
 * canonical, which is what makes all four outcomes reachable through one save:
 * a code maps to exactly one product at a time, re-saving a switched-off
 * mapping reactivates the original row rather than creating a second, and
 * pointing a code somewhere new is an edit with a history rather than a
 * delete-and-insert.
 *
 * `repointed` is separated from `updated` because it is the consequential one.
 * Changing a note changes a sentence; changing the canonical changes which
 * purchases count as the same medicine, and the supervisor should be told which
 * of the two they just did.
 */
export function planAliasSave(existing: ExistingAlias | null, next: ValidatedAlias): AliasSavePlan {
  if (!existing) return "created";
  if (existing.canonicalItemCode !== next.canonicalItemCode) return "repointed";
  if (!existing.active) return "reactivated";
  if (existing.note !== next.note || existing.aliasNameSnapshot !== next.aliasNameSnapshot) {
    return "updated";
  }
  return "unchanged";
}

/* ------------------------------------------------------------------------- */
/* Reading the catalogue                                                     */
/* ------------------------------------------------------------------------- */

export function buildAliasCatalog(products: readonly AliasProduct[]): Map<string, AliasProduct> {
  const out = new Map<string, AliasProduct>();
  for (const p of products) {
    const code = normalizeItemCode(p.itemCode);
    if (code) out.set(code, p);
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Candidates                                                                */
/* ------------------------------------------------------------------------- */

/**
 * A source item code the catalogue does not carry, and what it appears to be.
 *
 * This is the audit made continuous. The original pass over the live data found
 * 112 distinct source codes for 23 product names, of which 90 were absent from
 * the catalogue: 88 whose whole normalised name matched exactly one catalogue
 * product, and two -- `LIMITLESS CHROMAX CUT SACHETS` and `SAXENDA 6MG/ML` --
 * that are simply products the desk does not carry. The same computation runs
 * on the management screen so the next import's unmapped codes surface without
 * anybody re-running an audit by hand.
 */
export type AliasCandidateStatus =
  | "exact_code_match"
  | "exact_unique_name_match"
  | "ambiguous"
  | "no_match";

export const ALIAS_CANDIDATE_LABELS: Record<AliasCandidateStatus, string> = {
  exact_code_match: "Already a catalogue product",
  exact_unique_name_match: "Name matches exactly one catalogue product",
  ambiguous: "Name matches more than one catalogue product",
  no_match: "Not recognised — no catalogue product carries this name",
};

export interface AliasCandidate {
  sourceItemCode: string;
  sourceItemName: string | null;
  /** How many source rows carry this code. Ordering is by this, descending. */
  occurrences: number;
  status: AliasCandidateStatus;
  canonicalItemCode: string | null;
  canonicalItemName: string | null;
  /** True when an alias row already covers this code, active or not. */
  alreadyMapped: boolean;
  reason: string;
}

/** One distinct (code, name) pair seen in the source, with a count. */
export interface SourceProductTally {
  itemCode: string | null;
  itemName: string | null;
  occurrences: number;
}

/**
 * Which source codes need a decision.
 *
 * Deliberately reports `exact_unique_name_match` as a *candidate* rather than
 * applying it. The name rule already resolves those rows at read time, so
 * nothing is broken while they sit here; promoting one to an alias is what
 * turns an inference into a recorded decision, and that is a person's call.
 *
 * Pure and in-memory: the caller reads the tallies once, and this walks them.
 * Nothing here queries anything per code.
 */
export function findAliasCandidates(
  tallies: readonly SourceProductTally[],
  index: ProductIdentityIndex,
  mappedCodes: ReadonlySet<string> = new Set(),
): AliasCandidate[] {
  /*
   * Folded by code first. One code can appear against several spellings of a
   * name across imports, and reporting it twice would ask a supervisor to make
   * the same decision twice.
   */
  const byCode = new Map<string, { name: string | null; occurrences: number }>();
  for (const row of tallies) {
    const code = normalizeItemCode(row.itemCode);
    if (!code) continue;
    const existing = byCode.get(code);
    if (existing) {
      existing.occurrences += row.occurrences;
      if (!existing.name) existing.name = row.itemName ?? null;
      continue;
    }
    byCode.set(code, { name: row.itemName ?? null, occurrences: row.occurrences });
  }

  const out: AliasCandidate[] = [];
  for (const [code, row] of byCode) {
    const identity = resolveTelesalesProductIdentity(index, {
      itemCode: code,
      itemName: row.name,
    });

    const status: AliasCandidateStatus =
      identity.via === "item_code"
        ? "exact_code_match"
        : identity.via === "alias"
          ? "exact_code_match" // already decided; not a candidate needing one
          : identity.via === "product_name"
            ? "exact_unique_name_match"
            : identity.unresolved === "ambiguous_name"
              ? "ambiguous"
              : "no_match";

    out.push({
      sourceItemCode: code,
      sourceItemName: row.name,
      occurrences: row.occurrences,
      status,
      canonicalItemCode: identity.canonicalItemCode,
      canonicalItemName: identity.canonicalItemName,
      alreadyMapped: mappedCodes.has(code) || identity.via === "alias",
      reason:
        identity.via === "alias"
          ? "A configured mapping already covers this code"
          : ALIAS_CANDIDATE_LABELS[status],
    });
  }

  /*
   * Most-seen first, then by code, so the list is stable across page loads and
   * the codes worth a decision are the ones at the top.
   */
  out.sort(
    (a, b) => b.occurrences - a.occurrences || a.sourceItemCode.localeCompare(b.sourceItemCode),
  );
  return out;
}

/**
 * The sentence a supervisor agrees to before saving.
 *
 * Spelled out rather than implied by two dropdowns, because what is being
 * asserted -- that these are one medicine for every purchase, refill and
 * recommendation from now on -- is not obvious from an arrow between two names.
 */
export function describeAliasEffect(next: ValidatedAlias, aliasName?: string | null): string {
  const alias = normalizeItemName(aliasName)
    ? `${aliasName!.trim()} (${next.aliasItemCode})`
    : next.aliasItemCode;
  return (
    `Item code ${alias} will be treated as the same CRM product as ` +
    `${next.canonicalItemName} (${next.canonicalItemCode}) for purchase history, ` +
    `refill cycles and recommendations. No source record, invoice or Shams MIS ` +
    `identifier is changed, and switching the mapping off reverses it.`
  );
}
