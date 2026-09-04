import { resolveTelesalesProductIdentity, type ProductIdentityIndex } from "./identity";
import type { ProductRelation } from "./recommendations";

/**
 * Cross-sell configuration: the rules for what may be configured at all.
 *
 * ===========================================================================
 * Configuration, not inference
 * ===========================================================================
 * A relationship here says one thing: *an authorized person decided that a
 * customer who bought A is worth telling about B*. It is not evidence, not a
 * correlation, and emphatically not a clinical judgement. Phase 3 measured the
 * co-purchase data and found nothing that could support deriving these — the
 * only pairs with support from more than one customer were different strengths
 * of the same medicine — so the table ships empty and stays empty until a human
 * fills it in.
 *
 * That is also why a dose change is not a relationship. Mounjaro 5mg to
 * Mounjaro 10mg is a prescribing decision; nothing in this module may propose
 * one, and nothing here treats two products as related because they share a
 * family. The only way a pair exists is that somebody with `manage_telesales`
 * typed it.
 *
 * ===========================================================================
 * Pure, so the rules are testable
 * ===========================================================================
 * Validation lives here rather than in the server function so the CRUD rules —
 * both products real, not the same product, no silent duplicate — can be tested
 * without a database. The server function applies the verdict and owns the
 * transport.
 */

/** A product from `telesales_products`. The master, never re-typed. */
export interface RelationProduct {
  itemCode: string;
  itemName: string;
  active: boolean;
}

/**
 * What kind of thing the desk is asserting about the pair.
 *
 * Both are "tell this customer about that product" and both are typed by a
 * person; they differ in what the agent says next. A cross-sell opens with a
 * companion — you buy the pen, here is the sensor. An up-sell opens with more
 * of the same — you buy the 4-pack monthly, here is the 12-week one.
 *
 * Naming the difference is the entire reason for the field: the recommendation
 * strip reads it aloud to the agent, and "you might also want" is the wrong
 * sentence for a larger pack of what is already in the basket.
 */
export const RELATION_KINDS = ["cross_sell", "up_sell"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const RELATION_KIND_LABELS: Record<RelationKind, string> = {
  cross_sell: "Cross-sell",
  up_sell: "Up-sell",
};

/** How the agent is meant to open, per kind. Shown on the configuration screen
 *  so the choice is made against what it will produce. */
export const RELATION_KIND_HINTS: Record<RelationKind, string> = {
  cross_sell: "A companion product — something that goes with what they bought.",
  up_sell: "More of the same — a larger pack or a higher tier of what they buy.",
};

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === "string" && (RELATION_KINDS as readonly string[]).includes(value);
}

export interface RelationInput {
  fromItemCode: string;
  toItemCode: string;
  kind?: string | null;
  note?: string | null;
}

/** Why a proposed relationship was refused. */
export type RelationRejection =
  | "missing_source"
  | "missing_target"
  | "same_product"
  | "unknown_source"
  | "unknown_target"
  | "inactive_target";

export const RELATION_REJECTION_LABELS: Record<RelationRejection, string> = {
  missing_source: "Choose the product the customer already bought",
  missing_target: "Choose the product to recommend",
  same_product: "A product cannot be its own cross-sell",
  unknown_source: "That product is not in the Telesales catalogue",
  unknown_target: "That product is not in the Telesales catalogue",
  inactive_target: "That product is switched off in the catalogue, so it cannot be recommended",
};

export interface ValidatedRelation {
  fromItemCode: string;
  toItemCode: string;
  kind: RelationKind;
  /** Taken from the catalogue, never from user input — the agent reads this
   *  name as the explanation, so it has to be the pharmacy's own. */
  toItemName: string;
  note: string | null;
}

export type RelationValidation =
  | { ok: true; value: ValidatedRelation }
  | { ok: false; reason: RelationRejection };

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Can this pair be configured?
 *
 * The catalogue is the authority on both ends. A free-typed item code would let
 * somebody configure a recommendation for a product the pharmacy does not sell,
 * which an agent would then read out to a customer.
 *
 * The source is allowed to be a *deactivated* product; the target is not. A
 * customer may well have bought something the desk has since stopped selling,
 * and that purchase is still a real fact to recommend from — but recommending a
 * product that has been switched off is offering something that cannot be
 * fulfilled.
 */
export function validateRelation(
  input: RelationInput,
  catalog: ReadonlyMap<string, RelationProduct>,
): RelationValidation {
  const from = clean(input.fromItemCode);
  const to = clean(input.toItemCode);

  if (!from) return { ok: false, reason: "missing_source" };
  if (!to) return { ok: false, reason: "missing_target" };

  // Checked before existence: "a product cannot be its own cross-sell" is the
  // more useful thing to say than "that product is not in the catalogue", and
  // the database CHECK constraint enforces the same rule underneath.
  if (from === to) return { ok: false, reason: "same_product" };

  const source = catalog.get(from);
  if (!source) return { ok: false, reason: "unknown_source" };

  const target = catalog.get(to);
  if (!target) return { ok: false, reason: "unknown_target" };
  if (!target.active) return { ok: false, reason: "inactive_target" };

  const note = clean(input.note);
  return {
    ok: true,
    value: {
      fromItemCode: from,
      toItemCode: to,
      // Defaulted rather than refused: every pair configured before this field
      // existed is a cross-sell, and so is a request that omits it.
      kind: isRelationKind(input.kind) ? input.kind : "cross_sell",
      toItemName: target.itemName,
      note: note || null,
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Saving over an existing pair                                              */
/* ------------------------------------------------------------------------- */

/** What an existing row means for a save of the same pair. */
export type SavePlan = "created" | "reactivated" | "updated" | "unchanged";

export interface ExistingRelation {
  active: boolean;
  note: string | null;
  toItemName: string;
  kind: RelationKind;
}

/**
 * What saving this pair should actually do.
 *
 * The unique key is on the pair alone and ignores `active`, which is what makes
 * this possible: re-configuring a pair somebody switched off reactivates the
 * original row rather than failing on a constraint or quietly creating a
 * second. The configuration's history survives being turned off and on again,
 * and a supervisor never sees "that already exists" for something they cannot
 * see in the list.
 *
 * `unchanged` matters as much as the others — saving a pair that is already
 * active with the same note should not bump `updated_at` and claim somebody
 * edited it.
 */
export function planSave(existing: ExistingRelation | null, next: ValidatedRelation): SavePlan {
  if (!existing) return "created";
  if (!existing.active) return "reactivated";
  if (
    existing.note !== next.note ||
    existing.toItemName !== next.toItemName ||
    existing.kind !== next.kind
  ) {
    return "updated";
  }
  return "unchanged";
}

export const SAVE_PLAN_LABELS: Record<SavePlan, string> = {
  created: "Recommendation added",
  reactivated: "Recommendation switched back on",
  updated: "Recommendation updated",
  unchanged: "No change — that pair is already configured",
};

/* ------------------------------------------------------------------------- */
/* Reading the catalogue                                                     */
/* ------------------------------------------------------------------------- */

export function buildRelationCatalog(
  products: readonly RelationProduct[],
): Map<string, RelationProduct> {
  const out = new Map<string, RelationProduct>();
  for (const p of products) {
    const code = clean(p.itemCode);
    if (code) out.set(code, p);
  }
  return out;
}

/**
 * How a configured pair reads on screen.
 *
 * Names, never codes. The agent is being told why a lead is in front of them,
 * and `10611028 → 99001` is not a reason.
 */
export function describeRelation(
  relation: { fromItemCode: string; toItemName: string },
  catalog: ReadonlyMap<string, RelationProduct>,
): string {
  const from = catalog.get(relation.fromItemCode.trim());
  return `${from?.itemName ?? relation.fromItemCode} → ${relation.toItemName}`;
}

/* ------------------------------------------------------------------------- */
/* Which cross-sells apply to one lead                                       */
/* ------------------------------------------------------------------------- */

/**
 * The configured companions for the product a lead is about.
 *
 * ===========================================================================
 * A different question from the recommendation engine's
 * ===========================================================================
 * `findRelation` in `recommendations.ts` picks the *single* cross-sell that
 * becomes a lead's headline recommendation, and to do that it needs the
 * customer's whole purchase history: it excludes companions they already own,
 * and it considers every product they have ever bought as a possible source.
 * That rule is unchanged and nothing here touches it.
 *
 * This answers the narrower question the lead page asks — *for the product in
 * front of me, what has the desk configured?* — so it takes no history and
 * makes no judgement about what the customer owns. An agent looking at the
 * panel wants the configuration, not a ranked suggestion; the suggestion is
 * what Recommended Leads is for.
 *
 * ===========================================================================
 * Identity, not the raw code
 * ===========================================================================
 * A relation is always configured against a `telesales_products` code, because
 * `validateRelation` accepts nothing else. A lead may carry an alias code from
 * the source workbook's other numbering, so matching on the raw code alone
 * would show nothing for the 88 leads that carry one. The canonical identity is
 * resolved through `resolveTelesalesProductIdentity` — the module's one
 * resolver — and the raw code is kept as well, so nothing that matched before
 * can stop matching.
 *
 * Inactive relations are not filtered here. The caller reads them from the
 * database with `active = true`, exactly as the recommendation engine does, and
 * duplicating that filter in two places is how the two come to disagree.
 */
export function applicableCrossSell(input: {
  /** The lead's product, as the lead carries it. */
  product: { itemCode: string | null; itemName: string | null };
  identity: ProductIdentityIndex;
  /** Active relations, keyed by the product the customer already bought. */
  relationsByItem: ReadonlyMap<string, readonly ProductRelation[]>;
}): ProductRelation[] {
  const raw = input.product.itemCode?.trim();
  const canonical = resolveTelesalesProductIdentity(
    input.identity,
    input.product,
  ).canonicalItemCode;

  const sources = new Set<string>();
  if (raw) sources.add(raw);
  if (canonical) sources.add(canonical);
  if (sources.size === 0) return [];

  /*
   * Deduplicated by target.
   *
   * A lead whose raw code and canonical code are both configured would
   * otherwise list the same companion twice — which reads as two
   * recommendations for one decision.
   */
  const byTarget = new Map<string, ProductRelation>();
  for (const code of [...sources].sort()) {
    for (const relation of input.relationsByItem.get(code) ?? []) {
      const target = relation.toItemCode.trim();
      if (!byTarget.has(target)) byTarget.set(target, relation);
    }
  }

  // Sorted, so the same lead lists the same companions in the same order on
  // every load — the ordering `findRelation` also insists on, for the same
  // reason.
  return [...byTarget.values()].sort((a, b) => a.toItemCode.localeCompare(b.toItemCode));
}
