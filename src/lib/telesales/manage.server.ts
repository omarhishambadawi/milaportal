import type { ActorIdentity } from "./actions.server";

/**
 * Management operations: archiving an import, and moving leads in bulk.
 *
 * Server-only, `service_role`, one authorization check per entry point in
 * `telesales.functions.ts`. Everything here is an operation a supervisor
 * performs *on* the desk rather than work an agent does on a lead, which is why
 * it is a separate module from `actions.server.ts`.
 *
 * ===========================================================================
 * Nothing here deletes anything
 * ===========================================================================
 * "Remove this import" is implemented as an archive, and that is not timidity —
 * it is the only option that does not destroy the audit trail the module was
 * built to keep.
 *
 * `telesales_lead_activities.lead_id` is `ON DELETE CASCADE`, so a hard
 * `DELETE FROM telesales_leads` would silently take every call an agent ever
 * logged with it, straight through the append-only trigger that exists to stop
 * exactly that. A supervisor tidying up last month's import would erase the
 * record that somebody spoke to a customer, and nothing would say so.
 *
 * So rows are stamped `archived_at`, they leave the queue, and their history
 * stays readable. `restoreImport` exists because a reversible operation is the
 * only kind worth offering on a production dataset.
 */

/** What an archive would touch, counted before anything is written. */
export interface ArchiveImpact {
  importId: string;
  fileName: string;
  sourceType: string;
  alreadyArchived: boolean;
  sourceRecords: number;
  /** Leads generated *exclusively* from this import's rows. */
  leads: number;
  /** Open follow-ups on those leads. */
  followups: number;
  /**
   * Leads this import produced that have since been worked — a call logged, an
   * outcome recorded, or a conversion. Counted separately because archiving
   * them is a different decision from archiving 700 untouched rows, and the
   * confirmation dialog says so.
   */
  leadsWithActivity: number;
  /** Customers whose only leads come from this import. They are *not* archived
   *  — see `archiveImport` — but the count tells the operator what will empty. */
  customersAffected: number;
}

/**
 * Which leads belong exclusively to one import.
 *
 * "Exclusively" is the load-bearing word in the brief and it is not decoration.
 * A lead points at one `source_record_id`, so ownership looks unambiguous — but
 * a *retention cycle* generated from a converted lead has no source record at
 * all, and re-importing an overlapping file leaves a second source row whose
 * lead was refused by the dedup index and therefore still points at the first
 * import.
 *
 * So the rule is: a lead belongs to this import when its source record does,
 * **and** it has no child cycle that would be orphaned by archiving it. A lead
 * with a child is left alone; archiving it would strand a retention cycle whose
 * parent had vanished from the queue.
 *
 * The set itself is computed in `telesales_archive_impact` /
 * `telesales_archive_import` rather than here, because the archive has to be
 * atomic across three tables and a half-applied archive is a desk in a state no
 * screen describes.
 */

/** Count what an archive would do, without doing it. */
export async function describeArchiveImpact(
  supabase: any,
  importId: string,
): Promise<ArchiveImpact | null> {
  const { data: imp } = await supabase
    .from("telesales_imports")
    .select("id,file_name,source_type,archived_at")
    .eq("id", importId)
    .maybeSingle();
  if (!imp) return null;

  const { data, error } = await supabase.rpc("telesales_archive_impact", {
    _import_id: importId,
  });
  if (error) throw new Error(error.message);
  const row = (data as any[])?.[0] ?? {};

  return {
    importId,
    fileName: imp.file_name,
    sourceType: imp.source_type,
    alreadyArchived: Boolean(imp.archived_at),
    sourceRecords: Number(row.source_records ?? 0),
    leads: Number(row.leads ?? 0),
    followups: Number(row.followups ?? 0),
    leadsWithActivity: Number(row.leads_with_activity ?? 0),
    customersAffected: Number(row.customers_affected ?? 0),
  };
}

export interface ArchiveResult {
  importId: string;
  sourceRecords: number;
  leads: number;
  followups: number;
}

/**
 * Archive an import and everything generated exclusively from it.
 *
 * Order matters. Follow-ups are cancelled first so the
 * `telesales_followups_sync_lead` trigger clears `next_followup_on` while the
 * lead is still visible; archiving the lead first would leave a stale date on a
 * row nobody can see, which resurfaces the moment it is restored.
 *
 * Customers are deliberately **not** archived. A customer identity is shared
 * across imports and pipelines by construction — that is the whole point of
 * consolidating on the phone number — so removing a Cash import must not delete
 * the identity a Wasfaty lead is still pointing at. A customer whose leads have
 * all gone simply has no open work, which is a state the profile renders
 * correctly and which costs one row.
 */
export async function archiveImport(
  supabase: any,
  input: { importId: string; reason: string; actor: ActorIdentity },
): Promise<ArchiveResult> {
  const impact = await describeArchiveImpact(supabase, input.importId);
  if (!impact) throw new Error("That import no longer exists.");
  if (impact.alreadyArchived) throw new Error("That import is already archived.");

  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc("telesales_archive_import", {
    _import_id: input.importId,
    _actor: input.actor.userId,
    _reason: input.reason,
    _at: now,
  });
  if (error) throw new Error(error.message);
  const row = (data as any[])?.[0] ?? {};

  return {
    importId: input.importId,
    sourceRecords: Number(row.source_records ?? 0),
    leads: Number(row.leads ?? 0),
    followups: Number(row.followups ?? 0),
  };
}

/** Put an archived import back. The inverse, because a one-way operation on a
 *  production dataset is a trap. */
export async function restoreImport(
  supabase: any,
  input: { importId: string; actor: ActorIdentity },
): Promise<{ leads: number }> {
  const { data, error } = await supabase.rpc("telesales_restore_import", {
    _import_id: input.importId,
  });
  if (error) throw new Error(error.message);
  return { leads: Number((data as any[])?.[0]?.leads ?? 0) };
}

/* ------------------------------------------------------------------------- */
/* Bulk lead management                                                      */
/* ------------------------------------------------------------------------- */

export interface BulkResult {
  requested: number;
  changed: number;
  /** Ids the operation refused, with why. Never silent: a supervisor who
   *  selected 20 leads and changed 18 needs to know which two and why. */
  skipped: { id: string; reason: string }[];
}

/** How many leads one bulk call may touch. A supervisor selecting a page is
 *  the intended use; a thousand-lead sweep should be a generation run. */
export const BULK_LIMIT = 500;

/**
 * Assign, reassign or unassign many leads at once.
 *
 * `assigneeId: null` unassigns. This is manager-only at the server-function
 * boundary — an agent's single-lead claim goes through `assignLead`, which
 * enforces the ownership rule; this path deliberately bypasses that rule
 * because reassigning somebody else's lead is precisely what it is for.
 *
 * Archived leads are refused rather than silently skipped, because a supervisor
 * who selected them is working from a filter that included them and should be
 * told the filter was wrong.
 */
export async function bulkAssign(
  supabase: any,
  input: { leadIds: string[]; assigneeId: string | null; actor: ActorIdentity },
): Promise<BulkResult> {
  const ids = [...new Set(input.leadIds)].slice(0, BULK_LIMIT);
  if (ids.length === 0) return { requested: 0, changed: 0, skipped: [] };

  const { data: rows, error: readError } = await supabase
    .from("telesales_leads")
    .select("id,status,assigned_to,archived_at")
    .in("id", ids);
  if (readError) throw new Error(readError.message);

  const skipped: BulkResult["skipped"] = [];
  const actionable: string[] = [];
  for (const row of (rows as any[]) ?? []) {
    if (row.archived_at) {
      skipped.push({ id: row.id, reason: "archived" });
      continue;
    }
    if (row.assigned_to === input.assigneeId) {
      skipped.push({ id: row.id, reason: "already assigned to that agent" });
      continue;
    }
    actionable.push(row.id);
  }
  if (actionable.length === 0) return { requested: ids.length, changed: 0, skipped };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("telesales_leads")
    .update({
      assigned_to: input.assigneeId,
      assigned_at: input.assigneeId ? now : null,
      assigned_by: input.assigneeId ? input.actor.userId : null,
    })
    .in("id", actionable);
  if (error) throw new Error(error.message);

  /*
   * A lead sitting at `new` becomes `assigned`; anything further along keeps
   * the status it earned. Reassigning a lead that is mid-conversation must not
   * rewind it to "assigned" and lose the fact that somebody has already dialled.
   */
  if (input.assigneeId) {
    await supabase
      .from("telesales_leads")
      .update({ status: "assigned" })
      .in("id", actionable)
      .eq("status", "new");
  }

  await appendBulkActivities(supabase, {
    leadIds: actionable,
    actor: input.actor,
    activityType: input.assigneeId ? "assigned" : "unassigned",
    note: input.assigneeId ? "Assigned in bulk by a team lead" : "Unassigned in bulk",
    metadata: { to: input.assigneeId, bulk: true },
  });

  return { requested: ids.length, changed: actionable.length, skipped };
}

/**
 * Archive many leads.
 *
 * Soft, for the same reason `archiveImport` is: the activity log is the record
 * that a customer was called, and it must outlive the queue row.
 */
export async function bulkArchive(
  supabase: any,
  input: { leadIds: string[]; reason: string; actor: ActorIdentity },
): Promise<BulkResult> {
  const ids = [...new Set(input.leadIds)].slice(0, BULK_LIMIT);
  if (ids.length === 0) return { requested: 0, changed: 0, skipped: [] };

  const { data: rows } = await supabase
    .from("telesales_leads")
    .select("id,archived_at")
    .in("id", ids);

  const skipped: BulkResult["skipped"] = [];
  const actionable: string[] = [];
  for (const row of (rows as any[]) ?? []) {
    if (row.archived_at) skipped.push({ id: row.id, reason: "already archived" });
    else actionable.push(row.id);
  }
  if (actionable.length === 0) return { requested: ids.length, changed: 0, skipped };

  const now = new Date().toISOString();

  // Cancel open follow-ups first, so the sync trigger clears `next_followup_on`
  // while the lead is still live.
  await supabase
    .from("telesales_followups")
    .update({ status: "cancelled", completed_at: now, completed_by: input.actor.userId })
    .in("lead_id", actionable)
    .eq("status", "scheduled");

  const { error } = await supabase
    .from("telesales_leads")
    .update({ archived_at: now, archived_by: input.actor.userId, archive_reason: input.reason })
    .in("id", actionable);
  if (error) throw new Error(error.message);

  await appendBulkActivities(supabase, {
    leadIds: actionable,
    actor: input.actor,
    activityType: "closed",
    outcome: null,
    note: `Archived: ${input.reason}`,
    metadata: { archived: true, bulk: true },
  });

  return { requested: ids.length, changed: actionable.length, skipped };
}

/** Restore archived leads to the queue. */
export async function bulkRestore(
  supabase: any,
  input: { leadIds: string[]; actor: ActorIdentity },
): Promise<BulkResult> {
  const ids = [...new Set(input.leadIds)].slice(0, BULK_LIMIT);
  if (ids.length === 0) return { requested: 0, changed: 0, skipped: [] };

  /*
   * Read first, exactly as `bulkArchive` does.
   *
   * The obvious shortcut -- update `.not("archived_at","is",null)` and report
   * `ids.length` changed -- reports work that did not happen. A supervisor who
   * selects twenty rows of which five are archived would be told twenty were
   * restored, and the other fifteen would each gain a "reopened" entry in an
   * append-only timeline describing something that never occurred. Both the
   * count and the audit trail have to describe reality.
   */
  const { data: rows, error: readError } = await supabase
    .from("telesales_leads")
    .select("id,archived_at")
    .in("id", ids);
  if (readError) throw new Error(readError.message);

  const skipped: BulkResult["skipped"] = [];
  const actionable: string[] = [];
  for (const row of (rows as any[]) ?? []) {
    if (row.archived_at) actionable.push(row.id);
    else skipped.push({ id: row.id, reason: "not archived" });
  }
  if (actionable.length === 0) return { requested: ids.length, changed: 0, skipped };

  /*
   * `.not("archived_at","is",null)` stays on the write as well as the read.
   *
   * Between the two, another supervisor may have restored the same lead. The
   * condition makes the write a no-op in that case rather than a second
   * restore, which is the cheap form of the concurrency guarantee -- no lock,
   * no transaction, and the loser of the race simply changes nothing.
   */
  const { error } = await supabase
    .from("telesales_leads")
    .update({ archived_at: null, archived_by: null, archive_reason: null })
    .in("id", actionable)
    .not("archived_at", "is", null);
  if (error) throw new Error(error.message);

  await appendBulkActivities(supabase, {
    leadIds: actionable,
    actor: input.actor,
    activityType: "reopened",
    note: "Restored from the archive",
    metadata: { bulk: true },
  });

  /*
   * Restoring returns the lead to the queue and nothing more. Its dates are
   * untouched, so the lifecycle view re-derives from the same due date it had
   * before -- a lead archived in January comes back stale, which is the honest
   * answer. Restoring is not a way to make an old opportunity look new.
   */
  return { requested: ids.length, changed: actionable.length, skipped };
}

/**
 * One activity row per affected lead, in one insert.
 *
 * Bulk operations still write per-lead history — a supervisor moving 200 leads
 * leaves 200 entries, because "who moved this lead and when" is asked of one
 * lead at a time. `metadata.bulk` marks them so the timeline can group them if
 * it ever needs to.
 *
 * Deliberately never `activity_type: 'call'`: none of these is a customer
 * contact, and letting one through would corrupt every "last contacted by" on
 * the board.
 */
async function appendBulkActivities(
  supabase: any,
  input: {
    leadIds: string[];
    actor: ActorIdentity;
    activityType: string;
    outcome?: string | null;
    note: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const CHUNK = 250;
  for (let i = 0; i < input.leadIds.length; i += CHUNK) {
    await supabase.from("telesales_lead_activities").insert(
      input.leadIds.slice(i, i + CHUNK).map((leadId) => ({
        lead_id: leadId,
        activity_type: input.activityType,
        outcome: input.outcome ?? null,
        note: input.note,
        actor_id: input.actor.userId,
        actor_name: input.actor.name,
        actor_role: input.actor.role,
        metadata: input.metadata,
      })),
    );
  }
}
