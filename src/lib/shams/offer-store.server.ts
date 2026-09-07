/**
 * The local Shams offer dataset, in Supabase. Server-only.
 *
 * Every read and write of `public.shams_offers` and
 * `public.shams_offer_products` goes through this module. It is to offers what
 * `catalog-store.server.ts` is to the product catalogue, and it is deliberately
 * shaped the same way — candidate reads, a health signal, staging, an atomic
 * promotion, and one state row — so an operator who understands one understands
 * both.
 *
 * ## What changed for Branch Stock
 *
 * Opening a product used to cost a ~62 KB CRM `available-branches` request on
 * the critical path. It now costs an indexed read of two local tables. The CRM
 * is still the source of the data; it is no longer on the path between an agent
 * and an answer.
 *
 * ## What this module is not
 *
 * It is not the CRM. Nothing here contacts `shams-crm.cloud`; filling these
 * tables is `src/lib/shams-crm/offer-sync.server.ts`, which calls the staging
 * and promotion helpers below.
 *
 * It is not the offer *rules* either. Whether a product may show a single
 * discounted price is `summariseProductOffer` in
 * `src/lib/shams-crm/offer-summary.ts`, pure and unit-tested, and coverage is
 * `classifyOfferScope`. This module stores their verdicts; it does not reach
 * its own.
 *
 * ## Access
 *
 * Both tables have RLS on and no policies, so the service role is the only
 * thing that can read them, and the only route to the service role is a server
 * function behind `requireSupabaseAuth` + `view_shams_mis`.
 */

import type { ShamsCrmOffer, ShamsOfferScopeKind } from "@/lib/shams-crm/types";
import type { ShamsOfferSummary } from "@/lib/shams-crm/offer-summary";

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The local offer dataset could not answer.
 *
 * Its own error for the same reason `ShamsCatalogError` is: this is MilaPortal's
 * database having a bad day, not Shams, and an offer panel that reported a
 * Supabase outage as a CRM outage would send someone to the wrong system.
 *
 * `kind` chooses the copy in `features/shams/constants.ts` and never carries a
 * query, a row or a URL.
 */
export class ShamsOfferStoreError extends Error {
  constructor(
    readonly kind: "offers_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ShamsOfferStoreError";
  }
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/** `numeric` arrives as a string from PostgREST when it will not fit a double. */
function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The most item codes one summary lookup will answer for.
 *
 * A search returns at most `MAX_SEARCH_RESULTS` (100) products and every row
 * wants a badge, so the cap is sized to that with room to spare. It bounds a
 * pathological request rather than expressing a cost: this is one indexed read
 * of a table keyed by `item_code`, not 100 upstream requests — which is the
 * entire difference between this phase and the last one.
 */
export const MAX_OFFER_LOOKUP_ITEMS = 200;

interface SummaryRow {
  item_code: string;
  scope: string;
  branches_available: number | null;
  branches_with_offer: number | null;
  offer_display: string | null;
  unit_price: number | string | null;
  offer_price: number | string | null;
}

function toSummary(row: SummaryRow): ShamsOfferSummary {
  const unitPrice = toNumber(row.unit_price);
  const offerPrice = toNumber(row.offer_price);
  return {
    itemCode: row.item_code,
    // The column is constrained to the three storable kinds; anything else
    // would be a shape that changed under us, and `none` is the reading that
    // cannot mislead — it is what a checked item with no promotion looks like.
    scope: (["all", "some", "none"].includes(row.scope)
      ? row.scope
      : "none") as ShamsOfferScopeKind,
    branchesAvailable: row.branches_available ?? 0,
    branchesWithOffer: row.branches_with_offer ?? 0,
    offerDisplay: row.offer_display,
    // Both or neither, as the table's own CHECK constraint enforces. Restated
    // here so a row written before that constraint existed cannot produce half
    // a price pair in a browser.
    unitPrice: unitPrice !== null && offerPrice !== null ? unitPrice : null,
    offerPrice: unitPrice !== null && offerPrice !== null ? offerPrice : null,
  };
}

/**
 * Offer summaries for a set of item codes.
 *
 * One indexed read, however many codes are asked about. An item **absent** from
 * the returned map has not been swept yet — the caller renders that as
 * `unknown`, never as "no offer".
 *
 * **Throws when the tables cannot be read.** Deliberately not flattened to an
 * empty map: "no offers on these products" and "the dataset is unreachable"
 * lead to opposite decisions, and an agent shown "no offer" during a database
 * incident quotes the full price on a discounted item.
 */
export async function fetchOfferSummaries(
  itemCodes: readonly string[],
): Promise<Map<string, ShamsOfferSummary>> {
  const codes = [...new Set(itemCodes.map((c) => c.trim()).filter(Boolean))].slice(
    0,
    MAX_OFFER_LOOKUP_ITEMS,
  );
  const out = new Map<string, ShamsOfferSummary>();
  if (codes.length === 0) return out;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("shams_offer_products")
    .select(
      "item_code,scope,branches_available,branches_with_offer,offer_display,unit_price,offer_price",
    )
    .in("item_code", codes);

  if (error) {
    console.warn("[shams-offers] summary read failed:", error.code ?? "unknown");
    throw new ShamsOfferStoreError(
      "offers_unavailable",
      "The local Shams offer data could not be read.",
    );
  }

  for (const row of (data ?? []) as SummaryRow[]) out.set(row.item_code, toSummary(row));
  return out;
}

interface OfferRow {
  item_code: string;
  branch_code: string;
  price: number | string | null;
  offer_percent: number | string | null;
  offer_display: string | null;
  after_offer_price: number | string | null;
}

/**
 * Every branch's offer for one item.
 *
 * The Branch Stock table's read. Rows exist only for branches that actually
 * carry a promotion, so an empty array from an item **with** a summary row means
 * "checked, no branch has one" — and an empty array for an item with **no**
 * summary row means nobody has asked. The caller distinguishes them; this
 * returns what the table holds.
 */
export async function fetchBranchOffers(itemCode: string): Promise<ShamsCrmOffer[]> {
  const code = itemCode.trim();
  if (!code) return [];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("shams_offers")
    .select("item_code,branch_code,price,offer_percent,offer_display,after_offer_price")
    .eq("item_code", code);

  if (error) {
    console.warn("[shams-offers] branch read failed:", error.code ?? "unknown");
    throw new ShamsOfferStoreError(
      "offers_unavailable",
      "The local Shams offer data could not be read.",
    );
  }

  const out: ShamsCrmOffer[] = [];
  for (const row of (data ?? []) as OfferRow[]) {
    const price = toNumber(row.price);
    const offerPercent = toNumber(row.offer_percent);
    const afterOfferPrice = toNumber(row.after_offer_price);
    // The same rule `normalizeOffers` applies at the CRM boundary: a row that
    // cannot state a real discount is not an offer, and must never reach a
    // screen that could render it as "0% off".
    if (price === null || afterOfferPrice === null) continue;
    if (offerPercent === null || offerPercent <= 0) continue;
    out.push({
      itemCode: row.item_code,
      branchCode: row.branch_code,
      price,
      offerPercent,
      offerDisplay: row.offer_display?.trim() || `${offerPercent}%`,
      afterOfferPrice,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The offer dataset's size, freshness, sweep progress and last outcome.
 *
 * Everything an operator needs to answer "are agents seeing offers, and how old
 * are they" — and nothing else. No rows, no credentials, no endpoint.
 */
export interface ShamsOfferSyncHealth {
  /** Items whose offers have been checked at least once. */
  productRowCount: number;
  /** Per-branch offer rows currently live. */
  offerRowCount: number;
  /** Of the checked items, how many carry a promotion. */
  itemsWithOffers: number;
  /**
   * True once a sweep has ever promoted anything.
   *
   * The gate for the UI's "not synced" state: before this, an item without a row
   * means the sweep has not reached it, and nothing may be rendered as "no
   * offer".
   */
  synced: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** The last time a sweep reached the end of the catalogue. */
  lastFullSweepAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  nextRefreshDueAt: string | null;
  /** Age of the last successful slice, in ms. Null when there has never been one. */
  ageMs: number | null;
  /** The promotions-sync marker the current rows were fetched against. */
  sourceMarker: string | null;
  /** Where the sweep has reached. Null when it is idle or has never run. */
  cursorItemCode: string | null;
  sweepStartedAt: string | null;
  sweepItemsDone: number;
  /** True while a sweep is part way through the catalogue. */
  sweepInProgress: boolean;
  /** The last promoting slice's metrics. */
  lastItemsProcessed: number;
  lastRowsInserted: number;
  lastRowsUpdated: number;
  lastRowsDeleted: number;
  /** Inserted + updated + deleted + summary verdicts that moved. Never "processed". */
  lastRowsChanged: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
}

export interface OfferSyncStateRow {
  offer_row_count: number | null;
  product_row_count: number | null;
  items_with_offers: number | null;
  source_marker: string | null;
  cursor_item_code: string | null;
  sweep_started_at: string | null;
  sweep_completed_at: string | null;
  sweep_items_done: number | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_full_sweep_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  last_items_processed: number | null;
  last_rows_inserted: number | null;
  last_rows_updated: number | null;
  last_rows_deleted: number | null;
  last_rows_changed: number | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  next_refresh_due_at: string | null;
}

const STATE_COLUMNS =
  "offer_row_count,product_row_count,items_with_offers,source_marker,cursor_item_code," +
  "sweep_started_at,sweep_completed_at,sweep_items_done,last_attempt_at,last_success_at," +
  "last_full_sweep_at,last_outcome,last_error,last_items_processed,last_rows_inserted," +
  "last_rows_updated,last_rows_deleted,last_rows_changed,last_started_at,last_finished_at," +
  "next_refresh_due_at";

/**
 * Read the state row, or `null` when it cannot be read.
 *
 * Shared by the health signal and by the sweep, which both need the same fields
 * and neither of which should fail because a diagnostic could not load.
 */
export async function readOfferSyncState(): Promise<OfferSyncStateRow | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("shams_offer_sync_state")
    .select(STATE_COLUMNS)
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("[shams-offers] sync state unreadable:", error.code ?? "unknown");
    return null;
  }
  return (data as OfferSyncStateRow | null) ?? null;
}

/**
 * The health signal.
 *
 * Never throws. A diagnostic that fails when the thing it diagnoses fails is
 * worse than useless, so an unreadable state row reports an unsynced dataset
 * rather than raising — which is also the honest reading of "the database would
 * not answer", and the reading that makes the UI say "offers unavailable"
 * instead of "no offer".
 */
export async function readOfferSyncHealth(now: number = Date.now()): Promise<ShamsOfferSyncHealth> {
  const state = await readOfferSyncState();
  const lastSuccessAt = state?.last_success_at ?? null;
  const at = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;

  return {
    productRowCount: state?.product_row_count ?? 0,
    offerRowCount: state?.offer_row_count ?? 0,
    itemsWithOffers: state?.items_with_offers ?? 0,
    synced: Boolean(lastSuccessAt) && (state?.product_row_count ?? 0) > 0,
    lastSuccessAt,
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastFullSweepAt: state?.last_full_sweep_at ?? null,
    lastOutcome: state?.last_outcome ?? null,
    lastError: state?.last_error ?? null,
    nextRefreshDueAt: state?.next_refresh_due_at ?? null,
    ageMs: Number.isFinite(at) ? now - at : null,
    sourceMarker: state?.source_marker ?? null,
    cursorItemCode: state?.cursor_item_code ?? null,
    sweepStartedAt: state?.sweep_started_at ?? null,
    sweepItemsDone: state?.sweep_items_done ?? 0,
    sweepInProgress: Boolean(state?.cursor_item_code),
    lastItemsProcessed: state?.last_items_processed ?? 0,
    lastRowsInserted: state?.last_rows_inserted ?? 0,
    lastRowsUpdated: state?.last_rows_updated ?? 0,
    lastRowsDeleted: state?.last_rows_deleted ?? 0,
    lastRowsChanged: state?.last_rows_changed ?? 0,
    lastStartedAt: state?.last_started_at ?? null,
    lastFinishedAt: state?.last_finished_at ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* The sweep cursor                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The next page of catalogue item codes to ask the CRM about.
 *
 * The catalogue drives the sweep and stays server-side: this is a bounded page
 * after a cursor, never the catalogue itself. An empty result means the sweep
 * has reached the end.
 */
export async function nextSweepItemCodes(
  afterItemCode: string | null,
  limit: number,
): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("shams_offer_sweep_slice", {
    // `p_after` defaults to NULL, which is how the first slice asks for the
    // start of the catalogue; omitting it says the same thing.
    p_after: afterItemCode ?? undefined,
    p_limit: limit,
  });
  if (error) {
    console.warn("[shams-offers] sweep slice read failed:", error.code ?? "unknown");
    throw new ShamsOfferStoreError(
      "offers_unavailable",
      "The product catalogue could not be read to choose the next offer sweep slice.",
    );
  }
  return ((data ?? []) as { item_code: string }[]).map((row) => row.item_code);
}

/* -------------------------------------------------------------------------- */
/* Writes — staging and promotion                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rows per staging insert.
 *
 * A slice covers ~150 items; an item with an offer contributes up to ~138 branch
 * rows, so a slice where everything is on promotion is ~20,000 rows. In practice
 * it is a handful. Chunked at the catalogue's 1,000 for the same reason: one
 * JSON body per request, comfortably inside any proxy's limit.
 */
const STAGING_CHUNK = 1000;

export interface OfferPromotion {
  /** Items this slice covered — the denominator for everything else. */
  items: number;
  inserted: number;
  updated: number;
  deleted: number;
  /** Per-item verdicts whose classification moved. */
  summariesChanged: number;
  /** Rows whose values actually moved. Never "items processed". */
  changed: number;
  offerRows: number;
  productRows: number;
  itemsWithOffers: number;
  sweepComplete: boolean;
}

/** One item's result, as the sweep produces it. */
export interface OfferSweepItem {
  summary: ShamsOfferSummary;
  offers: readonly ShamsCrmOffer[];
}

/**
 * Stage one sweep slice, then promote it atomically.
 *
 * The live tables are untouched until the final RPC returns, which is what the
 * staging dance exists for: a CRM that dies part way, a worker killed between
 * chunks, or a slice that comes back empty all leave the previous rows serving
 * Branch Stock. There is no window in which offers are half replaced.
 *
 * **The promotion is scoped to this slice's item codes.** That is the one real
 * difference from the catalogue's, and it is what makes an incremental sweep
 * safe at all: a slice covering 150 of 8,484 products cannot touch the other
 * 8,334, so an abandoned sweep leaves a partially-updated dataset rather than a
 * mostly-deleted one.
 *
 * Throws on any failure, having changed nothing a reader can see.
 */
export async function promoteOfferSlice(
  items: readonly OfferSweepItem[],
  options: {
    cursor: string | null;
    sweepComplete: boolean;
    sourceMarker?: string | null;
    sourceUpdatedAt?: Date;
    startedAt?: Date;
  },
): Promise<OfferPromotion> {
  if (items.length === 0) {
    // The same refusal the RPC makes, raised before ~150 requests' worth of
    // rows are staged for nothing. A slice that covered no items must not
    // advance the cursor past products it never looked at.
    throw new ShamsOfferStoreError(
      "offers_unavailable",
      "The offer sweep produced no items, so nothing was promoted.",
    );
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const batchId = crypto.randomUUID();

  const summaryRows = items.map(({ summary }) => ({
    batch_id: batchId,
    item_code: summary.itemCode,
    // `unknown` is not storable: a staged verdict exists because the CRM
    // answered. The sweep never produces one, and this makes that structural.
    scope: summary.scope === "unknown" ? "none" : summary.scope,
    branches_available: summary.branchesAvailable,
    branches_with_offer: summary.branchesWithOffer,
    offer_display: summary.offerDisplay,
    unit_price: summary.unitPrice,
    offer_price: summary.offerPrice,
  }));

  const offerRows = items.flatMap(({ offers }) =>
    offers.map((offer) => ({
      batch_id: batchId,
      item_code: offer.itemCode,
      branch_code: offer.branchCode,
      price: offer.price,
      offer_percent: offer.offerPercent,
      offer_display: offer.offerDisplay,
      after_offer_price: offer.afterOfferPrice,
    })),
  );

  try {
    for (let i = 0; i < summaryRows.length; i += STAGING_CHUNK) {
      const { error } = await supabaseAdmin
        .from("shams_offer_products_staging")
        .insert(summaryRows.slice(i, i + STAGING_CHUNK));
      if (error) {
        console.warn("[shams-offers] summary staging failed:", error.code ?? "unknown");
        throw new ShamsOfferStoreError(
          "offers_unavailable",
          "The refreshed Shams offers could not be staged.",
        );
      }
    }

    for (let i = 0; i < offerRows.length; i += STAGING_CHUNK) {
      const { error } = await supabaseAdmin
        .from("shams_offers_staging")
        .insert(offerRows.slice(i, i + STAGING_CHUNK));
      if (error) {
        console.warn("[shams-offers] offer staging failed:", error.code ?? "unknown");
        throw new ShamsOfferStoreError(
          "offers_unavailable",
          "The refreshed Shams offers could not be staged.",
        );
      }
    }

    const { data, error } = await supabaseAdmin.rpc("shams_promote_offers", {
      p_batch_id: batchId,
      p_source_updated_at: (options.sourceUpdatedAt ?? new Date()).toISOString(),
      p_source_marker: options.sourceMarker ?? undefined,
      p_cursor: options.cursor ?? undefined,
      p_sweep_complete: options.sweepComplete,
      p_started_at: (options.startedAt ?? new Date()).toISOString(),
    });
    if (error) {
      console.warn("[shams-offers] promotion failed:", error.code ?? "unknown");
      throw new ShamsOfferStoreError(
        "offers_unavailable",
        "The refreshed Shams offers could not be promoted.",
      );
    }

    const promotion = (data ?? {}) as Partial<OfferPromotion>;
    return {
      items: promotion.items ?? summaryRows.length,
      inserted: promotion.inserted ?? 0,
      updated: promotion.updated ?? 0,
      deleted: promotion.deleted ?? 0,
      summariesChanged: promotion.summariesChanged ?? 0,
      changed: promotion.changed ?? 0,
      offerRows: promotion.offerRows ?? 0,
      productRows: promotion.productRows ?? 0,
      itemsWithOffers: promotion.itemsWithOffers ?? 0,
      sweepComplete: promotion.sweepComplete ?? options.sweepComplete,
    };
  } finally {
    /*
     * Clear this attempt's scratch rows whatever happened. A successful
     * promotion has already deleted them, so this is for the failure paths.
     * Best effort: a failure to tidy up must not mask the failure that caused
     * it, nor undo a promotion that worked.
     */
    await supabaseAdmin
      .from("shams_offer_products_staging")
      .delete()
      .eq("batch_id", batchId)
      .then(undefined, () => undefined);
    await supabaseAdmin
      .from("shams_offers_staging")
      .delete()
      .eq("batch_id", batchId)
      .then(undefined, () => undefined);
  }
}

/**
 * Record an attempt that did not promote anything.
 *
 * `success` is written by `shams_promote_offers` inside the swap, so it cannot
 * be claimed by a caller that did not actually change the rows. This writes the
 * other three outcomes, and always moves `next_refresh_due_at` forward — a
 * failure that left the sweep due would have the scheduler retrying it every
 * minute against whatever is failing.
 */
export async function recordOfferAttempt(patch: {
  outcome: "unchanged" | "not_configured" | "failed";
  error?: string | null;
  attemptedAt: Date;
  nextRefreshDueAt: Date;
  /** Set when a failure should abandon the current sweep rather than resume it. */
  resetCursor?: boolean;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("shams_offer_sync_state")
    .update({
      last_attempt_at: patch.attemptedAt.toISOString(),
      last_outcome: patch.outcome,
      last_error: patch.error ?? null,
      next_refresh_due_at: patch.nextRefreshDueAt.toISOString(),
      updated_at: new Date().toISOString(),
      ...(patch.resetCursor ? { cursor_item_code: null, sweep_items_done: 0 } : {}),
    })
    .eq("id", 1);
  if (error) console.warn("[shams-offers] sync state write failed:", error.code ?? "unknown");
}

/**
 * Mark the attempt as started, and schedule the next look.
 *
 * Written *before* the CRM is contacted so a worker that dies mid-slice still
 * leaves evidence that it tried, and — more importantly — leaves the sweep not
 * due, so the next tick does not immediately try again into whatever killed it.
 * The outcome overwrites this a moment later.
 */
export async function beginOfferAttempt(
  attemptedAt: Date,
  nextDueAt: Date,
  options: { startingSweep?: boolean } = {},
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("shams_offer_sync_state")
    .update({
      last_attempt_at: attemptedAt.toISOString(),
      next_refresh_due_at: nextDueAt.toISOString(),
      updated_at: new Date().toISOString(),
      ...(options.startingSweep
        ? {
            sweep_started_at: attemptedAt.toISOString(),
            sweep_items_done: 0,
            cursor_item_code: null,
          }
        : {}),
    })
    .eq("id", 1);
  if (error) console.warn("[shams-offers] sync state write failed:", error.code ?? "unknown");
}
