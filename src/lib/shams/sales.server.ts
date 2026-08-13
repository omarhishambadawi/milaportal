/**
 * Shams sales/invoice reads (server-only).
 *
 * `GET /api/v2/sales/details` is the only sales endpoint in the capture. It
 * takes a document-number range and a warehouse, and it echoes back the
 * parameters it understood:
 *
 *   {fromdate, todate, start_date, end_date, doc_no_start, doc_no_end, wh_cd}
 *
 * Two of those need care. `fromdate`/`todate` appear **only** in that echo —
 * the portal's own frontend never sends them — and while `start_date`/`end_date`
 * are sent, they are sent **empty** (`start_date=&end_date=`), so no captured
 * request demonstrates the accepted date format. The date window is therefore
 * exposed but documented as unverified, and the document-number path is the one
 * this module is built around, because it is the one with evidence behind it.
 *
 * Results are **not cached**. Invoices are transactional, a stale total is worse
 * than a slow one, and a lookup is a deliberate single-document act rather than
 * the per-keystroke traffic that justifies the catalog caches.
 */

import { shamsFetch, ShamsError, TtlCache } from "./client.server";
import { groupInvoices, stripLeadingZeros } from "./normalize";
import { sortInvoiceBranchMatches } from "./search";
import type { InvoiceBranchMatch, RawSalesResponse, ShamsInvoice } from "./types";

/** Branch/warehouse codes are `P` + four digits, e.g. `P0304`. */
const BRANCH_CODE_PATTERN = /^[A-Z]\d{4}$/i;
/** Document numbers are digits, optionally zero-padded on input. */
const DOC_NO_PATTERN = /^\d{1,12}$/;
/** `YYYYMMDD`, the only date format the capture shows anywhere (on `crm/data`). */
const DATE_PATTERN = /^\d{8}$/;

export interface InvoiceQuery {
  /** Warehouse / branch code, e.g. `P0304`. Required. */
  branchCode: string;
  /** First document number in the range. */
  docNoStart: string;
  /** Last document number; defaults to `docNoStart` for a single document. */
  docNoEnd?: string;
  /**
   * Optional `YYYYMMDD` window.
   *
   * NOT VERIFIED — no captured request sends a non-empty date, so neither the
   * accepted format nor the filtering behaviour is confirmed. Omit unless
   * validating against the live API.
   */
  startDate?: string;
  endDate?: string;
  /**
   * Override the transport's 30 s default.
   *
   * Used by the branch sweep, where one slow warehouse out of 137 must not hold
   * everything else up. A single deliberate lookup leaves this unset.
   */
  timeoutMs?: number;
}

export class ShamsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShamsQueryError";
  }
}

/**
 * Validate a caller's query before it reaches the network.
 *
 * The MIS answers `200` with an empty result for a malformed query as readily as
 * for a genuinely missing document, so a bad request would otherwise be
 * indistinguishable from "no such invoice".
 */
export function validateInvoiceQuery(query: InvoiceQuery): {
  branchCode: string;
  docNoStart: string;
  docNoEnd: string;
  startDate: string;
  endDate: string;
} {
  const branchCode = query.branchCode?.trim().toUpperCase() ?? "";
  if (!BRANCH_CODE_PATTERN.test(branchCode)) {
    throw new ShamsQueryError("Branch code must look like P0304.");
  }

  const docNoStart = query.docNoStart?.trim() ?? "";
  if (!DOC_NO_PATTERN.test(docNoStart)) {
    throw new ShamsQueryError("Document number must be numeric.");
  }

  const docNoEnd = (query.docNoEnd?.trim() || docNoStart) as string;
  if (!DOC_NO_PATTERN.test(docNoEnd)) {
    throw new ShamsQueryError("End document number must be numeric.");
  }
  if (Number(stripLeadingZeros(docNoEnd)) < Number(stripLeadingZeros(docNoStart))) {
    throw new ShamsQueryError("Document range ends before it starts.");
  }

  const startDate = query.startDate?.trim() ?? "";
  const endDate = query.endDate?.trim() ?? "";
  for (const value of [startDate, endDate]) {
    if (value !== "" && !DATE_PATTERN.test(value)) {
      throw new ShamsQueryError("Dates must be formatted YYYYMMDD.");
    }
  }

  return { branchCode, docNoStart, docNoEnd, startDate, endDate };
}

/**
 * Fetch and assemble the documents matching a query.
 *
 * Returns `[]` for a document that does not exist — the API answers `200` with
 * `count: 0` rather than a 404, so absence is data, not failure.
 */
export async function getInvoices(query: InvoiceQuery): Promise<ShamsInvoice[]> {
  const { branchCode, docNoStart, docNoEnd, startDate, endDate } = validateInvoiceQuery(query);

  const body = await shamsFetch<RawSalesResponse>(
    "/api/v2/sales/details",
    {
      // Sent even when empty: this is exactly what the MIS frontend sends, and
      // the endpoint's parameter echo shows it expects the keys to be present.
      start_date: startDate,
      end_date: endDate,
      doc_no_start: docNoStart,
      doc_no_end: docNoEnd,
      wh_cd: branchCode,
    },
    query.timeoutMs ? { timeoutMs: query.timeoutMs } : {},
  );

  return groupInvoices(body?.data);
}

/**
 * One document, or `null`.
 *
 * A convenience over `getInvoices` for the common single-document lookup.
 */
export async function getInvoice(branchCode: string, docNo: string): Promise<ShamsInvoice | null> {
  const invoices = await getInvoices({ branchCode, docNoStart: docNo });
  return invoices[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Branch discovery                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How many branches are probed at once, within one part of the sweep.
 *
 * Was 8, which was the whole performance problem: 137 branches at 8 in flight
 * is ~17 waves, and at the observed 0.4–2.3 s per document lookup that is a
 * ten-to-forty-second wait on an operational screen.
 *
 * 24 is chosen against what is actually known. No rate limit has ever been
 * observed — no `X-RateLimit-*`, no `Retry-After`, no throttled request across
 * two captures — but absence of evidence is not a licence, so this stays in the
 * range a browser would itself produce (Chrome allows 6 per host and the MIS
 * portal happily fires a request per keystroke) rather than being raised until
 * something breaks. Combined with the client running parts in parallel, a sweep
 * is ~6 waves instead of ~17.
 */
const DISCOVERY_CONCURRENCY = 24;

/**
 * Per-branch timeout during a sweep.
 *
 * The transport's default is 30 s, which is right for a lookup a user is
 * waiting on but wrong for one branch out of 137: a single slow warehouse could
 * hold a worker for half a minute while the other 136 sat finished. A branch
 * that has not answered in 6 s is treated as a failure and skipped — the sweep
 * reports how many did that, and the agent is not made to wait for it.
 */
const DISCOVERY_TIMEOUT_MS = 6_000;

/**
 * Sweep results, cached server-side.
 *
 * Which branches hold document N does not change minute to minute, and the
 * question is expensive enough — one whole-chain sweep — that answering it twice
 * for two agents on the same document is waste. Per-isolate and in-memory, like
 * every other cache here; nothing is persisted.
 */
const DISCOVERY_TTL_MS = 5 * 60_000;
const discoveryCache = new TtlCache<InvoiceBranchSweep>(DISCOVERY_TTL_MS);

export interface InvoiceBranchSweep {
  matches: InvoiceBranchMatch[];
  probed: number;
  failed: number;
}

/** Test seam; also lets a diagnostic force a cold sweep. */
export function _clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Split the chain into `parts` interleaved groups.
 *
 * Round-robin rather than contiguous blocks, and that is the point: branch codes
 * are regional (`P00xx` Riyadh, `P02xx` Jeddah…), so contiguous slices would put
 * one region's branches — and any regional slowness — entirely inside one part,
 * making that part the one everybody waits for. Interleaving gives every part
 * the same mix, so the parts finish at roughly the same time and a progressive
 * UI fills in evenly.
 */
export function partitionBranches(codes: string[], part: number, parts: number): string[] {
  if (parts <= 1) return codes;
  return codes.filter((_, index) => index % parts === part);
}

/**
 * Which branches hold a document with this number?
 *
 * ## Why this is a fan-out
 *
 * A document number identifies an invoice only *within* a warehouse, and the
 * MIS offers no way to ask about a number across the chain. Its entire API
 * surface is known — `product/{search,info,stock}`, `sales/details`,
 * `crm/data`, four `dashboard/*` reports, and auth/users — read from the
 * portal's own shipped bundle, which builds every `sales/details` call with a
 * single `wh_cd`. The MIS's own Sales Register requires a store code for the
 * same reason.
 *
 * So the only honest way to answer "where does 22138 exist?" is to ask each
 * branch. Nothing here infers existence from MilaServ's branch table: that list
 * is only the set of places to *look*, and a branch appears in the result solely
 * because Shams returned a document for it.
 *
 * A branch that fails to answer is skipped rather than failing the sweep — one
 * unreachable warehouse should not hide the nine that replied — but a total
 * failure surfaces as one, since "no branches match" and "nothing answered" are
 * different facts and only the first is a legitimate empty state.
 */
export async function findInvoiceBranches(
  docNo: string,
  branchCodes: string[],
  options: { part?: number; parts?: number } = {},
): Promise<InvoiceBranchSweep> {
  const doc = docNo.trim();
  if (!DOC_NO_PATTERN.test(doc)) {
    throw new ShamsQueryError("Document number must be numeric.");
  }

  const parts = Math.max(1, Math.floor(options.parts ?? 1));
  const part = Math.min(Math.max(0, Math.floor(options.part ?? 0)), parts - 1);

  const candidates = branchCodes
    .map((code) => code.trim().toUpperCase())
    .filter((code) => BRANCH_CODE_PATTERN.test(code));
  // Sorted before partitioning so the split is deterministic: the same branch
  // always lands in the same part, which is what makes the cache key honest.
  const unique = [...new Set(candidates)].sort((a, b) => a.localeCompare(b));
  const mine = partitionBranches(unique, part, parts);

  const cacheKey = `${doc}::${part}/${parts}::${mine.length}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached) return cached;

  const matches: InvoiceBranchMatch[] = [];
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= mine.length) return;
      const branchCode = mine[index];
      try {
        const invoices = await getInvoices({
          branchCode,
          docNoStart: doc,
          timeoutMs: DISCOVERY_TIMEOUT_MS,
        });
        for (const invoice of invoices) {
          matches.push({
            branchCode,
            docDate: invoice.docDate,
            grandTotal: invoice.grandTotal,
            cancelled: invoice.cancelled,
            isCallCentre: invoice.isCallCentre,
            customer: invoice.customer,
          });
        }
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, mine.length) }, () => worker()),
  );

  if (mine.length > 0 && failed === mine.length) {
    // Not cached: a total failure is a transient condition, and caching it would
    // make a retry report the same nothing for five minutes.
    throw new ShamsError("unavailable", "Shams MIS did not answer the branch search.");
  }

  const sweep: InvoiceBranchSweep = {
    matches: sortInvoiceBranchMatches(matches),
    probed: mine.length,
    failed,
  };
  discoveryCache.set(cacheKey, sweep);
  return sweep;
}
