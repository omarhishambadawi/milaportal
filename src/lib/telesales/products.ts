import type { LeadType } from "./types";

/**
 * Product eligibility.
 *
 * Two questions, asked in this order for every source row:
 *
 *   1. Is this item code one the desk sells by phone?
 *   2. If nobody has classified that code yet, does its *name* say what it is?
 *
 * The first is a table lookup; the second is an ordered list of rules. Both come
 * out of the database (`telesales_products`, `telesales_product_patterns`), so
 * adding a strength is a row rather than a release. This file is the pure
 * matcher over whatever those tables currently say.
 *
 * ### Why name matching alone is not enough
 *
 * `FREESTYLE OPTIUM STRIPS 50's` and `FREESTYLE OPTIUM GLUCOSE METER` occur 42
 * and 39 times in the July extract and never once in a working sheet. They are
 * fingerstick products; FreeStyle Libre is a continuous glucose monitor. A rule
 * that asks whether the name contains "FREESTYLE" is wrong 81 times a month, and
 * it is wrong in the expensive direction — an agent calls somebody about a
 * product they did not buy.
 *
 * ### Why code matching alone is not enough either
 *
 * The extract is the pharmacy's, and it gains SKUs without telling anyone. A new
 * Mounjaro strength arrives with an unknown code; if only the code table were
 * consulted it would be invisible until somebody noticed the queue was short.
 */

/** A row of `telesales_products`. */
export interface ProductRow {
  itemCode: string;
  itemName: string;
  family: string;
  strength: string | null;
  category: string | null;
  eligibleCash: boolean;
  eligibleRetention: boolean;
  refillDays: number | null;
  active: boolean;
}

/** A row of `telesales_product_patterns`. */
export interface ProductPatternRow {
  pattern: string;
  family: string;
  eligible: boolean;
  priority: number;
  active: boolean;
}

/** The answer, with enough provenance to explain itself on screen. */
export interface ProductMatch {
  eligible: boolean;
  family: string | null;
  strength: string | null;
  refillDays: number | null;
  /** How the decision was reached. Shown on the lead detail page and stored in
   *  the generation run's counters, so "why is this not a lead" is answerable
   *  without re-running anything. */
  reason:
    | "catalog"
    | "catalog_disabled"
    | "catalog_wrong_type"
    | "pattern"
    | "pattern_excluded"
    | "unknown";
  /** The pattern that decided it, when one did. */
  matchedPattern: string | null;
}

/**
 * Collapse whitespace and upper-case, so `"VOLTIC-D 50MG 20 DISP. TAB "` and
 * `"VOLTIC-D  50MG 20 DISP. TAB"` are one string.
 *
 * Nothing else is stripped. Punctuation carries meaning in these names —
 * `MOUNJARO 15 MG 0.5ML PEN 4'S` is a different product from
 * `MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR` — and a matcher that discarded it
 * would collapse two SKUs the desk prices differently.
 */
export function normalizeItemName(name: string | null | undefined): string {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Item codes arrive as numbers, as numeric strings, and once as `"10611032 "`. */
export function normalizeItemCode(code: string | number | null | undefined): string {
  if (code == null) return "";
  return String(code).trim();
}

/**
 * A compiled catalogue, built once per generation run rather than per row.
 *
 * The July extract is 173,008 rows; recompiling nine regular expressions for
 * each of them is the difference between a run that takes a second and one that
 * takes a minute.
 */
export interface ProductCatalog {
  byCode: Map<string, ProductRow>;
  patterns: { re: RegExp; family: string; eligible: boolean; source: string }[];
}

export function buildCatalog(
  products: readonly ProductRow[],
  patterns: readonly ProductPatternRow[],
): ProductCatalog {
  const byCode = new Map<string, ProductRow>();
  for (const p of products) {
    if (!p.active) continue;
    byCode.set(normalizeItemCode(p.itemCode), p);
  }

  const compiled: ProductCatalog["patterns"] = [];
  for (const row of [...patterns].filter((p) => p.active).sort((a, b) => a.priority - b.priority)) {
    let re: RegExp;
    try {
      re = new RegExp(row.pattern, "i");
    } catch {
      /*
       * A pattern that will not compile is skipped, not thrown.
       *
       * These are operator-editable strings. One bad regular expression typed
       * into the product screen must not take down the nightly generation for
       * every product — the cost of skipping it is that one family falls back to
       * code matching, which is the behaviour before the rule existed.
       */
      continue;
    }
    compiled.push({ re, family: row.family, eligible: row.eligible, source: row.pattern });
  }

  return { byCode, patterns: compiled };
}

/**
 * Decide whether one source row's product belongs in a queue of this type.
 *
 * Order of resolution:
 *
 *   1. **The code is in the catalogue.** That is the end of it, in both
 *      directions — a code listed as ineligible is ineligible even if its name
 *      matches a positive pattern. This is what makes seeding FreeStyle Optium
 *      as `eligible_cash = false` an actual guarantee rather than a hint.
 *
 *   2. **The name matches a pattern**, lowest priority number first. An
 *      exclusion (`eligible = false`) stops the scan and refuses.
 *
 *   3. **Neither.** Not eligible, reported as `unknown` so the import summary
 *      can say how many rows nobody has classified.
 */
export function matchProduct(
  catalog: ProductCatalog,
  input: { itemCode: string | number | null | undefined; itemName: string | null | undefined },
  leadType: LeadType,
): ProductMatch {
  const code = normalizeItemCode(input.itemCode);
  const known = code ? catalog.byCode.get(code) : undefined;

  if (known) {
    // Retention asks a different question from Cash: a sensor is consumed and
    // re-ordered, a reader is bought once. `telesales_products` carries both
    // answers and the lead type picks one.
    const eligible = leadType === "retention" ? known.eligibleRetention : known.eligibleCash;
    return {
      eligible,
      family: known.family,
      strength: known.strength,
      refillDays: known.refillDays,
      reason: eligible
        ? "catalog"
        : leadType === "retention" && known.eligibleCash
          ? "catalog_wrong_type"
          : "catalog_disabled",
      matchedPattern: null,
    };
  }

  const name = normalizeItemName(input.itemName);
  if (name) {
    for (const p of catalog.patterns) {
      if (!p.re.test(name)) continue;
      return {
        eligible: p.eligible,
        family: p.family,
        strength: null,
        refillDays: null,
        reason: p.eligible ? "pattern" : "pattern_excluded",
        matchedPattern: p.source,
      };
    }
  }

  return {
    eligible: false,
    family: null,
    strength: null,
    refillDays: null,
    reason: "unknown",
    matchedPattern: null,
  };
}

/** Human copy for the import summary and the lead detail page. */
export const MATCH_REASON_LABELS: Record<ProductMatch["reason"], string> = {
  catalog: "Eligible product",
  catalog_disabled: "Product is switched off in the catalogue",
  catalog_wrong_type: "Eligible for Cash but not for a refill cycle",
  pattern: "Matched a product name rule",
  pattern_excluded: "Excluded by a product name rule",
  unknown: "Product not recognised",
};

/**
 * The families the desk works, for filter dropdowns.
 *
 * Derived from the catalogue rather than hardcoded, so a family added by an
 * INSERT appears in the filter without a release.
 */
export function familiesInCatalog(catalog: ProductCatalog): string[] {
  const seen = new Set<string>();
  for (const p of catalog.byCode.values())
    if (p.eligibleCash || p.eligibleRetention) seen.add(p.family);
  for (const p of catalog.patterns) if (p.eligible) seen.add(p.family);
  return [...seen].sort();
}

const FAMILY_LABELS: Record<string, string> = {
  mounjaro: "Mounjaro",
  ozempic: "Ozempic",
  wegovy: "Wegovy",
  rybelsus: "Rybelsus",
  freestyle_libre: "FreeStyle Libre",
  dexcom: "Dexcom",
  insulin: "Insulin",
  other: "Other",
};

/** `freestyle_libre` → "FreeStyle Libre"; an unmapped family title-cases so a
 *  new one is readable the day it is inserted. */
export function familyLabel(family: string | null | undefined): string {
  if (!family) return "—";
  return (
    FAMILY_LABELS[family] ??
    family
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}
