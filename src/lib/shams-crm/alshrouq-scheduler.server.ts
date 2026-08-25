/**
 * Scheduled AlShrouq dispatch: parking a courier handoff, and performing it
 * later without anyone's browser being open. Server-only.
 *
 * ## The two halves
 *
 *   `scheduleAlShrouqDispatch` — runs when the agent approves the order. It
 *   validates exactly as an immediate send would, then writes one row holding
 *   the approved payload and the time it is due. It contacts nobody.
 *
 *   `runDueAlShrouqDispatches` — runs from `pg_cron`, every minute, via
 *   `alshrouq_dispatch_due()` → `net.http_post` → the scheduler route. It claims
 *   due rows and sends them.
 *
 * ## Why the snapshot exists
 *
 * The worker never reads the order. It reads `payload_snapshot`, written when
 * the agent said yes.
 *
 * A dispatch that rebuilt itself from `orders` at 2am would tell a courier
 * whatever the row said by then — a phone corrected after the fact, a branch
 * changed by someone tidying up — and nobody would have approved that. The
 * snapshot means the delivery that happens is the delivery that was authorised,
 * and it is why editing a Portal order after scheduling changes nothing about
 * what AlShrouq is told.
 *
 * ## Claiming, and why two workers cannot collide
 *
 * A row is taken with a compare-and-swap: `UPDATE … SET status='processing'
 * WHERE id = ? AND status='scheduled'`, which Postgres serialises. The worker
 * that gets a row back owns it; the other gets nothing and moves on. If a
 * dispatch record somehow still slipped past, the unique index
 * `alshrouq_dispatches_live_order_key` is the backstop it collides with.
 *
 * ## What it does not do
 *
 * It does not retry a POST. Ever. A timeout, a 5xx or a 401 leaves the row
 * `indeterminate` after one reconciliation read, and a human resolves it. The
 * whole point of scheduling is that nobody is watching — which is exactly when
 * an automatic retry would put a second driver on the road unobserved.
 */

import {
  isAlShrouqLiveDispatchEnabled,
  prepareAlShrouqDispatch,
  type AlShrouqDispatchResult,
  type DispatchDeps,
  type DispatchRequest,
} from "./alshrouq-dispatch.server";
import {
  createAlshrouqOrder,
  findAlshrouqOrderByClientOrderId,
  newAlshrouqOperationId,
  type AlShrouqReconciledOrder,
} from "./alshrouq-create.server";
import { fetchAlShrouqDispatchOptions } from "./alshrouq-config.server";
import type { AlShrouqCreatePayload } from "./alshrouq-payload";
import {
  canCancelDispatch,
  describeCancelRefusal,
  type AlShrouqDispatchStatus as DispatchStatus,
} from "./alshrouq-dispatch-state";

/**
 * The lifecycle, as the database stores it.
 *
 * Re-exported rather than redeclared: the states and the rules about them live
 * in `alshrouq-dispatch-state.ts`, so the worker, the cancellation and the
 * duplicate check cannot end up with three slightly different ideas of what
 * `indeterminate` means.
 */
export type { AlShrouqDispatchStatus } from "./alshrouq-dispatch-state";

interface SupabaseLike {
  from: (table: string) => any;
}

const defaultDeps: DispatchDeps = {
  fetchOptions: fetchAlShrouqDispatchOptions,
  createOrder: createAlshrouqOrder,
  reconcile: findAlshrouqOrderByClientOrderId,
  newOperationId: newAlshrouqOperationId,
  liveEnabled: isAlShrouqLiveDispatchEnabled,
  agentPrincipal: async (userId) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { agentCrmPrincipal, supabaseAgentCredentialDeps } =
      await import("./agent-credentials.server");
    return agentCrmPrincipal(userId, supabaseAgentCredentialDeps(supabaseAdmin as never));
  },
};

const UNIQUE_VIOLATION = "23505";

/** How many due rows one run will take. Bounded so a backlog cannot stall it. */
const BATCH_SIZE = 25;

export type ScheduleResult =
  /** Parked. Nothing was sent; `scheduledFor` is when it will be. */
  | { kind: "scheduled"; scheduledFor: string }
  /** Anything `prepareAlShrouqDispatch` refused — invalid, uncovered branch, … */
  | AlShrouqDispatchResult;

/**
 * Park a dispatch for later.
 *
 * Validated now, deliberately: an agent scheduling an order for tonight should
 * be told about a missing phone number or an uncovered branch while they are
 * still looking at it.
 *
 * The row is written with `dispatch_status='scheduled'`, which also takes the
 * order's slot in `alshrouq_dispatches_live_order_key` — so a second schedule,
 * or an immediate send while one is pending, is refused by the database rather
 * than producing two couriers.
 */
export async function scheduleAlShrouqDispatch(
  request: DispatchRequest,
  scheduledFor: Date,
  supabase: SupabaseLike,
  overrides: Partial<DispatchDeps> = {},
): Promise<ScheduleResult> {
  const deps: DispatchDeps = { ...defaultDeps, ...overrides };

  const prepared = await prepareAlShrouqDispatch(request, supabase, deps);
  if (!("ok" in prepared)) return prepared;

  const payload = prepared.payload;
  const when = scheduledFor.toISOString();

  const row = {
    order_id: request.orderId,
    client_order_id: payload.client_order_id,
    alshrouq_branch_id: payload.branch_id,
    branch_no: request.branchNo,
    payment_type: payload.payment_type,
    value: payload.value,
    details: payload.details ?? null,
    customer_address: payload.customer_address ?? null,
    customer_lat: payload.customer_lat ?? null,
    customer_lng: payload.customer_lng ?? null,
    preparation_time: payload.preparation_time ?? null,
    dispatch_status: "scheduled" as const,
    scheduled_for: when,
    scheduled_by: request.userId,
    /**
     * Whose delivery this is, frozen beside the payload.
     *
     * The same principle as `payload_snapshot`: what goes out at 2am is what was
     * approved, decided now. Kept apart from `scheduled_by` because the two
     * answer different questions — who acted, and whose delivery it is — and a
     * supervisor scheduling an agent's order makes them different values.
     */
    crm_agent_id: request.orderAgentId,
    scheduled_at: new Date().toISOString(),
    // The whole point. Read at dispatch time instead of the order.
    payload_snapshot: payload as unknown as Record<string, unknown>,
    dispatched_by: request.userId,
  };

  const { error } = await supabase.from("alshrouq_dispatches").insert(row);

  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const { data } = await supabase
        .from("alshrouq_dispatches")
        .select("external_order_id,local_id,status,tracking_url,dispatched_at")
        .eq("order_id", request.orderId)
        .is("cancelled_at", null)
        .maybeSingle();
      return {
        kind: "already_dispatched",
        dispatch: {
          externalOrderId: data?.external_order_id ?? null,
          localId: data?.local_id ?? null,
          status: data?.status ?? null,
          trackingUrl: data?.tracking_url ?? null,
          dispatchedAt: data?.dispatched_at ?? null,
        },
      };
    }
    throw new Error("The scheduled dispatch could not be saved.");
  }

  return { kind: "scheduled", scheduledFor: when };
}

export interface RunDueSummary {
  /** Rows that were due when the run started. */
  due: number;
  claimed: number;
  accepted: number;
  failed: number;
  indeterminate: number;
  /** Due rows left untouched because the production gate is closed. */
  skippedDisabled: number;
  /**
   * Due rows returned to `scheduled` because the order agent's CRM identity
   * could not be used. Counted separately from `failed`: nothing is wrong with
   * the order, and the delivery still goes out once the link is fixed.
   */
  blocked: number;
}

interface DueRow {
  id: string;
  order_id: string;
  client_order_id: string;
  payload_snapshot: AlShrouqCreatePayload | null;
  scheduled_for: string;
  /** Who approved it. Audit only — no longer the identity it is sent under. */
  scheduled_by: string | null;
  /** The order's assigned agent. The identity this row is sent under. */
  crm_agent_id: string | null;
}

/**
 * Perform every dispatch that has come due.
 *
 * Idempotent by construction: a row is only acted on if the compare-and-swap
 * into `processing` succeeds, so running this twice concurrently — or a cron
 * firing twice — dispatches each order once.
 *
 * **The safety gate is checked before anything is claimed.** With it closed the
 * run touches nothing: rows stay `scheduled`, no request is made, no status is
 * invented, and they will be picked up whenever the gate is opened. A scheduled
 * order that quietly reported "sent" while the gate was shut would be the worst
 * possible failure, so it cannot happen.
 */
export async function runDueAlShrouqDispatches(
  supabase: SupabaseLike,
  overrides: Partial<DispatchDeps> = {},
  now: Date = new Date(),
): Promise<RunDueSummary> {
  const deps: DispatchDeps = { ...defaultDeps, ...overrides };
  const summary: RunDueSummary = {
    due: 0,
    claimed: 0,
    accepted: 0,
    failed: 0,
    indeterminate: 0,
    skippedDisabled: 0,
    blocked: 0,
  };

  const { data: dueRows } = await supabase
    .from("alshrouq_dispatches")
    // `crm_agent_id` is read because it *is* the identity this row will be sent
    // under: the agent the order was assigned to when it was approved is who the
    // CRM must record. `scheduled_by` comes too, as the fallback for rows
    // written before the two were told apart.
    .select("id,order_id,client_order_id,payload_snapshot,scheduled_for,scheduled_by,crm_agent_id")
    .eq("dispatch_status", "scheduled")
    .is("cancelled_at", null)
    .lte("scheduled_for", now.toISOString())
    .limit(BATCH_SIZE);

  const due = (dueRows ?? []) as DueRow[];
  summary.due = due.length;
  if (due.length === 0) return summary;

  if (!deps.liveEnabled()) {
    summary.skippedDisabled = due.length;
    return summary;
  }

  for (const row of due) {
    // Compare-and-swap. Losing the race is normal and silent.
    const { data: claimed } = await supabase
      .from("alshrouq_dispatches")
      .update({
        dispatch_status: "processing",
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("dispatch_status", "scheduled")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;
    summary.claimed += 1;

    const payload = row.payload_snapshot;
    if (!payload || typeof payload !== "object") {
      // Nothing approved, nothing to send. Never reconstructed from the order.
      await supabase
        .from("alshrouq_dispatches")
        .update({
          dispatch_status: "failed",
          last_error: "The approved dispatch details are missing.",
          attempt_count: 1,
        })
        .eq("id", row.id);
      summary.failed += 1;
      continue;
    }

    /*
     * Whose delivery this is, read from the row rather than from the order.
     *
     * The order's agent was recorded in `crm_agent_id` when the dispatch was
     * approved, and that frozen value is what the worker logs in as — an
     * ordinary immediate create, so from the CRM's side it is indistinguishable
     * from that agent having typed it at this moment. The order itself is never
     * re-read here, for the same reason `payload_snapshot` exists: what goes out
     * is what was approved, not what the row has since become.
     *
     * `scheduled_by` is the fallback, and only for rows written before the two
     * were distinguished — where an agent approving their own order made them
     * the same value anyway.
     *
     * If the credential is gone, the row goes **back to `scheduled`** with the
     * reason recorded. It is not sent under the service account and not under
     * anybody else: a delivery attributed to the wrong person is worse than a
     * late one, and the schedule survives so it goes out once an administrator
     * fixes the link.
     */
    const attributedTo = row.crm_agent_id ?? row.scheduled_by;
    const identity = attributedTo ? await deps.agentPrincipal(attributedTo) : null;
    if (!identity || !identity.ok) {
      await supabase
        .from("alshrouq_dispatches")
        .update({
          dispatch_status: "scheduled",
          last_error: identity
            ? `Blocked: the order agent's Shams CRM account is unavailable (${identity.problem}).`
            : "Blocked: this dispatch has no recorded agent to send it as.",
        })
        .eq("id", row.id);
      summary.blocked += 1;
      continue;
    }

    const operationId = deps.newOperationId();
    const sent = await deps.createOrder(payload, operationId, identity.principal);

    if (sent.kind === "rejected") {
      await supabase
        .from("alshrouq_dispatches")
        .update({
          dispatch_status: "failed",
          last_error: `AlShrouq refused the order (${sent.status}).`,
          attempt_count: 1,
        })
        .eq("id", row.id);
      summary.failed += 1;
      continue;
    }

    // The reference comes from the GET, for an accepted send and an ambiguous
    // one alike. The POST body is never read for it.
    const found = await deps
      .reconcile(payload.client_order_id)
      .catch((): AlShrouqReconciledOrder | null => null);

    if (sent.kind === "indeterminate" && !found) {
      await supabase
        .from("alshrouq_dispatches")
        .update({
          dispatch_status: "indeterminate",
          last_error: sent.message,
          attempt_count: 1,
        })
        .eq("id", row.id);
      summary.indeterminate += 1;
      continue;
    }

    await supabase
      .from("alshrouq_dispatches")
      .update({
        dispatch_status: "accepted",
        local_id: found?.id != null ? String(found.id) : null,
        external_order_id: found?.externalOrderId != null ? String(found.externalOrderId) : null,
        tracking_url: found?.trackingUrl ?? null,
        status: found?.statusLabel ?? null,
        refreshed_at: found ? new Date().toISOString() : null,
        dispatched_at: new Date().toISOString(),
        attempt_count: 1,
        last_error: null,
      })
      .eq("id", row.id);
    summary.accepted += 1;
  }

  return summary;
}

/**
 * Calling off a scheduled dispatch.
 *
 * The inverse of `scheduleAlShrouqDispatch`, and like it, **it contacts
 * nobody**. There is no transport in this function: cancelling a parked dispatch
 * is a local decision about a request that was never made, and there is no
 * AlShrouq cancellation endpoint in this integration to call even if there were
 * something to call off.
 *
 * ## Only `scheduled`, and why
 *
 * `canCancelDispatch` allows exactly one state. A parked row has contacted
 * nobody, so calling it off costs nothing and tells no one. Every other state is
 * refused with a sentence naming the reason — see `describeCancelRefusal`. The
 * refusal that matters most is `indeterminate`: recording "cancelled" against an
 * outcome nobody can establish would be a claim the data does not support, and
 * it would quietly free the order's slot for a resend.
 *
 * ## The race with the worker
 *
 * An agent can click Cancel in the same second `pg_cron` fires. Both operations
 * want the same transition out of `scheduled`:
 *
 *   worker: UPDATE … SET dispatch_status='processing' WHERE id=? AND dispatch_status='scheduled'
 *   cancel: UPDATE … SET dispatch_status='cancelled'  WHERE order_id=? AND dispatch_status='scheduled'
 *
 * Postgres serialises two updates to one row, so exactly one matches
 * `dispatch_status='scheduled'` and the other matches nothing. There is no
 * window in which both succeed, and no read-then-write for a concurrent
 * transaction to slip between.
 *
 * If cancellation wins, the row is `cancelled` and the worker's claim finds
 * nothing — and even if that worker had already selected the row in its due
 * query, it cannot claim it, and an unclaimed row is never sent.
 *
 * If the worker wins, cancellation returns `conflict` and **says so**. It does
 * not retry, and it does not overwrite a `processing` row: that row may be
 * mid-request, and marking it cancelled would record a delivery as called off
 * while a driver was being assigned.
 */
export type CancelScheduledResult =
  /** Called off. Nothing was sent, and nothing will be. */
  | { kind: "cancelled"; cancelledAt: string }
  /** No dispatch for this order at all. */
  | { kind: "not_found" }
  /** Already cancelled — reported as its own outcome, not as an error. */
  | { kind: "already_cancelled" }
  /**
   * The dispatch is in a state cancellation may not touch. `status` is what it
   * is actually in, and `message` is what to tell the agent.
   */
  | { kind: "conflict"; status: DispatchStatus | null; message: string };

/**
 * `userId` is the **verified** caller, from `requireSupabaseAuth`'s claims — the
 * server function takes an order id and nothing else, so a browser cannot
 * attribute a cancellation to somebody else by asking to. It joins
 * `dispatched_by` and `scheduled_by` in recording who did the consequential
 * thing, which cancellation was previously the only one to omit.
 */
export async function cancelScheduledAlShrouqDispatch(
  orderId: string,
  userId: string,
  supabase: SupabaseLike,
): Promise<CancelScheduledResult> {
  const cancelledAt = new Date().toISOString();

  /*
   * The compare-and-swap. `dispatch_status='scheduled'` is the guard, and it is
   * the same predicate the worker's claim uses, so the two cannot both win.
   *
   * `cancelled_at` is set in the same statement as the status. They are the two
   * markers the rest of the system reads — the unique index keys on
   * `cancelled_at IS NULL`, the due query and the timeline on both — and writing
   * them separately would leave a window where the row disagreed with itself.
   */
  const { data: cancelled } = await supabase
    .from("alshrouq_dispatches")
    .update({
      dispatch_status: "cancelled",
      cancelled_at: cancelledAt,
      cancelled_by: userId,
    })
    .eq("order_id", orderId)
    .eq("dispatch_status", "scheduled")
    .is("cancelled_at", null)
    .select("id,cancelled_at")
    .maybeSingle();

  if (cancelled) return { kind: "cancelled", cancelledAt };

  /*
   * Nothing was updated. Read the row to say *why* — a cancellation that failed
   * silently, or that reported success it did not achieve, is worse than one
   * that explains itself. This read happens only on the failure path, so the
   * common case is a single statement.
   */
  const { data: current } = await supabase
    .from("alshrouq_dispatches")
    .select("dispatch_status,cancelled_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!current) return { kind: "not_found" };

  const status = (current.dispatch_status ?? null) as DispatchStatus | null;
  if (status === "cancelled" || current.cancelled_at) return { kind: "already_cancelled" };

  // Never silently mutate a row cancellation may not have. Report the state.
  return { kind: "conflict", status, message: describeCancelRefusal(status) };
}
