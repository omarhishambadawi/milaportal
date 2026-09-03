import { compareDates, type BusinessDate, type DateWindow } from "./dates";
import {
  judgeCashRecord,
  judgeRetentionBacklogRecord,
  judgeWasfatyRecord,
  type RowVerdict,
} from "./generation";
import type { ProductCatalog } from "./products";
import type { LeadType, SourceRecordInput } from "./types";

/**
 * Why an import produced the number of leads it produced.
 *
 * ===========================================================================
 * The question this exists to answer
 * ===========================================================================
 * A Wasfaty file of 3,937 rows was imported and 46 leads appeared. Nothing in
 * the product could explain the other 3,891, so the only way to find out was to
 * read the generator and then query the database by hand. That is the defect —
 * not the 46, which turned out to be exactly right.
 *
 * The answer, for that file: every row had a Patient ID and a Prescription No,
 * none was missing a date, and none failed any eligibility rule. 3,891 rows
 * simply carried a dispense date outside today-and-tomorrow — 3,721 in the past
 * and 170 in the future — and 46 did not. The window worked precisely as
 * designed and the desk had no way to see it.
 *
 * ===========================================================================
 * It asks the generator's own questions
 * ===========================================================================
 * Every verdict here comes from `judgeCashRecord`, `judgeWasfatyRecord` or
 * `judgeRetentionBacklogRecord` — the same functions `generateCashLeads` and
 * friends call, not a second reading of the same rules. A diagnostic that
 * reasoned about the rules independently would eventually explain a run that
 * did not happen, and it would be believed, because explaining is what it is
 * for.
 *
 * The one thing added on top is *sub-classification*: `outside_window` is a
 * single rule in the generator and one skip reason, but "the prescription was
 * collectable last month" and "the prescription opens in November" are
 * different facts for the desk. The split is presentational and is derived from
 * the same verdict rather than from a second rule.
 *
 * ===========================================================================
 * Every row is accounted for
 * ===========================================================================
 * The buckets are mutually exclusive and their counts sum to the number of rows
 * examined. That is asserted in the tests, because a reconciliation that does
 * not reconcile is worse than no reconciliation: it invites the reader to trust
 * a number that is quietly wrong.
 */

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Why a row is or is not a lead today.
 *
 * Each maps to a real branch in the generator, except the two `outside_window`
 * variants, which split one branch by the sign of the date difference, and
 * `already_generated`, which is the `UNIQUE (lead_type, dedup_key)` refusal the
 * generator counts as a duplicate.
 */
export type DiagnosisReason =
  | "eligible"
  | "already_generated"
  | "no_date"
  | "outside_window_past"
  | "outside_window_future"
  | "ineligible_product"
  | "no_contact_identity";

export const DIAGNOSIS_LABELS: Record<DiagnosisReason, string> = {
  eligible: "Eligible now",
  already_generated: "Already generated as a lead",
  no_date: "No usable date on the row",
  outside_window_past: "Date is before the window",
  outside_window_future: "Date is after the window",
  ineligible_product: "Product is not worked by this pipeline",
  no_contact_identity: "Nothing on the row identifies a customer",
};

/**
 * What the desk should understand from each bucket. Written for the person
 * asking "so where did my rows go", not for whoever wrote the generator.
 */
export const DIAGNOSIS_EXPLANATIONS: Record<DiagnosisReason, string> = {
  eligible: "These rows qualify and will become leads when generation is run.",
  already_generated:
    "A lead already exists for these rows. Running generation again will not duplicate them.",
  no_date: "The date column was empty or unreadable, so there is nothing to judge the row against.",
  outside_window_past:
    "The date has already passed. These rows are kept as history and will not become leads.",
  outside_window_future:
    "The date has not arrived yet. These rows become eligible on their own date.",
  ineligible_product:
    "The product is not one this pipeline calls about, or is switched off in the catalogue.",
  no_contact_identity:
    "No customer reference, name or phone — and for Wasfaty, no Patient ID or Prescription No.",
};

/** Whether a bucket is worth a person's attention, for ordering and colour. */
export function isActionable(reason: DiagnosisReason): boolean {
  return reason === "eligible" || reason === "no_date" || reason === "no_contact_identity";
}

/* ------------------------------------------------------------------------- */
/* Inputs and output                                                         */
/* ------------------------------------------------------------------------- */

/** The parts of a source row the diagnosis reads. */
export type DiagnosableRecord = SourceRecordInput & { id: string };

export interface DiagnosisBucket {
  reason: DiagnosisReason;
  rows: number;
  /** The date range of the rows in this bucket, when they carry dates. Null for
   *  `no_date`, and the reason the past/future split is worth reading. */
  earliest: BusinessDate | null;
  latest: BusinessDate | null;
  /** How many of these rows carry a usable phone number. */
  withPhone: number;
  /** A handful of row numbers, so the operator can find them in the file. */
  sampleRowNumbers: number[];
}

export interface ImportDiagnosis {
  leadType: LeadType;
  anchorDate: BusinessDate;
  /** Null for the retention backlog, which has no window. */
  window: DateWindow | null;
  rowsExamined: number;
  buckets: DiagnosisBucket[];
  /** Rows that would become leads if generation ran now. */
  eligibleNow: number;
  /** Rows already represented by a lead. */
  alreadyGenerated: number;
  /** Rows that will never become leads under the current rules. */
  permanentlyExcluded: number;
  /** Rows that are not eligible yet but will be, on their own date. */
  pendingFutureDate: number;
}

/** How many sample row numbers each bucket carries. */
const SAMPLE_LIMIT = 5;

/* ------------------------------------------------------------------------- */
/* The diagnosis                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Classify every row of an import against the rules that will judge it.
 *
 * `existingDedupKeys` is the set of `dedup_key` values already present on
 * `telesales_leads` for this lead type. A row whose key is in it has already
 * produced a lead, which is the single most reassuring thing the report can
 * say: running generation again changes nothing.
 *
 * Pure and in-memory. The caller reads the rows once and the keys once; nothing
 * here queries anything, and nothing here is per-row I/O.
 */
export function diagnoseImport(input: {
  leadType: LeadType;
  anchorDate: BusinessDate;
  window: DateWindow | null;
  records: readonly DiagnosableRecord[];
  catalog: ProductCatalog;
  /** Keyed by the same `dedupKeyFor…` the generator would produce. */
  existingDedupKeys?: ReadonlySet<string>;
  /** Produces the dedup key for a row, so this module does not re-implement it. */
  dedupKeyFor?: (record: DiagnosableRecord) => string;
}): ImportDiagnosis {
  const { leadType, anchorDate, window, records, catalog } = input;
  const existing = input.existingDedupKeys ?? new Set<string>();

  const byReason = new Map<DiagnosisReason, DiagnosableRecord[]>();
  const push = (reason: DiagnosisReason, record: DiagnosableRecord) => {
    const bucket = byReason.get(reason);
    if (bucket) bucket.push(record);
    else byReason.set(reason, [record]);
  };

  for (const record of records) {
    const verdict: RowVerdict =
      leadType === "cash"
        ? judgeCashRecord(record, requireWindow(window), catalog)
        : leadType === "wasfaty"
          ? judgeWasfatyRecord(record, requireWindow(window))
          : judgeRetentionBacklogRecord(record, catalog);

    if (!verdict.eligible) {
      push(expand(verdict.reason, record, window), record);
      continue;
    }

    /*
     * Eligible by the rules — but a lead may already exist for it. Checked
     * after the rules, never instead of them: "already generated" is only
     * meaningful for a row that would otherwise qualify, and reporting it for
     * an ineligible row would claim the generator had accepted something it
     * refused.
     */
    const key = input.dedupKeyFor?.(record);
    push(key && existing.has(key) ? "already_generated" : "eligible", record);
  }

  const buckets: DiagnosisBucket[] = [...byReason.entries()]
    .map(([reason, rows]) => summarize(reason, rows))
    .sort(byReasonOrder);

  const count = (reason: DiagnosisReason) => byReason.get(reason)?.length ?? 0;

  return {
    leadType,
    anchorDate,
    window,
    rowsExamined: records.length,
    buckets,
    eligibleNow: count("eligible"),
    alreadyGenerated: count("already_generated"),
    /*
     * "Permanent" is a statement about the current rules, not about the data.
     * A past date cannot come back and an ineligible product stays ineligible
     * until somebody changes the catalogue — which is exactly the kind of
     * decision this report exists to prompt.
     */
    permanentlyExcluded:
      count("outside_window_past") +
      count("no_date") +
      count("ineligible_product") +
      count("no_contact_identity"),
    pendingFutureDate: count("outside_window_future"),
  };
}

/**
 * Split the generator's single `outside_window` refusal by which side of the
 * window the row fell on.
 *
 * Presentation, not a rule. The generator asked one question and got one
 * answer; this reads the same date it already judged and says which way.
 */
function expand(
  reason: Exclude<RowVerdict & { eligible: false }, { eligible: true }>["reason"],
  record: DiagnosableRecord,
  window: DateWindow | null,
): DiagnosisReason {
  if (reason !== "outside_window") return reason;
  if (!window || !record.sourceDate) return "outside_window_past";
  return compareDates(record.sourceDate, window.from) < 0
    ? "outside_window_past"
    : "outside_window_future";
}

function requireWindow(window: DateWindow | null): DateWindow {
  /*
   * Cash and Wasfaty cannot be judged without one. The retention backlog is the
   * only pipeline with no window, and it never reaches here.
   */
  if (!window) throw new Error("A dated pipeline was diagnosed without a window.");
  return window;
}

function summarize(reason: DiagnosisReason, rows: readonly DiagnosableRecord[]): DiagnosisBucket {
  let earliest: BusinessDate | null = null;
  let latest: BusinessDate | null = null;
  let withPhone = 0;
  const sampleRowNumbers: number[] = [];

  for (const row of rows) {
    if (row.phone) withPhone++;
    if (row.sourceDate) {
      if (!earliest || compareDates(row.sourceDate, earliest) < 0) earliest = row.sourceDate;
      if (!latest || compareDates(row.sourceDate, latest) > 0) latest = row.sourceDate;
    }
    if (sampleRowNumbers.length < SAMPLE_LIMIT) sampleRowNumbers.push(row.rowNumber);
  }

  return { reason, rows: rows.length, earliest, latest, withPhone, sampleRowNumbers };
}

/**
 * Reading order: what will happen, then what already happened, then what never
 * will. A report is read top-down and the actionable part belongs at the top.
 */
const REASON_ORDER: DiagnosisReason[] = [
  "eligible",
  "already_generated",
  "outside_window_future",
  "outside_window_past",
  "no_date",
  "no_contact_identity",
  "ineligible_product",
];

function byReasonOrder(a: DiagnosisBucket, b: DiagnosisBucket): number {
  return REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason);
}

/**
 * The one-line summary, in the desk's terms.
 *
 * Deliberately states the reconciliation as an equation. "3,937 rows: 46
 * eligible now, 3,891 excluded" is the sentence somebody needed and did not
 * have.
 */
export function describeDiagnosis(d: ImportDiagnosis): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const parts: string[] = [];
  if (d.eligibleNow) parts.push(`${n(d.eligibleNow)} eligible now`);
  if (d.alreadyGenerated) parts.push(`${n(d.alreadyGenerated)} already generated`);
  if (d.pendingFutureDate) parts.push(`${n(d.pendingFutureDate)} waiting for their date`);
  if (d.permanentlyExcluded) parts.push(`${n(d.permanentlyExcluded)} excluded`);
  return `${n(d.rowsExamined)} row${d.rowsExamined === 1 ? "" : "s"}: ${
    parts.length ? parts.join(", ") : "nothing to report"
  }.`;
}
