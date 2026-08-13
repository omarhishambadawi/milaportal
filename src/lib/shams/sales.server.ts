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

import { shamsFetch, ShamsError } from "./client.server";
import { groupInvoices, stripLeadingZeros } from "./normalize";
import type { RawSalesResponse, ShamsInvoice } from "./types";

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

  const body = await shamsFetch<RawSalesResponse>("/api/v2/sales/details", {
    // Sent even when empty: this is exactly what the MIS frontend sends, and the
    // endpoint's parameter echo shows it expects the keys to be present.
    start_date: startDate,
    end_date: endDate,
    doc_no_start: docNoStart,
    doc_no_end: docNoEnd,
    wh_cd: branchCode,
  });

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
 * How many branches are probed at once.
 *
 * The MIS answers a document lookup in 0.4–2.3 s. Eight in flight keeps a
 * whole-chain sweep inside a few seconds without turning one agent's lookup
 * into a burst the MIS could reasonably call abuse.
 */
const DISCOVERY_CONCURRENCY = 8;

/** A branch that genuinely holds the document. */
export interface InvoiceBranchMatch {
  branchCode: string;
  /** The document's date, so a chooser can tell two same-numbered docs apart. */
  docDate: string | null;
  grandTotal: number;
  cancelled: boolean;
  /** Carried through so the chooser can show the status without a second read. */
  isCallCentre: boolean;
  customer: string | null;
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
): Promise<{ matches: InvoiceBranchMatch[]; probed: number; failed: number }> {
  const doc = docNo.trim();
  if (!DOC_NO_PATTERN.test(doc)) {
    throw new ShamsQueryError("Document number must be numeric.");
  }

  const candidates = branchCodes
    .map((code) => code.trim().toUpperCase())
    .filter((code) => BRANCH_CODE_PATTERN.test(code));
  const unique = [...new Set(candidates)].sort((a, b) => a.localeCompare(b));

  const matches: InvoiceBranchMatch[] = [];
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= unique.length) return;
      const branchCode = unique[index];
      try {
        const invoices = await getInvoices({ branchCode, docNoStart: doc });
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
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, unique.length) }, () => worker()),
  );

  if (unique.length > 0 && failed === unique.length) {
    throw new ShamsError("unavailable", "Shams MIS did not answer the branch search.");
  }

  matches.sort((a, b) => a.branchCode.localeCompare(b.branchCode));
  return { matches, probed: unique.length, failed };
}
