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

export interface RelationInput {
  fromItemCode: string;
  toItemCode: string;
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
  if (existing.note !== next.note || existing.toItemName !== next.toItemName) return "updated";
  return "unchanged";
}

export const SAVE_PLAN_LABELS: Record<SavePlan, string> = {
  created: "Cross-sell added",
  reactivated: "Cross-sell switched back on",
  updated: "Cross-sell updated",
  unchanged: "No change — that cross-sell is already configured",
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
