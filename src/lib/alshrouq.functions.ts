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
  isHeldForLater,
  isHistoricalAlShrouqOrder,
  latestDispatch,
  HISTORICAL_ALSHROUQ_NOTICE,
  liveDispatch,
  loadEditableOrder,
  recordDispatchEvent,
  scheduledFor,
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
        historical: isHistoricalAlShrouqOrder(order, row != null),
        historicalManual: order.alshrouq_historical === true,
        scheduledAt: order.alshrouq_scheduled_at,
        held: isHeldForLater(order),
        blockers: [],
      };
    }

    const row = await latestDispatch(supabase, data.orderId);

    // An order that predates the integration is reported as such and nothing
    // else. No branch lookup — that is a CRM round trip — and no blockers: the
    // fields it is "missing" are ones it was never going to have.
    if (isHistoricalAlShrouqOrder(order, row != null)) {
      return {
        configured: true,
        alshrouqBranchId: null,
        coverage: "unmapped",
        dispatch: null,
        historical: true,
        historicalManual: order.alshrouq_historical === true,
        scheduledAt: order.alshrouq_scheduled_at,
        held: false,
        blockers: [],
      };
    }

    /**
     * A live delivery describes itself, from the row written when it was sent.
     *
     * Nothing here is re-derived from `order`, and that is the point. An order
     * dispatched from P0025 and later invoiced from P0001 has legitimately moved
     * branch — both facts are true — but the van went to P0025, and reading the
     * delivery's branch off the order afterwards would name the wrong shop. It
     * would also compute coverage and blockers for a branch that has nothing to
     * do with this delivery, so an order collected from a covered branch could
     * start reporting "AlShrouq does not cover…" once the invoice moved it.
     *
     * The CRM is not contacted either: `branchCoverage` is a round trip, and
     * there is nothing left to decide about an order already sent.
     */
    if (row && !row.cancelled_at) {
      return {
        configured: true,
        alshrouqBranchId: row.alshrouq_branch_id ?? null,
        coverage: "covered",
        dispatch: toDispatchRecord(row, storedTimeline(row)),
        historical: false,
        historicalManual: order.alshrouq_historical === true,
        // The appointment this delivery was held for, not whatever the order
        // says now — and it is no longer held, because it has gone.
        scheduledAt: row.scheduled_at ?? null,
        held: false,
        blockers: [],
      };
    }

    // No live delivery: this order may still be sent, so the *current* branch
    // and the current fields are exactly what matters. A cancelled dispatch
    // takes this path too, because a re-send goes out from the order as it is now.
    const coverage = await branchCoverage(order.branch_no);

    return {
      configured: true,
      alshrouqBranchId: coveredBranchId(coverage),
      coverage: coverage.kind,
      dispatch: row ? toDispatchRecord(row, storedTimeline(row)) : null,
      historical: false,
      historicalManual: order.alshrouq_historical === true,
      scheduledAt: order.alshrouq_scheduled_at,
      held: isHeldForLater(order),
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

/**
 * Declare an order historical, or take the declaration back.
 *
 * Owner and admin only, checked here against `has_role` rather than trusted from
 * the browser: the flag decides whether a live courier integration will ever
 * touch this order, so hiding the control would not be a control at all. A
 * supervisor holding `edit_all_orders` may edit the order and still not set
 * this.
 *
 * The write goes through the privileged client because `orders` has no column
 * grant that would let an ordinary caller set it, which is deliberate — the
 * only way to change it is this function, past this check.
 */
export const alshrouqSetHistorical = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orderId: string; historical: boolean }) =>
    z.object({ orderId: z.string().uuid(), historical: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<{ historical: boolean }> => {
    const { supabase, userId } = context as unknown as { supabase: DispatchClient; userId: string };

    const owner = await supabase.rpc("has_role", { _user_id: userId, _role: "owner" });
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (owner.data !== true && admin.data !== true) {
      throw new Error("Forbidden: only an owner or admin may mark an order historical.");
    }

    // Refuse while a live delivery exists: the courier already has it, and
    // calling it historical afterwards would only hide that from the panel.
    if (await liveDispatch(supabase, data.orderId)) {
      throw new Error("This order has a live AlShrouq delivery — cancel it first.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("orders" as any)
      .update({ alshrouq_historical: data.historical } as any)
      .eq("id", data.orderId);
    if (error) throw new Error("Unable to record that.");

    await recordDispatchEvent(
      data.orderId,
      userId,
      data.historical ? "alshrouq_marked_historical" : "alshrouq_unmarked_historical",
      { source: "AlShrouq" },
    );
    return { historical: data.historical };
  });

/* -------------------------------------------------------------------------- */
/* Creating the delivery                                                       */
/* -------------------------------------------------------------------------- */

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
    const { attemptDispatch } = await import("@/lib/alshrouq/dispatch.server");
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
      | { ok: true; dispatch: AlShrouqDispatchRecord }
      | { ok: true; held: true; scheduledAt: string }
      | { ok: false; message: string }
    > => {
      const { supabase, userId } = context as unknown as {
        supabase: DispatchClient;
        userId: string;
      };
      try {
        const order = await loadEditableOrder(supabase, userId, data.orderId);

        /**
         * Held for later: record the appointment and send nothing.
         *
         * Decided on the server so the timeline entry is durable — the agent can
         * close the tab the moment they save, and the sweep is what keeps the
         * appointment. Deliberately *not* a dispatch row: nothing has been sent,
         * and a row would claim the courier had been told.
         */
        const at = scheduledFor(order);
        if (at && isHeldForLater(order)) {
          const iso = at.toISOString();
          // Re-saving an unchanged schedule is not an event. Only a *different*
          // time is worth a line, which is also how a changed appointment reads.
          const { data: prior } = await supabase
            .from("order_activity")
            .select("details")
            .eq("order_id", data.orderId)
            .eq("action", "alshrouq_scheduled")
            .order("created_at", { ascending: false })
            .limit(1);
          const last = (prior as { details?: { scheduled_at?: string } }[] | null)?.[0]?.details
            ?.scheduled_at;
          if (last !== iso) {
            await recordDispatchEvent(data.orderId, userId, "alshrouq_scheduled", {
              source: "AlShrouq",
              scheduled_at: iso,
            });
          }
          return { ok: true, held: true, scheduledAt: iso };
        }

        const { attemptDispatch } = await import("@/lib/alshrouq/dispatch.server");
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
