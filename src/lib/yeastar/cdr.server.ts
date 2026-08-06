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
 *   4. Pagination retrieves ALL records until total_number is reached, with a
 *      high safety ceiling. Page 1 is a blocking probe — its `total_number`
 *      sizes the job — and the remaining pages are then fetched concurrently.
 *      See DEFAULT_PAGE_SIZE for why the page size is not the API maximum.
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
 * How many CDR pages to have in flight at once.
 *
 * Measured against the live PBX over July 2026 (14,294 rows, 8 pages of 2,000):
 *
 *   concurrency 6 → every page 26-28s, total wall 34.8s
 *   concurrency 3 → every page ~14.6s, total wall 37.7s
 *
 * The appliance is throughput-bound: it serializes the work whatever we do, so
 * the total is the same either way and the only thing extra concurrency buys is
 * a longer queue in front of each individual request. At 6 that queue pushed
 * every page past the client's 25s request timeout, and an aborted page used to
 * escalate into a full unfiltered `/cdr/list` sweep of the entire CDR history —
 * which is how a month-wide filter stopped loading at all.
 *
 * So 3: the same wall time, with each request finishing in well under half the
 * timeout, and enough headroom left that two users on a month do not put each
 * other over it. Tunable, because the right value depends on hardware this code
 * cannot measure from here.
 */
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.YEASTAR_CDR_PAGE_CONCURRENCY) || 3);

/**
 * Per-request timeout for a CDR page.
 *
 * The client's 25s default is sized for the small control-plane calls (roster,
 * queue list). A 2,000-row CDR page legitimately takes ~15s on this appliance
 * even unqueued, so 25s left almost no margin and turned a slow page into a
 * failed window. Tunable alongside the concurrency above.
 */
const PAGE_TIMEOUT_MS = Math.max(10_000, Number(process.env.YEASTAR_CDR_PAGE_TIMEOUT_MS) || 60_000);

/** How many times to re-try a page that failed in transport before giving up. */
const PAGE_RETRIES = 2;

/**
 * Rows per CDR page.
 *
 * Was 10,000 — the API maximum — on the reasoning that fewer round-trips is
 * fewer round-trips. That is backwards once the pages after the first are
 * fetched together, because page 1 is a BLOCKING probe: nothing else can start
 * until its `total_number` says how many pages there are. At 10,000 the probe
 * alone carries three quarters of a month's rows, so the window is essentially
 * fetched serially no matter what the rest do.
 *
 * Modelled over a 14,000-row month (the live-audit figure) across per-request
 * overheads from 100 ms to 1 s, 10,000 is the WORST available choice at every
 * point in that range and ~2,000 is at or near the best at all of them:
 *
 *   page_size   overhead 100ms   250ms   500ms   1000ms
 *      10,000          3,200   3,500   4,000    5,000   ms
 *       2,000            800   1,100   1,600    2,600   ms
 *
 * Small enough to keep the probe cheap, large enough that a month is still only
 * a handful of requests. Tunable for the same reason as the concurrency.
 */
const DEFAULT_PAGE_SIZE = Math.min(
  10_000,
  Math.max(100, Number(process.env.YEASTAR_CDR_PAGE_SIZE) || 2_000),
);

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
  pageSize?: number; // default DEFAULT_PAGE_SIZE (2,000); Yeastar max is 10,000
  maxPages?: number; // safety ceiling, default 1,000
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

/**
 * Page 1 of a sweep failed, so the ENDPOINT itself could not be used.
 *
 * Distinguished from a later page failing, because only this one justifies
 * switching endpoints. See the fallback logic in `fetchCdrRange`.
 */
class CdrProbeError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "CdrProbeError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  /**
   * One page, re-tried on a transport failure.
   *
   * A timed-out page is a transient condition on a busy appliance, not evidence
   * that the window or the endpoint is wrong — and it used to be fatal to the
   * whole sweep. Re-trying it costs one request; not re-trying it cost the user
   * their dashboard. The caller's own abort signal is never re-tried, because
   * that means the request was cancelled deliberately.
   */
  const getPage = async (p: number): Promise<CdrRecord[]> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= PAGE_RETRIES; attempt++) {
      if (attempt > 0) {
        console.warn(`[yeastar cdr] ${endpoint} page=${p} retry ${attempt}/${PAGE_RETRIES}`);
        await sleep(500 * attempt);
      }
      if (signal?.aborted) throw new Error("CDR fetch aborted by caller");
      try {
        const { httpStatus, json, body } = await yeastarFetch<CdrPageResponse>(
          endpoint,
          { ...baseQuery, page: p, page_size: pageSize, sort_by: "time", order_by: "asc" },
          { signal, timeoutMs: PAGE_TIMEOUT_MS },
        );
        if (httpStatus !== 200)
          throw new Error(`Yeastar CDR HTTP ${httpStatus}: ${body.slice(0, 200)}`);
        if (!json || json.errcode !== 0) {
          throw new Error(
            `Yeastar CDR errcode ${json?.errcode ?? "n/a"}: ${json?.errmsg ?? "unknown"}`,
          );
        }
        if (typeof json.total_number === "number") totalReported = json.total_number;
        return json.data ?? []; // CORRECT field
      } catch (e) {
        lastError = e;
        if (signal?.aborted) throw e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  // Append element-by-element rather than `records.push(...list)`: with
  // page_size up to 10,000 the spread pushes that many args onto the call stack
  // in one call, which risks a RangeError on large pages. A plain loop has no
  // argument-count ceiling.
  const append = (list: CdrRecord[]) => {
    for (const r of list) records.push(r);
  };

  // Page 1 is the probe: it is the only one whose page count is unknown in
  // advance, and its `total_number` tells us exactly how many more there are.
  // It is also the only page whose failure says anything about the ENDPOINT, so
  // it is tagged — see `CdrProbeError`.
  let first: CdrRecord[];
  try {
    first = await getPage(1);
  } catch (e) {
    throw new CdrProbeError(e);
  }
  append(first);
  const report = (p: number, totalPages: number | null, got: number) => {
    console.log(
      `[yeastar cdr] ${endpoint} page=${p} got=${got} total=${totalReported ?? "?"} acc=${records.length}`,
    );
    return progress && jobId
      ? progress.updateJob(jobId, {
          status: "fetching",
          page: p,
          totalPages,
          records: records.length,
          totalReported,
          message: totalPages ? `Fetching page ${p} of ${totalPages}…` : `Fetching page ${p}…`,
        })
      : Promise.resolve();
  };

  const totalPages =
    totalReported != null ? Math.max(1, Math.ceil(totalReported / pageSize)) : null;
  await report(1, totalPages, first.length);

  let truncated = false;
  if (first.length >= pageSize && !(totalReported !== null && records.length >= totalReported)) {
    if (totalPages != null) {
      // The PBX told us the total, so the remaining pages are known up front and
      // there is no reason to discover them one blocking round-trip at a time.
      // This is where a big window used to spend most of its wall time.
      const wanted = Math.min(totalPages, maxPages);
      truncated = totalPages > maxPages;
      const rest = Array.from({ length: wanted - 1 }, (_, i) => i + 2);
      const pageRows = new Array<CdrRecord[]>(rest.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(PAGE_CONCURRENCY, rest.length) }, async () => {
          for (;;) {
            const idx = next++;
            if (idx >= rest.length) return;
            pageRows[idx] = await getPage(rest[idx]!);
          }
        }),
      );
      // Concatenated in page order, so the `sort_by=time&order_by=asc` the
      // request asked for still holds across the whole result.
      for (let i = 0; i < pageRows.length; i++) {
        append(pageRows[i] ?? []);
        await report(rest[i]!, totalPages, pageRows[i]?.length ?? 0);
      }
      page = wanted;
    } else {
      // No total to go on — fall back to discovering pages sequentially.
      for (page = 2; page <= maxPages; page++) {
        const list = await getPage(page);
        append(list);
        await report(page, null, list.length);
        if (list.length < pageSize) break;
        if (totalReported !== null && records.length >= totalReported) break;
      }
      truncated = page > maxPages;
    }
  }

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
  // v1.0 /cdr/list and /cdr/search accept page_size up to 10,000; see
  // DEFAULT_PAGE_SIZE for why the maximum is not the fastest setting.
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  // Pages are smaller now, so the ceiling has to rise with them to cover the
  // same volume. 2,000 × 1,000 is two million rows before it trips.
  const maxPages = opts.maxPages ?? 1_000;
  const { startEpoch, endEpoch } = dayBounds(opts.from, opts.to);
  const inWindow = (r: CdrRecord) =>
    typeof r.timestamp === "number" && r.timestamp >= startEpoch && r.timestamp <= endEpoch;

  console.log(`[yeastar cdr] window epoch ${startEpoch}..${endEpoch} (tz+${TZ_OFFSET_MIN}m)`);

  // /cdr/search accepts start_time/end_time as Unix timestamps (seconds).
  //
  // It falls back to /cdr/list — which has NO server-side date filter and
  // therefore sweeps the PBX's entire retained history — in exactly two cases,
  // and both of them are statements about the ENDPOINT rather than about one
  // request:
  //
  //   1. Page 1 itself failed (`CdrProbeError`). The epoch form was rejected,
  //      so /cdr/search cannot answer this window at all.
  //   2. Page 1 succeeded but the window came back empty (H2 — silent zero-data
  //      blackout: some firmwares answer 0 rows instead of erroring).
  //
  // A LATER page failing is neither. By then page 1 has already come back with
  // rows and a plausible `total_number`, which is proof that /cdr/search works;
  // the failure is transport, and `getPage` has already re-tried it. Escalating
  // it to the unfiltered sweep is what broke month-wide filtering: on this PBX
  // the window is 14,294 rows and the unfiltered history is 70,052, so a single
  // slow page turned into five times the work, timed out in turn, and took the
  // whole dashboard down with it. It now propagates as the honest failure it is.
  let path: FetchCdrResult["path"] = "search";
  let records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let pages = 0;
  let truncated = false;

  const listFallback = async (why: string) => {
    console.warn(`[yeastar cdr] ${why} — falling back to the unfiltered /cdr/list sweep.`);
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
  };

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
      path = "search-empty-list-fallback";
      await listFallback("/cdr/search returned 0 records (H2 empty-fallback)");
    }
  } catch (e: any) {
    if (!(e instanceof CdrProbeError)) throw e;
    path = "list-fallback";
    await listFallback(`/cdr/search page 1 failed (${e.message})`);
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
