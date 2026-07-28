import { format, parseISO } from "date-fns";

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
  if (s.searching) qb = qb.or(buildSearchOr(s.term));
  return qb;
}

export function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}
