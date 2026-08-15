/**
 * One-off catalog diagnostics (server-only).
 *
 * The same three questions `scripts/shams-catalog-probe.mjs` asks, run from
 * inside the deployment instead of from CI — because the MIS credentials live in
 * the Worker environment and nowhere else, and copying them into a second store
 * to answer a diagnostic question is worse than running the question where they
 * already are.
 *
 *   A  does any MIS path serve a product catalog?
 *   B  does `product/search?q=` truncate? (`count` vs `data.length` — a
 *      truncated candidate set is the open explanation for wildcard searches
 *      that come back thin)
 *   C  are the NAN OPTIPRO rows present upstream at all?
 *
 * Transport is `shamsFetch` and nothing else: no token exchange, no header, and
 * no read of `SHAMS_MIS_*` happens here. Twenty-four read-only requests per run.
 *
 * **No raw upstream body is returned.** Each response is reduced to its shape —
 * status, kind, row counts, field names — plus at most five `{itemCode,
 * itemName}` pairs for C. The base URL is deliberately absent from the result.
 */

import { shamsFetch, ShamsError } from "./client.server";

/** Paths a catalog dump could live under. Only the first has evidence behind it. */
const CATALOG_PATHS: { path: string; note: string }[] = [
  { path: "/products/names", note: "PharmacyCRM's path, no /api/v2 prefix" },
  { path: "/api/v2/products/names", note: "same, under the versioned prefix" },
  { path: "/api/v2/product/names", note: "singular, matching product/info" },
  { path: "/api/v2/product/list", note: "conventional" },
  { path: "/api/v2/product/all", note: "conventional" },
  { path: "/api/v2/products", note: "conventional" },
  { path: "/api/v2/product/catalog", note: "conventional" },
  { path: "/api/v2/stock/sync/status", note: "PharmacyCRM's refresh marker" },
  { path: "/stock/sync/status", note: "same, unprefixed" },
];

/** Broad terms, to see whether a big result set stops at a round number. */
const BROAD_TERMS = ["a", "e", "in", "ta", "co"];

/**
 * The queries this investigation was opened against, plus four that separate the
 * two readings of `count`.
 *
 * `q=nan` returned `count: 50, data.length: 50` with **no** NAN OPTIPRO row,
 * while `q=10400746` returned that exact product. Either `count` is the total
 * and the NAN range genuinely is not in the catalog, or `count` is just the rows
 * on this page and 50 is a cap that cut the range off. Naming the product
 * directly decides it: if `nan optipro` returns it, the catalog has it and `nan`
 * was truncated.
 */
const REPORTED_TERMS = [
  "nan",
  "op",
  "pana",
  "extra",
  "omega",
  "10400746",
  "nan optipro",
  "nan 2 optipro",
  "optipro",
  "1800",
];

const SEARCH_PATH = "/api/v2/product/search";

/**
 * A broad term may match thousands of rows and the endpoint has no `limit`, so
 * the client's 30 s default is tight for exactly the requests that matter most.
 */
const BROAD_TIMEOUT_MS = 60_000;

/** The rows `nan*op` must find: a name reading "nan … op". */
const NAN_OPTIPRO = /^nan\b.*\bop/i;

export interface CatalogRow {
  path: string;
  note: string;
  httpStatus: number | null;
  failure: string | null;
  bodyKind: string;
  rows: number | null;
  fields: string[] | null;
  durationMs: number;
}

export interface TruncationRow {
  q: string;
  httpStatus: number | null;
  failure: string | null;
  count: number | null;
  dataLength: number | null;
  truncated: boolean | null;
  durationMs: number;
  /** Pagination/total fields the envelope carried, if any. */
  meta: Record<string, string> | null;
  /** Top-level key *names* of the envelope — never their values. */
  envelopeKeys: string[] | null;
}

export interface ReportedRow extends TruncationRow {
  nanOptipro: number;
  sample: { itemCode: string; itemName: string }[];
}

export interface CatalogDiagnostics {
  probedAt: string;
  catalog: CatalogRow[];
  truncation: TruncationRow[];
  reported: ReportedRow[];
}

interface Attempt {
  httpStatus: number | null;
  failure: string | null;
  body: unknown;
  durationMs: number;
}

/**
 * One request, with a non-2xx recorded rather than thrown.
 *
 * A 404 is the *answer* to "does this path exist", so `ShamsError` is caught and
 * reduced to its `kind` and status. Anything that is not a `ShamsError` is a
 * real fault and still propagates.
 */
async function attempt(
  path: string,
  query: Record<string, string | number | undefined>,
  opts: { timeoutMs?: number; retry?: boolean },
): Promise<Attempt> {
  const started = Date.now();
  try {
    const body = await shamsFetch<unknown>(path, query, opts);
    return { httpStatus: 200, failure: null, body, durationMs: Date.now() - started };
  } catch (err) {
    if (err instanceof ShamsError) {
      return {
        httpStatus: err.httpStatus,
        failure: err.kind,
        body: null,
        durationMs: Date.now() - started,
      };
    }
    throw err;
  }
}

/** `{success, count, data:[…]}`, a bare array, or something else entirely. */
function describe(body: unknown): {
  bodyKind: string;
  rows: number | null;
  fields: string[] | null;
} {
  if (Array.isArray(body)) {
    return { bodyKind: "array", rows: body.length, fields: fieldsOf(body[0]) };
  }
  if (body && typeof body === "object") {
    const rows = rowsOf(body);
    if (rows) return { bodyKind: "envelope", rows: rows.length, fields: fieldsOf(rows[0]) };
    return { bodyKind: "object", rows: null, fields: Object.keys(body).slice(0, 12) };
  }
  return { bodyKind: body === null ? "empty" : typeof body, rows: null, fields: null };
}

function fieldsOf(row: unknown): string[] | null {
  return row && typeof row === "object" ? Object.keys(row).slice(0, 12) : null;
}

function rowsOf(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const data = rec.data ?? rec.items ?? rec.products;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : null;
}

/**
 * Pagination fields worth looking for, and the envelope's own key names.
 *
 * Read off the response the caller already has — no extra request. The key names
 * are collected as well as the known fields, because a paging field this list
 * failed to guess would otherwise cost another round trip to discover.
 */
const META_KEYS = [
  "total",
  "totalCount",
  "total_count",
  "pages",
  "page",
  "pageSize",
  "page_size",
  "limit",
  "offset",
  "next",
  "hasNext",
  "has_next",
];

function pageMeta(body: unknown): Pick<TruncationRow, "meta" | "envelopeKeys"> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { meta: null, envelopeKeys: null };
  }
  const rec = body as Record<string, unknown>;
  const meta: Record<string, string> = {};
  for (const key of META_KEYS) {
    const value = rec[key];
    if (value !== undefined && value !== null && typeof value !== "object") {
      meta[key] = String(value);
    }
  }
  return {
    meta: Object.keys(meta).length > 0 ? meta : null,
    envelopeKeys: Object.keys(rec).slice(0, 12),
  };
}

/** The `count` the API declares, which can exceed the rows it actually sent. */
function declaredCount(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const count = (body as Record<string, unknown>).count;
  return typeof count === "number" ? count : null;
}

/**
 * One search, returning both the summary row and the rows behind it.
 *
 * The rows come back with the summary rather than from a second call: nothing in
 * `shamsFetch` caches — the 5-minute search cache lives in `catalog.server.ts`,
 * around `searchProducts`, which this deliberately does not go through — so
 * asking twice would mean two real upstream requests per term.
 */
async function searchRow(
  q: string,
  timeoutMs?: number,
): Promise<{ row: TruncationRow; rows: Record<string, unknown>[] }> {
  const { httpStatus, failure, body, durationMs } = await attempt(
    SEARCH_PATH,
    { q },
    { timeoutMs },
  );
  const count = declaredCount(body);
  const rows = rowsOf(body) ?? [];
  const dataLength = rowsOf(body) === null ? null : rows.length;
  return {
    row: {
      q,
      httpStatus,
      failure,
      count,
      dataLength,
      truncated: count === null || dataLength === null ? null : count > dataLength,
      durationMs,
      ...pageMeta(body),
    },
    rows,
  };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A, B and C, in sequence so the run stays inside one request budget. */
export async function runCatalogDiagnostics(): Promise<CatalogDiagnostics> {
  const catalog: CatalogRow[] = [];
  for (const { path, note } of CATALOG_PATHS) {
    // `retry: false` — a 404 is an answer, not a transient fault worth a second
    // request, and it halves the cost of the nine paths that will mostly miss.
    const { httpStatus, failure, body, durationMs } = await attempt(path, {}, { retry: false });
    catalog.push({ path, note, httpStatus, failure, durationMs, ...describe(body) });
  }

  const truncation: TruncationRow[] = [];
  for (const q of BROAD_TERMS) truncation.push((await searchRow(q, BROAD_TIMEOUT_MS)).row);

  const reported: ReportedRow[] = [];
  for (const q of REPORTED_TERMS) {
    const { row, rows } = await searchRow(q);
    reported.push({
      ...row,
      nanOptipro: rows.filter((r) => NAN_OPTIPRO.test(text(r.itemName))).length,
      sample: rows.slice(0, 5).map((r) => ({
        itemCode: text(r.itemCode),
        itemName: text(r.itemName),
      })),
    });
  }

  return { probedAt: new Date().toISOString(), catalog, truncation, reported };
}
