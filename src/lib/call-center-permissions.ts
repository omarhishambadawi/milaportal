/**
 * Single source of truth for the permissions that grant access to the Call
 * Center Analytics feature (the page, its sidebar entry, and its server data
 * functions).
 *
 * A user may view Call Center Analytics if they hold ANY of these permissions.
 * Administrators always pass — every caller applies its own admin short-circuit
 * (`hasPerm` on the client, `is_administrator` on the server).
 *
 * This module has no imports on purpose, so it is safe to consume from both the
 * client bundle (via `canViewCallCenter` in permissions.ts) and the server
 * functions in yeastar.functions.ts. It defines only the access GATE; it does
 * not change any role or permission definitions.
 */
export const CALL_CENTER_VIEW_PERMISSIONS = ["view_call_center", "view_team_analytics"] as const;
