/**
 * Keeping the local Shams offer dataset current. Server-only.
 *
 * The background half of moving offers off Branch Stock's critical path.
 * `src/lib/shams/offer-store.server.ts` owns the tables; this owns the decision
 * to refill them.
 *
 * ## Why this is a sweep and the catalogue refresh is not
 *
 * The catalogue is one request. `GET /products/names` answers with all ~8,484
 * products, so `refreshProductCatalog` downloads the world and swaps it in.
 *
 * Offers have no such endpoint, and this is established rather than assumed:
 * `docs/shams/api-discovery.md` §11.1 records that there is no `/offers`, no
 * promotions list and no feed; §11.2 that an offer is a per-branch field on
 * `GET /products/{item_code}/available-branches`, ~62 KB for one item; §11.5
 * that there is no bulk form, no pagination and no way to ask about many items
 * at once. §11.6 concludes that a cached offers index is "not possible against
 * the API as it stands".
 *
 * It is possible — but only as one request per product, which for the whole
 * catalogue is ~8,484 requests and on the order of half a gigabyte. That cost is
 * the entire shape of this file:
 *
 *   * work is **sliced** — `SWEEP_SLICE_ITEMS` products per run, at
 *     `SWEEP_CONCURRENCY` in flight, so no single run is long or heavy;
 *   * progress is **durable** — the cursor lives in the state row, so a worker
 *     killed mid-sweep resumes rather than restarting;
 *   * a full pass runs **only when it is worth running** — when the CRM's own
 *     promotions sync reports a new success marker, when the dataset has never
 *     been swept, or when it is older than `MAX_SWEEP_AGE_MS`. Never on a short
 *     timer, and never as a background trickle for its own sake.
 *
 * `POST /promotions/sync` is **never** called. It starts a ~24-minute job on
 * Shams' own infrastructure (§11.3); nothing in this codebase may fire it, and
 * nothing here does. Only the status document is read.
 *
 * ## Nothing here can break Branch Stock
 *
 * Structurally, as with the catalogue. Every path out of `sweepOffers` either
 * promotes a complete, validated slice or leaves the tables byte for byte as
 * they were:
 *
 *   * no CRM credentials       -> recorded, nothing touched
 *   * status read failed       -> recorded, nothing touched
 *   * nothing due              -> recorded, nothing touched
 *   * the catalogue is empty   -> recorded, nothing touched
 *   * every item in the slice failed -> recorded, nothing touched
 *   * staging failed mid-way   -> recorded, nothing touched (the swap never ran)
 *
 * And a promotion that does land is **scoped to the slice's own item codes**, so
 * even a sweep abandoned half way leaves every product it did not reach exactly
 * as it was. There is no ordering of events in which Branch Stock reads an empty
 * or half-written offer dataset.
 *
 * This function never throws for an operational failure. It is called from the
 * scheduler tick, where an exception would take the reconciliation pass down
 * with it, and from an administrator's button, where a stack trace is not an
 * answer.
 */

import { isCrmConfigured } from "./client.server";
import { stockSyncMarker } from "./sync-status";
import { summariseProductOffer, type ShamsOfferSummary } from "./offer-summary";
import type { ShamsCrmOffer } from "./types";

interface SupabaseLike {
  from: (table: string) => any;
}

/* -------------------------------------------------------------------------- */
/* Cadence and size                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Products asked about in one run.
 *
 * The single most important number in this file, because it is multiplied by
 * ~62 KB. 150 items is roughly 9 MB and, at the concurrency below, well under a
 * minute — small enough that a scheduler tick is never held open and that a
 * worker dying costs one slice's work.
 *
 * Larger would finish a sweep sooner and make each run a liability; smaller
 * would stretch a full pass past the point where the dataset is meaningfully
 * current. 8,484 / 150 is 57 runs.
 */
export const SWEEP_SLICE_ITEMS = 150;

/**
 * How many of those run at once.
 *
 * Four, matching `SCOPE_CONCURRENCY` in `offers.server.ts` — the figure already
 * chosen for this endpoint, for the same reason: each response is ~62 KB and
 * rate limits on this API are recorded as NOT VERIFIED (§11.5). A sweep is
 * background work against somebody else's production system and is deliberately
 * not the fastest thing it could be.
 */
const SWEEP_CONCURRENCY = 4;

/**
 * How soon the next slice runs while a sweep is in progress.
 *
 * Two minutes puts a full 57-slice pass at roughly two hours — fast enough that
 * a promotions change reaches agents the same shift, slow enough that the CRM
 * sees a steady trickle rather than a flood. The scheduler tick fires every
 * minute and pokes only when this has elapsed.
 */
const SWEEP_INTERVAL_MS = 2 * 60_000;

/**
 * How often the marker is checked while the dataset is idle.
 *
 * One small status read an hour, exactly as the catalogue does against
 * `/stock/sync/status`. It bounds how long offers can lag a completed upstream
 * promotions run, and it is not how often 500 MB moves: that happens only when
 * the marker says something changed.
 */
const IDLE_INTERVAL_MS = 60 * 60_000;

/**
 * How long after a failure before trying again.
 *
 * Fifteen minutes, matching the catalogue. Shorter than the idle interval
 * because a failed slice leaves the sweep stalled, and far longer than the
 * tick, because a CRM that is down should not be asked 1,440 times a day.
 */
const RETRY_INTERVAL_MS = 15 * 60_000;

/**
 * The age at which a full sweep is run whatever the marker says.
 *
 * The marker is the trigger and this is the safety net beneath it — the same
 * pairing the catalogue uses, and for the same two cases: a CRM whose
 * promotions sync genuinely has not run (the captured deployment reports
 * `sync_interval_minutes: 0`, i.e. Manual), and a marker that stops moving for a
 * reason nobody here can see.
 *
 * Seven days, not the catalogue's one. A full offer pass is ~8,484 requests
 * against a third party; forcing one daily on the off chance would be an
 * unreasonable standing cost, and an offer that has not changed in a week has
 * not changed. An administrator who believes otherwise presses Sweep now.
 */
const MAX_SWEEP_AGE_MS = 7 * 24 * 60 * 60_000;

/** The status read's own timeout. A hung CRM must not hold a tick open. */
const STATUS_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export type OfferSweepOutcome =
  /** A slice was promoted. `sweepComplete` says whether it was the last one. */
  | "swept"
  /** Nothing was due: the marker had not moved and the data is not old. */
  | "unchanged"
  /** No CRM credentials on this deployment. Not a fault. */
  | "not_configured"
  /** Something went wrong. The previous offer data is intact. */
  | "failed";

export interface OfferSweepResult {
  outcome: OfferSweepOutcome;
  /** Items this run asked the CRM about. */
  itemsProcessed: number;
  /** Items the CRM would not answer for. They keep their previous rows. */
  itemsFailed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  /** Rows whose values actually moved — never `itemsProcessed`. */
  rowsChanged: number;
  /** Per-branch offer rows live after this run. */
  offerRows: number;
  /** Items whose offers have been checked at least once. */
  productRows: number;
  itemsWithOffers: number;
  /** True when this run reached the end of the catalogue. */
  sweepComplete: boolean;
  /** One sentence, safe to show an administrator. Null when nothing went wrong. */
  error: string | null;
}

function emptyResult(outcome: OfferSweepOutcome, error: string | null = null): OfferSweepResult {
  return {
    outcome,
    itemsProcessed: 0,
    itemsFailed: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
    rowsChanged: 0,
    offerRows: 0,
    productRows: 0,
    itemsWithOffers: 0,
    sweepComplete: false,
    error,
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce any thrown value to one short sentence.
 *
 * `last_error` is read by an administrator and stored indefinitely, so an
 * upstream body, a URL or a header must never reach it. The same rule, and the
 * same words, as `summarize` in `catalog-sync.server.ts`.
 */
async function summarize(err: unknown): Promise<string> {
  const { ShamsCrmError } = await import("./client.server");
  const { ShamsOfferStoreError } = await import("@/lib/shams/offer-store.server");

  if (err instanceof ShamsOfferStoreError) return err.message;
  if (err instanceof ShamsCrmError) {
    return err.httpStatus
      ? `${err.message} (${err.kind}, HTTP ${err.httpStatus})`
      : `${err.message} (${err.kind})`;
  }
  console.warn("[shams-offers] unexpected failure:", (err as Error)?.name ?? "unknown");
  return "An unexpected error occurred while sweeping Shams offers.";
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

export interface SweepOffersOptions {
  /**
   * Start a fresh sweep from the beginning, regardless of the marker.
   *
   * The administrator's "Sweep now". Never set by the scheduler: a forced full
   * pass on a timer would be ~8,484 requests on a clock, which is the cost this
   * design exists to avoid.
   */
  force?: boolean;
  now?: Date;
}

interface SweptItem {
  summary: ShamsOfferSummary;
  offers: readonly ShamsCrmOffer[];
}

/**
 * Ask the CRM about a slice of items, at bounded concurrency.
 *
 * An item that fails is **omitted**, not recorded as having no offer — exactly
 * the rule `getOfferScopes` follows, and for the same reason: the CRM being
 * unreachable for one product is not evidence about its promotion. The omitted
 * item keeps whatever rows it already had and will be revisited on the next
 * full sweep.
 */
async function readSlice(itemCodes: readonly string[]): Promise<{
  items: SweptItem[];
  failed: number;
}> {
  const { fetchOfferReadNow } = await import("./offers.server");

  const items: SweptItem[] = [];
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= itemCodes.length) return;
      const code = itemCodes[index];
      try {
        const { offers, scope } = await fetchOfferReadNow(code);
        // `summariseProductOffer` decides whether a single product-level price
        // is defensible. The sweep does not: storing a global discount for a
        // branch-specific offer is the one mistake this dataset could make that
        // would show an agent a price nobody charges.
        items.push({ summary: summariseProductOffer(scope, offers), offers });
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SWEEP_CONCURRENCY, itemCodes.length) }, () => worker()),
  );
  return { items, failed };
}

/**
 * Advance the local offer dataset by one slice, or decide it is already current.
 *
 * Returns a verdict; never throws for an operational failure. The state row is
 * written on every path, so an operator can always tell "checked, nothing to do"
 * from "has not been checked since Tuesday".
 */
export async function sweepOffers(options: SweepOffersOptions = {}): Promise<OfferSweepResult> {
  const now = options.now ?? new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);

  const store = await import("@/lib/shams/offer-store.server");

  if (!isCrmConfigured()) {
    /*
     * A deployment state, not a sync outcome. Recorded rather than logged as an
     * error every hour — and the tables are left exactly as they are, which on
     * a deployment that has synced before means agents keep seeing the offers
     * they saw yesterday.
     */
    await store.recordOfferAttempt({
      outcome: "not_configured",
      error: "Shams CRM is not configured on this deployment, so offers are not being swept.",
      attemptedAt: now,
      nextRefreshDueAt: at(IDLE_INTERVAL_MS),
    });
    return emptyResult("not_configured");
  }

  const state = await store.readOfferSyncState();
  const cursor = state?.cursor_item_code ?? null;
  const inProgress = cursor !== null;
  const lastFull = state?.last_full_sweep_at ? Date.parse(state.last_full_sweep_at) : NaN;
  const ageMs = Number.isFinite(lastFull) ? now.getTime() - lastFull : null;
  const productRows = state?.product_row_count ?? 0;

  /*
   * Claim the attempt before the network is touched.
   *
   * A worker killed mid-slice otherwise leaves the sweep still due, and the next
   * tick — a minute later — walks into whatever killed it. The outcome
   * overwrites this a moment later.
   */
  const startingSweep = options.force === true || (!inProgress && productRows === 0);
  await store.beginOfferAttempt(now, at(SWEEP_INTERVAL_MS), { startingSweep });

  /*
   * A sweep already in progress continues without asking anything.
   *
   * The marker is what decides whether to *start* a pass; re-reading it between
   * slices would let a marker that moved mid-sweep restart one that is 80 %
   * done, and would spend a status request every two minutes for an answer that
   * cannot change the plan.
   */
  let marker: string | null = state?.source_marker ?? null;

  if (!inProgress) {
    let readMarker: string | null = null;
    try {
      const { crmFetch } = await import("./client.server");
      const { normalizeSyncStatus } = await import("./sync-status");
      const raw = await crmFetch<Parameters<typeof normalizeSyncStatus>[0]>(
        "/promotions/sync/status",
        { timeoutMs: STATUS_TIMEOUT_MS },
      );
      // The same envelope both sync endpoints answer with, and the same
      // reduction the catalogue applies to the stock one. `stockSyncMarker` is
      // named for its first caller, not for its input.
      readMarker = stockSyncMarker(normalizeSyncStatus(raw, now.getTime()));
    } catch (err) {
      /*
       * The marker is unreadable. Deliberately **not** a reason to sweep
       * anyway: if the CRM cannot answer a small status document it is unlikely
       * to serve 8,484 per-item responses, and an unconditional fallback would
       * turn every CRM wobble into a full pass. The age check below is the only
       * thing that forces one without a marker, and it is a week wide.
       */
      if (productRows > 0 && (ageMs === null || ageMs < MAX_SWEEP_AGE_MS)) {
        const error = await summarize(err);
        await store.recordOfferAttempt({
          outcome: "failed",
          error,
          attemptedAt: now,
          nextRefreshDueAt: at(RETRY_INTERVAL_MS),
        });
        console.warn("[shams-offers] status read failed; offers left as they are");
        return emptyResult("failed", error);
      }
      // Nothing to protect, or too old to keep. Fall through and sweep.
    }

    const stale = ageMs === null || ageMs >= MAX_SWEEP_AGE_MS;
    const markerMoved = readMarker !== null && readMarker !== (state?.source_marker ?? null);
    const needed = options.force === true || productRows === 0 || stale || markerMoved;

    if (!needed) {
      await store.recordOfferAttempt({
        outcome: "unchanged",
        error: null,
        attemptedAt: now,
        nextRefreshDueAt: at(IDLE_INTERVAL_MS),
      });
      const result = emptyResult("unchanged");
      result.productRows = productRows;
      result.offerRows = state?.offer_row_count ?? 0;
      result.itemsWithOffers = state?.items_with_offers ?? 0;
      return result;
    }

    if (readMarker !== null) marker = readMarker;
  }

  try {
    // `force` restarts from the top; anything else resumes where the cursor is.
    const after = options.force === true ? null : cursor;
    const codes = await store.nextSweepItemCodes(after, SWEEP_SLICE_ITEMS);

    if (codes.length === 0) {
      /*
       * The end of the catalogue — or a catalogue with nothing in it.
       *
       * Both mean "there is no next slice", and both are recorded rather than
       * promoted: promoting an empty slice would advance the cursor past
       * products nobody looked at. A resumed sweep that runs out of items has
       * finished, so the cursor is cleared and the dataset goes idle.
       */
      await store.recordOfferAttempt({
        outcome: "unchanged",
        error:
          productRows === 0 && !inProgress
            ? "The product catalogue is empty, so there are no items to sweep offers for."
            : null,
        attemptedAt: now,
        nextRefreshDueAt: at(IDLE_INTERVAL_MS),
        resetCursor: true,
      });
      const result = emptyResult("unchanged");
      result.sweepComplete = inProgress;
      result.productRows = productRows;
      result.offerRows = state?.offer_row_count ?? 0;
      result.itemsWithOffers = state?.items_with_offers ?? 0;
      return result;
    }

    const { items, failed } = await readSlice(codes);

    if (items.length === 0) {
      /*
       * Every item in the slice failed.
       *
       * Not promoted, and — critically — the cursor is **not** advanced, so the
       * next run asks about these same products rather than skipping them. A
       * slice that answered for nobody is a CRM problem, not a dataset of 150
       * products with no offers.
       */
      const error = `Shams CRM answered for none of the ${codes.length} products in this slice.`;
      await store.recordOfferAttempt({
        outcome: "failed",
        error,
        attemptedAt: now,
        nextRefreshDueAt: at(RETRY_INTERVAL_MS),
      });
      console.warn("[shams-offers] slice failed entirely; offers left as they are");
      const result = emptyResult("failed", error);
      result.itemsFailed = failed;
      return result;
    }

    /*
     * The cursor is the last code the slice **asked about**, not the last one
     * that answered. Items the CRM refused keep their existing rows and are
     * revisited on the next full pass; parking the cursor on a failure instead
     * would stall the sweep on one bad product indefinitely.
     */
    const lastCode = codes[codes.length - 1];
    const sweepComplete = codes.length < SWEEP_SLICE_ITEMS;

    const promotion = await store.promoteOfferSlice(items, {
      cursor: lastCode,
      sweepComplete,
      sourceMarker: marker,
      sourceUpdatedAt: now,
      startedAt: now,
    });

    console.info(
      `[shams-offers] slice promoted: ${promotion.items} items, ${promotion.changed} rows changed` +
        `${sweepComplete ? " (sweep complete)" : ""}`,
    );

    return {
      outcome: "swept",
      itemsProcessed: promotion.items,
      itemsFailed: failed,
      rowsInserted: promotion.inserted,
      rowsUpdated: promotion.updated,
      rowsDeleted: promotion.deleted,
      rowsChanged: promotion.changed,
      offerRows: promotion.offerRows,
      productRows: promotion.productRows,
      itemsWithOffers: promotion.itemsWithOffers,
      sweepComplete: promotion.sweepComplete,
      error: null,
    };
  } catch (err) {
    const error = await summarize(err);
    await store.recordOfferAttempt({
      outcome: "failed",
      error,
      attemptedAt: now,
      nextRefreshDueAt: at(RETRY_INTERVAL_MS),
    });
    console.warn("[shams-offers] sweep failed; the previous offer data is still serving");
    const result = emptyResult("failed", error);
    result.productRows = productRows;
    result.offerRows = state?.offer_row_count ?? 0;
    return result;
  }
}

/**
 * Is the offer dataset due a look?
 *
 * The same predicate `shams_sync_tick()` evaluates in SQL, available to callers
 * that already hold a Supabase client. Errs towards "yes": a state row that
 * cannot be read is a reason to run the sweep, which is bounded and harmless,
 * rather than to skip it, which would be silent.
 */
export async function isOfferSweepDue(
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from("shams_offer_sync_state")
    .select("next_refresh_due_at")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return true;

  const due = (data as { next_refresh_due_at: string | null }).next_refresh_due_at;
  if (!due) return true;
  const at = Date.parse(due);
  return !Number.isFinite(at) || at <= now.getTime();
}
