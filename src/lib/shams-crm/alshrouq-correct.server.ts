/**
 * Correcting one wrong resolution, and nothing else. Server-only.
 *
 * ## Why this is separate from `alshrouq-resolve.server.ts`
 *
 * `resolveAlShrouqDispatch` refuses to touch a row that already carries an
 * answer, and that refusal is load-bearing: a second operator silently
 * overwriting the first one's account is the one thing an audit record must
 * never allow. Loosening it would have made every resolution editable in order
 * to fix three of them.
 *
 * So this is a different operation with a different name and a much narrower
 * door. It performs exactly one transition — `delivered` → `handled_manually` —
 * on exactly the rows whose recorded outcome the evidence already contradicts.
 * Everything else about resolution is untouched.
 *
 * ## What went wrong, and why this is a correction rather than a decision
 *
 * Three dispatches from the 2026-09-10 outage were recorded as `delivered`,
 * whose own wording is "AlShrouq confirmed the delivery exists and was
 * completed". AlShrouq was never asked about any of them — they were handled by
 * hand, under a standing instruction that nothing be sent to the courier about
 * them — and for 12389 no request had ever left the machine at all
 * (`attempt_count = 0`).
 *
 * That is not a judgement call an operator got wrong. It is a claim the row's
 * own columns contradict, which is why the eligibility test is the evidence
 * conflict itself rather than a list of ids retyped here.
 *
 * ## It contacts nobody
 *
 * There is no transport in this module and there must never be one. It does not
 * import `createAlshrouqOrder`, it does not import
 * `findAlshrouqOrderByClientOrderId`, it imports no CRM client, and it makes no
 * request of any kind. A correction is a statement about what this system
 * recorded — asking AlShrouq about it is precisely what these three dispatches
 * are barred from.
 *
 * ## What it writes, and what it deliberately leaves alone
 *
 * It changes four columns on the dispatch row — the outcome, the reason, and who
 * corrected it when — and appends one `order_activity` entry. It does **not**
 * touch `dispatch_status`, `cancelled_at`, `attempt_count`, `last_attempt_at`,
 * `last_error`, or anything at all on `orders`. The machine's observation stands;
 * only the operator's conclusion about it changes.
 *
 * Because `cancelled_at` stays null the row keeps the order's slot in
 * `alshrouq_dispatches_live_order_key`, so nothing here frees an order for a
 * fresh courier request.
 *
 * ## The original is not overwritten
 *
 * The `alshrouq_dispatch_resolved` entry that recorded `delivered` stays exactly
 * where it is, with its own actor, timestamp and note. This appends a second,
 * differently-named entry carrying the previous outcome, the previous author and
 * the previous timestamp beside the new ones — so the log reads as a history
 * rather than as a value that has always been what it now says.
 */

import {
  CORRECTABLE_FROM_OUTCOME,
  CORRECTION_TARGET_OUTCOME,
  RESOLUTION_CORRECTION_ACTIVITY_ACTION,
  normaliseResolutionNote,
} from "./alshrouq-resolution";
import { describeEvidenceConflict } from "./alshrouq-reconciliation";

interface SupabaseLike {
  from: (table: string) => any;
}

export type CorrectResolutionResult =
  /** Corrected. Nothing was sent, and the original entry is still in the log. */
  | { kind: "corrected"; correctedAt: string; previousOutcome: string }
  /** No such dispatch, or not one this caller may see. */
  | { kind: "not_found" }
  /**
   * The row is not one this operation may touch, and `message` says why. Covers
   * an unresolved row, an outcome that is not `delivered`, a row already
   * corrected, and — the important one — a `delivered` whose evidence does not
   * contradict it.
   */
  | { kind: "ineligible"; message: string };

export interface CorrectResolutionInput {
  dispatchId: string;
  /** The operator's account of why. Required, and validated upstream. */
  reason: string;
  /** The **verified** caller, from the session's claims. Never from a browser. */
  correctedBy: string;
}

/** The columns the eligibility test reads. Deliberately not a generated row type. */
interface CorrectableRow {
  id: string;
  order_id: string;
  client_order_id: string | null;
  dispatch_status: string | null;
  resolution_outcome: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  attempt_count: number | null;
}

/**
 * Correct one dispatch's recorded outcome.
 *
 * `supabase` must be the service-role client: `alshrouq_dispatches` carries a
 * single `SELECT` policy and no write policy, so every write to it comes from
 * code that has already decided the caller may make it. The caller's own client
 * does the visibility read in the server function above this one.
 */
export async function correctAlShrouqResolutionToHandledManually(
  input: CorrectResolutionInput,
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<CorrectResolutionResult> {
  const correctedAt = now.toISOString();

  const { data: row } = await supabase
    .from("alshrouq_dispatches")
    .select(
      "id,order_id,client_order_id,dispatch_status,resolution_outcome," +
        "resolution_note,resolved_at,resolved_by,attempt_count",
    )
    .eq("id", input.dispatchId)
    .maybeSingle();

  const current = (row ?? null) as CorrectableRow | null;
  if (!current) return { kind: "not_found" };

  /*
   * Four gates, and the fourth is the one that matters.
   *
   * The first three are cheap facts about the row. The fourth asks whether the
   * evidence actually contradicts what was recorded — and it is what stops this
   * operation from being a general "mark it handled manually" button. An
   * ordinary `delivered`, recorded by an operator who really did ring AlShrouq,
   * has no conflict and is refused here.
   */
  if (!current.resolution_outcome) {
    return {
      kind: "ineligible",
      message: "This dispatch has no recorded outcome, so there is nothing to correct.",
    };
  }

  if (current.resolution_outcome === CORRECTION_TARGET_OUTCOME) {
    return {
      kind: "ineligible",
      message: "This dispatch is already recorded as handled manually.",
    };
  }

  if (current.resolution_outcome !== CORRECTABLE_FROM_OUTCOME) {
    return {
      kind: "ineligible",
      message:
        `Only a dispatch recorded as "${CORRECTABLE_FROM_OUTCOME}" can be corrected here, ` +
        `and this one is recorded as "${current.resolution_outcome}".`,
    };
  }

  const conflict = describeEvidenceConflict({
    clientOrderId: current.client_order_id,
    dispatchId: current.id,
    resolutionOutcome: current.resolution_outcome,
    attemptCount: current.attempt_count,
    dispatchStatus: current.dispatch_status,
  });
  if (!conflict) {
    return {
      kind: "ineligible",
      message:
        "This dispatch's recorded outcome does not contradict its evidence, so it is not " +
        "a correction this operation may make.",
    };
  }

  /*
   * The compare-and-swap.
   *
   * `resolution_outcome = 'delivered'` is the guard, so two operators correcting
   * at once produce exactly one correction and one honest refusal — the second
   * finds the row already at `handled_manually` and matches nothing. There is no
   * read-then-write window for a concurrent transaction to slip between, because
   * the predicate is evaluated by the same statement that writes.
   *
   * The patch is exactly four columns. `dispatch_status`, `cancelled_at`,
   * `attempt_count`, `last_attempt_at` and `last_error` are all absent on
   * purpose: the machine's record of what happened is not the operator's to
   * revise, and the order's dispatch slot must stay held.
   */
  const { data: corrected } = await supabase
    .from("alshrouq_dispatches")
    .update({
      resolution_outcome: CORRECTION_TARGET_OUTCOME,
      resolution_note: normaliseResolutionNote(input.reason),
      resolved_at: correctedAt,
      resolved_by: input.correctedBy,
    })
    .eq("id", input.dispatchId)
    .eq("resolution_outcome", CORRECTABLE_FROM_OUTCOME)
    .select("id,order_id")
    .maybeSingle();

  if (!corrected) {
    // Lost the race, or the row moved under us. Never retried, never forced.
    return {
      kind: "ineligible",
      message: "This dispatch was changed by someone else. Reload and check its current outcome.",
    };
  }

  /*
   * The audit entry, appended beside the original rather than replacing it.
   *
   * Everything a reader needs to reconstruct the change without consulting the
   * row: what it was, what it became, who did each, when, and why. And the one
   * sentence that is the whole point of the correction — that no courier
   * confirmation was used, because none was ever obtained.
   *
   * No payload, no customer identity, no courier response body. This function
   * does not read any of them.
   */
  await supabase.from("order_activity").insert({
    order_id: corrected.order_id,
    actor_id: input.correctedBy,
    action: RESOLUTION_CORRECTION_ACTIVITY_ACTION,
    details: {
      previous_outcome: CORRECTABLE_FROM_OUTCOME,
      corrected_outcome: CORRECTION_TARGET_OUTCOME,
      previous_note: current.resolution_note,
      previous_resolved_at: current.resolved_at,
      previous_resolved_by: current.resolved_by,
      reason: normaliseResolutionNote(input.reason),
      dispatch_id: current.id,
      dispatch_status: current.dispatch_status,
      /** The finding that made the row correctable, stored as it was read. */
      evidence_conflict: conflict,
      /**
       * Stated in the record, not merely true of the code.
       *
       * An auditor reading this entry should not have to take it on trust that a
       * correction to "handled manually" involved no courier contact.
       */
      external_confirmation_used: false,
    },
  });

  return { kind: "corrected", correctedAt, previousOutcome: CORRECTABLE_FROM_OUTCOME };
}
