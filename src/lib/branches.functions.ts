import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AUDIT_ACTIONS, logAdminAction } from "@/lib/audit.server";
import type { ImportHistoryEntry } from "@/features/branches/types";

/**
 * Writing the Branch Directory.
 *
 * Imports do not go through the client's Supabase connection even though RLS
 * would permit them, because an import is not one write: it snapshots the
 * current table, reconciles a thousand rows against it, deactivates what the
 * file dropped, and records a history entry. Half of that landing is worse than
 * none of it, and only a server function can hold the whole sequence behind one
 * authorization check and one error path.
 */

/** Rows per upsert round trip. Keeps a 1000-branch import off any payload cap. */
const WRITE_CHUNK = 250;

/**
 * Columns an import may write.
 *
 * `created_at` is absent deliberately: re-importing a branch must not reset when
 * it was first known. `active` and `updated_at` are set by the handler, not
 * accepted from the caller.
 */
const BranchRowSchema = z.object({
  branch_no: z.string().min(1).max(64),
  city: z.string().min(1).max(120),
  phone: z.string().max(32).nullable(),
  area_manager: z.string().max(160).nullable(),
  area_manager_phone: z.string().max(32).nullable(),
  email: z.string().max(200).nullable(),
  address: z.string().max(500).nullable(),
  maps_url: z.string().max(1000).nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  scooter: z.boolean(),
  scooter_note: z.string().max(200).nullable(),
  working_hours: z.string().max(200).nullable(),
  friday_hours: z.string().max(200).nullable(),
  duty_hours: z.number().nullable(),
});

type BranchRow = z.infer<typeof BranchRowSchema>;

const ModeSchema = z.enum(["replace", "merge", "update", "add"]);

/** Validation counts carried into the audit record. */
const ValidationSchema = z.object({
  critical: z.number().int().min(0),
  warning: z.number().int().min(0),
  info: z.number().int().min(0),
  flaggedRows: z.number().int().min(0),
  rejected: z.number().int().min(0),
  valid: z.number().int().min(0),
});

/**
 * Gate for changing branches.
 *
 * `admin_access` rather than a new permission, because it already means exactly
 * this: it is the permission the branches RLS policy has always checked, its
 * label in the permission editor is literally "Admin Access (edit branches,
 * system)", and the roles holding it — owner, admin, supervisor — are precisely
 * the three the brief lists as able to import. Minting `import_branches`
 * alongside it would create two names for one privilege that could then be
 * granted apart, which is how a surface ends up reachable by someone the branch
 * table itself refuses.
 *
 * Routed through has_permission() so this check and the RLS policy cannot drift.
 */
async function assertCanManageBranches(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_permission", {
    _user_id: userId,
    _permission: "admin_access",
  });
  if (error) {
    console.error("[authz] has_permission RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    console.warn("[authz] branch management attempt without admin_access", { userId });
    throw new Error("Forbidden: branch management access required");
  }
}

/**
 * Additional gate for rollback.
 *
 * Administrator-only, one rung above import. A rollback does not add
 * information — it discards whatever has happened since a chosen point,
 * including corrections made by someone else, and it does so without any row
 * on screen changing colour to say so. The brief gives rollback to Admin and
 * Owner and gives Supervisor only import; this is that line.
 */
async function assertAdministrator(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_administrator", { _user_id: userId });
  if (error) {
    console.error("[authz] is_administrator RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    console.warn("[authz] rollback attempt by non-administrator", { userId });
    throw new Error("Forbidden: only an administrator may roll the Branch Directory back");
  }
}

/**
 * The actor's role, captured at the moment of the import.
 *
 * Stored on the record rather than resolved on read: `imported_by` resolves to
 * whatever role that account holds *today*, and an audit trail that rewrites
 * history when someone is promoted is not an audit trail. Best-effort — a
 * lookup failure must not fail an import that has already been written.
 */
async function getActorRole(supabase: any, userId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    return (data?.role as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Every column of every branch, for the pre-import snapshot. */
const SNAPSHOT_COLUMNS =
  "branch_no,city,phone,area_manager,area_manager_phone,email,address,maps_url,latitude,longitude,scooter,scooter_note,working_hours,friday_hours,duty_hours,active,created_at,updated_at";

async function readAllBranches(supabaseAdmin: any): Promise<any[]> {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("branches")
      .select(SNAPSHOT_COLUMNS)
      .order("branch_no")
      .range(start, start + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function upsertChunked(supabaseAdmin: any, rows: Record<string, unknown>[]) {
  for (let index = 0; index < rows.length; index += WRITE_CHUNK) {
    const { error } = await supabaseAdmin
      .from("branches")
      .upsert(rows.slice(index, index + WRITE_CHUNK), { onConflict: "branch_no" });
    if (error) throw new Error(error.message);
  }
}

/**
 * Deactivate branches by code.
 *
 * This is what "remove" means here, and it is not a soft-delete chosen out of
 * caution: `orders.branch_no` is a foreign key onto this table, so a branch that
 * has ever taken an order genuinely cannot be deleted. A DELETE would abort the
 * entire import on the first referenced row — and the branches most likely to be
 * dropped from a sheet are old ones, which are exactly the ones with order
 * history. Deactivated branches leave the directory and keep every order that
 * points at them intact.
 */
async function deactivate(supabaseAdmin: any, codes: string[]) {
  for (let index = 0; index < codes.length; index += WRITE_CHUNK) {
    const { error } = await supabaseAdmin
      .from("branches")
      .update({ active: false, updated_at: new Date().toISOString() })
      .in("branch_no", codes.slice(index, index + WRITE_CHUNK));
    if (error) throw new Error(error.message);
  }
}

/**
 * Ceiling on a stored workbook, in base64 characters.
 *
 * ~7MB of base64 is ~5MB of file, which is an order of magnitude above any real
 * branch sheet (the current one is under 60KB) and below the point where a
 * single row makes the table awkward. A file past this still imports — the
 * rows are what matter — it just is not kept for re-download.
 */
const MAX_SOURCE_FILE_B64 = 7_000_000;

export const branchImportApply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      mode: z.infer<typeof ModeSchema>;
      fileName?: string;
      sourceFile?: { base64: string; type: string; size: number };
      rows: BranchRow[];
      validation?: z.infer<typeof ValidationSchema>;
    }) =>
      z
        .object({
          mode: ModeSchema,
          fileName: z.string().max(260).optional(),
          // The workbook itself, so an administrator can get their own file back
          // rather than an export that has lost the rejected rows and the columns
          // the template does not carry. Optional: an import applied through the
          // API without one is still a valid import.
          sourceFile: z
            .object({
              base64: z.string().max(MAX_SOURCE_FILE_B64),
              type: z.string().max(200),
              size: z.number().int().min(0),
            })
            .optional(),
          // Bounded so a malformed or hostile request cannot ask the server to
          // hold an unbounded array in memory. The network has ~1000 branches;
          // 20000 is far above any real sheet and far below a problem.
          rows: z.array(BranchRowSchema).min(1).max(20000),
          // What the file looked like before it was filtered down to `rows`.
          // Accepted from the client because validation runs there; it is
          // recorded, never acted on, so a wrong value misreports history
          // rather than changing what is written.
          validation: ValidationSchema.optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageBranches(context.supabase, context.userId);

    // Duplicate codes are rejected in the preview, but the preview runs in a
    // browser and this handler is reachable without it. Two rows with the same
    // code in one upsert batch make Postgres raise "ON CONFLICT DO UPDATE
    // cannot affect row a second time", which would surface as an opaque 500.
    const seen = new Set<string>();
    for (const row of data.rows) {
      if (seen.has(row.branch_no)) {
        throw new Error(`Duplicate branch code in the upload: ${row.branch_no}`);
      }
      seen.add(row.branch_no);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Snapshot first. Everything below is reversible only because this ran.
    const before = await readAllBranches(supabaseAdmin);
    const existing = new Set(before.map((row) => row.branch_no as string));

    const incoming = data.rows.filter((row) => {
      if (data.mode === "update") return existing.has(row.branch_no);
      if (data.mode === "add") return !existing.has(row.branch_no);
      return true;
    });

    const now = new Date().toISOString();
    const payload = incoming.map((row) => ({
      ...row,
      // Present in the file means present in the directory: an import is how a
      // previously deactivated branch comes back.
      active: true,
      updated_at: now,
    }));

    const added = incoming.filter((row) => !existing.has(row.branch_no)).length;
    const updated = incoming.length - added;

    // Replace All is the only mode that removes anything. Note it is scoped to
    // rows that are currently active — re-running the same replace twice must
    // report zero removals the second time, not re-deactivate the same rows.
    const dropped =
      data.mode === "replace"
        ? before
            .filter((row) => row.active && !seen.has(row.branch_no as string))
            .map((row) => row.branch_no as string)
        : [];

    if (payload.length > 0) await upsertChunked(supabaseAdmin, payload);
    if (dropped.length > 0) await deactivate(supabaseAdmin, dropped);

    // History is written last, after the data actually changed. An entry for an
    // import that failed halfway would offer a rollback to a state that was
    // never left.
    const { data: entry, error: historyError } = await supabaseAdmin
      .from("branch_imports")
      .insert({
        imported_by: context.userId,
        actor_role: await getActorRole(context.supabase, context.userId),
        mode: data.mode,
        file_name: data.fileName ?? null,
        rows_total: data.rows.length,
        rows_added: added,
        rows_updated: updated,
        rows_removed: dropped.length,
        rows_ignored: data.rows.length - incoming.length,
        rows_failed: data.validation?.rejected ?? 0,
        validation_summary: data.validation ?? {},
        snapshot: before,
        snapshot_rows: before.length,
        source_file: data.sourceFile?.base64 ?? null,
        source_file_type: data.sourceFile?.type ?? null,
        source_file_size: data.sourceFile?.size ?? null,
      })
      .select("id")
      .single();
    if (historyError) throw new Error(historyError.message);

    await logAdminAction({
      actorId: context.userId,
      targetUserId: null,
      action: AUDIT_ACTIONS.branchesImported,
      details: {
        importId: entry?.id ?? null,
        mode: data.mode,
        fileName: data.fileName ?? null,
        rowsTotal: data.rows.length,
        rowsAdded: added,
        rowsUpdated: updated,
        rowsRemoved: dropped.length,
      },
    });

    return {
      importId: entry?.id ?? null,
      added,
      updated,
      removed: dropped.length,
      skipped: data.rows.length - incoming.length,
    };
  });

/**
 * Correcting one branch, from its card, without a workbook.
 *
 * The gap this closes: a phone number changes, or an address is written wrong,
 * and the only way to fix it was to obtain the master sheet, edit the row, and
 * re-import — which touches every branch in the file to change one field, and
 * which nobody does for a typo. So typos stayed.
 *
 * Deliberately narrower than an import in three ways:
 *
 *   - `branch_no` identifies the row and is never itself writable. Renaming a
 *     branch code is a re-key of a column that `orders.branch_no` points at, and
 *     it is not a thing an edit dialog should be able to do by accident.
 *   - `active` is not writable either. Deactivating a branch is what a Replace
 *     import means and what a rollback undoes; doing it from a card would leave
 *     no history entry to restore from.
 *   - There is no snapshot, and therefore no rollback of a single edit. The
 *     import history describes whole-directory states; interleaving per-field
 *     edits into it would make "restore the directory as it stood before this
 *     import" mean something it does not. The audit log records the before and
 *     after of every changed field instead, which is the recoverable form for a
 *     change this size.
 *
 * Same `admin_access` gate as an import, which is the same gate the branches RLS
 * policy applies — owner, admin and supervisor.
 */
const BranchEditSchema = z.object({
  branch_no: z.string().min(1).max(64),
  city: z.string().min(1).max(120),
  phone: z.string().max(32).nullable(),
  area_manager: z.string().max(160).nullable(),
  area_manager_phone: z.string().max(32).nullable(),
  email: z.string().max(200).nullable(),
  address: z.string().max(500).nullable(),
  maps_url: z.string().max(1000).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  scooter: z.boolean(),
  scooter_note: z.string().max(200).nullable(),
  working_hours: z.string().max(200).nullable(),
  friday_hours: z.string().max(200).nullable(),
  duty_hours: z.number().min(0).max(24).nullable(),
});

type BranchEdit = z.infer<typeof BranchEditSchema>;

export const branchUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: BranchEdit) => BranchEditSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertCanManageBranches(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { branch_no: branchNo, ...fields } = data;

    // Read first, so the audit entry can name what actually changed rather than
    // listing every field the form submitted. An edit dialog posts all of them
    // whether or not they were touched.
    const { data: before, error: readError } = await supabaseAdmin
      .from("branches")
      .select(SNAPSHOT_COLUMNS)
      .eq("branch_no", branchNo)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!before) throw new Error(`No branch with the code ${branchNo}`);

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, next] of Object.entries(fields)) {
      const previous = (before as Record<string, unknown>)[key] ?? null;
      if (previous !== (next ?? null)) changed[key] = { from: previous, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { branchNo, changed: 0 };

    const { error } = await supabaseAdmin
      .from("branches")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("branch_no", branchNo);
    if (error) throw new Error(error.message);

    await logAdminAction({
      actorId: context.userId,
      targetUserId: null,
      action: AUDIT_ACTIONS.branchUpdated,
      details: { branchNo, fields: changed },
    });

    return { branchNo, changed: Object.keys(changed).length };
  });

export const branchImportHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d?: { limit?: number }) =>
    z.object({ limit: z.number().int().min(1).max(100).optional().default(20) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertCanManageBranches(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // `snapshot` is deliberately not selected: it is a full copy of the branch
    // table per row, and this list renders twenty of them. `snapshot_rows`
    // carries the only thing the list needs to know about it.
    const { data: entries, error } = await supabaseAdmin
      .from("branch_imports")
      .select(
        "id,imported_at,imported_by,actor_role,mode,file_name,rows_total,rows_added,rows_updated,rows_removed,rows_ignored,rows_failed,validation_summary,reverted_from,notes,snapshot_rows",
      )
      .order("imported_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);

    const rows = (entries ?? []) as any[];
    const importerIds = [...new Set(rows.map((row) => row.imported_by).filter(Boolean))];
    const names = new Map<string, string>();
    if (importerIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id,full_name")
        .in("id", importerIds);
      for (const profile of (profiles ?? []) as any[]) names.set(profile.id, profile.full_name);
    }

    return rows.map((row) => ({
      id: row.id as string,
      imported_at: row.imported_at as string,
      imported_by: row.imported_by as string | null,
      importer_name: row.imported_by ? (names.get(row.imported_by) ?? null) : null,
      actor_role: (row.actor_role as string | null) ?? null,
      mode: row.mode as string,
      file_name: row.file_name as string | null,
      rows_total: row.rows_total as number,
      rows_added: row.rows_added as number,
      rows_updated: row.rows_updated as number,
      rows_removed: row.rows_removed as number,
      rows_ignored: (row.rows_ignored as number) ?? 0,
      rows_failed: (row.rows_failed as number) ?? 0,
      validation_summary: (row.validation_summary ??
        null) as ImportHistoryEntry["validation_summary"],
      reverted_from: row.reverted_from as string | null,
      notes: row.notes as string | null,
      restorable: (row.snapshot_rows as number) > 0,
    }));
  });

/**
 * The most recent uploaded workbook, for editing offline and uploading again.
 *
 * Two calls rather than one, and deliberately: `branchImportLastFileMeta` is
 * cheap and tells the page whether to offer a download button and what to label
 * it, while `branchImportLastFile` transfers the bytes and only runs when
 * somebody presses that button. Folding the file into the metadata would mean
 * every visit to the import page pulls a spreadsheet nobody asked for.
 *
 * "Most recent" means the newest entry that *has* a file. A rollback has no
 * upload behind it and imports predating the column have none either, so the
 * newest entry is frequently not the answer.
 */
const SOURCE_META_COLUMNS = "id,imported_at,file_name,source_file_type,source_file_size";

export interface LastImportFileMeta {
  id: string;
  importedAt: string;
  fileName: string | null;
  type: string | null;
  size: number | null;
}

export const branchImportLastFileMeta = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LastImportFileMeta | null> => {
    await assertCanManageBranches(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data, error } = await supabaseAdmin
      .from("branch_imports")
      .select(SOURCE_META_COLUMNS)
      .not("source_file", "is", null)
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;

    return {
      id: data.id as string,
      importedAt: data.imported_at as string,
      fileName: (data.file_name as string | null) ?? null,
      type: (data.source_file_type as string | null) ?? null,
      size: (data.source_file_size as number | null) ?? null,
    };
  });

export const branchImportLastFile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertCanManageBranches(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data, error } = await supabaseAdmin
      .from("branch_imports")
      .select("file_name,source_file,source_file_type")
      .not("source_file", "is", null)
      .order("imported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.source_file) throw new Error("No uploaded file has been kept yet");

    return {
      fileName: (data.file_name as string | null) ?? "branches.xlsx",
      type:
        (data.source_file_type as string | null) ??
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: data.source_file as string,
    };
  });

export const branchImportRollback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { importId: string }) => z.object({ importId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdministrator(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: entry, error } = await supabaseAdmin
      .from("branch_imports")
      .select("id,snapshot,snapshot_rows,mode,file_name,imported_at")
      .eq("id", data.importId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!entry) throw new Error("That import no longer exists");

    const snapshot = (entry.snapshot ?? []) as any[];
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
      throw new Error(
        "That entry has no snapshot to restore — it ran when the directory was empty.",
      );
    }

    // Snapshot the present before overwriting it, so a rollback is itself
    // reversible. Rolling back to the wrong point is a mistake someone will make
    // at least once, and it should not be the one action in this feature with no
    // way out.
    const before = await readAllBranches(supabaseAdmin);
    const restoredCodes = new Set(snapshot.map((row) => row.branch_no as string));

    const now = new Date().toISOString();
    // Rows are restored verbatim, `active` included: the point of a rollback is
    // to reproduce the earlier state exactly, deactivations and all.
    const payload = snapshot.map((row) => ({
      branch_no: row.branch_no,
      city: row.city,
      phone: row.phone ?? null,
      area_manager: row.area_manager ?? null,
      area_manager_phone: row.area_manager_phone ?? null,
      email: row.email ?? null,
      address: row.address ?? null,
      maps_url: row.maps_url ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      scooter: row.scooter ?? false,
      scooter_note: row.scooter_note ?? null,
      working_hours: row.working_hours ?? null,
      friday_hours: row.friday_hours ?? null,
      duty_hours: row.duty_hours ?? null,
      active: row.active ?? true,
      updated_at: now,
    }));
    await upsertChunked(supabaseAdmin, payload);

    // Branches created after the snapshot are deactivated rather than deleted —
    // the same FK constraint applies, and one of them may already have taken an
    // order in the window being rolled back.
    const orphaned = before
      .filter((row) => row.active && !restoredCodes.has(row.branch_no as string))
      .map((row) => row.branch_no as string);
    if (orphaned.length > 0) await deactivate(supabaseAdmin, orphaned);

    const { data: created, error: historyError } = await supabaseAdmin
      .from("branch_imports")
      .insert({
        imported_by: context.userId,
        mode: "rollback",
        file_name: entry.file_name ?? null,
        rows_total: snapshot.length,
        rows_added: 0,
        rows_updated: snapshot.length,
        rows_removed: orphaned.length,
        snapshot: before,
        snapshot_rows: before.length,
        reverted_from: entry.id,
        notes: `Restored the directory as it stood before the ${entry.mode} import of ${entry.imported_at}.`,
      })
      .select("id")
      .single();
    if (historyError) throw new Error(historyError.message);

    await logAdminAction({
      actorId: context.userId,
      targetUserId: null,
      action: AUDIT_ACTIONS.branchesRolledBack,
      details: {
        rolledBackTo: entry.id,
        rolledBackToMode: entry.mode,
        rolledBackToTime: entry.imported_at,
        newEntryId: created?.id ?? null,
        rowsRestored: snapshot.length,
        rowsDeactivated: orphaned.length,
      },
    });

    return { restored: snapshot.length, deactivated: orphaned.length };
  });
