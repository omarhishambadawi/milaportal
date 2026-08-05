/**
 * Yeastar CDR (Call Detail Records) retrieval.
 *
 * Notes:
 *   1. The CDR list/search response array is `data` (NOT `cdr_list`).
 *   2. `/cdr/search` accepts `start_time`/`end_time` as Unix timestamps
 *      (seconds). We pre-filter with `/cdr/search` and authoritatively
 *      post-filter every record by its epoch `timestamp`. If `/cdr/search`
 *      fails or returns zero rows for the window we fall back to a full
 *      `/cdr/list` sweep and rely on the epoch post-filter.
 *   3. Real CDR fields are mapped: `timestamp`, `disposition`, `call_type`,
 *      `duration`, `ring_duration`, `talk_duration`, `call_from_number`,
 *      `call_to_number`, etc.
 *   4. Pagination retrieves ALL records (page_size up to 10,000) until
 *      total_number is reached, with a high safety ceiling.
 *   5. Day boundaries are computed in the business timezone (default UTC+3,
 *      Asia/Riyadh — no DST) so buckets line up with dashboard filters.
 */
import { yeastarFetch } from "./client.server";
import type { RawCdrRow } from "./normalize";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

// Business timezone offset for day-boundary math. Defaults to the centralized
// business timezone (Asia/Riyadh = UTC+3, no DST); override per-deployment.
const TZ_OFFSET_MIN = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES);

/**
 * A raw CDR row, exactly as the live PBX emits it.
 *
 * This is `RawCdrRow` from the normalization layer — one definition, verified
 * field-by-field against the live PBX (see `docs/yeastar/field-mapping.md`). The
 * previous hand-written interface declared fourteen fields this firmware never
 * sends (`wait_time`, `agent_ring_time`, `dst*`, `answer_by`, `linkedid`, `id`,
 * …); they are gone, along with the parsing that depended on them.
 *
 * Remember: a row is a LEG, not a call. Group by `call_id` before deriving any
 * KPI — see `./normalize`.
 */
export type CdrRecord = RawCdrRow;

interface CdrPageResponse {
  errcode: number;
  errmsg: string;
  total_number?: number;
  data?: CdrRecord[]; // CORRECT field (was `cdr_list`)
}

export interface FetchCdrOptions {
  from: string; // "YYYY-MM-DD" (inclusive, business tz)
  to: string; // "YYYY-MM-DD" (inclusive, business tz)
  pageSize?: number; // default 10,000 (Yeastar max)
  maxPages?: number; // safety ceiling, default 200
  signal?: AbortSignal;
  jobId?: string; // when set, progress is reported via progress.server.ts
}

export interface FetchCdrResult {
  records: CdrRecord[];
  totalReported: number | null;
  /**
   * Rows the PBX actually returned, BEFORE our own epoch window filter.
   *
   * Reported because the gap between this and `records.length` is otherwise
   * invisible: a call present in the PBX's own report but absent from our
   * analytics has to be lost either here (pagination) or in that filter
   * (window semantics), and neither was previously observable.
   */
  fetchedRows: number;
  /** Rows discarded because their timestamp fell outside the requested window. */
  droppedOutOfWindow: number;
  pagesFetched: number;
  path: "search" | "list-fallback" | "search-empty-list-fallback";
  startEpoch: number;
  endEpoch: number;
  elapsedMs: number;
  truncated: boolean; // true if the safety ceiling was hit
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Epoch-seconds bounds for [from 00:00:00, to 23:59:59] in the business tz. */
function dayBounds(from: string, to: string): { startEpoch: number; endEpoch: number } {
  const offMs = TZ_OFFSET_MIN * 60_000;
  const startEpoch = Math.floor((Date.parse(`${from}T00:00:00Z`) - offMs) / 1000);
  const endEpoch = Math.floor((Date.parse(`${to}T23:59:59Z`) - offMs) / 1000);
  return { startEpoch, endEpoch };
}

async function fetchAllPages(
  endpoint: string,
  baseQuery: Record<string, string | number | undefined>,
  pageSize: number,
  maxPages: number,
  signal?: AbortSignal,
  jobId?: string,
): Promise<{
  records: CdrRecord[];
  totalReported: number | null;
  pages: number;
  truncated: boolean;
}> {
  const records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let page = 1;
  const progress = jobId ? await import("./progress.server") : null;
  for (; page <= maxPages; page++) {
    const { httpStatus, json, body } = await yeastarFetch<CdrPageResponse>(
      endpoint,
      { ...baseQuery, page, page_size: pageSize, sort_by: "time", order_by: "asc" },
      { signal },
    );

    if (httpStatus !== 200)
      throw new Error(`Yeastar CDR HTTP ${httpStatus}: ${body.slice(0, 200)}`);
    if (!json || json.errcode !== 0) {
      throw new Error(
        `Yeastar CDR errcode ${json?.errcode ?? "n/a"}: ${json?.errmsg ?? "unknown"}`,
      );
    }

    const list = json.data ?? []; // CORRECT field
    if (typeof json.total_number === "number") totalReported = json.total_number;
    // Append element-by-element rather than `records.push(...list)`: with
    // page_size up to 10,000 the spread pushes that many args onto the call
    // stack in one call, which risks a RangeError on large pages. A plain loop
    // has no argument-count ceiling.
    for (const r of list) records.push(r);
    const totalPages =
      totalReported != null ? Math.max(1, Math.ceil(totalReported / pageSize)) : null;
    if (progress && jobId) {
      await progress.updateJob(jobId, {
        status: "fetching",
        page,
        totalPages,
        records: records.length,
        totalReported,
        message: totalPages ? `Fetching page ${page} of ${totalPages}…` : `Fetching page ${page}…`,
      });
    }

    console.log(
      `[yeastar cdr] ${endpoint} page=${page} got=${list.length} total=${totalReported ?? "?"} acc=${records.length}`,
    );
    if (list.length < pageSize) break;
    if (totalReported !== null && records.length >= totalReported) break;
  }
  const truncated = page > maxPages;
  if (truncated)
    console.warn(
      `[yeastar cdr] SAFETY CEILING hit at ${maxPages} pages — result may be incomplete`,
    );
  return { records, totalReported, pages: Math.min(page, maxPages), truncated };
}

// ---- Targeted single-number retrieval --------------------------------------
//
// `fetchCdrRange` is a WINDOW sweep: it pages the whole period because the
// dashboards aggregate over all of it. Call Lookup wants the opposite — one
// subscriber's calls — and paying for a 30-day sweep to answer that is the
// dominant cost of the page.
//
// `/cdr/search` accepts `call_from` and `call_to` (verified in the P-Series
// Appliance developer guide, "Search Specific CDR (v1.0)"), so the number filter
// can be pushed to the PBX and only the matching rows cross the wire.
//
// Two properties make this safe:
//
//   1. **Legs survive.** Every leg of an inbound call carries the SAME
//      `call_from_number` — the customer (verified against
//      `docs/yeastar/samples/cdr-search.json`, where a six-leg call repeats
//      `0538XXXX46` on the IVR, queue and agent rows alike). So filtering on
//      `call_from` returns the COMPLETE leg set, and `call_id` grouping still
//      sees the agent leg it needs to say who answered. Outbound is single-leg
//      and carries the customer in `call_to`.
//   2. **The PBX filter is only ever a pre-filter.** The caller still applies
//      its own authoritative suffix match, exactly as `fetchCdrRange` re-applies
//      its epoch window filter over `/cdr/search`'s date pre-filter. If this
//      firmware ignored `call_from`/`call_to` the rows would be over-broad, not
//      wrong — and `filterEffective` below reports that so the caller can fall
//      back rather than issue one full sweep per variant.

export interface FetchCdrByNumberOptions {
  from: string;
  to: string;
  /**
   * The spellings to search for. `/cdr/search` matches the number EXACTLY
   * unless fuzzy search is enabled PBX-side, so the caller passes every form
   * the same subscriber is recorded under (see `numberVariants`).
   */
  variants: string[];
  signal?: AbortSignal;
  /** Rows per page. Small by design — one subscriber has few calls. */
  pageSize?: number;
  maxPages?: number;
}

export interface FetchCdrByNumberResult {
  /** De-duplicated rows, epoch-filtered to the window. */
  records: CdrRecord[];
  /**
   * False when the PBX appears to have ignored the number parameters and
   * answered with the whole window. The rows are still usable — the caller's
   * own filter is authoritative — but it means this path saved nothing.
   */
  filterEffective: boolean;
  queriesIssued: number;
  elapsedMs: number;
}

/** Run `queries` with a bounded number in flight at once. */
async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await run(items[i]!);
    }
  });
  await Promise.all(workers);
}

export async function fetchCdrByNumber(
  opts: FetchCdrByNumberOptions,
): Promise<FetchCdrByNumberResult> {
  const started = Date.now();
  const pageSize = opts.pageSize ?? 1_000;
  const maxPages = opts.maxPages ?? 20;
  const { startEpoch, endEpoch } = dayBounds(opts.from, opts.to);

  // One query per (variant × end). `call_from` catches inbound — the customer
  // placed the call — and `call_to` catches outbound.
  const queries: Array<{ param: "call_from" | "call_to"; value: string }> = [];
  for (const v of opts.variants) {
    if (!v) continue;
    queries.push({ param: "call_from", value: v });
    queries.push({ param: "call_to", value: v });
  }
  if (queries.length === 0) {
    return { records: [], filterEffective: true, queriesIssued: 0, elapsedMs: 0 };
  }

  // Row-level de-dup. `new_id` is unique per ROW (`uid` and `call_id` are
  // call-level — de-duplicating on either would collapse a call to one leg).
  const byRow = new Map<string, CdrRecord>();
  const rowKey = (r: CdrRecord) =>
    r.new_id != null
      ? `n:${r.new_id}`
      : `c:${r.call_id ?? ""}|${r.timestamp ?? ""}|${r.call_to_number ?? ""}|${r.call_from_number ?? ""}`;

  let queriesIssued = 0;
  let filterEffective = true;

  const runQuery = async (q: { param: "call_from" | "call_to"; value: string }) => {
    const r = await fetchAllPages(
      "/openapi/v1.0/cdr/search",
      { start_time: startEpoch, end_time: endEpoch, [q.param]: q.value },
      pageSize,
      maxPages,
      opts.signal,
    );
    queriesIssued++;
    for (const row of r.records) byRow.set(rowKey(row), row);
  };

  // Probe with one real query before fanning out. If this firmware ignores the
  // number parameters it answers with the entire window, and firing the rest
  // would then cost N full sweeps instead of the single one the caller already
  // has a fallback for. The probe is not wasted work — it is the first query.
  await runQuery(queries[0]!);
  const probeRows = byRow.size;
  if (probeRows >= pageSize) {
    // A single subscriber does not have a full page of calls in one window;
    // this is the whole window coming back unfiltered.
    filterEffective = false;
  }

  if (filterEffective && queries.length > 1) {
    await pooled(queries.slice(1), 6, runQuery);
  }

  const records = [...byRow.values()].filter(
    (r) => typeof r.timestamp === "number" && r.timestamp >= startEpoch && r.timestamp <= endEpoch,
  );

  console.log(
    `[yeastar cdr] by-number queries=${queriesIssued} rows=${records.length} effective=${filterEffective}`,
  );

  return { records, filterEffective, queriesIssued, elapsedMs: Date.now() - started };
}

export async function fetchCdrRange(opts: FetchCdrOptions): Promise<FetchCdrResult> {
  const started = Date.now();
  // v1.0 /cdr/list and /cdr/search accept page_size up to 10,000.
  const pageSize = opts.pageSize ?? 10_000;
  const maxPages = opts.maxPages ?? 200;
  const { startEpoch, endEpoch } = dayBounds(opts.from, opts.to);
  const inWindow = (r: CdrRecord) =>
    typeof r.timestamp === "number" && r.timestamp >= startEpoch && r.timestamp <= endEpoch;

  console.log(`[yeastar cdr] window epoch ${startEpoch}..${endEpoch} (tz+${TZ_OFFSET_MIN}m)`);

  // /cdr/search accepts start_time/end_time as Unix timestamps (seconds).
  // Falls back to /cdr/list (no server-side date filter) if search errors
  // OR returns zero records for a non-trivial window (H2 — silent zero-data
  // blackout: some PBX firmwares reject the epoch form and return 0 rows
  // instead of an error).
  let path: FetchCdrResult["path"] = "search";
  let records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let pages = 0;
  let truncated = false;
  try {
    const r = await fetchAllPages(
      "/openapi/v1.0/cdr/search",
      { start_time: startEpoch, end_time: endEpoch },
      pageSize,
      maxPages,
      opts.signal,
      opts.jobId,
    );
    records = r.records;
    totalReported = r.totalReported;
    pages = r.pages;
    truncated = r.truncated;
    if (records.length === 0) {
      console.warn(
        "[yeastar cdr] /cdr/search returned 0 records — falling back to /cdr/list (H2 empty-fallback).",
      );
      path = "search-empty-list-fallback";
      const full = await fetchAllPages(
        "/openapi/v1.0/cdr/list",
        {},
        pageSize,
        maxPages,
        opts.signal,
        opts.jobId,
      );
      records = full.records;
      totalReported = full.totalReported;
      pages = full.pages;
      truncated = full.truncated;
    }
  } catch (e: any) {
    console.warn(
      `[yeastar cdr] /cdr/search failed (${e?.message ?? e}) — falling back to /cdr/list.`,
    );
    path = "list-fallback";
    const full = await fetchAllPages(
      "/openapi/v1.0/cdr/list",
      {},
      pageSize,
      maxPages,
      opts.signal,
      opts.jobId,
    );
    records = full.records;
    totalReported = full.totalReported;
    pages = full.pages;
    truncated = full.truncated;
  }

  // Authoritative timezone-correct filter by epoch timestamp.
  const filtered = records.filter(inWindow);
  const droppedOutOfWindow = records.length - filtered.length;
  console.log(`[yeastar cdr] path=${path} fetched=${records.length} inWindow=${filtered.length}`);

  return {
    records: filtered,
    totalReported,
    fetchedRows: records.length,
    droppedOutOfWindow,
    pagesFetched: pages,
    path,
    startEpoch,
    endEpoch,
    elapsedMs: Date.now() - started,
    truncated,
  };
}
