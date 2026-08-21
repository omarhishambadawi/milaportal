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

/** The lifecycle, as the database stores it. */
export type AlShrouqDispatchStatus =
  | "scheduled"
  | "processing"
  | "accepted"
  | "failed"
  | "indeterminate"
  | "cancelled";

interface SupabaseLike {
  from: (table: string) => any;
}

const defaultDeps: DispatchDeps = {
  fetchOptions: fetchAlShrouqDispatchOptions,
  createOrder: createAlshrouqOrder,
  reconcile: findAlshrouqOrderByClientOrderId,
  newOperationId: newAlshrouqOperationId,
  liveEnabled: isAlShrouqLiveDispatchEnabled,
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
    value: payload.order_value,
    details: payload.details ?? null,
    customer_address: payload.customer_address ?? null,
    customer_lat: payload.customer_lat ?? null,
    customer_lng: payload.customer_lng ?? null,
    preparation_time: payload.preparation_time ?? null,
    dispatch_status: "scheduled" as const,
    scheduled_for: when,
    scheduled_by: request.userId,
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
}

interface DueRow {
  id: string;
  order_id: string;
  client_order_id: string;
  payload_snapshot: AlShrouqCreatePayload | null;
  scheduled_for: string;
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
  };

  const { data: dueRows } = await supabase
    .from("alshrouq_dispatches")
    .select("id,order_id,client_order_id,payload_snapshot,scheduled_for")
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

    const operationId = deps.newOperationId();
    const sent = await deps.createOrder(payload, operationId);

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
