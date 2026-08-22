/**
 * One order's AlShrouq dispatch rows — the single client-side read of them.
 *
 * Two surfaces need this state: the AlShrouq card, which summarises where the
 * delivery stands, and the order timeline, which narrates how it got there.
 * Sharing one hook — and so one query key — means the page fetches the row once
 * and the two cannot disagree about it, the same reason `useOrderActivity` was
 * extracted when the invoice panel became its second reader.
 *
 * ## Why every row, and not just the live one
 *
 * "The current dispatch" is the row with `cancelled_at IS NULL` — the same
 * predicate as the unique index `alshrouq_dispatches_live_order_key`, so at most
 * one exists. But a cancelled dispatch is still something that *happened* to
 * this order, and a timeline that filtered it out would quietly lose the fact
 * that a courier was called off. So the query fetches them all and the split is
 * made here: `current` for the card's status and for whether anything may still
 * be approved, every row for the history.
 *
 * ## No polling
 *
 * There is no `refetchInterval` here and there must not be one. A scheduled
 * dispatch is performed by `pg_cron` → the worker, on the server, whether or not
 * a browser is open; a timer in the client would spend a request a second to
 * watch a row that changes twice in its lifetime. The countdown re-renders from
 * the persisted `scheduled_for` without asking anyone anything, and the rows are
 * refetched the ordinary way — on invalidation after an action.
 *
 * ## Read-only, and RLS-bounded
 *
 * `alshrouq_dispatches` carries one RLS policy — `SELECT` for `authenticated`,
 * qualified by the order's own visibility — and no policy for `INSERT`,
 * `UPDATE` or `DELETE`, so those commands are denied for any client that is not
 * the service role. Every write goes through the server function that actually
 * called the courier. So this hook cannot dispatch, cancel or amend anything,
 * and a row it returns is one the caller was already entitled to see.
 *
 * (The block is the *policy*, not the table grant: `authenticated` holds the
 * default Supabase write grants on this table. Verified in Phase 10H.)
 *
 * The table is absent from the generated `types.ts` — which Lovable re-emits, so
 * it is never hand-edited — hence the cast this codebase already uses for such
 * tables.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { currentDispatch } from "./dispatch-selection";
import type { AlShrouqDispatchRow } from "./dispatch-timeline";

/**
 * The dispatch row as the client reads it.
 *
 * Adds to the timeline's columns the few the card displays. Deliberately not
 * `select("*")`: `payload_snapshot` holds the customer's name, phone and address
 * as they were approved, and there is no reason to ship a second copy of that to
 * a browser to render a status badge. `last_response` is excluded for the same
 * reason.
 */
export interface AlShrouqOrderDispatch extends AlShrouqDispatchRow {
  /** The row's own id — what the resolve action targets. */
  id: string;
  payment_type: string | null;
  value: number | null;
  customer_address: string | null;
  customer_lat: number | null;
  customer_lng: number | null;
  branch_no: string | null;
  created_at: string | null;
  /**
   * The note for the driver, as it was approved.
   *
   * The same value the CRM payload carries as `details`, frozen on the row at
   * approval time. Read here so the card can show the handover note an agent
   * typed weeks ago without re-deriving it from the order — which may have been
   * edited since, and which AlShrouq was never told about.
   */
  details: string | null;
}

const COLUMNS =
  "id,dispatch_status,scheduled_for,scheduled_at,last_attempt_at,dispatched_at,cancelled_at," +
  "external_order_id,tracking_url,refreshed_at,last_error,status,payment_type,value," +
  "customer_address,customer_lat,customer_lng,branch_no,created_at,details," +
  // The operator's answer, when a stuck dispatch has been settled. `resolved_by`
  // is an id and is deliberately not fetched — the card shows *that* it was
  // resolved, and the order timeline carries the attribution with a name.
  "resolution_outcome,resolved_at,resolution_note";

export interface AlShrouqOrderDispatchState {
  /** Every dispatch this order has had, oldest first. History. */
  rows: AlShrouqOrderDispatch[];
  /** The one that is not cancelled, if there is one. At most one can exist. */
  current: AlShrouqOrderDispatch | null;
}

export function useOrderAlShrouqDispatch(orderId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.orders.dispatch(orderId),
    enabled: enabled && !!orderId,
    queryFn: async (): Promise<AlShrouqOrderDispatchState> => {
      const { data } = await (supabase as any)
        .from("alshrouq_dispatches")
        .select(COLUMNS)
        .eq("order_id", orderId as string)
        .order("created_at", { ascending: true });
      const rows = ((data as AlShrouqOrderDispatch[] | null) ?? []).filter(Boolean);
      return { rows, current: currentDispatch(rows) };
    },
  });
}
