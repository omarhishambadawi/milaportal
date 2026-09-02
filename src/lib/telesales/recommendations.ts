import {
  addDays,
  compareDates,
  daysBetween,
  describeRefill,
  formatBusinessDate,
  isBusinessDate,
  type BusinessDate,
  type RefillLabel,
} from "./dates";
import { isRefillStale } from "./lifecycle";
import type { InvoiceMatchStatus } from "./reconciliation";
import type { StockState } from "@/lib/shams/availability";

/**
 * Which leads are worth calling first, and why.
 *
 * ===========================================================================
 * Deterministic, explainable, and computed from data we already hold
 * ===========================================================================
 * Every recommendation here is a rule an agent can argue with. There is no
 * score, no model and no ranking the desk cannot reconstruct: a lead is
 * recommended because the customer bought this product and the refill cycle
 * says they have run out, or because they have bought it more than once, or
 * because somebody configured a related product. Nothing else qualifies.
 *
 * ===========================================================================
 * The purchase history is local, which is what makes this affordable
 * ===========================================================================
 * `telesales_source_records` is the pharmacy's own sales extract, already
 * imported: phone, item code, date, document number, branch. That is a purchase
 * history, and it is in Postgres. So the whole engine runs on one query per
 * page load rather than one MIS request per lead — the failure mode the brief
 * is most concerned about.
 *
 * The Shams MIS stays the source of truth for what it sold. This module never
 * calls it; the richer per-customer history on the lead detail still comes from
 * `shamsGetCustomerHistory`, and the two do not compete because they answer
 * different questions. This one asks "which of these 700 leads should I look at
 * at all", which must be answerable without asking anybody.
 *
 * ===========================================================================
 * What is deliberately NOT inferred
 * ===========================================================================
 * Product relationships. Cross-sell fires only from an explicit configured
 * relation (`telesales_product_relations`). Co-purchase in the live data does
 * not support anything more: of the pairs bought by the same customer, the nine
 * with support from more than one customer are all within a single product
 * family — dose changes, not companions — and every cross-family pair rests on
 * exactly one customer. Deriving "bought A, so offer B" from that would be
 * inventing a commercial relationship out of coincidence, and for medication it
 * would be inventing a clinical one. So the rule exists, is tested, and returns
 * nothing until the business configures a pair.
 */

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                */
/* ------------------------------------------------------------------------- */

/** The three reasons a lead can be recommended. */
export type RecommendationKind = "refill" | "previously_purchased" | "cross_sell";

/**
 * The priority bands, strongest first.
 *
 * A band is the *headline* — one per lead. Everything else a lead has going for
 * it (in stock, verified invoice, bought before) travels as a supporting badge
 * on the same recommendation rather than as a second row.
 */
export type RecommendationBand =
  | "refill_due_today"
  | "refill_overdue"
  | "refill_soon"
  | "previously_purchased"
  | "cross_sell";

/**
 * Rank order, lower is stronger. Exactly the order the brief asks for.
 *
 * Due-today outranks overdue on purpose: an overdue refill is a customer who
 * has already gone without, and calling them is still right, but the one whose
 * supply runs out *today* is the call that stops it happening at all.
 */
export const BAND_PRIORITY: Record<RecommendationBand, number> = {
  refill_due_today: 1,
  refill_overdue: 2,
  refill_soon: 3,
  previously_purchased: 4,
  cross_sell: 5,
};

export const BAND_LABELS: Record<RecommendationBand, string> = {
  refill_due_today: "REFILL DUE TODAY",
  refill_overdue: "REFILL OVERDUE",
  refill_soon: "REFILL SOON",
  previously_purchased: "PREVIOUSLY PURCHASED",
  cross_sell: "CROSS-SELL",
};

export const KIND_LABELS: Record<RecommendationKind, string> = {
  refill: "Refill opportunity",
  previously_purchased: "Previously purchased",
  cross_sell: "Cross-sell",
};

/** A supporting signal. Never a reason to recommend on its own. */
export type SupportingBadge = "in_stock" | "invoice_verified" | "bought_before" | "repeat_customer";

export const SUPPORTING_LABELS: Record<SupportingBadge, string> = {
  in_stock: "IN STOCK",
  invoice_verified: "INVOICE VERIFIED",
  bought_before: "BOUGHT BEFORE",
  repeat_customer: "REPEAT CUSTOMER",
};

/* ------------------------------------------------------------------------- */
/* Inputs                                                                    */
/* ------------------------------------------------------------------------- */

/** One row of the local purchase history (`telesales_source_records`). */
export interface PurchaseRecord {
  phone: string;
  itemCode: string | null;
  itemName: string | null;
  sourceDate: BusinessDate | null;
  documentNo: string | null;
  branchNo: string | null;
}

/** The refill cycle for a product (`telesales_products.refill_days`). */
export interface RefillCycle {
  itemCode: string;
  refillDays: number | null;
}

/**
 * A configured product relationship (`telesales_product_relations`).
 *
 * Business configuration, never inference. `note` is the desk's own wording and
 * is shown to the agent verbatim when present, so a relationship can carry the
 * reason it exists rather than being asserted by the software.
 */
export interface ProductRelation {
  fromItemCode: string;
  toItemCode: string;
  toItemName: string;
  note: string | null;
}

/** The parts of a lead this engine reads. A projection, not the whole row. */
export interface RecommendableLead {
  id: string;
  phone: string | null;
  itemCode: string | null;
  itemName: string | null;
  branchNo: string | null;
  sourceDate: BusinessDate | null;
  nextFollowupOn: BusinessDate | null;
  invoiceMatchStatus: InvoiceMatchStatus | null;
  documentNo: string | null;
}

/** Everything the engine needs, gathered once for the whole page. */
export interface RecommendationContext {
  today: BusinessDate;
  /** Purchase history grouped by canonical phone. */
  historyByPhone: ReadonlyMap<string, readonly PurchaseRecord[]>;
  /** Refill cycle per item code. */
  cycleByItem: ReadonlyMap<string, RefillCycle>;
  /** Configured relations, keyed by the product the customer already bought. */
  relationsByItem: ReadonlyMap<string, readonly ProductRelation[]>;
  /**
   * Branch stock, when it is known. Absent means **unknown**, which is not
   * out-of-stock and never suppresses a recommendation.
   */
  stockByItem?: ReadonlyMap<string, { state: StockState; quantity: number | null }>;
  /** How many days ahead still counts as "soon". Three, matching `describeRefill`. */
  soonDays?: number;
  /**
   * The staleness bound for a product with no configured cycle.
   *
   * Only a fallback: where `telesales_products.refill_days` exists it is used
   * instead, so the bound is the product's own cycle rather than one number
   * applied to a 10-day sensor and a 30-day pen alike.
   */
  defaultStaleDays?: number;
}

/* ------------------------------------------------------------------------- */
/* Output                                                                    */
/* ------------------------------------------------------------------------- */

/** Why a lead was not recommended. Kept so the page can say so honestly. */
export type DeclineReason =
  | "no_phone"
  | "no_product"
  | "no_purchase_history"
  | "no_refill_basis"
  | "refill_too_stale"
  | "not_due_and_no_repeat"
  | "no_configured_relation";

export const DECLINE_LABELS: Record<DeclineReason, string> = {
  no_phone: "No usable phone number",
  no_product: "No product on the lead",
  no_purchase_history: "No purchase history for this customer",
  no_refill_basis: "No refill cycle configured for this product",
  refill_too_stale:
    "Refill was due more than a full cycle ago - a re-activation call, not a refill",
  not_due_and_no_repeat: "Not due, and no earlier purchase of this product",
  no_configured_relation: "No configured related product",
};

export interface Recommendation {
  leadId: string;
  kind: RecommendationKind;
  band: RecommendationBand;
  /** From `BAND_PRIORITY`. Lower sorts first. */
  priority: number;
  /** One agent-facing sentence. Never a formula. */
  reason: string;
  supporting: SupportingBadge[];
  /** The refill wording, reusing `describeRefill`. Null for non-refill bands. */
  refill: RefillLabel | null;
  /** The date the refill is judged against, and where it came from. */
  dueOn: BusinessDate | null;
  dueBasis: "promised_callback" | "refill_cycle" | null;
  /** The purchase the recommendation rests on. */
  lastPurchasedOn: BusinessDate | null;
  /** Earlier, separate purchases of the same product. */
  priorPurchaseCount: number;
  /** Only for `cross_sell`. */
  crossSell: ProductRelation | null;
  stock: { state: StockState; quantity: number | null };
}

export type LeadVerdict =
  | { recommended: true; recommendation: Recommendation }
  | { recommended: false; declined: DeclineReason };

/* ------------------------------------------------------------------------- */
/* The rules                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Is this history row the very purchase that produced this lead?
 *
 * It matters more than it sounds. A retention lead is generated *from* a source
 * record, so without this check every lead would report itself as evidence that
 * the customer is a repeat buyer, and "previously purchased" would be true of
 * everything and therefore mean nothing.
 *
 * Identity is the document number where both carry one — a document is the
 * purchase — and falls back to the date when either does not.
 */
function isOwnSourcePurchase(lead: RecommendableLead, record: PurchaseRecord): boolean {
  if (lead.documentNo && record.documentNo) {
    return lead.documentNo.trim() === record.documentNo.trim();
  }
  return Boolean(lead.sourceDate) && lead.sourceDate === record.sourceDate;
}

function sameProduct(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim() === b.trim();
}

/** The most recent of a set of purchases. */
function latest(records: readonly PurchaseRecord[]): PurchaseRecord | null {
  let best: PurchaseRecord | null = null;
  for (const r of records) {
    if (!r.sourceDate || !isBusinessDate(r.sourceDate)) continue;
    if (!best || compareDates(r.sourceDate, best.sourceDate!) > 0) best = r;
  }
  return best;
}

function stockFor(
  ctx: RecommendationContext,
  itemCode: string | null,
): { state: StockState; quantity: number | null } {
  if (!itemCode) return { state: "unknown", quantity: null };
  return ctx.stockByItem?.get(itemCode.trim()) ?? { state: "unknown", quantity: null };
}

/**
 * The product name an agent would recognise, trimmed for a sentence.
 *
 * Full names run to `MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA`, which is correct
 * on a row and unreadable mid-sentence, so the reason line uses the first few
 * words and the row still shows the whole thing.
 */
function shortName(name: string | null): string {
  const clean = String(name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "this product";
  const words = clean.split(" ");
  return words.length <= 4 ? clean : words.slice(0, 4).join(" ");
}

/**
 * Judge one lead.
 *
 * Order matters and is the priority order: a lead that is due for a refill is a
 * refill opportunity even if the customer has also bought it three times
 * before — the repeat purchase becomes a supporting badge rather than competing
 * for the headline. This is what §5 means by combining signals into one
 * recommendation instead of emitting several.
 */
export function recommendLead(lead: RecommendableLead, ctx: RecommendationContext): LeadVerdict {
  const phone = lead.phone?.trim();
  if (!phone) return { recommended: false, declined: "no_phone" };
  if (!lead.itemCode?.trim() && !lead.itemName?.trim()) {
    return { recommended: false, declined: "no_product" };
  }

  const history = ctx.historyByPhone.get(phone) ?? [];
  if (history.length === 0) {
    return { recommended: false, declined: "no_purchase_history" };
  }

  const itemCode = lead.itemCode?.trim() ?? null;

  /*
   * Purchases of *this* product, split into the one that produced the lead and
   * any earlier, separate ones.
   */
  const sameProductPurchases = history.filter((r) => sameProduct(r.itemCode, itemCode));
  const priorPurchases = sameProductPurchases.filter((r) => !isOwnSourcePurchase(lead, r));
  const anchor = latest(sameProductPurchases);

  const stock = stockFor(ctx, itemCode);
  const invoiceVerified = lead.invoiceMatchStatus === "matched";

  /* --------------------------------------------------------------------- */
  /* A. Refill opportunity                                                 */
  /* --------------------------------------------------------------------- */

  /*
   * Two ways to know when a refill is due, and the promise wins.
   *
   * `next_followup_on` is a date a human committed to — the callback the
   * customer was told to expect. A cycle projection is an estimate. When both
   * exist the promise is the one the desk is accountable for, so it decides,
   * and the projection is not consulted.
   */
  const cycle = itemCode ? ctx.cycleByItem.get(itemCode) : undefined;
  const projected =
    anchor?.sourceDate && cycle?.refillDays != null && cycle.refillDays > 0
      ? addDays(anchor.sourceDate, cycle.refillDays)
      : null;

  const dueOn = lead.nextFollowupOn ?? projected;
  const dueBasis: Recommendation["dueBasis"] = lead.nextFollowupOn
    ? "promised_callback"
    : projected
      ? "refill_cycle"
      : null;

  if (dueOn && isBusinessDate(dueOn)) {
    const refill = describeRefill(dueOn, ctx.today, { soonDays: ctx.soonDays });

    /*
     * How long an overdue refill stays an opportunity.
     *
     * One full cycle, bounded by the product's own configured `refill_days`.
     * The rule and the reasoning behind it live in `lifecycle.ts`, which the
     * queue also calls -- so a lead cannot be stale on one screen and an
     * overdue refill on another.
     *
     * A lead that fails this test is not discarded. It falls through to the
     * repeat-purchase rule below, where a customer who has bought before is
     * still worth a call -- correctly labelled as demonstrated demand rather
     * than as a refill, and correctly ranked beneath the urgent ones. It also
     * stays in the ordinary queue, which is where the desk works its backlog.
     */
    const tooStale = isRefillStale({
      dueOn,
      cycleDays: cycle?.refillDays ?? null,
      today: ctx.today,
      defaultCycleDays: ctx.defaultStaleDays,
    });

    // `future` is not an opportunity either: a refill three weeks out is not
    // this agent's call today, and putting it on the recommended list would
    // bury the ones that are.
    if (
      !tooStale &&
      (refill.severity === "due" || refill.severity === "overdue" || refill.severity === "soon")
    ) {
      const band: RecommendationBand =
        refill.severity === "due"
          ? "refill_due_today"
          : refill.severity === "overdue"
            ? "refill_overdue"
            : "refill_soon";

      const supporting: SupportingBadge[] = [];
      if (stock.state === "in_stock") supporting.push("in_stock");
      if (invoiceVerified) supporting.push("invoice_verified");
      if (priorPurchases.length > 0) supporting.push("repeat_customer");

      return {
        recommended: true,
        recommendation: {
          leadId: lead.id,
          kind: "refill",
          band,
          priority: BAND_PRIORITY[band],
          reason: refillReason(lead, anchor, refill, dueBasis, priorPurchases.length),
          supporting,
          refill,
          dueOn,
          dueBasis,
          lastPurchasedOn: anchor?.sourceDate ?? null,
          priorPurchaseCount: priorPurchases.length,
          crossSell: null,
          stock,
        },
      };
    }
  }

  /* --------------------------------------------------------------------- */
  /* B. Previously purchased                                               */
  /* --------------------------------------------------------------------- */

  if (priorPurchases.length > 0) {
    const last = latest(priorPurchases);
    const supporting: SupportingBadge[] = [];
    if (stock.state === "in_stock") supporting.push("in_stock");
    if (invoiceVerified) supporting.push("invoice_verified");

    const times = priorPurchases.length;
    const when = last?.sourceDate
      ? `, most recently on ${formatBusinessDate(last.sourceDate)}`
      : "";
    return {
      recommended: true,
      recommendation: {
        leadId: lead.id,
        kind: "previously_purchased",
        band: "previously_purchased",
        priority: BAND_PRIORITY.previously_purchased,
        reason:
          `Customer has bought ${shortName(lead.itemName)} ` +
          `${times === 1 ? "once before" : `${times} times before`}${when}.`,
        supporting,
        refill: null,
        dueOn: null,
        dueBasis: null,
        lastPurchasedOn: last?.sourceDate ?? null,
        priorPurchaseCount: times,
        crossSell: null,
        stock,
      },
    };
  }

  /* --------------------------------------------------------------------- */
  /* C. Cross-sell                                                         */
  /* --------------------------------------------------------------------- */

  /*
   * Only from configuration, and only from a product this customer actually
   * bought. With `telesales_product_relations` empty — which it is — this
   * branch returns nothing, which is the correct answer for the data rather
   * than a gap to be filled with a guess.
   */
  const relation = findRelation(history, ctx, itemCode);
  if (relation) {
    const source = history.find((r) => sameProduct(r.itemCode, relation.fromItemCode));
    const supporting: SupportingBadge[] = [];
    const relStock = stockFor(ctx, relation.toItemCode);
    if (relStock.state === "in_stock") supporting.push("in_stock");
    if (invoiceVerified) supporting.push("invoice_verified");

    return {
      recommended: true,
      recommendation: {
        leadId: lead.id,
        kind: "cross_sell",
        band: "cross_sell",
        priority: BAND_PRIORITY.cross_sell,
        reason:
          `Customer previously purchased ${shortName(source?.itemName ?? null)}; ` +
          `${shortName(relation.toItemName)} is configured as a related product` +
          `${relation.note ? ` (${relation.note})` : ""}.`,
        supporting,
        refill: null,
        dueOn: null,
        dueBasis: null,
        lastPurchasedOn: source?.sourceDate ?? null,
        priorPurchaseCount: 0,
        crossSell: relation,
        stock: relStock,
      },
    };
  }

  /* --------------------------------------------------------------------- */
  /* Nothing qualified                                                     */
  /* --------------------------------------------------------------------- */

  if (!dueOn && !cycle?.refillDays) {
    return { recommended: false, declined: "no_refill_basis" };
  }
  // Past due by more than a cycle, with no earlier purchase to fall back on.
  if (
    isRefillStale({
      dueOn,
      cycleDays: cycle?.refillDays ?? null,
      today: ctx.today,
      defaultCycleDays: ctx.defaultStaleDays,
    })
  ) {
    return { recommended: false, declined: "refill_too_stale" };
  }
  return { recommended: false, declined: "not_due_and_no_repeat" };
}

/**
 * A configured relation from something the customer already owns to something
 * they do not.
 *
 * "Do not" is the part that keeps it useful: recommending a companion product
 * to somebody who has already bought it is noise, so anything in the history is
 * excluded from being the target.
 */
function findRelation(
  history: readonly PurchaseRecord[],
  ctx: RecommendationContext,
  leadItemCode: string | null,
): ProductRelation | null {
  const owned = new Set<string>();
  for (const r of history) if (r.itemCode?.trim()) owned.add(r.itemCode.trim());
  if (leadItemCode) owned.add(leadItemCode);

  /*
   * One product may have several configured companions, and a lead carries one
   * recommendation, so one has to be chosen. It is chosen deterministically.
   *
   * Iterating `owned` directly would order the candidates by whatever order the
   * customer's purchase rows came back in, which means the same lead could show
   * a different cross-sell on two page loads. Sorting both the sources and the
   * targets makes the answer a function of the configuration and the customer,
   * and of nothing else.
   */
  const candidates: ProductRelation[] = [];
  for (const code of [...owned].sort()) {
    for (const relation of ctx.relationsByItem.get(code) ?? []) {
      // Never recommend something the customer has already bought: a companion
      // they own is not an opportunity, it is noise.
      if (owned.has(relation.toItemCode.trim())) continue;
      candidates.push(relation);
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      a.fromItemCode.localeCompare(b.fromItemCode) || a.toItemCode.localeCompare(b.toItemCode),
  );
  return candidates[0];
}

/** The refill sentence, in the desk's own terms. */
function refillReason(
  lead: RecommendableLead,
  anchor: PurchaseRecord | null,
  refill: RefillLabel,
  basis: Recommendation["dueBasis"],
  priorCount: number,
): string {
  const product = shortName(lead.itemName);
  const bought = anchor?.sourceDate
    ? `Customer purchased ${product} on ${formatBusinessDate(anchor.sourceDate)}`
    : `Customer purchased ${product}`;

  const timing =
    refill.days === 0
      ? "and is due for refill today"
      : refill.days != null && refill.days < 0
        ? `and the refill is ${Math.abs(refill.days)} day${Math.abs(refill.days) === 1 ? "" : "s"} overdue`
        : `and is due for refill in ${refill.days} day${refill.days === 1 ? "" : "s"}`;

  const how =
    basis === "promised_callback"
      ? " (agreed callback date)"
      : basis === "refill_cycle"
        ? " (refill cycle)"
        : "";

  const repeat =
    priorCount > 0 ? ` Bought it ${priorCount === 1 ? "once" : `${priorCount} times`} before.` : "";

  return `${bought} ${timing}${how}.${repeat}`;
}

/* ------------------------------------------------------------------------- */
/* Ranking                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Sort order for the recommended list.
 *
 *   1. band priority — due today, overdue, soon, previously purchased, cross-sell
 *   2. in-stock first, but only where stock is actually *known*
 *   3. the more overdue of two refills
 *   4. lead id, so the order is total and a re-render cannot reshuffle equals
 *
 * Step 2 is careful about unknown on purpose: an unknown stock answer sorts
 * with out-of-stock rather than below it, because the brief is explicit that a
 * lead must not be buried for want of an answer nobody has.
 */
export function compareRecommendations(a: Recommendation, b: Recommendation): number {
  if (a.priority !== b.priority) return a.priority - b.priority;

  const aStock = a.stock.state === "in_stock" ? 0 : 1;
  const bStock = b.stock.state === "in_stock" ? 0 : 1;
  if (aStock !== bStock) return aStock - bStock;

  const aDays = a.refill?.days ?? null;
  const bDays = b.refill?.days ?? null;
  if (aDays != null && bDays != null && aDays !== bDays) return aDays - bDays;

  return a.leadId.localeCompare(b.leadId);
}

/* ------------------------------------------------------------------------- */
/* Batch                                                                     */
/* ------------------------------------------------------------------------- */

export interface RecommendationSummary {
  recommended: Recommendation[];
  /** Why the rest did not qualify, counted. Shown so "only 31 of 712" is
   *  explainable rather than suspicious. */
  declined: Record<DeclineReason, number>;
  considered: number;
}

/**
 * Judge a whole set of leads in one pass.
 *
 * No I/O, no per-lead lookup beyond the maps handed in. The caller gathers
 * history, cycles and relations with one query each and this walks them, which
 * is the entire performance story: the cost of the page is three bounded
 * queries, not one request per lead.
 */
export function recommendLeads(
  leads: readonly RecommendableLead[],
  ctx: RecommendationContext,
): RecommendationSummary {
  const recommended: Recommendation[] = [];
  const declined: Record<DeclineReason, number> = {
    no_phone: 0,
    no_product: 0,
    no_purchase_history: 0,
    no_refill_basis: 0,
    refill_too_stale: 0,
    not_due_and_no_repeat: 0,
    no_configured_relation: 0,
  };

  for (const lead of leads) {
    const verdict = recommendLead(lead, ctx);
    if (verdict.recommended) recommended.push(verdict.recommendation);
    else declined[verdict.declined] += 1;
  }

  recommended.sort(compareRecommendations);
  return { recommended, declined, considered: leads.length };
}

/** Group history rows by phone, the shape `RecommendationContext` wants. */
export function groupHistoryByPhone(
  rows: readonly PurchaseRecord[],
): Map<string, PurchaseRecord[]> {
  const out = new Map<string, PurchaseRecord[]>();
  for (const row of rows) {
    const key = row.phone?.trim();
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Group configured relations by the product the customer already owns. */
export function groupRelationsByItem(
  rows: readonly ProductRelation[],
): Map<string, ProductRelation[]> {
  const out = new Map<string, ProductRelation[]>();
  for (const row of rows) {
    const key = row.fromItemCode?.trim();
    if (!key) continue;
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** How many days until the refill, for a caller that wants the raw number. */
export function daysUntilRefill(rec: Recommendation, today: BusinessDate): number | null {
  if (!rec.dueOn || !isBusinessDate(rec.dueOn)) return null;
  return daysBetween(today, rec.dueOn);
}
