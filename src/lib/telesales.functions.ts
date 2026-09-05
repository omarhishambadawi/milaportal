import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ActorIdentity } from "@/lib/telesales/actions.server";
import type { ShamsProduct } from "@/lib/shams/types";

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
        // What the parser understood the headers to mean. Reported by the
        // browser because that is where parsing happens; stored with the import
        // so "what did it map" is answerable after the fact.
        mappedFields: z.array(z.string().max(64)).max(100).default([]),
        mappedColumns: z.record(z.string().max(64), z.number().int().min(0).max(1000)).default({}),
        /*
         * The mapping as a person would read it -- "Mobile Number -> Phone" --
         * recorded with the import so what was used stays answerable. Per
         * import; nothing reads it back to pre-fill a later upload.
         */
        columnMapping: z
          .record(
            z.string().max(120),
            z.object({ column: z.string().max(200).nullable(), auto: z.boolean() }),
          )
          .optional(),
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
        mappedFields: data.mappedFields,
        mappedColumns: data.mappedColumns,
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
        columnMapping: data.columnMapping ?? null,
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

/**
 * How a generation run may be narrowed.
 *
 * Every field only ever *shrinks* the set of rows considered. None of them
 * relaxes an eligibility rule, and none can reach outside the pipeline's own
 * window — `narrowWindow` clamps the dates, so a filter cannot be used to
 * generate last March's prescriptions by typing a date into a box. The lists
 * are capped here as well as server-side because an unbounded `in (...)` is a
 * URL the database never sees.
 */
const generationFilters = z
  .object({
    importId: uuid.nullable().optional(),
    branchNos: z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional(),
    cities: z.array(z.string().trim().min(1).max(120)).max(200).nullable().optional(),
    itemCodes: z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional(),
    hasPhone: z.boolean().nullable().optional(),
    dateFrom: businessDate.nullable().optional(),
    dateTo: businessDate.nullable().optional(),
  })
  .optional();

export const telesalesGenerate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // Omitted runs all three pipelines in the order the daily sweep uses.
        leadType: z.enum(["cash", "retention", "wasfaty"]).nullable().optional(),
        anchorDate: businessDate.nullable().optional(),
        filters: generationFilters,
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { runDailyGeneration, runGeneration } = await import("@/lib/telesales/generate.server");
    const client = await admin();

    /*
     * A scoped run must name its pipeline. Filtering "all three" by an import
     * that belongs to one of them would silently run the other two unfiltered,
     * which is the opposite of what somebody pressing a filtered Generate
     * expects.
     */
    if (data.filters && !data.leadType) {
      throw new Error("Choose which pipeline to generate before filtering it.");
    }

    const runs = data.leadType
      ? [
          await runGeneration(client, {
            leadType: data.leadType,
            anchorDate: data.anchorDate ?? undefined,
            executionSource: "manual",
            actorId: userId,
            filters: (data.filters ?? undefined) as any,
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

/**
 * Explain an import: how many of its rows are leads, and why the rest are not.
 *
 * Read-only, and the answer comes from the generator's own rules — the same
 * `judgeCashRecord` / `judgeWasfatyRecord` the run itself calls. A report that
 * reasoned about the rules separately would eventually explain a run that did
 * not happen, and it would be believed.
 *
 * `manage_telesales`, matching the tables it reports on. `telesales_imports`,
 * `telesales_source_records` and `telesales_generation_runs` all carry RLS
 * policies keyed on that permission, so an agent who could call this would read
 * counts derived from rows they cannot see anywhere else in the product -- and
 * the review screen beside it would render empty. Import is a supervisor
 * surface end to end.
 */
export const telesalesDiagnoseImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ importId: uuid, anchorDate: businessDate.nullable().optional() }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { diagnoseImportById } = await import("@/lib/telesales/diagnose.server");
    const diagnosis = await diagnoseImportById(await admin(), {
      importId: data.importId,
      anchorDate: data.anchorDate ?? undefined,
    });
    if (!diagnosis) throw new Error("That import no longer exists.");
    return { ok: true as const, diagnosis };
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

/**
 * Search Shams MIS Branch Stock, for the catalogue screen.
 *
 * The same `searchProducts` the `/shams` Stock tab calls, behind a different
 * permission. `shamsSearchProducts` asserts `view_shams_mis`, which is the
 * page-level key for the MIS module — and a telesales supervisor curating the
 * CRM's product list is not necessarily granted that page.
 *
 * So this checks `manage_telesales`, which is the permission the *write* on the
 * other side of this search already requires. Nothing is widened: the caller
 * can already read every product in `telesales_products` and every item name on
 * every lead, and what comes back here is an item code and a name.
 *
 * Read-only, and it writes nothing to the MIS.
 */
export const telesalesSearchCatalogSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ q: z.string().trim().min(2).max(80) }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");

    const { isConfigured } = await import("@/lib/shams/client.server");
    if (!isConfigured()) {
      return { ok: false as const, configured: false, products: [] as ShamsProduct[] };
    }
    const { searchProducts } = await import("@/lib/shams/catalog.server");
    return { ok: true as const, configured: true, products: await searchProducts(data.q) };
  });

/**
 * Add a product to the Telesales catalogue from Shams MIS Branch Stock.
 *
 * ===========================================================================
 * Branch Stock is the source of truth for identity
 * ===========================================================================
 * The item code and the item name are read from the MIS by the code the
 * operator picked, and the request's own name is ignored entirely. That is the
 * whole point of the brief's rule: a curated local list of products the desk
 * sells by phone, whose identity is the pharmacy's, not a supervisor's typing.
 *
 * The MIS is not asked to store anything and is not written to. This copies two
 * fields into `telesales_products` so that eligibility, refill cycles and
 * cross-sell pairs have something local and stable to hang off — an item code
 * that has been withdrawn from the MIS must not take a configured cross-sell
 * with it.
 *
 * ===========================================================================
 * What is asked of the operator, and what is not
 * ===========================================================================
 * Not asked: the code and the name, which Branch Stock already knows.
 * Asked: whether the desk sells it for Cash, whether it has a retention cycle,
 * and how long that cycle is. None of those are properties of a product in the
 * MIS — they are decisions about how this desk works — so there is nothing to
 * look up and no honest default beyond "off".
 *
 * The family is proposed from the existing name patterns and can be overridden.
 * Duplicates are impossible rather than checked: `item_code` is the primary
 * key, and a second add of the same code updates the row it finds.
 */
export const telesalesAddCatalogProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        itemCode: z.string().trim().min(1).max(64),
        family: z.string().trim().min(1).max(40),
        eligibleCash: z.boolean(),
        eligibleRetention: z.boolean(),
        refillDays: z.number().int().min(1).max(365).nullable(),
        notes: z.string().trim().max(300).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");

    /*
     * The name comes from the MIS, always.
     *
     * `getProductDetail` is the same cached read the Shams stock tab uses, so a
     * product the operator has just looked at costs nothing to add. A code the
     * MIS does not recognise is refused here rather than stored as a row whose
     * name nobody can resolve.
     */
    const { getProductDetail } = await import("@/lib/shams/catalog.server");
    const detail = await getProductDetail(data.itemCode);
    if (!detail) {
      throw new Error(
        `Shams Branch Stock has no product with item code ${data.itemCode}. ` +
          "Search for it by name and pick it from the list.",
      );
    }

    const client = await admin();
    const { error } = await client.from("telesales_products").upsert(
      {
        item_code: detail.itemCode,
        item_name: detail.itemName,
        family: data.family,
        eligible_cash: data.eligibleCash,
        eligible_retention: data.eligibleRetention,
        refill_days: data.refillDays,
        notes: data.notes ?? null,
        active: true,
        source: "branch_stock",
        added_by: userId,
      },
      { onConflict: "item_code" },
    );
    if (error) throw new Error(error.message);

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesProductAdded,
      targetUserId: null,
      details: {
        item_code: detail.itemCode,
        item_name: detail.itemName,
        family: data.family,
        eligible_cash: data.eligibleCash,
        eligible_retention: data.eligibleRetention,
      },
    });

    return { ok: true as const, itemCode: detail.itemCode, itemName: detail.itemName };
  });

/* ------------------------------------------------------------------------- */
/* Management: deleting imports, and moving leads in bulk                     */
/* ------------------------------------------------------------------------- */

/**
 * What deleting an import would take, before it is taken.
 *
 * Read-only, and the numbers the confirmation dialog quotes. Separate from the
 * delete itself so the dialog cannot be the thing that performs it — which
 * matters more here than it did for the archive, because there is no undo.
 */
export const telesalesDeleteImpact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ importId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await resolveActor(supabase, userId, "manage");
    const { describeDeleteImpact } = await import("@/lib/telesales/manage.server");
    return { ok: true as const, impact: await describeDeleteImpact(await admin(), data.importId) };
  });

/**
 * Delete an import permanently.
 *
 * Not reversible, which is why it is confirmed against real counts and written
 * to the admin audit log with them. After this runs, the audit entry is the
 * only record that the file was ever uploaded.
 *
 * Leads somebody has worked survive it, detached from the file they came from —
 * see `telesales_delete_import` for the rule and for the trigger that stops a
 * mistake in it from destroying a call log.
 */
export const telesalesDeleteImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ importId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { deleteImport } = await import("@/lib/telesales/manage.server");
    const result = await deleteImport(await admin(), { importId: data.importId, actor });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesImportDeleted,
      targetUserId: null,
      details: { ...result },
    });

    return { ok: true as const, ...result };
  });

/**
 * Delete one lead. Administrators only.
 *
 * Narrower than `manage_telesales` on purpose. Every other write in this module
 * is an operational one a team lead performs daily — assign, archive, restore —
 * and each of them is reversible. This one is not: a lead nobody has worked is
 * gone, and the audit entry is the only remaining evidence that it existed. That
 * is an owner's or an administrator's call, not a supervisor's, and the check is
 * here rather than in the RPC because `resolveActor` is where this module reads
 * the actor's role.
 *
 * A lead carrying call history is archived rather than destroyed — see
 * `telesales_delete_lead`. The result says which happened, and the toast repeats
 * it, because "deleted" and "archived, log kept" are different facts and the
 * person who pressed the button is entitled to know which one they caused.
 */
export const telesalesDeleteLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ leadId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");
    const { isAdministrator } = await import("@/lib/auth");
    if (!isAdministrator(actor.role as any)) {
      console.warn("[telesales/authz] refused lead deletion", { userId, role: actor.role });
      throw new Error("Forbidden: administrator access required");
    }

    const { deleteLead } = await import("@/lib/telesales/manage.server");
    const result = await deleteLead(await admin(), { leadId: data.leadId, actor });

    const { AUDIT_ACTIONS, logAdminAction } = await import("@/lib/audit.server");
    await logAdminAction({
      actorId: userId,
      action: AUDIT_ACTIONS.telesalesLeadDeleted,
      targetUserId: null,
      details: { ...result },
    });

    return { ok: true as const, ...result };
  });

/* ------------------------------------------------------------------------- */
/* Management: archiving imports (legacy), and moving leads in bulk                   */
/* ------------------------------------------------------------------------- */

/*
 * `telesalesArchiveImpact`, `telesalesArchiveImport` and
 * `telesalesRestoreImport` were here.
 *
 * Removing an import is a deletion now — see `telesalesDeleteImport` above —
 * and keeping an archive path beside it would leave two ways to make a file
 * stop counting, one of which the screen no longer offers. The SQL functions
 * they called are left in place: production carries imports archived under the
 * old behaviour, and `generate.server.ts` still refuses to read their source
 * rows, which is what keeps a deliberately archived file from re-generating.
 */

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

/* ------------------------------------------------------------------------- */
/* Cross-sell configuration                                                  */
/* ------------------------------------------------------------------------- */

/** An item code as it appears in `telesales_products`. */
const itemCode = z.string().trim().min(1).max(64);

/**
 * Configure a cross-sell pair, or switch an existing one back on.
 *
 * The only write path to `telesales_product_relations`. RLS carries a SELECT
 * policy and nothing else, so PostgREST refuses every write from the browser
 * regardless of grants — configuration can change only here, and only for a
 * caller holding `manage_telesales`. An agent calling this function directly is
 * refused by `resolveActor` before anything is read.
 *
 * Both products are checked against `telesales_products` rather than trusted
 * from the request. A free-typed code would let somebody configure a
 * recommendation for a product the pharmacy does not sell, which an agent would
 * then read out to a customer. The recommended product's *name* is taken from
 * the catalogue for the same reason: it is the sentence the agent sees.
 *
 * Saving a pair that already exists reactivates it instead of failing on the
 * unique key or creating a second row — see `planSave`. Nothing here infers a
 * relationship; a pair exists because a person entered it.
 */
export const telesalesSaveProductRelation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        fromItemCode: itemCode,
        toItemCode: itemCode,
        // Validated against the enum in `relations.ts` rather than here, so the
        // list of kinds has one home; an unrecognised value defaults to
        // cross-sell rather than being refused.
        kind: z.string().trim().max(20).optional(),
        note: z.string().trim().max(300).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");

    const { buildRelationCatalog, planSave, validateRelation } =
      await import("@/lib/telesales/relations");

    const client = await admin();

    const { data: products, error: catalogError } = await client
      .from("telesales_products")
      .select("item_code,item_name,active");
    if (catalogError) throw new Error(catalogError.message);

    const catalog = buildRelationCatalog(
      ((products as any[]) ?? []).map((p) => ({
        itemCode: p.item_code,
        itemName: p.item_name,
        active: p.active,
      })),
    );

    const verdict = validateRelation(data, catalog);
    if (!verdict.ok) {
      const { RELATION_REJECTION_LABELS } = await import("@/lib/telesales/relations");
      throw new Error(RELATION_REJECTION_LABELS[verdict.reason]);
    }
    const next = verdict.value;

    const { data: existingRows, error: existingError } = await client
      .from("telesales_product_relations")
      .select("id,active,note,to_item_name,kind")
      .eq("from_item_code", next.fromItemCode)
      .eq("to_item_code", next.toItemCode)
      .limit(1);
    if (existingError) throw new Error(existingError.message);

    const existing = ((existingRows as any[]) ?? [])[0] ?? null;
    const plan = planSave(
      existing
        ? {
            active: existing.active,
            note: existing.note,
            toItemName: existing.to_item_name,
            kind: existing.kind === "up_sell" ? ("up_sell" as const) : ("cross_sell" as const),
          }
        : null,
      next,
    );

    if (plan === "unchanged") return { ok: true as const, plan };

    const now = new Date().toISOString();

    if (!existing) {
      const { error } = await client.from("telesales_product_relations").insert({
        from_item_code: next.fromItemCode,
        to_item_code: next.toItemCode,
        to_item_name: next.toItemName,
        kind: next.kind,
        note: next.note,
        active: true,
        created_by: actor.userId,
        updated_by: actor.userId,
      });
      // The unique key is the backstop for two supervisors configuring the same
      // pair at once: the loser is told it already exists rather than creating
      // a duplicate.
      if (error) {
        throw new Error(
          error.code === "23505"
            ? "That pair was just configured by somebody else."
            : error.message,
        );
      }
      return { ok: true as const, plan };
    }

    const { error } = await client
      .from("telesales_product_relations")
      .update({
        to_item_name: next.toItemName,
        kind: next.kind,
        note: next.note,
        active: true,
        updated_by: actor.userId,
        updated_at: now,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, plan };
  });

/**
 * Switch a configured cross-sell on or off.
 *
 * Deactivation rather than deletion, and there is no delete: the row records a
 * commercial decision somebody made, and the question "why were we offering
 * this in March" should stay answerable. An inactive pair is excluded at the
 * read — `use-recommended-leads` asks for `active = true` — so switching it off
 * stops every recommendation it was producing on the next load.
 */
export const telesalesSetProductRelationActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: uuid, active: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");

    const client = await admin();
    const { error } = await client
      .from("telesales_product_relations")
      .update({
        active: data.active,
        updated_by: actor.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/* ------------------------------------------------------------------------- */
/* Product identity mapping                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Map a source item code onto the catalogue product it means.
 *
 * The only write path to `telesales_product_aliases`. RLS carries a SELECT
 * policy and nothing else, so PostgREST refuses every write from the browser
 * regardless of grants — a mapping can change only here, and only for a caller
 * holding `manage_telesales`. An agent calling this function directly is
 * refused by `resolveActor` before anything is read.
 *
 * What is being asserted is that two item codes are **the same medicine**, and
 * every downstream answer — repeat purchases, refill dates, which leads get
 * recommended — follows from it. So the canonical end is taken from
 * `telesales_products` rather than trusted from the request, an alias code that
 * is itself a catalogue product is refused, and the database repeats all of it
 * as constraints and a trigger.
 *
 * Nothing is rewritten. No source record, lead or catalogue row changes, and
 * `telesalesSetProductAliasActive` reverses the effect completely. Saving a code
 * that is already mapped reactivates or re-points the existing row rather than
 * failing on the unique key or creating a second, contradictory answer — see
 * `planAliasSave`.
 *
 * This is not cross-sell and never creates one: `telesales_product_relations` is
 * a different table, a different concept, and neither feeds the other.
 */
export const telesalesSaveProductAlias = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        aliasItemCode: itemCode,
        canonicalItemCode: itemCode,
        aliasNameSnapshot: z.string().trim().max(300).nullable().optional(),
        note: z.string().trim().max(300).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");

    const { ALIAS_REJECTION_LABELS, buildAliasCatalog, planAliasSave, validateAlias } =
      await import("@/lib/telesales/aliases");

    const client = await admin();

    const { data: products, error: catalogError } = await client
      .from("telesales_products")
      .select("item_code,item_name,active");
    if (catalogError) throw new Error(catalogError.message);

    const catalog = buildAliasCatalog(
      ((products as any[]) ?? []).map((p) => ({
        itemCode: p.item_code,
        itemName: p.item_name,
        active: p.active,
      })),
    );

    const verdict = validateAlias(data, catalog);
    if (!verdict.ok) throw new Error(ALIAS_REJECTION_LABELS[verdict.reason]);
    const next = verdict.value;

    const { data: existingRows, error: existingError } = await client
      .from("telesales_product_aliases")
      .select("id,canonical_item_code,active,note,alias_name_snapshot")
      .eq("alias_item_code", next.aliasItemCode)
      .limit(1);
    if (existingError) throw new Error(existingError.message);

    const existing = ((existingRows as any[]) ?? [])[0] ?? null;
    const plan = planAliasSave(
      existing
        ? {
            canonicalItemCode: existing.canonical_item_code,
            active: existing.active,
            note: existing.note,
            aliasNameSnapshot: existing.alias_name_snapshot,
          }
        : null,
      next,
    );

    if (plan === "unchanged") return { ok: true as const, plan };

    if (!existing) {
      const { error } = await client.from("telesales_product_aliases").insert({
        alias_item_code: next.aliasItemCode,
        canonical_item_code: next.canonicalItemCode,
        alias_name_snapshot: next.aliasNameSnapshot,
        note: next.note,
        active: true,
        created_by: actor.userId,
        updated_by: actor.userId,
      });
      // The unique key is the backstop for two supervisors mapping the same
      // code at once: the loser is told it already exists rather than creating
      // a duplicate.
      if (error) {
        throw new Error(
          error.code === "23505"
            ? "That item code was just mapped by somebody else."
            : error.message,
        );
      }
      return { ok: true as const, plan };
    }

    const { error } = await client
      .from("telesales_product_aliases")
      .update({
        canonical_item_code: next.canonicalItemCode,
        alias_name_snapshot: next.aliasNameSnapshot,
        note: next.note,
        active: true,
        updated_by: actor.userId,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { ok: true as const, plan };
  });

/**
 * Switch a product identity mapping on or off.
 *
 * Deactivation rather than deletion, and there is no delete: the row records a
 * decision about what two item codes mean, and "why did this customer count as
 * a repeat buyer in September" should stay answerable. An inactive mapping is
 * excluded at the read — the resolver drops it, and the lifecycle view's
 * `codeset` filters `active` — so switching it off returns every affected lead
 * to code-only matching on the next load, with nothing to undo.
 */
export const telesalesSetProductAliasActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: uuid, active: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const actor = await resolveActor(supabase, userId, "manage");

    const client = await admin();
    const { error } = await client
      .from("telesales_product_aliases")
      .update({ active: data.active, updated_by: actor.userId })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
