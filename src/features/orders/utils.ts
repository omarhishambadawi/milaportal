import { format, parseISO } from "date-fns";
import { isFulfillmentGroup } from "./fulfillment";

export const toISO = (d: Date) => format(d, "yyyy-MM-dd");

export const normalizeSearchTerm = (value: string) =>
  value
    .replace(/[,%.*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/**
 * The selected day, split so the weekday can be emphasised.
 *
 * `weekday` is null for a multi-day range: "Monday" over a week of orders would
 * be describing only the first of them.
 */
export function describeDateRange(
  from: Date | undefined,
  to: Date | undefined,
): { weekday: string | null; date: string } {
  if (!from) return { weekday: null, date: "Pick a date" };
  const singleDay = !to || toISO(from) === toISO(to);
  if (singleDay) {
    return { weekday: format(from, "EEEE"), date: format(from, "MMMM d, yyyy") };
  }
  return { weekday: null, date: `${format(from, "d MMM yyyy")} — ${format(to, "d MMM yyyy")}` };
}

/** Format ISO date as "Friday, Jul 10, 2026". */
export const fmtOrderDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "EEEE, MMM d, yyyy");
  } catch {
    return String(iso);
  }
};

/**
 * The invoice numbers recorded on an order.
 *
 * `orders.invoice_no` is one text column holding one *or many* numbers — the
 * form joins them with `", "`, and older rows separate them with newlines — so
 * every reader has to split it, and the separator set is the thing they must
 * agree on. This was open-coded identically in three places (the form's load,
 * the list's `InvoiceCell`, and now the Shams panel); it is one function so that
 * a number saved by the form is the same number the panel looks up.
 *
 * Order is preserved and blanks are dropped: a trailing separator, or a row the
 * agent cleared without removing, is not an invoice number.
 */
export function parseInvoiceNumbers(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build an .or() filter string for PostgREST across searchable columns. */
export function buildSearchOr(term: string): string {
  // PostgREST .or() needs values with commas escaped; we already normalised
  // out `,` / `%` / `*` / `.` / `(` / `)` in normalizeSearchTerm().
  const t = `%${term}%`;
  return [
    `customer_name.ilike.${t}`,
    `customer_phone.ilike.${t}`,
    `invoice_no.ilike.${t}`,
    `display_no.ilike.${t}`,
    `branch_no.ilike.${t}`,
    `notes.ilike.${t}`,
  ].join(",");
}

/** Filter values applied to an orders PostgREST query builder. */
export interface OrderFilterState {
  searching: boolean;
  from: string;
  to: string;
  team: string;
  status: string;
  mineOnly: boolean;
  userId: string | undefined;
  /**
   * Whether this caller may narrow the list to one agent.
   *
   * Was `isAdmin`, which is why an Auditor — a role whose entire purpose is
   * reviewing other people's work, and which holds `view_all_agents` — could not
   * pick an agent. The permission named for this governs it now; RLS is still
   * the thing that decides which rows come back, so a caller who sets `agent`
   * without being able to see those rows gets an empty page rather than a leak.
   */
  canFilterAgents: boolean;
  agent: string;
  term: string;
  /**
   * "all", a fulfillment group ("delivery" / "pickup"), or one `delivery_type`
   * verbatim ("AlShrouq", "Azman", "Branch Scooter", "Store Pickup").
   * See FULFILLMENT_OPTIONS.
   */
  fulfillment: string;
  /** Narrow to the signed-in agent's starred orders. */
  starredOnly: boolean;
  /**
   * That agent's starred order ids. Read only when `starredOnly` is set, and
   * supplied by the caller rather than fetched here so this stays pure and the
   * list, the KPI strip and the export all narrow to one set.
   */
  starredIds: readonly string[];
}

/**
 * Narrow a query to a fulfillment group or to one delivery method.
 *
 * The three cases mirror `classifyFulfillment` exactly, and the third is the one
 * that was wrong. `not(delivery_type, ilike, %pickup%)` reads as "everything that
 * is not a pickup", but SQL's three-valued logic makes it "everything that is
 * known not to be a pickup": for a row with no method recorded, `NULL NOT ILIKE
 * '%pickup%'` is NULL rather than true, so the row was dropped. The KPI RPC
 * beside it wrote `COALESCE(delivery_type,'') NOT ILIKE …`, which counts that same
 * row as a delivery — so the table and the cards above it were totalling
 * different sets, and the filter looked broken because it *was* inconsistent.
 *
 * Both now say the same thing, and say it explicitly: a row with no method is in
 * neither group. Selecting Delivery therefore returns El Shorouk, Azman and
 * Branch Scooter — the whole point of a group filter is that it does not care
 * which courier — and selecting a single method is a plain equality test that
 * cannot fall out of step with the group containing it.
 */
function applyFulfillment(qb: any, fulfillment: string) {
  if (fulfillment === "all") return qb;

  if (!isFulfillmentGroup(fulfillment)) {
    // An individual method: the stored value, verbatim.
    return qb.eq("delivery_type", fulfillment);
  }

  if (fulfillment === "pickup") return qb.ilike("delivery_type", "%pickup%");

  return qb
    .not("delivery_type", "is", null)
    .neq("delivery_type", "")
    .not("delivery_type", "ilike", "%pickup%");
}

/**
 * Apply the shared orders filter set to a PostgREST query builder. Pure: all
 * inputs are passed in, so the list page fetch and the export share one
 * implementation with identical semantics.
 */
export function applyOrderFilters(qb: any, s: OrderFilterState) {
  if (!s.searching) qb = qb.gte("order_date", s.from).lte("order_date", s.to);
  if (s.team !== "all") qb = qb.eq("team", s.team as "customer_care" | "telesales");
  if (s.status !== "all") qb = qb.eq("status", s.status);
  if (s.mineOnly && s.userId) qb = qb.eq("agent_id", s.userId);
  if (s.canFilterAgents && s.agent !== "all") qb = qb.eq("agent_id", s.agent);
  // Starred is a narrowing like any other, so it composes with the date range,
  // the team, the fulfillment method and the search rather than replacing them,
  // and pagination still happens server-side over the narrowed set. An empty
  // list is passed through as `id IN ()` — an agent with no stars who turns the
  // filter on has no starred orders, and that is the honest answer.
  if (s.starredOnly) qb = qb.in("id", s.starredIds as string[]);
  qb = applyFulfillment(qb, s.fulfillment);
  if (s.searching) qb = qb.or(buildSearchOr(s.term));
  return qb;
}

export function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}
