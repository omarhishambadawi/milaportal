import { dedupKeyForRetention, dedupKeyForSource } from "./dedup";
import {
  cashWindow,
  formatWindow,
  retentionWindow,
  wasfatyWindow,
  withinWindow,
  type BusinessDate,
  type DateWindow,
} from "./dates";
import { familyLabel, matchProduct, type ProductCatalog } from "./products";
import { computePriority } from "./status";
import type { LeadType, SourceRecordInput, TelesalesSettings } from "./types";

/**
 * Lead generation, as a pure projection.
 *
 * Given a window, a product catalogue and a set of candidate rows, this decides
 * which become leads and what those leads say. It touches no database: the
 * server function fetches the candidates, calls this, and writes the result.
 *
 * That split is what makes the date rules testable. Month boundaries, exactly-
 * three-days, the same customer with two products, the same product at two
 * branches — all of them are assertions about this function, and none of them
 * needs a Postgres instance to make.
 *
 * ===========================================================================
 * Idempotency
 * ===========================================================================
 * This function is deterministic and produces a `dedupKey` per lead. Running it
 * twice produces the same keys, and `UNIQUE (lead_type, dedup_key)` turns the
 * second insert into a counted no-op. Nothing here checks whether a lead already
 * exists — that check would be a race against a concurrent run, and the index is
 * not.
 */

/** A lead the generator wants to create. */
export interface LeadDraft {
  leadType: LeadType;
  dedupKey: string;
  sourceRecordId: string | null;
  parentLeadId: string | null;
  cycleNumber: number;
  priority: number;

  customerRef: string | null;
  customerName: string | null;
  phone: string | null;
  phoneAlternates: string[];
  branchNo: string | null;
  city: string | null;
  facility: string | null;
  channel: string | null;

  itemCode: string | null;
  itemName: string | null;
  productFamily: string | null;
  productStrength: string | null;
  quantity: number | null;
  totalValue: number | null;

  documentNo: string | null;
  patientId: string | null;
  prescriptionNo: string | null;
  sourceDate: BusinessDate | null;

  generationReason: string;
  /** Proposed follow-up, when the source already carries a promised callback. */
  followupDueOn: BusinessDate | null;
}

/** Why a candidate did not become a lead. Counted, and shown on the run. */
export type SkipReason =
  | "outside_window"
  | "no_date"
  | "ineligible_product"
  | "no_contact_identity";

export interface GenerationResult {
  window: DateWindow;
  drafts: LeadDraft[];
  candidates: number;
  skipped: Record<SkipReason, number>;
}

function emptySkips(): Record<SkipReason, number> {
  return { outside_window: 0, no_date: 0, ineligible_product: 0, no_contact_identity: 0 };
}

/* ------------------------------------------------------------------------- */
/* Cash                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Cash leads for one anchor date.
 *
 * A source row becomes a Cash lead when all three hold:
 *
 *   1. Its invoice date is inside the window (`cashWindow`).
 *   2. Its product is eligible for Cash (`matchProduct`).
 *   3. It identifies a customer at all.
 *
 * The third is looser than it sounds and deliberately so. 36 rows across the
 * July working sheets are `REFUSED TO GET MOBILE NUMBER` with a phone of `0`,
 * `0000` or `m`, and the desk still worked them — the branch has the customer's
 * details even when the extract does not. So a row with a name or a customer
 * reference qualifies, and the queue shows it as having no number rather than
 * discarding it.
 *
 * ### One customer, two products, two branches
 *
 * All of these produce separate leads, because `dedupKeyForSource` keys on
 * customer + product + branch + date. That is the observed behaviour: the July
 * working sheets carry one row per invoice *line*, and a customer buying
 * Mounjaro and a FreeStyle sensor on one invoice appears twice.
 */
export function generateCashLeads(
  anchor: BusinessDate,
  records: readonly (SourceRecordInput & { id: string })[],
  catalog: ProductCatalog,
  settings: TelesalesSettings,
): GenerationResult {
  const window = cashWindow(anchor, {
    days: settings.cashWindowDays,
    lagDays: settings.cashWindowLagDays,
  });
  const skipped = emptySkips();
  const drafts: LeadDraft[] = [];
  const windowLabel = formatWindow(window);

  for (const record of records) {
    if (!record.sourceDate) {
      skipped.no_date++;
      continue;
    }
    if (!withinWindow(window, record.sourceDate)) {
      skipped.outside_window++;
      continue;
    }

    const product = matchProduct(catalog, record, "cash");
    if (!product.eligible) {
      skipped.ineligible_product++;
      continue;
    }

    if (!record.customerRef && !record.phone && !record.customerName) {
      skipped.no_contact_identity++;
      continue;
    }

    drafts.push({
      leadType: "cash",
      dedupKey: dedupKeyForSource("cash", record),
      sourceRecordId: record.id,
      parentLeadId: null,
      cycleNumber: 1,
      priority: computePriority({
        leadType: "cash",
        hasPhone: Boolean(record.phone),
        followupOverdue: false,
      }),
      customerRef: record.customerRef,
      customerName: record.customerName,
      phone: record.phone,
      phoneAlternates: record.phoneAlternates ?? [],
      branchNo: record.branchNo,
      city: record.city,
      facility: record.facility,
      channel: record.channel,
      itemCode: record.itemCode,
      itemName: record.itemName,
      productFamily: product.family,
      productStrength: product.strength,
      quantity: record.quantity,
      totalValue: record.totalValue ?? record.unitPrice,
      documentNo: record.documentNo,
      patientId: null,
      prescriptionNo: null,
      sourceDate: record.sourceDate,
      generationReason: `Cash window ${windowLabel} · ${familyLabel(product.family)}${
        product.strength ? ` ${product.strength}` : ""
      }`,
      followupDueOn: null,
    });
  }

  return { window, drafts, candidates: records.length, skipped };
}

/* ------------------------------------------------------------------------- */
/* Wasfaty                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Wasfaty leads for one anchor date.
 *
 * The window runs *forward* — today and tomorrow — because `Next Dispense Date`
 * is when a prescription becomes collectable, so the desk is calling ahead of it
 * rather than chasing a past event. The second day is the pre-opening
 * allowance.
 *
 * ### Product eligibility does not apply
 *
 * A deliberate difference from Cash, and it follows from the data: the Wasfaty
 * sheets carry no item code and no product name at all — the medication is
 * inside the prescription, which is exactly why the identity is the prescription
 * and not the item. Filtering by product here would filter on a column that does
 * not exist and reject every row.
 *
 * ### The missing phone number is not a rejection
 *
 * 2,774 of 3,952 rows in `Wasfaty Aug` have no phone, and the five per-city
 * sheets have none at all. That is the normal state of a Wasfaty lead, and
 * looking the number up is the agent's job. A lead without one is created,
 * ranked below the leads that can be dialled immediately, and shown with the
 * Patient ID and Prescription No the agent needs to find it.
 */
export function generateWasfatyLeads(
  anchor: BusinessDate,
  records: readonly (SourceRecordInput & { id: string })[],
  settings: TelesalesSettings,
  /** Current numbers, keyed by patient id — so a patient whose number was found
   *  last month is not sent back to the portal. */
  knownPhones: ReadonlyMap<string, string> = new Map(),
): GenerationResult {
  const window = wasfatyWindow(anchor, { days: settings.wasfatyWindowDays });
  const skipped = emptySkips();
  const drafts: LeadDraft[] = [];
  const windowLabel = formatWindow(window);

  for (const record of records) {
    if (!record.sourceDate) {
      skipped.no_date++;
      continue;
    }
    if (!withinWindow(window, record.sourceDate)) {
      skipped.outside_window++;
      continue;
    }
    if (!record.patientId && !record.prescriptionNo) {
      skipped.no_contact_identity++;
      continue;
    }

    const phone =
      record.phone ?? (record.patientId ? (knownPhones.get(record.patientId) ?? null) : null);

    drafts.push({
      leadType: "wasfaty",
      dedupKey: dedupKeyForSource("wasfaty", record),
      sourceRecordId: record.id,
      parentLeadId: null,
      cycleNumber: 1,
      priority: computePriority({
        leadType: "wasfaty",
        hasPhone: Boolean(phone),
        followupOverdue: false,
      }),
      customerRef: record.patientId,
      customerName: record.customerName,
      phone: phone,
      phoneAlternates: record.phoneAlternates ?? [],
      branchNo: record.branchNo,
      city: record.city,
      facility: record.facility,
      channel: null,
      itemCode: null,
      itemName: null,
      productFamily: null,
      productStrength: null,
      quantity: null,
      totalValue: record.totalValue,
      documentNo: null,
      patientId: record.patientId,
      prescriptionNo: record.prescriptionNo,
      sourceDate: record.sourceDate,
      generationReason: `Wasfaty dispense window ${windowLabel}`,
      followupDueOn: null,
    });
  }

  return { window, drafts, candidates: records.length, skipped };
}

/* ------------------------------------------------------------------------- */
/* Retention                                                                 */
/* ------------------------------------------------------------------------- */

/** A converted lead that may be due another cycle. */
export interface RetentionCandidate {
  id: string;
  leadType: LeadType;
  cycleNumber: number;
  customerRef: string | null;
  customerName: string | null;
  phone: string | null;
  branchNo: string | null;
  city: string | null;
  channel: string | null;
  itemCode: string | null;
  itemName: string | null;
  productFamily: string | null;
  productStrength: string | null;
  /** When the follow-up on that conversion falls due. */
  dueOn: BusinessDate | null;
}

/**
 * Retention leads for one anchor date.
 *
 * A retention lead is the *next cycle* of a conversion this system recorded. The
 * chain is what the workbooks could not express: the Retention sheet holds one
 * row per customer, edited in place, so a customer on their third refill has
 * lost the record of the first two.
 *
 * Here, cycle N+1 is a new row pointing at cycle N, and `dedupKeyForRetention`
 * includes the cycle number — which is what stops cycle 3 colliding with cycle 2
 * and silently ending the desk's follow-up of anybody they had already followed
 * up once.
 *
 * ### The window is backward, and bounded
 *
 * `retentionWindow` runs from `anchor - grace` to `anchor`, inclusive. Backward,
 * because a follow-up promised for a day the desk did not work is still owed;
 * the literal `Days to refill = 0` rule the workbooks used drops such a lead
 * permanently the first time a working day is missed. Bounded, because a
 * follow-up two months overdue should be somebody's decision rather than a row
 * that reappears in the queue forever.
 */
export function generateRetentionLeads(
  anchor: BusinessDate,
  candidates: readonly RetentionCandidate[],
  catalog: ProductCatalog,
  settings: TelesalesSettings,
): GenerationResult {
  const window = retentionWindow(anchor, { graceDays: settings.retentionOverdueGraceDays });
  const skipped = emptySkips();
  const drafts: LeadDraft[] = [];

  for (const candidate of candidates) {
    if (!candidate.dueOn) {
      skipped.no_date++;
      continue;
    }
    if (!withinWindow(window, candidate.dueOn)) {
      skipped.outside_window++;
      continue;
    }

    /*
     * The product must still be worth a refill call.
     *
     * A FreeStyle Libre *reader* converts as a Cash lead and has no refill
     * cycle — it is hardware, bought once. `eligible_retention` is the column
     * that says so, and asking it here is what keeps the desk from ringing a
     * customer about re-buying a device they still own.
     */
    const product = matchProduct(catalog, candidate, "retention");
    if (!product.eligible) {
      skipped.ineligible_product++;
      continue;
    }

    if (!candidate.customerRef && !candidate.phone && !candidate.customerName) {
      skipped.no_contact_identity++;
      continue;
    }

    const cycleNumber = candidate.cycleNumber + 1;
    drafts.push({
      leadType: "retention",
      dedupKey: dedupKeyForRetention({
        customerRef: candidate.customerRef,
        phone: candidate.phone,
        customerName: candidate.customerName,
        itemCode: candidate.itemCode,
        itemName: candidate.itemName,
        cycleNumber,
      }),
      sourceRecordId: null,
      parentLeadId: candidate.id,
      cycleNumber,
      priority: computePriority({
        leadType: "retention",
        hasPhone: Boolean(candidate.phone),
        // A cycle raised on a past due date is already late by construction.
        followupOverdue: candidate.dueOn !== anchor,
      }),
      customerRef: candidate.customerRef,
      customerName: candidate.customerName,
      phone: candidate.phone,
      phoneAlternates: [],
      branchNo: candidate.branchNo,
      city: candidate.city,
      facility: null,
      channel: candidate.channel,
      itemCode: candidate.itemCode,
      itemName: candidate.itemName,
      productFamily: product.family ?? candidate.productFamily,
      productStrength: product.strength ?? candidate.productStrength,
      quantity: null,
      totalValue: null,
      documentNo: null,
      patientId: null,
      prescriptionNo: null,
      sourceDate: candidate.dueOn,
      generationReason: `Refill cycle ${cycleNumber} · due ${candidate.dueOn}`,
      followupDueOn: candidate.dueOn,
    });
  }

  return { window, drafts, candidates: candidates.length, skipped };
}

/* ------------------------------------------------------------------------- */
/* Backlog                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Retention leads seeded from the existing workbook.
 *
 * The cutover path, run once. Every row of the Retention sheet becomes a cycle-1
 * lead carrying the callback the desk already promised, so the 328 rows with a
 * `Date to be called` arrive with a real follow-up rather than as unscheduled
 * work.
 *
 * No date window applies: the point is to take the backlog as it stands,
 * including the overdue part of it, and let the desk see what it is holding. The
 * generator's grace period governs what is raised *afterwards*.
 */
export function generateRetentionBacklog(
  records: readonly (SourceRecordInput & { id: string })[],
  catalog: ProductCatalog,
): GenerationResult {
  const skipped = emptySkips();
  const drafts: LeadDraft[] = [];

  for (const record of records) {
    const product = matchProduct(catalog, record, "retention");
    if (!product.eligible) {
      skipped.ineligible_product++;
      continue;
    }
    if (!record.customerRef && !record.phone && !record.customerName) {
      skipped.no_contact_identity++;
      continue;
    }

    drafts.push({
      leadType: "retention",
      dedupKey: dedupKeyForRetention({
        customerRef: record.customerRef,
        phone: record.phone ?? record.phoneRaw,
        customerName: record.customerName,
        itemCode: record.itemCode,
        itemName: record.itemName,
        cycleNumber: 1,
        // Only consulted for a backlog row with no usable number, where the
        // invoice is the only thing separating two anonymous walk-ins.
        documentNo: record.documentNo,
      }),
      sourceRecordId: record.id,
      parentLeadId: null,
      cycleNumber: 1,
      priority: computePriority({
        leadType: "retention",
        hasPhone: Boolean(record.phone),
        followupOverdue: Boolean(record.callbackDate),
      }),
      customerRef: record.customerRef,
      customerName: record.customerName,
      phone: record.phone,
      phoneAlternates: record.phoneAlternates ?? [],
      branchNo: record.branchNo,
      city: record.city,
      facility: null,
      channel: record.channel,
      itemCode: record.itemCode,
      itemName: record.itemName,
      productFamily: product.family,
      productStrength: product.strength,
      quantity: record.quantity,
      totalValue: record.totalValue,
      documentNo: record.documentNo,
      patientId: null,
      prescriptionNo: null,
      sourceDate: record.sourceDate,
      generationReason: "Migrated from the Retention workbook",
      followupDueOn: record.callbackDate,
    });
  }

  return {
    window: { from: "1970-01-01", to: "1970-01-01" },
    drafts,
    candidates: records.length,
    skipped,
  };
}
