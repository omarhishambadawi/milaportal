/**
 * Which dispatches may never be spoken to AlShrouq about again, and why.
 *
 * Pure and dependency-free: no HTTP, no Supabase, no React, no environment, and
 * — most importantly — **no import of any transport**. That is not tidiness. A
 * module that cannot reach the network cannot be the place a network call leaks
 * out of, and this is the module every reconciliation action asks before it
 * decides whether it is allowed to contact anybody.
 *
 * ## The rule
 *
 * A delivery that has already been dealt with **outside** the automated system
 * is finished. Asking AlShrouq about it is at best pointless and at worst the
 * first half of someone deciding to send it again — and a second courier at a
 * customer's door is the one failure this whole integration is built to avoid.
 *
 * So "handled manually" is not merely a label on a resolved row. It is a
 * standing refusal, enforced at the service boundary, that survives whatever a
 * screen happens to render.
 *
 * ## Two ways a dispatch earns the refusal
 *
 *   1. **The incident list below.** Three deliveries from the 2026-09-10
 *      outage, established as manually handled by the people who handled them.
 *      Named here because the refusal has to hold *before* anyone has resolved
 *      them — the window in which an operator opening the reconciliation centre
 *      could otherwise press a lookup button.
 *
 *   2. **A `handled_manually` resolution.** Once the outcome is recorded, the
 *      rule generalises: any dispatch settled that way is blocked from external
 *      contact from then on, with no list to maintain.
 *
 * The first exists to cover the gap before the second is true. Neither replaces
 * the other.
 */

import type { AlShrouqResolutionOutcome } from "./alshrouq-resolution";

/**
 * The 2026-09-10 deliveries that were dealt with by hand.
 *
 * `client_order_id` is the order's `display_no` without the `#`, which is the
 * identifier the people who handled these used when they said so. The dispatch
 * uuids are listed beside them because an id a human transcribed is an id a
 * human can mistype, and either one matching is enough to refuse.
 *
 * This list only ever grows by somebody establishing a fact about a real
 * delivery. It is deliberately source rather than configuration: a refusal that
 * protects a customer from a second driver should not be editable by anything
 * that can write to a table.
 */
export const MANUALLY_HANDLED_DISPATCHES: readonly {
  clientOrderId: string;
  dispatchId: string;
}[] = [
  { clientOrderId: "12389", dispatchId: "d0497719-c2dc-4e21-a4ec-9477dea4dd28" },
  { clientOrderId: "12422", dispatchId: "16763352-39b1-45b4-a1cc-09cb66868fd1" },
  { clientOrderId: "12428", dispatchId: "24e1be2d-3f4c-465d-a879-9183ad262638" },
] as const;

const BLOCKED_CLIENT_ORDER_IDS = new Set(MANUALLY_HANDLED_DISPATCHES.map((d) => d.clientOrderId));
const BLOCKED_DISPATCH_IDS = new Set(MANUALLY_HANDLED_DISPATCHES.map((d) => d.dispatchId));

/** Is this one of the deliveries the incident established as handled by hand? */
export function isManuallyHandledDispatch(ref: {
  clientOrderId?: string | null;
  dispatchId?: string | null;
}): boolean {
  const client = typeof ref.clientOrderId === "string" ? ref.clientOrderId.trim() : "";
  const dispatch = typeof ref.dispatchId === "string" ? ref.dispatchId.trim().toLowerCase() : "";
  return BLOCKED_CLIENT_ORDER_IDS.has(client) || BLOCKED_DISPATCH_IDS.has(dispatch);
}

/**
 * May anything at all be sent to AlShrouq about this dispatch?
 *
 * The single question every reconciliation action asks. It is deliberately
 * phrased about *contact* rather than about lookup or retry, because the
 * distinction between a safe read and an unsafe write is not the one that
 * matters here: for a delivery somebody has already handled, there is nothing
 * to learn and nothing to do, and the safest number of requests is none.
 *
 * Defaults to refusing. An unreadable outcome, a missing id, a row shape this
 * function does not recognise — every one of those returns `true`, because the
 * cost of wrongly refusing is an operator picking up a telephone and the cost
 * of wrongly permitting is a second driver.
 */
export function isExternalContactBlocked(ref: {
  clientOrderId?: string | null;
  dispatchId?: string | null;
  resolutionOutcome?: string | null;
}): boolean {
  if (isManuallyHandledDispatch(ref)) return true;
  return ref.resolutionOutcome === "handled_manually";
}

/** What an operator is told instead of a result. Names no credential and no customer. */
export const EXTERNAL_CONTACT_BLOCKED_MESSAGE =
  "This delivery was handled manually, outside the automated system. " +
  "Nothing is sent to AlShrouq about it — record the outcome here instead.";

/**
 * The badge wording, and the words it must not use.
 *
 * "Handled manually — no automated dispatch required" says what happened and
 * what did not. It must never be softened into anything that could be read as
 * the automated dispatch having worked: for 12389 no request ever left the
 * machine, and a screen implying otherwise is how a real delivery gets
 * forgotten.
 */
export const MANUALLY_HANDLED_BADGE = "Handled manually — no automated dispatch required";

/**
 * Is external contact permitted for a row, given everything known about it?
 *
 * The inverse of `isExternalContactBlocked`, plus the two conditions that make
 * a lookup meaningful at all: there has to be a reference to look up, and the
 * row has to be one the machine gave up on. Named separately because this is
 * the question the UI asks when deciding whether to offer a button, and the
 * answer should read as a permission rather than as the absence of a refusal.
 */
export function canLookUpExternally(row: {
  clientOrderId?: string | null;
  dispatchId?: string | null;
  resolutionOutcome?: string | null;
  dispatchStatus?: string | null;
}): boolean {
  if (isExternalContactBlocked(row)) return false;
  if (typeof row.clientOrderId !== "string" || row.clientOrderId.trim().length === 0) return false;
  return row.dispatchStatus === "indeterminate" || row.dispatchStatus === "failed";
}

/**
 * Does a recorded outcome contradict what the row itself says happened?
 *
 * ## Why this exists
 *
 * On 2026-09-12, between 01:06 and 01:07, all three of the manually-handled
 * deliveries above were resolved as **`delivered`** — the outcome whose own
 * explanation reads "AlShrouq confirmed the delivery exists and was completed".
 * For 12389 that cannot be true: `attempt_count` is 0, no request ever left the
 * machine, and AlShrouq was never asked about it. The audit trail now asserts a
 * courier delivery that nobody obtained a confirmation for.
 *
 * `resolveAlShrouqDispatch` will not overwrite an existing answer — deliberately,
 * because a second operator silently replacing the first one's account is the
 * one thing an audit record must never allow — so the contradiction cannot be
 * papered over, and should not be. It can be *shown*.
 *
 * This is a read. It changes nothing, corrects nothing, and accuses nobody. It
 * puts the disagreement in front of the person who can settle it, which is the
 * only honest thing a machine can do with a human record it has reason to doubt.
 *
 * Returns the sentence to show, or `null` when the record and the evidence agree.
 */
export function describeEvidenceConflict(row: {
  clientOrderId?: string | null;
  dispatchId?: string | null;
  resolutionOutcome?: string | null;
  /** From `attempt_count`: 0 means no terminal write ran, so nothing was sent. */
  attemptCount?: number | null;
  dispatchStatus?: string | null;
}): string | null {
  const outcome = row.resolutionOutcome;
  if (!outcome) return null;

  // Only the two outcomes that assert the courier did or did not do something
  // can conflict with the evidence. `undetermined` and `handled_manually`
  // assert nothing about AlShrouq, so nothing can contradict them.
  const claimsCourierConfirmation = outcome === "delivered" || outcome === "not_delivered";
  if (!claimsCourierConfirmation) return null;

  if (isManuallyHandledDispatch(row)) {
    return (
      `Recorded as "${outcome === "delivered" ? "confirmed delivered" : "confirmed not delivered"}", ` +
      "but this delivery was handled manually and AlShrouq was never asked about it. " +
      "The record claims a courier confirmation that could not have been obtained."
    );
  }

  /*
   * `attempt_count` is 0 only on a row settled by `reapStaleClaims` — the run
   * died between claiming the row and writing any outcome, which is the
   * signature of a failure before transmission. A `delivered` on top of that is
   * a delivery recorded for a request that never left.
   */
  if (row.dispatchStatus === "indeterminate" && row.attemptCount === 0 && outcome === "delivered") {
    return (
      "Recorded as confirmed delivered, but no request ever reached AlShrouq — " +
      "the attempt counter shows the dispatch stopped before it was sent."
    );
  }

  return null;
}

/**
 * The outcomes an operator may choose **without** having contacted AlShrouq.
 *
 * Every other outcome's explanation asserts something the courier confirmed, so
 * offering one of those for a blocked dispatch would invite an operator to
 * record a confirmation they were forbidden from obtaining.
 */
export const OFFLINE_RESOLUTION_OUTCOMES: readonly AlShrouqResolutionOutcome[] = [
  "handled_manually",
] as const;
