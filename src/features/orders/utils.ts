import { format, parseISO } from "date-fns";
import { stripOrderPrefix } from "@/lib/branches";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { isFulfillmentGroup } from "./fulfillment";

export const toISO = (d: Date) => format(d, "yyyy-MM-dd");

export const normalizeSearchTerm = (value: string) =>
  value
    .replace(/[,%.*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/**
 * The term the Orders search actually queries with.
 *
 * `orders.display_no` stores the bare number — `3853` — while every screen, and
 * therefore every note, message and screenshot, shows it through `formatOrderNo`
 * as `CC-3853`. So the string an agent copies out of the app was one the app
 * could not find, and the most common search on the page was the one that did
 * not work.
 *
 * The fix is at the *term*, not in the query: a term that is exactly a prefixed
 * order number becomes the bare number before it is sent. That keeps `CC-3853`
 * and `3853` a single search, which matters because the term also goes to
 * `orders_kpi_summary` — normalising here means the table and the KPI cards
 * above it are still asking the same question, with no change to either query
 * and no second `display_no` clause to pay for.
 *
 * `stripOrderPrefix` is the existing helper (`lib/branches`), the one
 * `formatOrderNo`'s prefixes come from, so the two cannot drift. It is applied
 * only when it actually removed a prefix **and** what is left is all digits —
 * an ordinary word must never be rewritten, and a customer called "CC-Pharmacy"
 * is still searched for verbatim. Nothing about how order numbers are stored or
 * displayed changes.
 */
export function toSearchTerm(value: string): string {
  const term = normalizeSearchTerm(value);
  const stripped = stripOrderPrefix(term);
  return stripped !== term && /^\d+$/.test(stripped) ? stripped : term;
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
 * Display only: the stored value, the sort (`order_date` in Postgres) and the
 * date-range filter are all untouched, and the long form above still serves the
 * order page and the XLSX export, where there is room for it.
 *
 * The list needed a narrower one. "Friday, Jul 10, 2026" spells out a weekday
 * the page header already states once for the whole range, and it was the widest
 * column in the table for the least-read fact in it. Fixed-width and tabular, so
 * the digits line up down the column.
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
 * Format a timestamp as "02:45 PM" — the clock time under the list's date.
 *
 * The second line of the Date and time column, and it reads `created_at`
 * because `order_date` is a `date`: there is no time in the column the line
 * above it shows. That makes this **when the order was entered**, which is the
 * same day for 99.5% of orders and deliberately not claimed to be anything more
 * for the rest — an order entered the morning after the shift it belongs to
 * keeps its own `order_date` above and shows the hour it was actually typed.
 *
 * `Intl`, not date-fns, and pinned to `BUSINESS_TIMEZONE`. The date above is a
 * plain `date` and has no zone to get wrong; a `timestamptz` does — it is stored
 * UTC, and formatting it in the reader's local zone would print a different hour
 * for the same order in Riyadh and Cairo. That is the exact drift `lib/timezone`
 * exists to have ended, and the order page's activity timeline already formats
 * its timestamps this way.
 *
 * Two-digit hour, where the timeline uses a bare one: this is a column, the
 * value sits under a fixed-width `dd/MM/yy` and is rendered `tabular-nums`, so a
 * 9 AM order should not shift the colon out of line with the 10 AM order below
 * it.
 */
export const fmtOrderTimeShort = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(at);
  } catch {
    return "—";
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
  /**
   * "all" | "verified" | "unverified" — the Invoice Verification filter, over
   * `orders.invoices_verified`. See `./verification`.
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
 * The mirror of `matchesVerification`, and one line each. The negative uses
 * `not(col, is, true)` rather than `eq(col, false)`: `invoices_verified` is
 * nullable and an order the MIS has not answered for holds NULL, so the obvious
 * spelling would drop exactly the orders *Non verified* is asking for — the same
 * three-valued-logic trap `applyFulfillment` above carries a paragraph about.
 */
function applyVerification(qb: any, verification: string) {
  if (verification === "verified") return qb.is("invoices_verified", true);
  if (verification === "unverified") return qb.not("invoices_verified", "is", true);
  return qb;
}

/**
 * Apply the shared orders filter set to a PostgREST query builder. Pure: all
 * inputs are passed in, so the list page fetch and the export share one
 * implementation with identical semantics.
 *
 * Every narrowing is an independent `AND`, which is what makes the filters
 * compose: adding a verification state does not disturb the status, the team,
 * the agent or the date, and clearing one leaves the rest standing.
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
  if (s.searching) qb = qb.or(buildSearchOr(s.term));
  return qb;
}

export function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}
