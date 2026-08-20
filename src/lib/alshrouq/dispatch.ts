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

import { ALSHROUQ, stripOrderPrefix } from "@/lib/branches";
import {
  readAlShrouqState,
  validateAlShrouqOrder,
  type AlShrouqOrderInput,
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
  /** AlShrouq's own order number — the one quoted when chasing a delivery. */
  externalOrderId: string | null;
  status: string | null;
  statusDetail: string | null;
  trackingUrl: string | null;
  paymentType: number | null;
  alshrouqBranchId: string;
  mapUrl: string | null;
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
  /** Distinguishes "not covered" from "not in the mapping", for the message. */
  coverage: BranchCoverage["kind"];
  dispatch: AlShrouqDispatchRecord | null;
  /**
   * This order predates the integration and is not part of it.
   *
   * When true the panel shows a note and no action at all: the blockers list is
   * empty, because "no delivery location" is not something to fix on an order
   * that was delivered months ago by a person on a phone.
   */
  historical: boolean;
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
  /** Where the delivery goes — captured on the order form, not in the panel. */
  alshrouq_map_url: string | null;
  alshrouq_lat: number | string | null;
  alshrouq_lng: number | string | null;
  alshrouq_payment_type: number | string | null;
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
  "id, display_no, team, agent_id, branch_no, customer_name, customer_phone, invoice_value, notes, delivery_type, status, alshrouq_map_url, alshrouq_lat, alshrouq_lng, alshrouq_payment_type";

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
  // A blank string is absence, not zero. `Number("")` is 0, which would turn a
  // NULL numeric column into a courier order worth nothing at all.
  if (typeof v === "string" && v.trim() === "") return null;
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
    externalOrderId: row.external_order_id ?? null,
    status: row.status ?? null,
    statusDetail: row.status_detail ?? null,
    trackingUrl: row.tracking_url ?? null,
    paymentType: numberOrNull(row.payment_type),
    alshrouqBranchId: row.alshrouq_branch_id,
    mapUrl: row.customer_address ?? null,
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

/** How a branch stands with AlShrouq, according to the CRM. */
export type BranchCoverage =
  | { kind: "covered"; alshrouqBranchId: string }
  /** The CRM knows the branch and says AlShrouq does not serve it. */
  | { kind: "not_covered"; name: string; note: string | null }
  /** No branch chosen, or the CRM's mapping has no such code. */
  | { kind: "unmapped" };

/**
 * Where AlShrouq collects this order from, resolved against the live CRM config.
 *
 * Deliberately **not** a database lookup. The mapping used to be a 137-row seed
 * frozen into a migration, and it was wrong for 87 branches — 27 of them mapped
 * to another pharmacy's id, which dispatches a real delivery to the wrong shop.
 * The CRM publishes the mapping on `GET /integrations/alshrouq/config` and keeps
 * it current, so that is what the Portal reads; there is no local copy to drift.
 *
 * A branch the CRM marks `covered: false` is refused rather than sent, because
 * AlShrouq will not collect from it and a submitted order would simply sit.
 */
export async function branchCoverage(branchNo: string | null): Promise<BranchCoverage> {
  if (!branchNo?.trim()) return { kind: "unmapped" };
  const { fetchAlShrouqConfig } = await import("@/lib/shams-crm/alshrouq.server");
  const config = await fetchAlShrouqConfig();
  const match = config.branches.find((b) => b.code === branchNo.trim());
  if (!match) return { kind: "unmapped" };
  if (!match.covered) return { kind: "not_covered", name: match.name, note: match.note };
  return { kind: "covered", alshrouqBranchId: match.id };
}

/** The id when the branch is dispatchable, and null for every other outcome. */
export function coveredBranchId(coverage: BranchCoverage): string | null {
  return coverage.kind === "covered" ? coverage.alshrouqBranchId : null;
}

/**
 * The identity handed to the CRM: the order's operational number, bare.
 *
 * `display_no` is stored as `#6529`; `stripOrderPrefix` takes it to `6529`,
 * which is exactly what the CRM's own dispatch history holds. It is emphatically
 * **not** `formatOrderNo`, which renders `CC-6529` for a screen — sending that
 * would give the same order two different names across the two systems and make
 * the duplicate lookup unable to recognise its own work.
 */
export function clientOrderIdFor(order: OrderForDispatch): string {
  return stripOrderPrefix(String(order.display_no ?? "").trim());
}

/**
 * An AlShrouq order that predates this integration and must stay out of it.
 *
 * ## The signal, and why it is this one
 *
 * Two persisted facts, both owned by the integration itself:
 *
 *   1. the order carries no delivery data — `alshrouq_lat`, `alshrouq_lng` and
 *      `alshrouq_payment_type` are all null, and
 *   2. the integration has never recorded a dispatch for it.
 *
 * Every row that existed when `…_alshrouq_order_delivery` added those columns
 * has them null by construction, and every order created through the new form
 * has all three — `orderFormSchema` will not save an AlShrouq order without
 * them. So "no delivery data" *is* "created before the integration", derived
 * from the schema rather than asserted by a flag or inferred from a date.
 *
 * `delivery_type` alone is deliberately not enough: it reads `AlShrouq` on both
 * kinds of order, which is exactly why an old order started being asked for
 * fields it will never have.
 *
 * ## Why it cannot drift
 *
 * The decision is made from the row **as stored**, never from what is on screen.
 * An agent typing coordinates into an old order therefore cannot turn it into a
 * dispatchable one — and because the form does not offer those fields on a
 * historical order, nothing can populate them in the first place. A historical
 * order stays historical.
 *
 * A cancelled dispatch still counts as (2): the order was in the integration,
 * was withdrawn, and re-sending it is a normal thing to do.
 */
export function isHistoricalAlShrouqOrder(
  order: OrderForDispatch,
  hasEverDispatched: boolean,
): boolean {
  if (order.delivery_type !== ALSHROUQ) return false;
  if (hasEverDispatched) return false;
  return (
    numberOrNull(order.alshrouq_lat) === null &&
    numberOrNull(order.alshrouq_lng) === null &&
    numberOrNull(order.alshrouq_payment_type) === null
  );
}

/** Worded for the agent looking at an order the integration will not touch. */
export const HISTORICAL_ALSHROUQ_NOTICE =
  "Historical AlShrouq order — automatic dispatch is not applicable.";

/**
 * The order's own inputs, in the shape the CRM contract takes.
 *
 * One place builds this, so the check that runs before dispatch and the payload
 * that is actually sent can never disagree about what the order says.
 */
export function dispatchInputFor(
  order: OrderForDispatch,
  alshrouqBranchId: string | null,
): AlShrouqOrderInput {
  return {
    alshrouqBranchId,
    clientOrderId: clientOrderIdFor(order),
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    mapUrl: order.alshrouq_map_url,
    paymentType: numberOrNull(order.alshrouq_payment_type),
    details: order.notes,
    lat: numberOrNull(order.alshrouq_lat),
    lng: numberOrNull(order.alshrouq_lng),
    value: numberOrNull(order.invoice_value) ?? 0,
    preparationTime: null,
  };
}

/**
 * What must be fixed on the *order* before it can be sent.
 *
 * Everything AlShrouq needs now lives on the order itself — the location and the
 * payment method are captured on the order form rather than typed into a
 * separate panel — so this validates the real values rather than stubbing the
 * ones a panel used to collect.
 */
export function dispatchBlockers(order: OrderForDispatch, coverage: BranchCoverage): string[] {
  const blockers = validateAlShrouqOrder(dispatchInputFor(order, coveredBranchId(coverage))).map(
    (e) => e.message,
  );

  // Said in the CRM's own terms, replacing the generic "no AlShrouq id": a
  // branch the courier does not serve is a different problem from one the
  // mapping has never heard of, and only the first has a note worth reading.
  if (coverage.kind === "not_covered") {
    return blockers.map((m) =>
      m.startsWith("This branch has no AlShrouq id")
        ? `AlShrouq does not cover ${coverage.name}${coverage.note ? ` (${coverage.note})` : ""}.`
        : m,
    );
  }
  return blockers;
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
export type AlShrouqEvent =
  /** Written *before* the POST, so an interrupted attempt still leaves a trace. */
  | "alshrouq_submission_started"
  | "alshrouq_dispatched"
  /** The create failed and the CRM does not have the order. Safe to retry. */
  | "alshrouq_failed"
  /** A create whose outcome was unknown turned out to have already landed. */
  | "alshrouq_recovered"
  | "alshrouq_status_changed"
  | "alshrouq_cancelled";

export async function recordDispatchEvent(
  orderId: string,
  actorId: string | null,
  action: AlShrouqEvent,
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
