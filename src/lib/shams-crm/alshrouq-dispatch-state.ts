/**
 * The AlShrouq dispatch state machine, as one set of rules.
 *
 * Pure and dependency-free: no HTTP, no Supabase, no React, no environment. It
 * answers four questions about a stored `dispatch_status`, and every caller that
 * needs one of those answers asks here rather than writing its own comparison.
 *
 * That is the whole point. These rules were previously spread across a duplicate
 * check, a worker query, a claim predicate and a piece of UI, each stating the
 * lifecycle in its own words — and the states where they must agree are exactly
 * the states where disagreeing puts a second driver at a customer's door.
 *
 * ## The lifecycle
 *
 * ```
 *   scheduled ──claim──> processing ──> accepted | failed | indeterminate
 *       │
 *       └──cancel──> cancelled
 * ```
 *
 * An immediate dispatch skips the first two and is written straight to
 * `accepted` or `indeterminate`.
 *
 * ## The one rule that matters
 *
 * A row that is not cancelled **owns its order's dispatch slot**, and while it
 * does, nothing may send that order again. That is not merely this module's
 * opinion: it is the predicate of the unique index
 * `alshrouq_dispatches_live_order_key` (`UNIQUE (order_id) WHERE cancelled_at IS
 * NULL`), so the application and the database cannot disagree about it.
 *
 * `indeterminate` owns the slot too, and that is the case this exists for. An
 * uncertain result means the courier may already be moving; treating it as
 * "nothing happened, try again" is the single most damaging thing the Portal
 * could do.
 */

/** The lifecycle, exactly as the database's CHECK constraint stores it. */
export type AlShrouqDispatchStatus =
  | "scheduled"
  | "processing"
  | "accepted"
  | "failed"
  | "indeterminate"
  | "cancelled";

/** Every legal value, for exhaustive tests and for validating stored text. */
export const ALSHROUQ_DISPATCH_STATUSES: readonly AlShrouqDispatchStatus[] = [
  "scheduled",
  "processing",
  "accepted",
  "failed",
  "indeterminate",
  "cancelled",
] as const;

export function isAlShrouqDispatchStatus(value: unknown): value is AlShrouqDispatchStatus {
  return (
    typeof value === "string" && (ALSHROUQ_DISPATCH_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Does a row in this state still own its order's dispatch slot?
 *
 * True for everything except `cancelled` — the same predicate as the unique
 * index. An unknown or malformed value counts as owning the slot: if the Portal
 * cannot tell what state a dispatch is in, the safe reading is that one exists.
 */
export function ownsDispatchSlot(status: string | null | undefined): boolean {
  return status !== "cancelled";
}

/**
 * May a new courier request be issued for an order that currently has this row?
 *
 * The inverse of `ownsDispatchSlot`, named separately because this is the
 * question the dispatch service and the UI actually ask, and the answer should
 * read as a refusal rather than as a property of a slot.
 *
 * **`failed` blocks.** That is the existing scheduler semantics, preserved
 * deliberately: a failed row is one AlShrouq refused, and this codebase has no
 * retry policy. Inventing one here would be inventing a resend workflow nobody
 * designed. Resolving a failed dispatch is a human action, and there is no
 * automatic path out of it.
 *
 * **`cancelled` does not block**, and it is safe that it does not: a dispatch
 * can only be cancelled while it is `scheduled` (see `canCancelDispatch`), so a
 * cancelled row is always one that never contacted anybody. The partial unique
 * index was built for exactly this — "a cancelled one no longer counts, so a
 * mistaken dispatch can be cancelled and re-sent".
 */
export function blocksNewDispatch(status: string | null | undefined): boolean {
  return ownsDispatchSlot(status);
}

/**
 * May this dispatch be cancelled?
 *
 * **Only `scheduled`.** A parked dispatch has contacted nobody, so calling it
 * off costs nothing and tells no one. Every other state is refused:
 *
 *   * `processing` — a worker has claimed the row and may be mid-request.
 *     Cancelling it would mark a dispatch cancelled that could already exist.
 *   * `accepted` — the courier has it. Cancelling here would be a Portal
 *     row saying a delivery is off while a driver is on the way; a real
 *     cancellation would have to be negotiated with AlShrouq, and this
 *     integration has no such endpoint.
 *   * `indeterminate` — the outcome is unknown, which is precisely when
 *     recording "cancelled" would be a claim nobody can support.
 *   * `failed` — nothing to call off, and cancelling would silently free the
 *     slot for a resend without anyone deciding to resend.
 *   * `cancelled` — already done.
 */
export function canCancelDispatch(status: string | null | undefined): boolean {
  return status === "scheduled";
}

/**
 * May the due worker claim this row?
 *
 * Only `scheduled`, which is also the compare-and-swap's own predicate. A
 * cancelled row can never be claimed, because `cancelled` is not `scheduled` —
 * the cancellation and the claim compete for the same transition and Postgres
 * serialises them, so exactly one wins.
 */
export function isWorkerClaimable(status: string | null | undefined): boolean {
  return status === "scheduled";
}

/**
 * Is this a state nothing moves out of on its own?
 *
 * `indeterminate` is terminal **and never automatically retried**: the request
 * was transmitted and the outcome is unknown, so the only safe next step is a
 * person reading it. There is no code path that re-POSTs it.
 */
export function isTerminalDispatchStatus(status: string | null | undefined): boolean {
  return (
    status === "accepted" ||
    status === "failed" ||
    status === "indeterminate" ||
    status === "cancelled"
  );
}

/**
 * Why a cancellation was refused, in the vocabulary the UI shows.
 *
 * Kept beside the rule it explains so a new state cannot be added to the
 * lifecycle without a sentence for it.
 */
export function describeCancelRefusal(status: string | null | undefined): string {
  switch (status) {
    case "processing":
      return "Dispatch is already being processed and cannot be cancelled.";
    case "accepted":
      return "This order has already been sent to AlShrouq and cannot be cancelled here.";
    case "indeterminate":
      return "This dispatch is awaiting review and cannot be cancelled until it is resolved.";
    case "failed":
      return "This dispatch has already failed, so there is nothing to cancel.";
    case "cancelled":
      return "This dispatch was already cancelled.";
    default:
      return "This dispatch is not scheduled, so it cannot be cancelled.";
  }
}
