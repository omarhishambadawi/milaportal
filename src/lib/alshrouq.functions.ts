/**
 * AlShrouq dispatch — the Portal's side of the CRM integration.
 *
 * Every call runs on the server behind `requireSupabaseAuth`, gated on the
 * caller's right to *edit the order in question* rather than on a new permission:
 * handing an order to a courier is an act on that order, so whoever may not
 * change it may not send it out either.
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
 * One live dispatch per order, enforced by a partial unique index in the database
 * *and* checked here before the request is sent, so an ordinary double-click reads
 * as a message rather than as a constraint violation after a courier has already
 * been dispatched. A cancelled dispatch does not count, so a mistake can be
 * withdrawn and re-sent.
 *
 * ## Status
 *
 * Statuses are stored and shown verbatim. There is deliberately **no** automatic
 * status sync: the CRM exposes a per-order refresh, not a feed, and nothing
 * verified tells us its status vocabulary or a webhook contract we could trust.
 * Refresh is on demand, persisted, and every change it observes becomes a
 * timeline event. See `docs/shams/api-discovery.md` §11.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  branchAlShrouqId,
  canDispatch,
  clientOrderIdFor,
  dispatchBlockers,
  latestDispatch,
  liveDispatch,
  loadEditableOrder,
  numberOrNull,
  recordDispatchEvent,
  storedTimeline,
  toDispatchRecord,
  type AlShrouqDispatchRecord,
  type AlShrouqPanelState,
  type DispatchClient,
} from "@/lib/alshrouq/dispatch";
import { buildAlShrouqCreatePayload, type AlShrouqConfig } from "@/lib/shams-crm/alshrouq";

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

    const alshrouqBranchId = await branchAlShrouqId(supabase, order.branch_no);
    const row = await latestDispatch(supabase, data.orderId);

    return {
      configured: isCrmConfigured(),
      alshrouqBranchId,
      dispatch: row ? toDispatchRecord(row, storedTimeline(row)) : null,
      blockers: dispatchBlockers(order, alshrouqBranchId),
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

/** Create the delivery. */
export const alshrouqDispatchOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      orderId: string;
      paymentType: string;
      lat: number;
      lng: number;
      details?: string | null;
      customerAddress?: string | null;
      preparationTime?: number | null;
    }) =>
      z
        .object({
          orderId: z.string().uuid(),
          paymentType: z.string().min(1),
          lat: z.number(),
          lng: z.number(),
          details: z.string().max(500).nullish(),
          customerAddress: z.string().max(300).nullish(),
          preparationTime: z.number().int().min(0).max(600).nullish(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }): Promise<AlShrouqDispatchRecord> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };
    const order = await loadEditableOrder(supabase, userId, data.orderId);
    const alshrouqBranchId = await branchAlShrouqId(supabase, order.branch_no);

    if (await liveDispatch(supabase, data.orderId)) {
      throw new Error("This order has already been sent to AlShrouq.");
    }

    const clientOrderId = clientOrderIdFor(order);
    const payload = buildAlShrouqCreatePayload({
      alshrouqBranchId,
      clientOrderId,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      customerAddress: data.customerAddress ?? null,
      paymentType: data.paymentType,
      // The order's notes: the only free text the Portal holds about what is
      // being delivered. An agent may amend it for the driver before sending;
      // nothing is synthesised.
      details: data.details ?? order.notes,
      lat: data.lat,
      lng: data.lng,
      value: numberOrNull(order.invoice_value),
      preparationTime: data.preparationTime ?? null,
    });

    const { createAlShrouqOrder } = await import("@/lib/shams-crm/alshrouq.server");
    const { state, raw } = await createAlShrouqOrder(payload);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: inserted, error } = await supabaseAdmin
      .from("alshrouq_dispatches" as any)
      .insert({
        order_id: order.id,
        client_order_id: clientOrderId,
        local_id: state.localId,
        status: state.status,
        status_detail: state.statusDetail,
        branch_no: order.branch_no,
        alshrouq_branch_id: payload.branch_id,
        payment_type: payload.payment_type,
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

    await recordDispatchEvent(order.id, userId, "alshrouq_dispatched", {
      source: "AlShrouq",
      client_order_id: clientOrderId,
      local_id: state.localId,
      payment_type: payload.payment_type,
      status: state.status,
      value: payload.value,
    });

    return toDispatchRecord(inserted, state.timeline);
  });

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
      status: state.status,
    });

    return toDispatchRecord(updated, state.timeline);
  });
