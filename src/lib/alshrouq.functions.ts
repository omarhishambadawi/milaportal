/**
 * AlShrouq dispatch — the Portal's side of the CRM integration.
 *
 * Every call runs on the server behind `requireSupabaseAuth`, gated on the
 * caller's right to *edit the order in question* rather than on a new permission:
 * handing an order to a courier is an act on that order, so whoever may not
 * change it may not send it out either.
 *
 * ## Where the delivery details come from
 *
 * The order row, and nothing else. Map link, coordinates and payment method are
 * captured on the order form beside the branch and the customer, so submitting
 * the order is what sends it — an agent never retypes the delivery into a second
 * form, and never opens AlShrouq's own dashboard to create it by hand.
 *
 * ## Why the writes use the privileged client
 *
 * `alshrouq_dispatches` has no INSERT or UPDATE grant for `authenticated`, so a
 * dispatch row can only be written by code that has actually spoken to the CRM.
 * Letting the browser insert it would allow a record claiming a delivery that
 * never happened. Authorization therefore happens first, through
 * `context.supabase` under the caller's own RLS, and only then does the
 * privileged client write down what the courier said.
 *
 * ## The duplicate rule
 *
 * Three layers, because a duplicate here means a second driver at a customer's
 * door and a second bill:
 *
 *   1. A partial unique index on `(order_id) WHERE cancelled_at IS NULL`, plus a
 *      unique index on `client_order_id` — the database refuses a second live
 *      dispatch even if two requests race.
 *   2. A pre-flight read of the live dispatch, so an ordinary double-click or a
 *      re-save returns the existing delivery instead of attempting another.
 *   3. For the case those cannot see — a POST that timed out after the courier
 *      may already have it — the CRM's own history is searched for our
 *      `client_order_id` before anything is sent again. See `attemptDispatch`.
 *
 * ## Status
 *
 * Statuses are stored and shown verbatim. There is deliberately **no** automatic
 * status sync: the CRM exposes a per-order refresh, and its status vocabulary is
 * the courier's own. Refresh is on demand, persisted, and every change it
 * observes becomes a timeline event.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  branchCoverage,
  canDispatch,
  clientOrderIdFor,
  coveredBranchId,
  dispatchBlockers,
  dispatchInputFor,
  latestDispatch,
  liveDispatch,
  loadEditableOrder,
  recordDispatchEvent,
  storedTimeline,
  toDispatchRecord,
  type AlShrouqDispatchRecord,
  type AlShrouqPanelState,
  type DispatchClient,
  type OrderForDispatch,
} from "@/lib/alshrouq/dispatch";
import {
  buildAlShrouqCreatePayload,
  type AlShrouqConfig,
  type AlShrouqOrderState,
} from "@/lib/shams-crm/alshrouq";

export type { AlShrouqDispatchRecord, AlShrouqPanelState };

const orderIdInput = (input: { orderId: string }) =>
  z.object({ orderId: z.string().uuid() }).parse(input);

/** Everything the dispatch panel needs in one round trip. */
export const alshrouqOrderState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(orderIdInput)
  .handler(async ({ data, context }): Promise<AlShrouqPanelState> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    const order = await loadEditableOrder(supabase, userId, data.orderId);
    const { isCrmConfigured } = await import("@/lib/shams-crm/client.server");

    // Without credentials there is no config to read, so coverage is unknown
    // rather than absent — asking would throw and the panel only wants to say
    // "this deployment is not connected".
    if (!isCrmConfigured()) {
      const row = await latestDispatch(supabase, data.orderId);
      return {
        configured: false,
        alshrouqBranchId: null,
        coverage: "unmapped",
        dispatch: row ? toDispatchRecord(row, storedTimeline(row)) : null,
        blockers: [],
      };
    }

    const coverage = await branchCoverage(order.branch_no);
    const row = await latestDispatch(supabase, data.orderId);

    return {
      configured: true,
      alshrouqBranchId: coveredBranchId(coverage),
      coverage: coverage.kind,
      dispatch: row ? toDispatchRecord(row, storedTimeline(row)) : null,
      blockers: dispatchBlockers(order, coverage),
    };
  });

/** The payment methods AlShrouq accepts, from the CRM — never a hardcoded list. */
export const alshrouqConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AlShrouqConfig> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    if (!(await canDispatch(supabase, userId))) {
      throw new Error("Forbidden: insufficient permissions");
    }
    const { fetchAlShrouqConfig } = await import("@/lib/shams-crm/alshrouq.server");
    return fetchAlShrouqConfig();
  });

/* -------------------------------------------------------------------------- */
/* Creating the delivery                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether a failed create may safely be retried.
 *
 * The distinction that matters: a request the CRM certainly rejected can be sent
 * again once the problem is fixed, while one that may have reached the courier
 * before the connection died must never be blindly repeated. Timeouts, transport
 * failures, 5xx responses and bodies we could not parse all fall in the second
 * group — in every one of them the order may exist on the other side.
 */
function outcomeIsUnknown(error: unknown): boolean {
  const kind = (error as { kind?: string } | null)?.kind;
  const status = (error as { httpStatus?: number | null } | null)?.httpStatus ?? null;
  if (kind === "timeout" || kind === "unavailable" || kind === "malformed") return true;
  if (kind === "http_error" && status != null && status >= 500) return true;
  // An unrecognised error is treated as unknown on purpose: guessing "it
  // definitely failed" is the guess that creates a second delivery.
  return kind === undefined;
}

/** Persist what the CRM said, and return the panel's view of it. */
async function persistDispatch(
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
      branch_no: order.branch_no,
      alshrouq_branch_id: payload.branch_id,
      payment_type: payload.payment_type,
      customer_address: payload.customer_address,
      details: payload.details,
      customer_lat: payload.customer_lat,
      customer_lng: payload.customer_lng,
      value: payload.value,
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
async function attemptDispatch(
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
      // The message only — never the payload, the headers or the session token.
      reason: error?.message ?? "unknown error",
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
    payment_type: payload.payment_type,
    status: result.state.status,
    value: payload.value,
  });
  return record;
}

/** Has this order been handed to the CRM before, successfully or not? */
async function hasPriorAttempt(supabase: DispatchClient, orderId: string): Promise<boolean> {
  const { data } = await supabase
    .from("order_activity")
    .select("id")
    .eq("order_id", orderId)
    .in("action", ["alshrouq_submission_started", "alshrouq_failed"])
    .limit(1);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

/**
 * Create the delivery.
 *
 * Takes only an order id: everything AlShrouq needs is on the order already.
 * Called automatically when an AlShrouq order is saved, and by the panel's retry
 * button when a submission failed.
 */
export const alshrouqDispatchOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(orderIdInput)
  .handler(async ({ data, context }): Promise<AlShrouqDispatchRecord> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    return attemptDispatch(supabase, userId, data.orderId);
  });

/**
 * The automatic submission, fired by the order form after a save.
 *
 * Distinct from `alshrouqDispatchOrder` in one way that matters: it never
 * throws. A save that succeeded must not be reported to the agent as a failure
 * because the courier leg did not complete — the order is saved, the failure is
 * on the timeline, and the panel offers a retry. It returns what happened so the
 * form can say so.
 */
export const alshrouqAutoSubmit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(orderIdInput)
  .handler(
    async ({
      data,
      context,
    }): Promise<
      { ok: true; dispatch: AlShrouqDispatchRecord } | { ok: false; message: string }
    > => {
      const { supabase, userId } = context as unknown as {
        supabase: DispatchClient;
        userId: string;
      };
      try {
        return { ok: true, dispatch: await attemptDispatch(supabase, userId, data.orderId) };
      } catch (error: any) {
        return { ok: false, message: error?.message ?? "AlShrouq did not accept the order." };
      }
    },
  );

/* -------------------------------------------------------------------------- */
/* Refresh and cancel                                                          */
/* -------------------------------------------------------------------------- */

/** Ask the CRM again what AlShrouq says about this delivery. */
export const alshrouqRefreshOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(orderIdInput)
  .handler(async ({ data, context }): Promise<AlShrouqDispatchRecord> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    const order = await loadEditableOrder(supabase, userId, data.orderId);

    const row = await latestDispatch(supabase, data.orderId);
    if (!row) throw new Error("This order has not been sent to AlShrouq.");
    if (!row.local_id) throw new Error("AlShrouq never returned a reference for this order.");

    const { refreshAlShrouqOrder } = await import("@/lib/shams-crm/alshrouq.server");
    const { state, raw } = await refreshAlShrouqOrder(String(row.local_id));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: updated, error } = await supabaseAdmin
      .from("alshrouq_dispatches" as any)
      .update({
        status: state.status ?? row.status,
        status_detail: state.statusDetail ?? row.status_detail,
        // Only ever filled in, never blanked: a refresh that omits the reference
        // does not mean the courier withdrew it.
        external_order_id: state.externalOrderId ?? row.external_order_id,
        tracking_url: state.trackingUrl ?? row.tracking_url,
        last_response: (raw ?? {}) as any,
        refreshed_at: new Date().toISOString(),
      } as any)
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) throw new Error("Unable to record the AlShrouq status.");

    // A timeline entry only when the status actually moved — a refresh that
    // confirms what we already knew is not an event in the order's history.
    if (state.status && state.status !== row.status) {
      await recordDispatchEvent(order.id, userId, "alshrouq_status_changed", {
        source: "AlShrouq",
        from: row.status ?? null,
        to: state.status,
        detail: state.statusDetail,
        local_id: row.local_id,
        external_order_id: state.externalOrderId ?? row.external_order_id ?? null,
      });
    }

    return toDispatchRecord(updated, state.timeline);
  });

/** Withdraw a live delivery, which also frees the order to be re-sent. */
export const alshrouqCancelOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(orderIdInput)
  .handler(async ({ data, context }): Promise<AlShrouqDispatchRecord> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    const order = await loadEditableOrder(supabase, userId, data.orderId);

    const row = await liveDispatch(supabase, data.orderId);
    if (!row) throw new Error("There is no live AlShrouq delivery for this order.");
    if (!row.local_id) throw new Error("AlShrouq never returned a reference for this order.");

    const { cancelAlShrouqOrder } = await import("@/lib/shams-crm/alshrouq.server");
    const { state, raw } = await cancelAlShrouqOrder(String(row.local_id));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: updated, error } = await supabaseAdmin
      .from("alshrouq_dispatches" as any)
      .update({
        status: state.status ?? row.status,
        status_detail: state.statusDetail ?? row.status_detail,
        last_response: (raw ?? {}) as any,
        cancelled_at: new Date().toISOString(),
      } as any)
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) {
      throw new Error("AlShrouq cancelled the delivery but the portal could not record it.");
    }

    await recordDispatchEvent(order.id, userId, "alshrouq_cancelled", {
      source: "AlShrouq",
      local_id: row.local_id,
      external_order_id: row.external_order_id ?? null,
      status: state.status,
    });

    return toDispatchRecord(updated, state.timeline);
  });
