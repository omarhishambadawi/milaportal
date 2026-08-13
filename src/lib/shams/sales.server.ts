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

import { shamsFetch } from "./client.server";
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
