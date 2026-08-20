/**
 * The policy behind AlShrouq dispatch: who may send, what a duplicate is, and
 * what gets written down.
 *
 * Lives beside `src/lib/alshrouq.functions.ts` rather than inside it because a
 * file declaring `createServerFn` must stay a thin wrapper — only imports, types
 * and the function declarations survive the server/client split. Everything here
 * is called from inside a handler, so the privileged Supabase client and the CRM
 * transport are both reached through `await import(...)` and never enter a client
 * bundle.
 */

import { formatOrderNo } from "@/lib/branches";
import {
  readAlShrouqState,
  validateAlShrouqOrder,
  type AlShrouqTimelineEntry,
} from "@/lib/shams-crm/alshrouq";

/* -------------------------------------------------------------------------- */
/* Shapes the browser sees                                                     */
/* -------------------------------------------------------------------------- */

export interface AlShrouqDispatchRecord {
  id: string;
  orderId: string;
  clientOrderId: string;
  localId: string | null;
  status: string | null;
  statusDetail: string | null;
  paymentType: string;
  alshrouqBranchId: string;
  value: number | null;
  preparationTime: number | null;
  lat: number | null;
  lng: number | null;
  dispatchedAt: string;
  refreshedAt: string | null;
  cancelledAt: string | null;
  timeline: AlShrouqTimelineEntry[];
}

export interface AlShrouqPanelState {
  /** Whether this deployment has CRM credentials at all. */
  configured: boolean;
  /** The branch's AlShrouq id, or null when AlShrouq does not cover it. */
  alshrouqBranchId: string | null;
  dispatch: AlShrouqDispatchRecord | null;
  /** Why this order cannot be dispatched yet, worded for the agent. */
  blockers: string[];
}

export interface OrderForDispatch {
  id: string;
  display_no: string;
  team: string;
  agent_id: string;
  branch_no: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  invoice_value: number | string | null;
  notes: string | null;
  delivery_type: string | null;
  status: string;
}

/** The narrow slice of a Supabase client this module uses. */
export interface DispatchClient {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  from: (table: string) => any;
}

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

/** `has_permission` short-circuits for owner and admin, so this reads as "or outranks it". */
export async function holdsPermission(
  supabase: DispatchClient,
  userId: string,
  permission: string,
): Promise<boolean> {
  const { data } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: permission,
  });
  return data === true;
}

/** May this caller act on orders at all — their own, or anyone's? */
export async function canDispatch(supabase: DispatchClient, userId: string): Promise<boolean> {
  return (
    (await holdsPermission(supabase, userId, "edit_all_orders")) ||
    (await holdsPermission(supabase, userId, "edit_orders"))
  );
}

const ORDER_COLUMNS =
  "id, display_no, team, agent_id, branch_no, customer_name, customer_phone, invoice_value, notes, delivery_type, status";

/**
 * The order, if this caller may act on it.
 *
 * Read through the caller's own client, so an order they cannot see is simply not
 * there — the RLS policies decide visibility and this does not restate them. On
 * top of that, editing rights: `edit_all_orders`, or `edit_orders` on an order
 * that is theirs. Dispatching is an act on the order, so it takes the same right
 * as changing it rather than a new permission of its own.
 */
export async function loadEditableOrder(
  supabase: DispatchClient,
  userId: string,
  orderId: string,
): Promise<OrderForDispatch> {
  const { data: order, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error("Unable to read that order.");
  if (!order) throw new Error("That order does not exist, or you cannot see it.");

  const all = await holdsPermission(supabase, userId, "edit_all_orders");
  const own = all || (await holdsPermission(supabase, userId, "edit_orders"));
  if (!all && !(own && (order as OrderForDispatch).agent_id === userId)) {
    throw new Error("Forbidden: you cannot dispatch this order.");
  }
  return order as OrderForDispatch;
}

/* -------------------------------------------------------------------------- */
/* Reading and writing the dispatch row                                        */
/* -------------------------------------------------------------------------- */

export const numberOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export function toDispatchRecord(
  row: any,
  timeline: AlShrouqTimelineEntry[],
): AlShrouqDispatchRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    clientOrderId: row.client_order_id,
    localId: row.local_id ?? null,
    status: row.status ?? null,
    statusDetail: row.status_detail ?? null,
    paymentType: row.payment_type,
    alshrouqBranchId: row.alshrouq_branch_id,
    value: numberOrNull(row.value),
    preparationTime: row.preparation_time ?? null,
    lat: numberOrNull(row.customer_lat),
    lng: numberOrNull(row.customer_lng),
    dispatchedAt: row.dispatched_at,
    refreshedAt: row.refreshed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    timeline,
  };
}

/**
 * The timeline the CRM last reported, read back out of the stored response
 * through the same reader a live response goes through — so a stored body and a
 * fresh one can never be interpreted two different ways.
 */
export function storedTimeline(row: any): AlShrouqTimelineEntry[] {
  if (!row?.last_response) return [];
  return readAlShrouqState(row.last_response).timeline;
}

/** The most recent dispatch row for an order, live or not. */
export async function latestDispatch(
  supabase: DispatchClient,
  orderId: string,
): Promise<any | null> {
  const { data } = await supabase
    .from("alshrouq_dispatches")
    .select("*")
    .eq("order_id", orderId)
    .order("dispatched_at", { ascending: false })
    .limit(1);
  return (data as any[] | null)?.[0] ?? null;
}

/** The live one, if any — the row the duplicate rule is about. */
export async function liveDispatch(supabase: DispatchClient, orderId: string): Promise<any | null> {
  const { data } = await supabase
    .from("alshrouq_dispatches")
    .select("*")
    .eq("order_id", orderId)
    .is("cancelled_at", null)
    .limit(1);
  return (data as any[] | null)?.[0] ?? null;
}

/** The branch's AlShrouq id, or null when AlShrouq does not cover it. */
export async function branchAlShrouqId(
  supabase: DispatchClient,
  branchNo: string | null,
): Promise<string | null> {
  if (!branchNo) return null;
  const { data } = await supabase
    .from("branches")
    .select("alshrouq_branch_id")
    .eq("branch_no", branchNo)
    .maybeSingle();
  return (data as { alshrouq_branch_id?: string | null } | null)?.alshrouq_branch_id ?? null;
}

/** The identity handed to the CRM: the order's display number, never agent input. */
export function clientOrderIdFor(order: OrderForDispatch): string {
  return formatOrderNo(order.team, order.display_no);
}

/**
 * What must be fixed on the *order* before the panel can be used at all.
 *
 * Payment method and coordinates are chosen inside the panel, so they are
 * stubbed here with values known to pass — this list is about the order's own
 * data: the branch mapping, the customer, the value.
 */
export function dispatchBlockers(
  order: OrderForDispatch,
  alshrouqBranchId: string | null,
): string[] {
  return validateAlShrouqOrder({
    alshrouqBranchId,
    clientOrderId: clientOrderIdFor(order),
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerAddress: null,
    paymentType: "chosen-in-panel",
    details: order.notes,
    lat: 24,
    lng: 46,
    value: numberOrNull(order.invoice_value) ?? 0,
    preparationTime: null,
  }).map((e) => e.message);
}

/* -------------------------------------------------------------------------- */
/* Timeline events                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write one AlShrouq event onto the order's timeline.
 *
 * Never throws. These run *after* the courier has been told something, and
 * failing the request at that point would invite a retry — and a retry means a
 * second delivery. Loud in the logs, silent to the agent: the same trade-off
 * `logAdminAction` makes, for the same reason.
 */
export async function recordDispatchEvent(
  orderId: string,
  actorId: string | null,
  action: "alshrouq_dispatched" | "alshrouq_status_changed" | "alshrouq_cancelled",
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("order_activity" as any)
      .insert({ order_id: orderId, actor_id: actorId, action, details } as any);
    if (error) throw new Error(error.message);
  } catch (e: any) {
    console.error("[alshrouq] failed to record timeline event", {
      action,
      error: e?.message ?? String(e),
    });
  }
}
