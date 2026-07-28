/**
 * Client-safe half of the administrative audit trail.
 *
 * `audit.server.ts` owns the *writing* side and must never reach a browser
 * bundle: it dynamically imports `client.server`, which reads the service-role
 * key. This module holds what both sides legitimately need — the page size the
 * server paginates by and the vocabulary the UI renders — so the read path can be
 * built without importing the server module for its constants.
 *
 * The label map is checked against `AuditAction` with `satisfies`, and the type
 * import is erased at compile time (`verbatimModuleSyntax: false`), so adding an
 * action to `AUDIT_ACTIONS` without giving it a label is a type error rather than
 * a row that renders as a raw `user.something` string.
 */
import type { AuditAction } from "@/lib/audit.server";

/** Entries fetched per "Load more" step. */
export const ACTIVITY_PAGE_SIZE = 50;

/**
 * Hard ceiling on a single request.
 *
 * The log is append-only and paged by *growing the limit* rather than by an
 * offset or a keyset cursor (see `adminListActivity`), so an unbounded limit is
 * one click away from asking for the whole table. Older entries stay reachable by
 * filtering to a user; this bounds the widest possible query.
 */
export const ACTIVITY_MAX_ROWS = 500;

/**
 * Short label for each audited action.
 *
 * Written from the actor's side ("Reset the password"), because every row is
 * already attributed to an actor and a target — repeating "Admin X set user Y's
 * password" in the label would say twice what the row's own byline says once.
 */
export const AUDIT_ACTION_LABEL = {
  "user.created": "Created the account",
  "user.deleted": "Deleted the account",
  "user.activated": "Reactivated the account",
  "user.deactivated": "Deactivated the account",
  "user.profile_updated": "Edited the profile",
  "user.role_changed": "Changed the role",
  "user.owner_granted": "Granted the Owner role",
  "user.password_set_by_admin": "Set a password",
  "user.password_reset_email_sent": "Sent a password reset email",
  "user.password_changed_self": "Changed their own password",
  "user.password_changed_via_recovery": "Set a password via recovery link",
  "user.temporary_password_expired": "Temporary password expired and was rotated",
  "branches.imported": "Imported the Branch Directory",
  "branches.rolled_back": "Rolled the Branch Directory back",
  "branches.updated": "Edited a branch",
} as const satisfies Record<AuditAction, string>;

/**
 * Actions that change what an account can do or who can sign into it.
 *
 * Rendered with emphasis in the log: an investigator scanning a page of entries
 * is looking for these, and a profile rename should not compete with an Owner
 * grant for attention.
 */
export const SENSITIVE_AUDIT_ACTIONS: readonly AuditAction[] = [
  "user.deleted",
  "user.role_changed",
  "user.owner_granted",
  "user.password_set_by_admin",
  "user.deactivated",
  // A rollback silently replaces every branch record with an older copy. It is
  // the one branch action that can undo someone else's correction without
  // leaving a trace in the data itself.
  "branches.rolled_back",
];

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTION_LABEL as Record<string, string>)[action] ?? action;
}

export function isSensitiveAuditAction(action: string): boolean {
  return (SENSITIVE_AUDIT_ACTIONS as readonly string[]).includes(action);
}
