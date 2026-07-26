import { format, parseISO } from "date-fns";

export const toISO = (d: Date) => format(d, "yyyy-MM-dd");

export const normalizeSearchTerm = (value: string) =>
  value
    .replace(/[,%.*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** Format ISO date as "Friday, Jul 10, 2026". */
export const fmtOrderDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "EEEE, MMM d, yyyy");
  } catch {
    return String(iso);
  }
};

/** Short form for mobile / dense cells: "Fri, Jul 10". */
export const fmtOrderDateShort = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "EEE, MMM d");
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
  isAdmin: boolean;
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
  if (s.isAdmin && s.agent !== "all") qb = qb.eq("agent_id", s.agent);
  if (s.searching) qb = qb.or(buildSearchOr(s.term));
  return qb;
}

export function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}
