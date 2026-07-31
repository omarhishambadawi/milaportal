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
