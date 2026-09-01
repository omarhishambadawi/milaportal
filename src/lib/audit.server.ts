/**
 * Server-only audit trail for administrative actions.
 *
 * Every privileged write in `admin.functions.ts` — and the two self-service
 * password paths in `profile.functions.ts` — records what happened, who did it,
 * and to whom. Before this the only trace was a `console.log` line in the server
 * process, which is not queryable, not retained, and gone the moment the worker
 * recycles.
 *
 * The table is append-only by privilege (see 20260725003000): no UPDATE or DELETE
 * grant exists for anyone, so entries can be added but never rewritten.
 */

/**
 * The action vocabulary. A closed set rather than free-form strings, so a typo
 * cannot produce an event that no query will ever match, and so the list of what
 * is audited can be read in one place.
 */
export const AUDIT_ACTIONS = {
  userCreated: "user.created",
  userDeleted: "user.deleted",
  userActivated: "user.activated",
  userDeactivated: "user.deactivated",
  userProfileUpdated: "user.profile_updated",
  userRoleChanged: "user.role_changed",
  ownerGranted: "user.owner_granted",
  /** An administrator set a password directly. */
  passwordSetByAdmin: "user.password_set_by_admin",
  /** An administrator triggered the recovery email. */
  passwordResetEmailSent: "user.password_reset_email_sent",
  /** The account holder changed their own password (current password verified). */
  passwordChangedSelf: "user.password_changed_self",
  /** The account holder set a password through a recovery link. */
  passwordChangedViaRecovery: "user.password_changed_via_recovery",
  /** A temporary password passed its deadline and was rotated away. */
  temporaryPasswordExpired: "user.temporary_password_expired",
  /** A workbook was imported into the Branch Directory. */
  branchesImported: "branches.imported",
  /** A previous state of the Branch Directory was restored. */
  branchesRolledBack: "branches.rolled_back",
  /** One branch was corrected in place, from its card, without an import. */
  branchUpdated: "branches.updated",
  /** The global Shams automation switch was moved. */
  shamsAutomationToggled: "shams_sync.automation_toggled",
  /** A Shams schedule slot was created or edited. */
  shamsScheduleSaved: "shams_sync.schedule_saved",
  /** A Shams schedule slot was removed. */
  shamsScheduleDeleted: "shams_sync.schedule_deleted",
  /**
   * An administrator started a sync by hand from the Control Center.
   *
   * Audited because it is the first action in this integration that lets a
   * browser start work on a third-party production system.
   */
  shamsManualRun: "shams_sync.manual_run",
  /** A telesales source workbook was imported. */
  telesalesImported: "telesales.imported",
  /** Lead generation was run by hand rather than by the scheduler. */
  telesalesGenerated: "telesales.generated",
  /** The Cash / Wasfaty / retention date windows were changed. */
  telesalesSettingsSaved: "telesales.settings_saved",
  /**
   * A product's telesales eligibility was changed.
   *
   * Audited because it silently changes tomorrow's queue for the whole desk, and
   * there is no single lead whose timeline it belongs on.
   */
  telesalesProductChanged: "telesales.product_eligibility_changed",
  /** The Retention workbook backlog was seeded into the CRM. */
  telesalesBacklogSeeded: "telesales.retention_backlog_seeded",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  actorId: string | null;
  targetUserId: string | null;
  action: AuditAction;
  details?: Record<string, unknown>;
}

/**
 * Name and email of the audited account, read at the time of the action.
 *
 * Snapshotted into the entry because the log has to stay readable after the
 * account is gone — deleting a user is itself an audited event, and "deleted
 * <uuid>" tells an investigator nothing. Best-effort: a lookup failure must not
 * stop the action being recorded.
 */
export async function targetSnapshot(userId: string): Promise<Record<string, unknown>> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: profile }, { data: user }] = await Promise.all([
      supabaseAdmin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
      supabaseAdmin.auth.admin.getUserById(userId),
    ]);
    return {
      targetName: (profile as { full_name?: string } | null)?.full_name ?? null,
      targetEmail: user?.user?.email ?? null,
    };
  } catch {
    return {};
  }
}

/**
 * Write one audit entry.
 *
 * Never throws, and that is a deliberate trade-off rather than an oversight.
 * These calls run *after* the action they describe has already succeeded — the
 * password is changed, the role is granted. Failing the request at that point
 * would report an error for work that was in fact done, which is the more
 * dangerous of the two failure modes: the caller would retry, and retrying
 * "reset this password" issues a second credential.
 *
 * So a failed write is loud in the logs and invisible to the user. If the audit
 * trail is ever required to be provably complete, the fix is to write the entry
 * *before* the action and mark it committed afterwards — a two-phase change that
 * belongs with that requirement, not ahead of it.
 */
export async function logAdminAction(entry: AuditEntry): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("admin_activity" as any).insert({
      actor_id: entry.actorId,
      target_user_id: entry.targetUserId,
      action: entry.action,
      details: entry.details ?? {},
    } as any);
    if (error) throw new Error(error.message);
  } catch (e: any) {
    console.error("[audit] FAILED to record administrative action", {
      action: entry.action,
      actorId: entry.actorId,
      targetUserId: entry.targetUserId,
      error: e?.message ?? String(e),
    });
  }
}
