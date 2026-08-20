/**
 * Creating an AlShrouq delivery — the one implementation.
 *
 * Server-only, and split out of `src/lib/alshrouq.functions.ts` for one reason:
 * the scheduled sweep has to reach exactly this code. Duplicate protection that
 * exists in two places is duplicate protection that will disagree, and here a
 * disagreement is a second driver at a customer's door. The interactive path and
 * the cron path therefore share every check — the live-dispatch read, the
 * historical gate, the schedule gate, and the `client_order_id` lookup after an
 * ambiguous POST.
 */

import {
  branchCoverage,
  clientOrderIdFor,
  coveredBranchId,
  dispatchBlockers,
  dispatchInputFor,
  heldNotice,
  isHeldForLater,
  isHistoricalAlShrouqOrder,
  latestDispatch,
  liveDispatch,
  loadEditableOrder,
  recordDispatchEvent,
  scheduledFor,
  storedTimeline,
  toDispatchRecord,
  HISTORICAL_ALSHROUQ_NOTICE,
  type AlShrouqDispatchRecord,
  type DispatchClient,
  type OrderForDispatch,
} from "@/lib/alshrouq/dispatch";
import { buildAlShrouqCreatePayload, type AlShrouqOrderState } from "@/lib/shams-crm/alshrouq";

/**
 * Whether a failed create may safely be retried.
 *
 * The distinction that matters: a request the CRM certainly rejected can be sent
 * again once the problem is fixed, while one that may have reached the courier
 * before the connection died must never be blindly repeated. Timeouts, transport
 * failures, 5xx responses and bodies we could not parse all fall in the second
 * group — in every one of them the order may exist on the other side.
 */
export function outcomeIsUnknown(error: unknown): boolean {
  const kind = (error as { kind?: string } | null)?.kind;
  const status = (error as { httpStatus?: number | null } | null)?.httpStatus ?? null;
  if (kind === "timeout" || kind === "unavailable" || kind === "malformed") return true;
  if (kind === "http_error" && status != null && status >= 500) return true;
  // An unrecognised error is treated as unknown on purpose: guessing "it
  // definitely failed" is the guess that creates a second delivery.
  return kind === undefined;
}

/** Persist what the CRM said, and return the panel's view of it. */
export async function persistDispatch(
  order: OrderForDispatch,
  userId: string,
  clientOrderId: string,
  payload: ReturnType<typeof buildAlShrouqCreatePayload>,
  state: AlShrouqOrderState,
  raw: unknown,
): Promise<AlShrouqDispatchRecord> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: inserted, error } = await supabaseAdmin
    .from("alshrouq_dispatches" as any)
    .insert({
      order_id: order.id,
      client_order_id: clientOrderId,
      local_id: state.localId,
      external_order_id: state.externalOrderId,
      status: state.status,
      status_detail: state.statusDetail,
      tracking_url: state.trackingUrl,
      // The branch the courier collects from, frozen here. `orders.branch_no`
      // may later become the branch that invoiced the order; this must not
      // follow it, because the van has already been to this one.
      branch_no: order.branch_no,
      alshrouq_branch_id: payload.branch_id,
      customer_name: payload.customer_name,
      customer_phone: payload.customer_phone,
      scheduled_at: order.alshrouq_scheduled_at,
      payment_type: payload.payment_type,
      customer_address: payload.customer_address,
      details: payload.details,
      customer_lat: payload.customer_lat,
      customer_lng: payload.customer_lng,
      value: payload.order_value,
      preparation_time: payload.preparation_time ?? null,
      last_response: (raw ?? {}) as any,
      dispatched_by: userId,
    } as any)
    .select("*")
    .single();
  if (error) throw new Error("AlShrouq accepted the order but the portal could not record it.");
  return toDispatchRecord(inserted, state.timeline);
}

/**
 * Send the order to AlShrouq, once.
 *
 * Shared by the automatic submission and the manual retry so there is exactly
 * one implementation of the duplicate rule.
 */
export async function attemptDispatch(
  supabase: DispatchClient,
  userId: string,
  orderId: string,
): Promise<AlShrouqDispatchRecord> {
  const order = await loadEditableOrder(supabase, userId, orderId);

  // Already sent: return what exists rather than refusing. The automatic path
  // fires on every save of an AlShrouq order, and a save is not a request for a
  // second courier.
  const existing = await liveDispatch(supabase, orderId);
  if (existing) return toDispatchRecord(existing, storedTimeline(existing));

  /**
   * The historical gate, and it is deliberately the first thing after the
   * duplicate check.
   *
   * An order raised before this integration existed was already delivered, by a
   * person, through the old manual workflow. Re-sending it would put a second
   * driver at a customer's door for a delivery that happened months ago. This
   * refuses before the CRM is contacted and before anything is written to the
   * timeline, so saving such an order cannot leave a trace of an attempt, let
   * alone an order.
   *
   * Enforced here rather than only in the form because this is the boundary that
   * actually reaches the courier: the form can be stale, bypassed, or replaced,
   * and the browser is not what must be trusted with this.
   */
  const everDispatched = await latestDispatch(supabase, orderId);
  if (isHistoricalAlShrouqOrder(order, everDispatched != null)) {
    throw new Error(HISTORICAL_ALSHROUQ_NOTICE);
  }

  /**
   * The schedule gate, and it sits here so that *every* caller passes it.
   *
   * The CRM accepts a delivery time and AlShrouq ignores it, so the only thing
   * that actually defers a delivery is withholding the request. Strictly
   * greater-than: an order due this second is due, and one due next second is
   * not sent now. Nothing is written when this refuses — no dispatch row, no
   * `submission_started` — because nothing was attempted, and a timeline that
   * said otherwise would be claiming the courier had been told.
   *
   * The sweep reaches this same function once the time has passed, so there is
   * one gate rather than one per caller.
   */
  const heldUntil = scheduledFor(order);
  if (heldUntil && isHeldForLater(order)) {
    throw new Error(heldNotice(heldUntil));
  }

  const coverage = await branchCoverage(order.branch_no);
  const blockers = dispatchBlockers(order, coverage);
  if (blockers.length > 0) throw new Error(blockers.join(" "));

  const clientOrderId = clientOrderIdFor(order);
  const payload = buildAlShrouqCreatePayload(dispatchInputFor(order, coveredBranchId(coverage)));

  const { findAlShrouqOrderByClientId, createAlShrouqOrder } =
    await import("@/lib/shams-crm/alshrouq.server");

  /** Adopt an order the CRM already has, instead of creating a second one. */
  const adopt = async (found: { state: AlShrouqOrderState; raw: unknown }) => {
    const record = await persistDispatch(
      order,
      userId,
      clientOrderId,
      payload,
      found.state,
      found.raw,
    );
    await recordDispatchEvent(order.id, userId, "alshrouq_recovered", {
      source: "AlShrouq",
      client_order_id: clientOrderId,
      local_id: found.state.localId,
      external_order_id: found.state.externalOrderId,
      // The courier tracking page, so the timeline can link to it. Nothing else
      // from the response goes on the event.
      tracking_url: found.state.trackingUrl,
      status: found.state.status,
    });
    return record;
  };

  // A previous attempt was recorded but left no dispatch row — a browser that
  // went away mid-request, or a timeout. Ask the CRM before sending anything.
  if (await hasPriorAttempt(supabase, orderId)) {
    const found = await findAlShrouqOrderByClientId(clientOrderId);
    if (found) return adopt(found);
  }

  await recordDispatchEvent(order.id, userId, "alshrouq_submission_started", {
    source: "AlShrouq",
    client_order_id: clientOrderId,
    branch_no: order.branch_no,
    alshrouq_branch_id: payload.branch_id,
  });

  let result: { state: AlShrouqOrderState; raw: unknown };
  try {
    result = await createAlShrouqOrder(payload);
  } catch (error: any) {
    if (outcomeIsUnknown(error)) {
      // The courier may already have it. One lookup decides; never a blind POST.
      const found = await findAlShrouqOrderByClientId(clientOrderId).catch(() => null);
      if (found) return adopt(found);
    }
    await recordDispatchEvent(order.id, userId, "alshrouq_failed", {
      source: "AlShrouq",
      client_order_id: clientOrderId,
      // The message, the status and the CRM's own wording — never the payload,
      // the headers or the session token. The status is what turns "it failed"
      // into something diagnosable after the fact.
      reason: error?.message ?? "unknown error",
      http_status: error?.httpStatus ?? null,
      crm_detail: error?.detail ?? null,
    });
    throw new Error(error?.message ?? "AlShrouq did not accept the order.");
  }

  const record = await persistDispatch(
    order,
    userId,
    clientOrderId,
    payload,
    result.state,
    result.raw,
  );
  await recordDispatchEvent(order.id, userId, "alshrouq_dispatched", {
    source: "AlShrouq",
    client_order_id: clientOrderId,
    local_id: result.state.localId,
    external_order_id: result.state.externalOrderId,
    tracking_url: result.state.trackingUrl,
    payment_type: payload.payment_type,
    status: result.state.status,
    value: payload.order_value,
  });
  return record;
}

/** Has this order been handed to the CRM before, successfully or not? */
export async function hasPriorAttempt(supabase: DispatchClient, orderId: string): Promise<boolean> {
  const { data } = await supabase
    .from("order_activity")
    .select("id")
    .eq("order_id", orderId)
    .in("action", ["alshrouq_submission_started", "alshrouq_failed"])
    .limit(1);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}
