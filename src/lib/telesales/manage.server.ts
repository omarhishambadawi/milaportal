import type { ActorIdentity } from "./actions.server";

/**
 * Management operations: deleting an import, and moving leads in bulk.
 *
 * Server-only, `service_role`, one authorization check per entry point in
 * `telesales.functions.ts`. Everything here is an operation a supervisor
 * performs *on* the desk rather than work an agent does on a lead, which is why
 * it is a separate module from `actions.server.ts`.
 *
 * ===========================================================================
 * Delete used to mean archive, and no longer does
 * ===========================================================================
 * "Remove this import" was implemented as an archive: rows were stamped
 * `archived_at`, left the queue, and stayed in the history behind a badge. The
 * reasoning was sound — `telesales_lead_activities` is append-only precisely so
 * that a tidy-up cannot erase the record of somebody having spoken to a
 * customer — but it answered a different question from the one the desk was
 * asking. A file uploaded by mistake stayed on the screen forever, underneath
 * the corrected file that replaced it.
 *
 * So the distinction moved from *what the operation is* to *which rows it may
 * take*:
 *
 *   - A lead nobody has touched is an artefact of the import. It goes.
 *   - A lead somebody has called, actioned, converted, or raised a retention
 *     cycle from has become independent CRM activity. It stays, detached from
 *     the file it came from by the `ON DELETE SET NULL` the schema has carried
 *     since the first migration for exactly this reason.
 *
 * The call history the archive existed to protect is still protected, by the
 * same trigger, which now permits a delete only for the generator's own
 * `created` bookkeeping rows and only inside the purge. A mistake in the
 * selection above aborts the transaction rather than destroying a log.
 */

/** What a delete would take, counted before anything is written. */
export interface DeleteImpact {
  importId: string;
  fileName: string;
  sourceType: string;
  /** Parsed rows, which go with the import unconditionally. */
  sourceRecords: number;
  /** Leads that would be removed: generated, never worked. */
  leadsDeleted: number;
  /** Leads that would be kept and detached: worked, converted, or a parent. */
  leadsKept: number;
  /** Scheduled follow-ups on the leads that would be removed. */
  followups: number;
  /** Generation runs that would lose their import reference but survive. */
  runs: number;
}

export async function describeDeleteImpact(
  supabase: any,
  importId: string,
): Promise<DeleteImpact | null> {
  const { data: imp } = await supabase
    .from("telesales_imports")
    .select("id,file_name,source_type")
    .eq("id", importId)
    .maybeSingle();
  if (!imp) return null;

  const { data, error } = await supabase.rpc("telesales_delete_impact", {
    _import_id: importId,
  });
  if (error) throw new Error(error.message);
  const row = (data as any[])?.[0] ?? {};

  return {
    importId,
    fileName: imp.file_name,
    sourceType: imp.source_type,
    sourceRecords: Number(row.source_records ?? 0),
    leadsDeleted: Number(row.leads_deleted ?? 0),
    leadsKept: Number(row.leads_kept ?? 0),
    followups: Number(row.followups ?? 0),
    runs: Number(row.runs ?? 0),
  };
}

export interface DeleteResult {
  importId: string;
  fileName: string;
  sourceRecords: number;
  leadsDeleted: number;
  leadsKept: number;
}

/**
 * Delete an import, its rows, and the leads nobody worked.
 *
 * The impact is read first and returned in the result, because after the RPC
 * runs there is nothing left to count and the audit entry is the only record
 * that the file existed. One RPC does the work: it touches four tables and a
 * half-applied delete would leave source records pointing at an import that is
 * gone.
 */
export async function deleteImport(
  supabase: any,
  input: { importId: string; actor: ActorIdentity },
): Promise<DeleteResult> {
  const impact = await describeDeleteImpact(supabase, input.importId);
  if (!impact) throw new Error("That import no longer exists.");

  const { data, error } = await supabase.rpc("telesales_delete_import", {
    _import_id: input.importId,
  });
  if (error) throw new Error(error.message);
  const row = (data as any[])?.[0] ?? {};

  return {
    importId: input.importId,
    fileName: impact.fileName,
    sourceRecords: Number(row.source_records ?? 0),
    leadsDeleted: Number(row.leads_deleted ?? 0),
    leadsKept: Number(row.leads_kept ?? 0),
  };
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

/* ------------------------------------------------------------------------- */
/* Removing one lead                                                         */
/* ------------------------------------------------------------------------- */

export interface DeleteLeadResult {
  leadId: string;
  /** What actually happened. "archived" when the lead carried call history. */
  mode: "deleted" | "archived";
}

/**
 * Remove one lead from the operational views.
 *
 * The judgement is the database's, in `telesales_delete_lead`, and it is the
 * same rule `telesales_delete_import` applies to the leads an import raised: a
 * lead nobody has worked is an artefact and goes; a lead carrying a call log is
 * archived instead, because `telesales_lead_activities` is append-only and that
 * guarantee is not something a delete button gets to spend.
 *
 * One RPC rather than a read-then-write here: the decision and the write have to
 * see the same row, and the hard-delete path needs the transaction-local flag
 * that lets a 'created' activity row cascade.
 */
export async function deleteLead(
  supabase: any,
  input: { leadId: string; actor: ActorIdentity },
): Promise<DeleteLeadResult> {
  const { data, error } = await supabase.rpc("telesales_delete_lead", {
    _lead_id: input.leadId,
    _actor: input.actor.userId,
  });
  if (error) throw new Error(error.message);
  const mode = (data as { mode: string }[] | null)?.[0]?.mode;
  return { leadId: input.leadId, mode: mode === "archived" ? "archived" : "deleted" };
}
