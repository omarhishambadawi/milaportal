/**
 * Keeping the local Shams product catalogue current. Server-only.
 *
 * The background half of the search change. `src/lib/shams/catalog-store.server.ts`
 * owns the table; this owns the decision to refill it, and the rule it follows
 * is the one PharmacyCRM Desktop uses (`docs/shams/api-discovery.md` §10.6):
 *
 *   1. Read `GET /stock/sync/status` — a small document.
 *   2. Reduce it to one success marker (`stockSyncMarker`).
 *   3. Re-fetch `GET /products/names` only when that marker has moved.
 *
 * A clock is the fallback, not the trigger. The catalogue changes when Shams'
 * own stock sync changes it; a TTL either re-downloads 700 KB for nothing or
 * serves rows that moved hours ago, and the marker does neither.
 *
 * ## Nothing here can break search
 *
 * That is the design constraint, and it is met structurally rather than
 * carefully. Every path out of `refreshProductCatalog` either replaces the
 * catalogue with a full, validated one or leaves it byte for byte as it was:
 *
 *   * no CRM credentials      -> recorded, nothing touched
 *   * status read failed      -> recorded, nothing touched
 *   * marker unchanged        -> recorded, nothing touched
 *   * download failed         -> recorded, nothing touched
 *   * download came up short  -> recorded, nothing touched (see `MIN_CATALOG_ROWS`)
 *   * staging failed mid-way  -> recorded, nothing touched (the swap never ran)
 *
 * There is no ordering of events in which an agent's search finds an empty or
 * half-written catalogue, because the live rows are only ever changed by one
 * statement inside `shams_promote_product_catalog`.
 *
 * This function never throws for an operational failure. It is called from the
 * scheduler tick, where an exception would take the reconciliation pass down
 * with it, and from an administrator's button, where a stack trace is not an
 * answer.
 */

import { isCrmConfigured } from "./client.server";
import { stockSyncMarker } from "./sync-status";

interface SupabaseLike {
  from: (table: string) => any;
}

/* -------------------------------------------------------------------------- */
/* Cadence                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How often the marker is checked.
 *
 * One small status read an hour — 24 requests a day, against an endpoint the
 * reconciliation path already polls every five minutes while a run is open. It
 * bounds how long the catalogue can lag a completed upstream sync, and it is not
 * how often 700 KB moves: that happens only when the marker says something
 * changed.
 */
const CHECK_INTERVAL_MS = 60 * 60_000;

/**
 * How long after a failure before trying again.
 *
 * Shorter than the ordinary interval, because a failed check leaves the
 * catalogue ageing, and longer than a minute, because the scheduler tick runs
 * every one of them and a CRM that is down should not be asked 1,440 times a
 * day. Fifteen minutes recovers from a transient outage within the hour and
 * never turns into a retry loop.
 */
const RETRY_INTERVAL_MS = 15 * 60_000;

/**
 * The age at which the catalogue is re-fetched whatever the marker says.
 *
 * The marker is the trigger and this is the safety net beneath it. Two things it
 * catches: a CRM whose stock sync has genuinely not run for days (the captured
 * deployment reports `sync_interval_minutes: 0`, i.e. "Manual"), and a marker
 * that stops moving for a reason nobody here can see. Twenty-four hours against
 * ~0.3 % daily drift is a bounded, stated amount of staleness rather than an
 * open-ended one.
 */
const MAX_CATALOG_AGE_MS = 24 * 60 * 60_000;

/**
 * The status read's own timeout.
 *
 * This runs inside a scheduler tick. A hung CRM must not hold that tick open, so
 * it is bounded well under the client's default, exactly as the sync status read
 * is in `sync.server.ts`.
 */
const STATUS_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export type CatalogRefreshOutcome =
  /** New rows are live. */
  | "refreshed"
  /** The marker had not moved and the catalogue was not old enough to force it. */
  | "unchanged"
  /** No CRM credentials on this deployment. Not a fault. */
  | "not_configured"
  /** Something went wrong. The previous catalogue is intact. */
  | "failed";

export interface CatalogRefreshResult {
  outcome: CatalogRefreshOutcome;
  /** Products live in the catalogue after this attempt. Never zero on success. */
  rowCount: number;
  /** Rows whose name or price actually moved. Zero on an unchanged refresh. */
  changed: number;
  /** Products the CRM no longer lists. */
  removed: number;
  /** One sentence, safe to show an administrator. Null when nothing went wrong. */
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce any thrown value to one short sentence.
 *
 * `last_error` is read by an administrator and stored indefinitely, so an
 * upstream body, a URL or a header must never reach it. The two error types this
 * path can raise are already shaped for that — they carry a `kind` and never a
 * credential — and anything unrecognised collapses to a generic line rather than
 * being stringified. The same rule, and the same words, as `summarizeError` in
 * `sync-scheduler.server.ts`.
 */
async function summarize(err: unknown): Promise<string> {
  const { ShamsCrmError } = await import("./client.server");
  const { ShamsCatalogError } = await import("@/lib/shams/catalog-store.server");

  if (err instanceof ShamsCatalogError) return err.message;
  if (err instanceof ShamsCrmError) {
    return err.httpStatus
      ? `${err.message} (${err.kind}, HTTP ${err.httpStatus})`
      : `${err.message} (${err.kind})`;
  }
  console.warn("[shams-catalog] unexpected failure:", (err as Error)?.name ?? "unknown");
  return "An unexpected error occurred while refreshing the product catalogue.";
}

/* -------------------------------------------------------------------------- */
/* The refresh                                                                 */
/* -------------------------------------------------------------------------- */

export interface RefreshCatalogOptions {
  /**
   * Download and replace regardless of the marker or the catalogue's age.
   *
   * The administrator's "Refresh now". Never set by the scheduler: a forced
   * refresh on a timer would be the TTL this design exists to avoid.
   */
  force?: boolean;
  now?: Date;
}

/**
 * Bring the local catalogue up to date, or decide it already is.
 *
 * Returns a verdict; never throws for an operational failure. The state row is
 * written on every path, so an operator can always tell the difference between
 * "checked, nothing to do" and "has not been checked since Tuesday" — a
 * distinction the previous in-memory cache could not express at all.
 */
export async function refreshProductCatalog(
  options: RefreshCatalogOptions = {},
): Promise<CatalogRefreshResult> {
  const now = options.now ?? new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);

  const store = await import("@/lib/shams/catalog-store.server");

  if (!isCrmConfigured()) {
    /*
     * A deployment state, not a sync outcome. Recorded rather than logged as an
     * error every hour — and, importantly, the catalogue is left exactly as it
     * is, which on a fresh database is the shipped seed. Search works here.
     */
    await store.recordCatalogAttempt({
      outcome: "not_configured",
      error:
        "Shams CRM is not configured on this deployment, so the product catalogue is not being refreshed.",
      attemptedAt: now,
      nextRefreshDueAt: at(CHECK_INTERVAL_MS),
    });
    const health = await store.readCatalogHealth(now.getTime());
    return {
      outcome: "not_configured",
      rowCount: health.rowCount,
      changed: 0,
      removed: 0,
      error: null,
    };
  }

  const state = await store.readCatalogState();
  const rowCount = state?.row_count ?? 0;
  const lastSuccess = state?.last_success_at ? Date.parse(state.last_success_at) : NaN;
  const ageMs = Number.isFinite(lastSuccess) ? now.getTime() - lastSuccess : null;

  /*
   * Claim the attempt before the network is touched.
   *
   * A worker killed mid-refresh otherwise leaves the catalogue still due, and
   * the next tick — a minute later — walks into whatever killed it. Writing the
   * next due time first turns that into one attempt an hour. The outcome
   * overwrites this a moment later.
   */
  await store.beginCatalogAttempt(now, at(CHECK_INTERVAL_MS));

  let marker: string | null = null;
  try {
    const { crmFetch } = await import("./client.server");
    const { normalizeSyncStatus } = await import("./sync-status");
    const raw = await crmFetch<Parameters<typeof normalizeSyncStatus>[0]>("/stock/sync/status", {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    marker = stockSyncMarker(normalizeSyncStatus(raw, now.getTime()));
  } catch (err) {
    /*
     * The marker is unreadable. Deliberately **not** a reason to download the
     * catalogue anyway: if the CRM cannot answer a small status document it is
     * unlikely to serve 700 KB, and an unconditional fallback would turn every
     * CRM wobble into a full download. The age check below is the only thing
     * that forces a fetch without a marker, and it is a day wide.
     */
    if (rowCount > 0 && (ageMs === null || ageMs < MAX_CATALOG_AGE_MS)) {
      const error = await summarize(err);
      await store.recordCatalogAttempt({
        outcome: "failed",
        error,
        attemptedAt: now,
        nextRefreshDueAt: at(RETRY_INTERVAL_MS),
      });
      console.warn("[shams-catalog] status read failed; catalogue left as it is");
      return { outcome: "failed", rowCount, changed: 0, removed: 0, error };
    }
    // Nothing to protect, or too old to keep. Fall through and try the download.
  }

  const stale = ageMs === null || ageMs >= MAX_CATALOG_AGE_MS;
  const markerMoved = marker !== null && marker !== (state?.source_marker ?? null);
  const needed = options.force === true || rowCount === 0 || stale || markerMoved;

  if (!needed) {
    await store.recordCatalogAttempt({
      outcome: "unchanged",
      error: null,
      attemptedAt: now,
      nextRefreshDueAt: at(CHECK_INTERVAL_MS),
    });
    return { outcome: "unchanged", rowCount, changed: 0, removed: 0, error: null };
  }

  try {
    const { fetchCatalogNow } = await import("./catalog.server");
    /*
     * The one 700 KB request, and the only one on any path in this file. It goes
     * through the no-fallback fetch on purpose: `getCatalog`'s stale-fallback
     * would hand back the rows we already have and this code would then record a
     * successful refresh, stamped with the new marker, having refreshed nothing.
     */
    const products = await fetchCatalogNow();

    const promotion = await store.replaceCatalog(products, {
      sourceMarker: marker,
      sourceUpdatedAt: now,
    });

    console.info(
      `[shams-catalog] refreshed: ${promotion.total} products, ${promotion.changed} changed, ${promotion.removed} removed`,
    );
    return {
      outcome: "refreshed",
      rowCount: promotion.total,
      changed: promotion.changed,
      removed: promotion.removed,
      error: null,
    };
  } catch (err) {
    const error = await summarize(err);
    await store.recordCatalogAttempt({
      outcome: "failed",
      error,
      attemptedAt: now,
      nextRefreshDueAt: at(RETRY_INTERVAL_MS),
    });
    console.warn("[shams-catalog] refresh failed; the previous catalogue is still serving");
    return { outcome: "failed", rowCount, changed: 0, removed: 0, error };
  }
}

/**
 * Is the catalogue due a look?
 *
 * The same predicate `shams_sync_tick()` evaluates in SQL, available to callers
 * that already hold a Supabase client and would rather not make a round trip
 * they can decide without. Errs towards "yes": a state row that cannot be read
 * is a reason to run the refresh, which is harmless, rather than to skip it,
 * which would be silent.
 */
export async function isCatalogRefreshDue(
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await supabase
    .from("shams_catalog_state")
    .select("next_refresh_due_at")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return true;

  const due = (data as { next_refresh_due_at: string | null }).next_refresh_due_at;
  if (!due) return true;
  const at = Date.parse(due);
  return !Number.isFinite(at) || at <= now.getTime();
}
