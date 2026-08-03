/**
 * Calls-module access rules, shared by the client and the server.
 *
 * Team agents are confined to their own team's dashboard: a Telesales agent may
 * only open /calls/telesales, a Customer Care agent only /calls/customer-care.
 * Everything else in the module (the overview, Analytics Center, Diagnostics,
 * Configuration) stays closed to them, in the navigation and on direct URL
 * access alike.
 *
 * This module has no imports on purpose so the server functions can read the
 * same rules without pulling client-only code into the server bundle.
 */
export type CallsTeam = "customer_care" | "telesales";

export type CallsPage =
  | "overview"
  | "customer_care"
  | "telesales"
  | "analytics"
  | "diagnostics"
  | "configuration";

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
  return team ? page === team : true;
}
