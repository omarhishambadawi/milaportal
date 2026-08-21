/**
 * Resolving a dispatch nobody can settle automatically — the rules, in one pure
 * module.
 *
 * No HTTP, no Supabase, no React, no environment. It answers what may be
 * resolved, what a person may say about it, and what each answer is called on
 * screen. Every caller — the server function, the card, the timeline — asks here
 * rather than writing its own comparison, for the same reason
 * `alshrouq-dispatch-state.ts` exists.
 *
 * ## This is reconciliation, not resending
 *
 * Nothing in this file, or in anything that uses it, contacts AlShrouq. A
 * resolution records what a human found out after ringing the courier; it does
 * not act on it. There is no "retry" outcome and no code path from any outcome
 * to the transport — an `indeterminate` dispatch may already have a driver on
 * the road, which is exactly why the machine refuses to guess and exactly why
 * the human's answer is a *record* rather than an instruction.
 *
 * ## Three vocabularies that must not merge
 *
 *   `status`             AlShrouq's own word, verbatim.       Courier truth.
 *   `dispatch_status`    this system's lifecycle.             Machine truth.
 *   `resolution_outcome` what a person established after.     Operator truth.
 *
 * A resolution never overwrites `dispatch_status`. A resolved row stays
 * `indeterminate` or `failed`, because that is what the machine actually
 * observed, and it keeps owning the order's dispatch slot.
 */

/** What an operator can conclude. Deliberately none of them is "retry". */
export type AlShrouqResolutionOutcome = "delivered" | "not_delivered" | "undetermined";

export const ALSHROUQ_RESOLUTION_OUTCOMES: readonly AlShrouqResolutionOutcome[] = [
  "delivered",
  "not_delivered",
  "undetermined",
] as const;

/**
 * The only two lifecycle states a person may resolve.
 *
 * `scheduled` and `processing` are not settled yet — there is nothing to
 * reconcile and the worker still owns them. `accepted` is already known.
 * `cancelled` never happened. Only the two states the machine gave up on are
 * open to a human answer.
 */
export const ALSHROUQ_RESOLVABLE_STATUSES = ["indeterminate", "failed"] as const;

export function isResolutionOutcome(value: unknown): value is AlShrouqResolutionOutcome {
  return (
    typeof value === "string" && (ALSHROUQ_RESOLUTION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * May this dispatch be resolved?
 *
 * Both halves matter. The state must be one the machine gave up on, and the row
 * must not already carry an answer — a second resolution would overwrite the
 * first operator's account of what happened, which is the one thing an audit
 * record must never allow.
 */
export function canResolveDispatch(
  status: string | null | undefined,
  existingOutcome: string | null | undefined = null,
): boolean {
  if (existingOutcome != null && existingOutcome !== "") return false;
  return (ALSHROUQ_RESOLVABLE_STATUSES as readonly string[]).includes(status ?? "");
}

/** Why a resolution was refused, in the wording the UI shows. */
export function describeResolveRefusal(
  status: string | null | undefined,
  existingOutcome: string | null | undefined = null,
): string {
  if (existingOutcome != null && existingOutcome !== "") {
    return "This dispatch has already been resolved.";
  }
  switch (status) {
    case "scheduled":
      return "This delivery has not been sent yet, so there is nothing to resolve.";
    case "processing":
      return "This dispatch is still being processed. Wait for it to settle.";
    case "accepted":
      return "AlShrouq accepted this delivery, so its outcome is already known.";
    case "cancelled":
      return "This delivery was cancelled before dispatch, so there is nothing to resolve.";
    default:
      return "This dispatch is not in a state that can be resolved.";
  }
}

/** The operator-facing name of each answer. */
export function describeResolutionOutcome(outcome: AlShrouqResolutionOutcome): string {
  switch (outcome) {
    case "delivered":
      return "Confirmed delivered";
    case "not_delivered":
      return "Confirmed not delivered";
    case "undetermined":
      return "Unable to determine";
  }
}

/** The line under each option: what choosing it actually means. */
export function explainResolutionOutcome(outcome: AlShrouqResolutionOutcome): string {
  switch (outcome) {
    case "delivered":
      return "AlShrouq confirmed the delivery exists and was completed.";
    case "not_delivered":
      return "AlShrouq confirmed no delivery was created for this order.";
    case "undetermined":
      return "The outcome could not be established even after checking with AlShrouq.";
  }
}

/**
 * The warning shown above the choice, per source state.
 *
 * Both sentences end the same way on purpose. The single most damaging
 * misreading of this screen would be an operator believing that recording an
 * answer also does something about it.
 */
export function resolutionWarningFor(status: string | null | undefined): string {
  return status === "failed"
    ? "The delivery attempt failed. This action records the reviewed outcome and will not retry automatically."
    : "The courier outcome could not be confirmed. This action records an operator decision only and will not resend the delivery.";
}

/** The `order_activity.action` this workflow writes. */
export const RESOLUTION_ACTIVITY_ACTION = "alshrouq_dispatch_resolved";

/**
 * The operator's note, bounded.
 *
 * Required: the note *is* the evidence. "AlShrouq confirmed by phone, ref
 * 6099196" is the whole content of the decision, and a resolution with no
 * account of how it was reached is an unsourced claim in an audit trail.
 *
 * Trimmed and capped, and otherwise stored as written — it is the operator's own
 * words and they are accountable for them. It is *not* a place for customer
 * contact details; the note is rendered on the order timeline, which is exactly
 * where a pasted phone number would end up living.
 */
export const RESOLUTION_NOTE_MAX = 280;

export function normaliseResolutionNote(note: string): string {
  return note.trim().slice(0, RESOLUTION_NOTE_MAX);
}

export function isValidResolutionNote(note: string): boolean {
  const trimmed = note.trim();
  return trimmed.length >= 3 && trimmed.length <= RESOLUTION_NOTE_MAX;
}
