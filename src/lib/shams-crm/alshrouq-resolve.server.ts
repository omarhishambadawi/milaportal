/**
 * Recording what a person found out about a stuck dispatch. Server-only.
 *
 * ## It contacts nobody
 *
 * There is no transport in this module and there must never be one. It does not
 * import `createAlshrouqOrder`, it makes no request of any kind, and no outcome
 * — not "confirmed not delivered", not "unable to determine" — has a branch that
 * sends anything. The whole point is that the machine has stopped guessing and a
 * human is writing down the answer.
 *
 * That is also why the action is called *resolve* and never *retry*. An
 * `indeterminate` dispatch may already have a driver on the road; the one thing
 * that must not follow it is another POST.
 *
 * ## What it changes, and what it deliberately does not
 *
 * It writes four columns — outcome, when, who, and the operator's account — and
 * nothing else. In particular it does **not** touch `dispatch_status`: a
 * resolved row stays `indeterminate` or `failed`, because that is what the
 * machine observed, and an operator's conclusion does not get to overwrite the
 * record of what the courier actually said.
 *
 * It also does not write `cancelled_at`, so the row keeps the order's slot in
 * `alshrouq_dispatches_live_order_key` and the order stays unsendable. Recording
 * what happened and re-authorising a delivery are separate decisions; this is
 * only the first.
 *
 * ## The race
 *
 * The update is a compare-and-swap guarded on both halves of "resolvable": the
 * status is still one the machine gave up on, and no answer has been recorded
 * yet. Two operators resolving at once therefore produce exactly one resolution
 * and one honest conflict — the second is never allowed to overwrite the first
 * operator's account of what happened.
 *
 * The guard is disjoint from the worker's claim (`dispatch_status='scheduled'`)
 * and from cancellation (also `'scheduled'`), so those cannot collide with this
 * at all: a row is either still in play or has been given up on, never both.
 */

import {
  RESOLUTION_ACTIVITY_ACTION,
  canResolveDispatch,
  describeResolveRefusal,
  normaliseResolutionNote,
  type AlShrouqResolutionOutcome,
} from "./alshrouq-resolution";

interface SupabaseLike {
  from: (table: string) => any;
}

export type ResolveDispatchResult =
  /** Recorded. Nothing was sent and nothing will be. */
  | { kind: "resolved"; outcome: AlShrouqResolutionOutcome; resolvedAt: string }
  /** No such dispatch, or not one this caller may see. */
  | { kind: "not_found" }
  /** Someone got there first. Their answer stands. */
  | { kind: "already_resolved" }
  /** The dispatch is not in a state a person may resolve. */
  | { kind: "conflict"; status: string | null; message: string };

export interface ResolveDispatchInput {
  dispatchId: string;
  outcome: AlShrouqResolutionOutcome;
  /** The operator's account of how they established it. Required upstream. */
  note: string;
  /** The **verified** caller, from the session's claims. Never from a browser. */
  resolvedBy: string;
}

/**
 * Resolve one stuck dispatch.
 *
 * `supabase` must be the service-role client: `alshrouq_dispatches` carries a
 * single RLS policy (`SELECT`) and no write policy, so every write to it goes
 * through code that has already decided the caller may make it. The caller's own
 * client does the visibility read in the server function above this one.
 */
export async function resolveAlShrouqDispatch(
  input: ResolveDispatchInput,
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<ResolveDispatchResult> {
  const resolvedAt = now.toISOString();

  /*
   * The compare-and-swap.
   *
   * `.in(dispatch_status, [...])` is the state guard and
   * `.is(resolution_outcome, null)` is the first-writer guard. Postgres
   * serialises two updates to one row, so the second finds `resolution_outcome`
   * already set and matches nothing.
   */
  const { data: resolved } = await supabase
    .from("alshrouq_dispatches")
    .update({
      resolution_outcome: input.outcome,
      resolved_at: resolvedAt,
      resolved_by: input.resolvedBy,
      resolution_note: normaliseResolutionNote(input.note),
    })
    .eq("id", input.dispatchId)
    .in("dispatch_status", ["indeterminate", "failed"])
    .is("resolution_outcome", null)
    .select("id,order_id,dispatch_status")
    .maybeSingle();

  if (resolved) {
    /*
     * The audit event, on the order's own history.
     *
     * This is a *person's* action, so it belongs in `order_activity` beside
     * every other human act on the order — unlike the worker's states, which are
     * derived from the dispatch row precisely so the worker keeps touching one
     * table. Writing it here does not weaken that: the worker is not what runs
     * this code.
     *
     * The details carry the outcome, the operator's note and the dispatch's
     * lifecycle state. They carry no customer identity, no payload snapshot and
     * no courier response body — none of which this function even reads.
     */
    await supabase.from("order_activity").insert({
      order_id: resolved.order_id,
      actor_id: input.resolvedBy,
      action: RESOLUTION_ACTIVITY_ACTION,
      details: {
        outcome: input.outcome,
        note: normaliseResolutionNote(input.note),
        dispatch_status: resolved.dispatch_status,
      },
    });

    return { kind: "resolved", outcome: input.outcome, resolvedAt };
  }

  /*
   * Nothing was updated. Read the row to say why — a refusal that explains
   * itself is the difference between an operator correcting course and an
   * operator clicking again.
   */
  const { data: current } = await supabase
    .from("alshrouq_dispatches")
    .select("dispatch_status,resolution_outcome")
    .eq("id", input.dispatchId)
    .maybeSingle();

  if (!current) return { kind: "not_found" };
  if (current.resolution_outcome) return { kind: "already_resolved" };

  const status = (current.dispatch_status ?? null) as string | null;
  return {
    kind: "conflict",
    status,
    // The state machine's own sentence, so the screen and the service agree.
    message: canResolveDispatch(status, current.resolution_outcome)
      ? "This dispatch could not be resolved."
      : describeResolveRefusal(status, current.resolution_outcome),
  };
}
