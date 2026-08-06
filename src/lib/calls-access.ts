/**
 * Calls-module access rules, shared by the client and the server.
 *
 * Team agents are confined to their own team's dashboard: a Telesales agent may
 * only open /calls/telesales, a Customer Care agent only /calls/customer-care.
 * Everything else in the module (the overview, Diagnostics, Configuration)
 * stays closed to them, in the navigation and on direct URL access alike.
 *
 * This module has no imports on purpose so the server functions can read the
 * same rules without pulling client-only code into the server bundle.
 */
export type CallsTeam = "customer_care" | "telesales";

export type CallsPage =
  | "overview"
  | "customer_care"
  | "telesales"
  | "lookup"
  | "diagnostics"
  | "configuration";

/**
 * Pages every holder of the Calls view permission may open, team agents
 * included.
 *
 * Only Call Lookup is on this list. It answers one question — has anyone here
 * spoken to this number before, and who — which is most useful to the agent with
 * that customer already on the line, and which the confinement rule would
 * otherwise deny them. It is a per-number history rather than a dashboard: it
 * aggregates nothing, ranks nobody and exposes no team's performance, so
 * widening it does not hand an agent the other team's analytics.
 */
const UNCONFINED_PAGES: ReadonlySet<CallsPage> = new Set<CallsPage>(["lookup"]);

/**
 * The single Calls page a role is confined to, or null when the role is not a
 * team agent (administrators, supervisors and auditors are unrestricted here and
 * keep whatever the permission gates already grant them).
 */
export function callsTeamForRole(role: string | null | undefined): CallsTeam | null {
  return role === "telesales" || role === "customer_care" ? role : null;
}

/** True when the role may open `page`, given it already passes the view gate. */
export function callsPageAllowedForRole(role: string | null | undefined, page: CallsPage): boolean {
  const team = callsTeamForRole(role);
  if (!team) return true;
  return page === team || UNCONFINED_PAGES.has(page);
}
