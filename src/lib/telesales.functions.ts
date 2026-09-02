import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ActorIdentity } from "@/lib/telesales/actions.server";

/**
 * The Telesales CRM write surface.
 *
 * Reads are not here. The queue, the lead detail and the management board go
 * straight to PostgREST under RLS, because they are ordinary filtered selects
 * and routing them through a server function would reimplement paging badly.
 * What is here is every write, because not one of them is a single row: recording
 * an outcome updates the lead, settles a follow-up, may open another and appends
 * to an append-only timeline, and a browser that managed three of those four
 * would leave a lead whose state disagrees with its own history.
 *
 * ### Authorization is checked twice, on purpose
 *
 * Once here, through `has_permission()` — the same oracle the RLS policies call,
 * so the page and the database cannot drift — and once inside the pure
 * `canActOnLead` rule, which decides whether *this* agent may touch *this* lead.
 * The first is "may you work leads at all"; the second is "is this one yours".
 * They are different questions and a single check would answer only one.
 */

/* ------------------------------------------------------------------------- */
/* Authorization                                                             */
/* ------------------------------------------------------------------------- */

async function hasPermission(supabase: any, userId: string, permission: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: permission,
  });
  if (error) {
    console.error("[telesales/authz] has_permission RPC error", {
      permission,
      error: error.message,
    });
    throw new Error("Forbidden: authorization check failed");
  }
  return Boolean(data);
}

/**
 * Who is acting, and what they may do.
 *
 * Resolved once per call and passed down, rather than re-asked by each helper:
 * three RPCs and a profile read per keystroke is what turns a one-click queue
 * into a slow one.
 *
 * The display name and role are read here so they can be *denormalised into the
 * activity row*. That is why they are fetched at all — `actor_id` is
 * `ON DELETE SET NULL`, so a deleted account would otherwise erase its own name
 * from every call it ever logged.
 */
async function resolveActor(
  supabase: any,
  userId: string,
  require: "work" | "manage" | "view",
): Promise<ActorIdentity> {
  const [canView, canWork, canManage] = await Promise.all([
    hasPermission(supabase, userId, "view_telesales"),
    hasPermission(supabase, userId, "work_telesales"),
    hasPermission(supabase, userId, "manage_telesales"),
  ]);

  const needed =
    require === "manage" ? canManage : require === "work" ? canWork || canManage : canView;
  if (!needed) {
    console.warn("[telesales/authz] refused", { userId, require });
    throw new Error(
      require === "manage"
        ? "Forbidden: telesales management access required"
        : require === "work"
          ? "Forbidden: telesales agent access required"
          : "Forbidden: telesales access required",
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  return {
    userId,
    canWork: canWork || canManage,
    canManage,
    name: (profile as { full_name: string } | null)?.full_name ?? null,
    role: (roleRow as { role: string } | null)?.role ?? null,
  };
}

/**
 * The service-role client.
 *
 * Imported inside the handler, never at module scope: this file is reachable
 * from route files, which ship to the browser, and a top-level import of
 * `client.server.ts` would drag the service key's loader into the client bundle.
 */
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

/* ------------------------------------------------------------------------- */
/* Schemas                                                                   */
/* ------------------------------------------------------------------------- */

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");
const note = z.string().trim().max(2000);

/* ------------------------------------------------------------------------- */
/* Agent actions                                                             */
/* ------------------------------------------------------------------------- */

export const telesalesAssignLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leadId: uuid,
        // null unassigns; a manager may name anyone, an agent is downgraded to
        // a self-claim by `assignLead`.
        assigneeId: uuid.nullable(),
        note: note.optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { assignLead } = await import("@/lib/telesales/actions.server");
    const result = await assignLead(await admin(), {
      leadId: data.leadId,
      assigneeId: data.assigneeId,
      actor,
      note: data.note ?? null,
    });
    return { ok: true as const, ...result };
  });

export const telesalesRecordOutcome = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leadId: uuid,
        outcomeKey: z.string().min(1).max(64),
        note: note.optional(),
        followupDueOn: businessDate.nullable().optional(),
        // Wall-clock, HH:MM. Not an instant — see the column comment on
        // `telesales_followups.due_time`.
        followupTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .nullable()
          .optional(),
        followupReason: z.string().trim().max(300).nullable().optional(),
        orderId: uuid.nullable().optional(),
        orderValue: z.number().nonnegative().max(1_000_000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { recordOutcome } = await import("@/lib/telesales/actions.server");
    const result = await recordOutcome(await admin(), {
      leadId: data.leadId,
      outcomeKey: data.outcomeKey,
      note: data.note ?? null,
      followupDueOn: data.followupDueOn ?? null,
      followupTime: data.followupTime ?? null,
      followupReason: data.followupReason ?? null,
      orderId: data.orderId ?? null,
      orderValue: data.orderValue ?? null,
      actor,
    });
    return { ok: true as const, ...result };
  });

export const telesalesAddNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadId: uuid, note: note.min(1) }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { addNote } = await import("@/lib/telesales/actions.server");
    await addNote(await admin(), { leadId: data.leadId, note: data.note, actor });
    return { ok: true as const };
  });

export const telesalesScheduleFollowup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leadId: uuid,
        dueOn: businessDate,
        dueTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .nullable()
          .optional(),
        reason: z.string().trim().max(300).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { scheduleFollowup } = await import("@/lib/telesales/actions.server");
    await scheduleFollowup(await admin(), {
      leadId: data.leadId,
      dueOn: data.dueOn,
      dueTime: data.dueTime ?? null,
      reason: data.reason ?? null,
      actor,
    });
    return { ok: true as const };
  });

export const telesalesCloseLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadId: uuid, reason: note.min(1) }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { closeLead } = await import("@/lib/telesales/actions.server");
    await closeLead(await admin(), { leadId: data.leadId, reason: data.reason, actor });
    return { ok: true as const };
  });

export const telesalesReopenLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadId: uuid, reason: note.min(1) }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    // Manager-only, and `reopenLead` asserts it again against the resolved
    // actor rather than trusting this line.
    const actor = await resolveActor(supabase, userId, "manage");
    const { reopenLead } = await import("@/lib/telesales/actions.server");
    await reopenLead(await admin(), { leadId: data.leadId, reason: data.reason, actor });
    return { ok: true as const };
  });

export const telesalesSetPatientPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        patientId: z.string().trim().min(1).max(64),
        phone: z.string().trim().min(6).max(32),
        leadId: uuid.nullable().optional(),
        prescriptionNo: z.string().trim().max(64).nullable().optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "work");
    const { setPatientPhone } = await import("@/lib/telesales/actions.server");
    const result = await setPatientPhone(await admin(), {
      patientId: data.patientId,
      phone: data.phone,
      leadId: data.leadId ?? null,
      prescriptionNo: data.prescriptionNo ?? null,
      notes: data.notes ?? null,
      actor,
    });
    return { ok: true as const, ...result };
  });

/* ------------------------------------------------------------------------- */
/* Import                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Store a workbook the browser has already parsed.
 *
 * The parse happens client-side and the *records* are posted, not the file. That
 * is deliberate: `July Leads.xlsx` is 15 MB, the operator needs to see the
 * preview and confirm the detected type before anything is written, and shipping
 * the workbook to a Worker only to ship a preview back would double the transfer
 * for no decision the browser cannot make.
 *
 * The row cap is the safety valve. 200,000 covers the largest observed extract
 * (173,008 rows) with room, and refuses a file that is not one of these.
 */
const SourceRecordSchema = z.object({
  sourceType: z.enum(["cash", "wasfaty", "retention"]),
  rowNumber: z.number().int().nonnegative(),
  contentHash: z.string().min(1).max(64),
  customerRef: z.string().max(120).nullable(),
  customerName: z.string().max(300).nullable(),
  phoneRaw: z.string().max(64).nullable(),
  /*
   * The canonical number, validated here as well as in `src/lib/phone.ts`.
   *
   * The browser parses the workbook and posts the rows, so this schema is the
   * trust boundary: a client that sent `+966…` — an older tab, a replayed
   * request, a future integration — would otherwise write a second format into
   * a column the whole module assumes is canonical. The pattern is the same one
   * the database CHECK enforces, so all three agree.
   */
  phone: z
    .string()
    .regex(/^05[03-9]\d{7}$/, "Expected a canonical Saudi mobile number (05XXXXXXXX)")
    .nullable(),
  phoneRejection: z.string().max(64).nullable(),
  phoneAlternates: z.array(z.string().regex(/^05[03-9]\d{7}$/)).max(10),
  branchNo: z.string().max(64).nullable(),
  city: z.string().max(120).nullable(),
  facility: z.string().max(300).nullable(),
  itemCode: z.string().max(64).nullable(),
  itemName: z.string().max(300).nullable(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  totalValue: z.number().nullable(),
  sourceDate: businessDate.nullable(),
  fillDate: businessDate.nullable(),
  dispenseTime: z.string().max(64).nullable(),
  documentNo: z.string().max(64).nullable(),
  channel: z.string().max(120).nullable(),
  patientId: z.string().max(64).nullable(),
  prescriptionNo: z.string().max(64).nullable(),
  callbackDate: businessDate.nullable(),
  agentLabel: z.string().max(120).nullable(),
  actionLabel: z.string().max(120).nullable(),
  notes: z.string().max(2000).nullable(),
  raw: z.record(z.string(), z.unknown()),
});

export const telesalesImportWorkbook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        fileName: z.string().min(1).max(300),
        fileSize: z.number().int().nonnegative().nullable(),
        sheetName: z.string().max(200),
        sourceType: z.enum(["cash", "wasfaty", "retention"]),
        contentDigest: z.string().max(64),
        rowsSeen: z.number().int().nonnegative(),
        headers: z.array(z.string().max(200)).max(100),
        records: z.array(SourceRecordSchema).max(200_000),
        issues: z
          .array(
            z.object({
              code: z.string().max(64),
              message: z.string().max(500),
              rows: z.array(z.number().int()).max(50),
            }),
          )
          .max(20),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { storeImport } = await import("@/lib/telesales/import.server");

    const outcome = await storeImport(
      await admin(),
      {
        sourceType: data.sourceType,
        sheetName: data.sheetName,
        headers: data.headers,
        records: data.records as any,
        issues: data.issues as any,
        rowsSeen: data.rowsSeen,
        contentDigest: data.contentDigest,
      },
      {
        fileName: data.fileName,
        fileSize: data.fileSize,
        importedBy: userId,
        actorRole: actor.role,
      },
    );

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesImported,
      targetUserId: null,
      // Counts and file identity. Never a row's contents.
      details: {
        import_id: outcome.importId,
        source_type: outcome.sourceType,
        file_name: data.fileName,
        sheet_name: data.sheetName,
        rows_total: outcome.rowsTotal,
        rows_stored: outcome.rowsStored,
        repeat_of: outcome.previousImportId,
      },
    });

    return { ok: true as const, ...outcome };
  });

export const telesalesImportHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ limit: z.number().int().min(1).max(50).default(20) }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { listImports } = await import("@/lib/telesales/import.server");
    return { ok: true as const, imports: await listImports(await admin(), data.limit) };
  });

/* ------------------------------------------------------------------------- */
/* Generation                                                                */
/* ------------------------------------------------------------------------- */

export const telesalesGenerate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // Omitted runs all three pipelines in the order the daily sweep uses.
        leadType: z.enum(["cash", "retention", "wasfaty"]).nullable().optional(),
        anchorDate: businessDate.nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { runDailyGeneration, runGeneration } = await import("@/lib/telesales/generate.server");
    const client = await admin();

    const runs = data.leadType
      ? [
          await runGeneration(client, {
            leadType: data.leadType,
            anchorDate: data.anchorDate ?? undefined,
            executionSource: "manual",
            actorId: userId,
          }),
        ]
      : await runDailyGeneration(client, {
          anchorDate: data.anchorDate ?? undefined,
          executionSource: "manual",
          actorId: userId,
        });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesGenerated,
      targetUserId: null,
      details: {
        anchor_date: data.anchorDate ?? null,
        runs: runs.map((r) => ({
          lead_type: r.leadType,
          created: r.created,
          duplicates: r.skippedDuplicate,
          errors: r.errors,
        })),
      },
    });

    return { ok: true as const, runs };
  });

export const telesalesSeedRetentionBacklog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ importId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { runRetentionBacklog } = await import("@/lib/telesales/generate.server");
    const summary = await runRetentionBacklog(await admin(), {
      importId: data.importId,
      actorId: userId,
    });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesBacklogSeeded,
      targetUserId: null,
      details: {
        import_id: data.importId,
        created: summary.created,
        duplicates: summary.skippedDuplicate,
        errors: summary.errors,
      },
    });

    return { ok: true as const, summary };
  });

/* ------------------------------------------------------------------------- */
/* Settings and product configuration                                        */
/* ------------------------------------------------------------------------- */

export const telesalesUpdateSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        cashWindowDays: z.number().int().min(1).max(31),
        cashWindowLagDays: z.number().int().min(0).max(60),
        wasfatyWindowDays: z.number().int().min(1).max(31),
        retentionOverdueGraceDays: z.number().int().min(0).max(365),
        automationEnabled: z.boolean(),
        generationHour: z.number().int().min(0).max(23),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const client = await admin();
    const { error } = await client
      .from("telesales_settings")
      .update({
        cash_window_days: data.cashWindowDays,
        cash_window_lag_days: data.cashWindowLagDays,
        wasfaty_window_days: data.wasfatyWindowDays,
        retention_overdue_grace_days: data.retentionOverdueGraceDays,
        automation_enabled: data.automationEnabled,
        generation_hour: data.generationHour,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (error) throw new Error(error.message);

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesSettingsSaved,
      targetUserId: null,
      details: { ...data },
    });

    return { ok: true as const };
  });

export const telesalesSetProductEligibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        itemCode: z.string().trim().min(1).max(64),
        eligibleCash: z.boolean(),
        eligibleRetention: z.boolean(),
        refillDays: z.number().int().min(1).max(365).nullable(),
        active: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const client = await admin();
    const { error } = await client
      .from("telesales_products")
      .update({
        eligible_cash: data.eligibleCash,
        eligible_retention: data.eligibleRetention,
        refill_days: data.refillDays,
        active: data.active,
      })
      .eq("item_code", data.itemCode);
    if (error) throw new Error(error.message);

    /*
     * A product change is written to the admin audit log, not to a lead
     * timeline.
     *
     * Turning a family on changes tomorrow's queue for the whole desk, which
     * makes it an administrative act rather than an operational one — and there
     * is no single lead it belongs to. `logAdminAction` never throws; a failed
     * audit write must not undo a configuration change the operator can already
     * see took effect.
     */
    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesProductChanged,
      targetUserId: null,
      details: {
        item_code: data.itemCode,
        eligible_cash: data.eligibleCash,
        eligible_retention: data.eligibleRetention,
        active: data.active,
      },
    });

    return { ok: true as const };
  });

/* ------------------------------------------------------------------------- */
/* Management: archiving imports, and moving leads in bulk                    */
/* ------------------------------------------------------------------------- */

/**
 * What archiving an import would do, before it is done.
 *
 * Read-only, and the numbers the confirmation dialog quotes back to the
 * operator. Separate from the archive itself so the dialog cannot be the thing
 * that performs it.
 */
export const telesalesArchiveImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ importId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { describeArchiveImpact } = await import("@/lib/telesales/manage.server");
    return { ok: true as const, impact: await describeArchiveImpact(await admin(), data.importId) };
  });

export const telesalesArchiveImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ importId: uuid, reason: z.string().trim().min(1).max(300) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { archiveImport } = await import("@/lib/telesales/manage.server");
    const result = await archiveImport(await admin(), {
      importId: data.importId,
      reason: data.reason,
      actor,
    });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesImportArchived,
      targetUserId: null,
      details: { ...result, reason: data.reason },
    });

    return { ok: true as const, ...result };
  });

export const telesalesRestoreImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ importId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { restoreImport } = await import("@/lib/telesales/manage.server");
    const result = await restoreImport(await admin(), { importId: data.importId, actor });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesImportRestored,
      targetUserId: null,
      details: { importId: data.importId, ...result },
    });

    return { ok: true as const, ...result };
  });

/** Ids a bulk action may carry. Capped in `manage.server.ts` too; this is the
 *  boundary check so an oversized request is refused before it reaches a query. */
const bulkIds = z.array(uuid).min(1).max(500);

/**
 * Assign, reassign or unassign many leads.
 *
 * `manage` rather than `work`: this deliberately bypasses the ownership rule
 * that stops an agent touching a colleague's lead, because moving somebody
 * else's lead is exactly what a team lead does. An agent's own single-lead
 * claim still goes through `telesalesAssignLead`, which enforces it.
 */
export const telesalesBulkAssign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadIds: bulkIds, assigneeId: uuid.nullable() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { bulkAssign } = await import("@/lib/telesales/manage.server");
    const result = await bulkAssign(await admin(), {
      leadIds: data.leadIds,
      assigneeId: data.assigneeId,
      actor,
    });
    return { ok: true as const, ...result };
  });

export const telesalesBulkArchive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ leadIds: bulkIds, reason: z.string().trim().min(1).max(300) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { bulkArchive } = await import("@/lib/telesales/manage.server");
    const result = await bulkArchive(await admin(), {
      leadIds: data.leadIds,
      reason: data.reason,
      actor,
    });
    return { ok: true as const, ...result };
  });

export const telesalesBulkRestore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadIds: bulkIds }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { bulkRestore } = await import("@/lib/telesales/manage.server");
    const result = await bulkRestore(await admin(), { leadIds: data.leadIds, actor });
    return { ok: true as const, ...result };
  });

/**
 * Record the Shams MIS customer id a lookup resolved.
 *
 * The only write this phase adds, and it stores one identifier — not the
 * customer's name, not their purchases, not their loyalty balance. Duplicating
 * the MIS into Telesales would mean two copies of a customer record ageing
 * apart; storing the id means a later phase can join to the MIS without asking
 * it who this number belongs to all over again.
 *
 * `mis_customer_id` and `mis_synced_at` were created in Phase 1 for exactly
 * this, so no schema change is needed.
 *
 * Idempotent and cheap: the caller only sends it when the resolved id differs
 * from what is stored, and the update is a no-op otherwise.
 */
export const telesalesLinkMisCustomer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        customerId: uuid,
        misCustomerId: z.string().trim().min(1).max(64),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    // `view` is the right gate: seeing the MIS panel is what produces this id,
    // and recording what you were already shown is not a privileged act.
    await resolveActor(supabase, userId, "view");

    const client = await admin();
    const { error } = await client
      .from("telesales_customers")
      .update({ mis_customer_id: data.misCustomerId, mis_synced_at: new Date().toISOString() })
      .eq("id", data.customerId)
      .is("mis_customer_id", null);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/**
 * Record an invoice reconciliation verdict on a lead.
 *
 * The reporting shadow of a live derivation. The lead detail always re-derives
 * from the MIS; this exists so a supervisor can ask "which of this week's leads
 * turned into invoices" without re-running a lookup per lead.
 *
 * Stores the relationship and nothing else — the matched document number, its
 * branch, the verdict and what disagreed. Never the invoice: Shams MIS owns
 * what it sold, and a copy inside Telesales would be a second version of a
 * commercial record ageing apart from the original.
 *
 * `view` is the gate. The verdict is derived from data the caller has already
 * been shown by `shamsGetInvoices` — which enforces `view_shams_mis` itself —
 * so writing down a conclusion about what you were just permitted to see is not
 * a further privilege.
 */
export const telesalesRecordInvoiceMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        leadId: uuid,
        status: z.enum(["matched", "not_matched", "ambiguous", "not_checked"]),
        docNo: z.string().trim().max(32).nullable(),
        branchNo: z.string().trim().max(32).nullable(),
        discrepancies: z.array(z.string().max(64)).max(10),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "view");

    const client = await admin();
    const { error } = await client
      .from("telesales_leads")
      .update({
        invoice_match_status: data.status,
        invoice_matched_doc_no: data.docNo,
        invoice_matched_branch_no: data.branchNo,
        invoice_discrepancies: data.discrepancies,
        invoice_checked_at: new Date().toISOString(),
      })
      .eq("id", data.leadId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
