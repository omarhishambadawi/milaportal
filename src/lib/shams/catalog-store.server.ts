/**
 * The local Shams product catalogue, in Supabase. Server-only.
 *
 * Every read and write of `public.shams_product_catalog` goes through this
 * module. It is the whole of the answer to "why is Branch Stock search slow on a
 * cold worker": it no longer is, because there is no cold worker — the catalogue
 * lives in Postgres, seeded at migration time and refreshed in the background,
 * and a search is one indexed query against it.
 *
 * ## What this module is not
 *
 * It is not search. No matching, no ranking, no result cap: those are
 * `src/lib/shams/search.ts` and `searchProducts` in `catalog.server.ts`, exactly
 * as before. This narrows 8,484 rows to the ones that could match and hands them
 * over. The division matters because the ranking rules are the agent-facing
 * behaviour and they stay in one pure, unit-tested place rather than being half
 * expressed in SQL.
 *
 * It is not the CRM either. Nothing here contacts `shams-crm.cloud`; filling
 * this table is `src/lib/shams-crm/catalog-sync.server.ts`, which calls the
 * staging and promotion helpers below.
 *
 * ## Access
 *
 * `shams_product_catalog` has RLS on and no policies, so the service role is the
 * only thing that can read it, and the only route to the service role is a
 * server function behind `requireSupabaseAuth` + `view_shams_mis`. The full
 * catalogue never crosses to a browser.
 */

import type { ShamsProduct } from "./types";

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The local catalogue could not answer.
 *
 * Modelled as its own error rather than folded into `ShamsError`, because the
 * two mean opposite things to an operator: `ShamsError` is "the third party is
 * having a bad day", this is "MilaPortal's own database is". They also lead to
 * different fixes, and a search that reported a Supabase outage as a Shams
 * outage would send someone to the wrong system.
 *
 * `kind` is carried to the browser through `toFailure` and chooses the copy in
 * `features/shams/constants.ts`; it never carries a query, a row or a URL.
 */
export class ShamsCatalogError extends Error {
  constructor(
    readonly kind: "catalog_unavailable" | "catalog_empty",
    message: string,
  ) {
    super(message);
    this.name = "ShamsCatalogError";
  }
}

/* -------------------------------------------------------------------------- */
/* LIKE patterns                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Make a piece of agent-typed text safe to embed in a `LIKE` pattern.
 *
 * `%`, `_` and the escape character itself are the only characters `LIKE` reads
 * as syntax, and an agent typing `50%` or `vitamin_d` means those literally. The
 * backslash goes first, or it would escape the escapes added after it.
 *
 * This is the only sanitisation the query needs: the pattern travels as a bound
 * RPC parameter, never as concatenated SQL, so there is no injection surface to
 * defend — only a matching one.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Which rows a query could possibly match, as two `LIKE` patterns.
 *
 * Both may be null — a query with nothing searchable in it retrieves nothing
 * rather than everything.
 */
export interface CatalogCandidateQuery {
  /** Matched against `search_name`. */
  namePattern: string | null;
  /** Matched against `item_code`. */
  codePattern: string | null;
}

/**
 * The most rows one search will pull back for ranking.
 *
 * Ranking runs over whatever this returns, so the cap is a ceiling on how much
 * of the catalogue a single query can consider — not on how many results the
 * agent sees, which is `MAX_SEARCH_RESULTS` and far smaller.
 *
 * 2,000 of 8,484 is roughly a quarter of the catalogue. A query that matches
 * more than that has not narrowed anything: `mounjaro` matches 10 rows, `nan`
 * about 50, and the broadest two-letter query the minimum length permits is
 * still well inside it. The cap exists so a pathological query costs a bounded
 * amount of work rather than an unbounded one, and the ordering it truncates
 * against (`item_code`) is deterministic, so it cannot make results flicker
 * between two runs of the same search.
 */
export const MAX_CATALOG_CANDIDATES = 2000;

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

interface CandidateRow {
  item_code: string;
  item_name: string;
  retail_price: number | string | null;
}

/** `numeric` arrives as a string from PostgREST when it will not fit a double. */
function toPrice(value: number | string | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Candidate products for one search.
 *
 * **Throws when the catalogue cannot be read.** Deliberately not flattened to an
 * empty array: "no products match" and "the catalogue is unreachable" lead to
 * opposite decisions, and an agent shown "no results" during a database incident
 * will tell a customer the product does not exist.
 *
 * `signal` is the browser's own abort signal, forwarded from the server function
 * through `getRequest().signal`. An agent typing quickly abandons a query every
 * ~350 ms, and passing it means the previous query's row read is cancelled at
 * the database rather than completed for nobody.
 */
export async function fetchCatalogCandidates(
  query: CatalogCandidateQuery,
  options: { signal?: AbortSignal; maxRows?: number } = {},
): Promise<ShamsProduct[]> {
  const { namePattern, codePattern } = query;
  if (!namePattern && !codePattern) return [];

  // Nothing is worth starting for a query the caller has already abandoned.
  if (options.signal?.aborted) return [];

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let request = supabaseAdmin.rpc("shams_search_product_catalog", {
    // Both arguments default to NULL in SQL, so an absent pattern is omitted
    // rather than sent as null -- the generated types model the defaults as
    // optional, and the two are equivalent at the database.
    p_name_pattern: namePattern ?? undefined,
    p_code_pattern: codePattern ?? undefined,
    p_max_rows: options.maxRows ?? MAX_CATALOG_CANDIDATES,
  });
  if (options.signal) request = request.abortSignal(options.signal);

  const { data, error } = await request;

  if (error) {
    /*
     * An abort is not a fault. The client went away — which is the normal
     * outcome of the next keystroke — so it resolves as "no candidates" and the
     * discarded query is never rendered anyway.
     */
    if (options.signal?.aborted) return [];
    console.warn("[shams] catalogue search failed:", error.code ?? "unknown");
    throw new ShamsCatalogError(
      "catalog_unavailable",
      "The local Shams product catalogue could not be read.",
    );
  }

  return ((data ?? []) as CandidateRow[]).map((row) => ({
    itemCode: row.item_code,
    itemName: row.item_name,
    retailPrice: toPrice(row.retail_price),
  }));
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue's size, freshness and last refresh outcome.
 *
 * Everything an operator needs to answer "is product search working, and is what
 * it is searching current" — and nothing else. No rows, no credentials, no
 * endpoint. `sourceMarker` is a timestamp string the CRM already publishes on
 * its public status document.
 */
export interface ShamsCatalogHealth {
  /** Products in the local catalogue. Zero is the one value that breaks search. */
  rowCount: number;
  /** True while the catalogue can answer searches at all. */
  usable: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  /** One sentence, already stripped of upstream detail. */
  lastError: string | null;
  nextRefreshDueAt: string | null;
  /** Age of the last successful refresh, in ms. Null when there has never been one. */
  ageMs: number | null;
  /** The stock-sync marker the current rows were fetched against. */
  sourceMarker: string | null;
}

interface CatalogStateRow {
  row_count: number | null;
  source_marker: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_outcome: string | null;
  last_error: string | null;
  next_refresh_due_at: string | null;
}

/**
 * Read the state row, or `null` when it cannot be read.
 *
 * Shared by the health signal and by the refresh, which both need the same seven
 * fields and neither of which should fail because a diagnostic could not load.
 */
export async function readCatalogState(): Promise<CatalogStateRow | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("shams_catalog_state")
    .select(
      "row_count,source_marker,last_attempt_at,last_success_at,last_outcome,last_error,next_refresh_due_at",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("[shams] catalogue state unreadable:", error.code ?? "unknown");
    return null;
  }
  return (data as CatalogStateRow | null) ?? null;
}

/**
 * The health signal.
 *
 * Never throws. A diagnostic that fails when the thing it diagnoses fails is
 * worse than useless, so an unreadable state row reports a zero-row, unusable
 * catalogue rather than raising — which is also the honest reading of "the
 * database would not answer".
 */
export async function readCatalogHealth(now: number = Date.now()): Promise<ShamsCatalogHealth> {
  const state = await readCatalogState();
  const rowCount = state?.row_count ?? 0;
  const lastSuccessAt = state?.last_success_at ?? null;
  const at = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;

  return {
    rowCount,
    usable: rowCount > 0,
    lastSuccessAt,
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastOutcome: state?.last_outcome ?? null,
    lastError: state?.last_error ?? null,
    nextRefreshDueAt: state?.next_refresh_due_at ?? null,
    ageMs: Number.isFinite(at) ? now - at : null,
    sourceMarker: state?.source_marker ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes — staging and promotion                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rows per staging insert.
 *
 * The refresh is ~8,484 rows and PostgREST takes them as one JSON body per
 * request, so this is a trade between request count and body size. 1,000 rows is
 * roughly 90 KB — comfortably inside any proxy's limit — and nine requests,
 * which is nothing against a job that runs a few times a day.
 */
const STAGING_CHUNK = 1000;

/**
 * The fewest rows a refresh may promote.
 *
 * A live catalogue has ~8,484 products and has never been observed to lose one
 * (`docs/shams/api-discovery.md` §10.6 measured 20 days of drift with no code
 * added or removed). A response carrying under a thousand is a truncated
 * download or an endpoint having a bad day, not a catalogue that shrank by 88 %,
 * and promoting it would break search far more thoroughly than a stale price
 * ever could.
 *
 * Asserted here *and* inside `shams_promote_product_catalog`. The database's
 * copy is the one that matters — it is inside the transaction that does the swap
 * — and this one exists so the failure is diagnosed before ~8,000 rows are
 * staged for nothing.
 */
export const MIN_CATALOG_ROWS = 1000;

export interface CatalogPromotion {
  staged: number;
  changed: number;
  removed: number;
  total: number;
}

/**
 * Stage one batch of products, then swap it in atomically.
 *
 * The live catalogue is untouched until the final RPC returns, which is the
 * property the whole staging dance exists for: a CRM that dies mid-download, a
 * worker killed between chunks, or a batch that comes up short all leave the
 * previous rows serving searches. There is no window in which the catalogue is
 * empty or half replaced.
 *
 * Throws on any failure, having changed nothing the search can see.
 */
export async function replaceCatalog(
  products: readonly ShamsProduct[],
  options: { sourceMarker?: string | null; sourceUpdatedAt?: Date; minRows?: number } = {},
): Promise<CatalogPromotion> {
  const minRows = options.minRows ?? MIN_CATALOG_ROWS;
  if (products.length < minRows) {
    throw new ShamsCatalogError(
      "catalog_empty",
      `The Shams CRM catalogue returned ${products.length} products, below the ${minRows} needed to replace the current one.`,
    );
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { normalizeForSearch } = await import("./search");
  const batchId = crypto.randomUUID();

  /*
   * `search_name` is computed here, by the same function the matcher applies to
   * the other side of every comparison. That is the reason it is a stored column
   * rather than a SQL expression: one implementation, in one language, so a
   * retrieval and a match can never disagree about what a product is called.
   */
  const rows = products.map((product) => ({
    batch_id: batchId,
    item_code: product.itemCode,
    item_name: product.itemName,
    search_name: normalizeForSearch(product.itemName),
    retail_price: product.retailPrice,
  }));

  try {
    for (let i = 0; i < rows.length; i += STAGING_CHUNK) {
      const { error } = await supabaseAdmin
        .from("shams_product_catalog_staging")
        .insert(rows.slice(i, i + STAGING_CHUNK));
      if (error) {
        console.warn("[shams] catalogue staging failed:", error.code ?? "unknown");
        throw new ShamsCatalogError(
          "catalog_unavailable",
          "The refreshed Shams catalogue could not be staged.",
        );
      }
    }

    const { data, error } = await supabaseAdmin.rpc("shams_promote_product_catalog", {
      p_batch_id: batchId,
      p_min_rows: minRows,
      p_source_updated_at: (options.sourceUpdatedAt ?? new Date()).toISOString(),
      p_source_marker: options.sourceMarker ?? undefined,
    });
    if (error) {
      console.warn("[shams] catalogue promotion failed:", error.code ?? "unknown");
      throw new ShamsCatalogError(
        "catalog_unavailable",
        "The refreshed Shams catalogue could not be promoted.",
      );
    }

    const promotion = (data ?? {}) as Partial<CatalogPromotion>;
    return {
      staged: promotion.staged ?? rows.length,
      changed: promotion.changed ?? 0,
      removed: promotion.removed ?? 0,
      total: promotion.total ?? rows.length,
    };
  } finally {
    /*
     * Clear this attempt's scratch rows whatever happened. A successful
     * promotion has already deleted them, so this is for the failure paths —
     * without it an abandoned batch would sit in the staging table until
     * somebody noticed. Best effort: a failure to tidy up must not mask the
     * failure that caused it, nor undo a promotion that worked.
     */
    await supabaseAdmin
      .from("shams_product_catalog_staging")
      .delete()
      .eq("batch_id", batchId)
      .then(undefined, () => undefined);
  }
}

/**
 * Record an attempt that did not promote anything.
 *
 * `success` is written by `shams_promote_product_catalog` inside the swap, so it
 * cannot be claimed by a caller that did not actually replace the rows. This
 * writes the other three outcomes, and always moves `next_refresh_due_at`
 * forward — a failure that left the catalogue due would have the scheduler
 * retrying it every minute.
 */
export async function recordCatalogAttempt(patch: {
  outcome: "unchanged" | "not_configured" | "failed";
  error?: string | null;
  attemptedAt: Date;
  nextRefreshDueAt: Date;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("shams_catalog_state")
    .update({
      last_attempt_at: patch.attemptedAt.toISOString(),
      last_outcome: patch.outcome,
      last_error: patch.error ?? null,
      next_refresh_due_at: patch.nextRefreshDueAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) console.warn("[shams] catalogue state write failed:", error.code ?? "unknown");
}

/**
 * Mark the attempt as started, and schedule the next look.
 *
 * Written *before* the CRM is contacted so a worker that dies mid-refresh still
 * leaves evidence that it tried, and — more importantly — leaves the catalogue
 * not due, so the next tick does not immediately try again into whatever killed
 * it. The outcome overwrites this a moment later.
 */
export async function beginCatalogAttempt(attemptedAt: Date, nextDueAt: Date): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("shams_catalog_state")
    .update({
      last_attempt_at: attemptedAt.toISOString(),
      next_refresh_due_at: nextDueAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) console.warn("[shams] catalogue state write failed:", error.code ?? "unknown");
}
