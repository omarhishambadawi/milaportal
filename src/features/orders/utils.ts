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
 * The digits of an order number, whichever way the agent wrote it.
 *
 * `orders.display_no` stores the bare number; the team prefix (`CC-`, `TS-`) is
 * added for display by `formatOrderNo`. So the number an agent reads off the
 * screen, off a WhatsApp message or off a colleague's note — `CC-3258`, `c-3258`,
 * `#3258` — is not the string in the column, and pasting it back into the search
 * box found nothing. That was the single most common way to search this page.
 *
 * Returns the digits for anything that is *only* an order number, and null for
 * everything else. The narrowness is the point: this adds one extra branch to the
 * search disjunction, and it must not fire for an ordinary word — "Ahmed" is a
 * customer, not order 0. A short alphabetic prefix is allowed (any of them, not
 * just the two the app emits, because `c-` and `cc-` are both what people type),
 * as is a leading `#`, a dash or a space between the two halves.
 *
 * Leading zeros are kept rather than stripped: the clause is an `ilike '%…%'`, so
 * `03258` should keep matching a `display_no` of `03258` and would stop if this
 * normalised it away.
 */
export function orderNumberTerm(term: string): string | null {
  const match = /^#?\s*(?:[a-z]{1,3}[-\s]?)?(\d{1,12})$/i.exec(term.trim());
  return match ? match[1] : null;
}

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

/** Format ISO date as "Friday, Jul 10, 2026". The order page and the export. */
export const fmtOrderDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "EEEE, MMM d, yyyy");
  } catch {
    return String(iso);
  }
};

/**
 * Format ISO date as "30/08/26" — the **list's** date.
 *
 * The table used `fmtOrderDate`, which spells the weekday out in full: "Friday,
 * Jul 10, 2026" needs about 168px of column on every row, and the weekday is
 * information the list header already carries once for the whole page (the
 * filter is a date range, so every row on screen is inside it). Down a column of
 * twenty-five rows it was the widest thing in the table and the least read.
 *
 * `dd/MM/yy`, fixed-width and tabular, so the column is 62px and the digits line
 * up. The long form stays on the order page and in the export, where there is
 * room for it and no surrounding date to read it against.
 */
export const fmtOrderDateShort = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "dd/MM/yy");
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

/**
 * Build an .or() filter string for PostgREST across searchable columns.
 *
 * Six `ilike` branches over the order's own text — every one of them backed by a
 * trigram index (`20260818120000_search_trigram_indexes.sql`), which is what lets
 * the planner turn the disjunction into a BitmapOr instead of a sequential scan.
 * Adding an unindexed column here would silently undo that for the whole OR.
 *
 * Two branches are conditional, and both exist because the thing an agent types
 * is not the thing the column stores:
 *
 *   * **the order number** — `display_no` holds `3258`, the screen shows
 *     `CC-3258`. `orderNumberTerm` recovers the digits from either spelling, so
 *     `3258`, `c-3258`, `CC-3258` and `#3258` all reach the same row.
 *   * **the agent** — `agent_name` is joined from `profiles`, not a column on
 *     `orders`, so a name is resolved to ids against the agent directory the page
 *     has already loaded and asked for as `agent_id.in.(…)`. Served by
 *     `orders_agent_idx`, so the OR stays indexable. This is the pattern
 *     Complaints already uses for the same reason.
 */
export function buildSearchOr(term: string, agentIds: readonly string[] = []): string {
  // PostgREST .or() needs values with commas escaped; we already normalised
  // out `,` / `%` / `*` / `.` / `(` / `)` in normalizeSearchTerm().
  const t = `%${term}%`;
  const parts = [
    `customer_name.ilike.${t}`,
    `customer_phone.ilike.${t}`,
    `invoice_no.ilike.${t}`,
    `display_no.ilike.${t}`,
    `branch_no.ilike.${t}`,
    `notes.ilike.${t}`,
  ];
  const orderNo = orderNumberTerm(term);
  // Only when the prefix actually changed the string — a bare `3258` is already
  // covered by the `display_no` branch above, and a duplicate branch is a second
  // index scan for the same rows.
  if (orderNo && orderNo !== term) parts.push(`display_no.ilike.%${orderNo}%`);
  // Ids are UUIDs from the directory, so there is nothing to escape.
  if (agentIds.length > 0) parts.push(`agent_id.in.(${agentIds.join(",")})`);
  return parts.join(",");
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
  /**
   * "all", or one of the `VerificationFilter` values. See `./verification` —
   * these are the same states the Call Centre column paints, expressed as a
   * filter, so the dropdown and the column cannot describe different sets.
   */
  verification: string;
  /** Narrow to the signed-in agent's starred orders. */
  starredOnly: boolean;
  /**
   * That agent's starred order ids. Read only when `starredOnly` is set, and
   * supplied by the caller rather than fetched here so this stays pure and the
   * list, the KPI strip and the export all narrow to one set.
   */
  starredIds: readonly string[];
  /**
   * Ids of the agents whose name matches the search term.
   *
   * Read only while `searching`, and resolved by the caller against the agent
   * directory it has already loaded — `agent_name` is a joined field, not a
   * column on `orders`, so there is nothing here to `ilike`.
   */
  searchAgentIds: readonly string[];
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
 * Narrow a query to an invoice-verification state.
 *
 * The SQL mirror of `matchesVerification`, and deliberately the same four cases
 * in the same order. `is` rather than `eq` for the negative side: the column is
 * nullable and `invoices_verified <> true` would drop a NULL row under SQL's
 * three-valued logic — the exact shape of the bug `applyFulfillment` above
 * carries a paragraph about. `not(col, is, true)` is the one spelling that keeps
 * "false or never set" together, which is what *Not verified* has to mean.
 */
function applyVerification(qb: any, verification: string) {
  switch (verification) {
    case "verified":
      return qb.is("invoices_verified", true);
    case "pending":
      return qb.not("invoices_verified", "is", true);
    case "call_centre":
      return qb.is("call_center_verified", true);
    case "non_call_centre":
      return qb.is("invoices_verified", true).not("call_center_verified", "is", true);
    default:
      return qb;
  }
}

/**
 * Apply the shared orders filter set to a PostgREST query builder. Pure: all
 * inputs are passed in, so the list page fetch and the export share one
 * implementation with identical semantics.
 *
 * Every narrowing is an independent `AND`, which is what makes the filters
 * compose: selecting a verification state does not disturb the status, the
 * branch or the date, and clearing one leaves the rest standing.
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
  qb = applyVerification(qb, s.verification);
  if (s.searching) qb = qb.or(buildSearchOr(s.term, s.searchAgentIds));
  return qb;
}

export function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}
