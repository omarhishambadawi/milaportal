import type { ParsedWorkbook, SourceRecordInput, SourceType } from "./types";

/**
 * Writing an imported workbook.
 *
 * Server-only. An import is not one write: it records the upload, stores up to
 * 173,008 normalised rows, and reports what it could not read. Half of that
 * landing is worse than none of it, so the whole sequence lives behind one
 * authorization check in `telesales.functions.ts` and one error path here.
 *
 * ### Nothing is ever overwritten
 *
 * A second upload of an overlapping file creates a *second* import with its own
 * rows. That is the requirement — "do not destroy or overwrite previous source
 * imports; we need traceability" — and it is also the thing the workbook could
 * not do: `July Leads` → `Main Database` holds 21-31 July while the working
 * sheets beside it cover 3-31 July, because the source tab was pasted over each
 * time a new extract arrived. Nothing in that file can say which extract
 * produced which lead.
 *
 * Deduplication happens later, at lead generation, where the unique index on
 * `(lead_type, dedup_key)` decides. Source rows are history; leads are work.
 */

/** Rows per insert round trip. */
const WRITE_CHUNK = 500;

export interface ImportOutcome {
  importId: string;
  sourceType: SourceType;
  rowsTotal: number;
  rowsStored: number;
  rowsDuplicate: number;
  rowsRejected: number;
  /** A previous import of the same content, when one exists. */
  previousImportId: string | null;
  issues: ParsedWorkbook["issues"];
}

/**
 * Has this exact workbook been imported before?
 *
 * Advisory, not blocking. Re-importing is legitimate — the pharmacy re-sends a
 * corrected file, or an operator wants a clean run — so the answer is reported
 * to the caller, and the caller decides. Blocking it would mean the one time it
 * mattered, somebody would work around it by editing a cell.
 */
export async function findPreviousImport(
  supabase: any,
  sourceType: SourceType,
  digest: string,
): Promise<string | null> {
  if (!digest) return null;
  const { data, error } = await supabase
    .from("telesales_imports")
    .select("id")
    .eq("source_type", sourceType)
    .eq("content_digest", digest)
    .eq("status", "completed")
    .order("imported_at", { ascending: false })
    .limit(1);
  if (error) return null;
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

function toRow(importId: string, record: SourceRecordInput) {
  return {
    import_id: importId,
    source_type: record.sourceType,
    row_number: record.rowNumber,
    content_hash: record.contentHash,
    customer_ref: record.customerRef,
    customer_name: record.customerName,
    phone_raw: record.phoneRaw,
    phone: record.phone,
    phone_rejection: record.phoneRejection,
    phone_alternates: record.phoneAlternates,
    branch_no: record.branchNo,
    city: record.city,
    facility: record.facility,
    item_code: record.itemCode,
    item_name: record.itemName,
    quantity: record.quantity,
    unit_price: record.unitPrice,
    total_value: record.totalValue,
    source_date: record.sourceDate,
    fill_date: record.fillDate,
    dispense_time: record.dispenseTime,
    callback_date: record.callbackDate,
    document_no: record.documentNo,
    channel: record.channel,
    patient_id: record.patientId,
    prescription_no: record.prescriptionNo,
    raw: record.raw,
  };
}

/**
 * Store a parsed workbook.
 *
 * The import row is written **first**, in `parsing` status, so that a crash
 * halfway through 173,008 rows leaves visible evidence rather than nothing. It
 * is moved to `completed` or `failed` at the end; a row left in `parsing` is a
 * run that died, and the import history shows it as such.
 */
export async function storeImport(
  supabase: any,
  parsed: ParsedWorkbook,
  meta: {
    fileName: string;
    fileSize: number | null;
    importedBy: string;
    actorRole: string | null;
    /**
     * How the file's columns were read, in the operator's words.
     *
     * Stored so "which column did this import treat as the dispense date" is
     * answerable afterwards, which matters most for the file that needed a
     * manual mapping in the first place. Null when nothing was recorded.
     */
    columnMapping?: Record<string, { column: string | null; auto: boolean }> | null;
  },
): Promise<ImportOutcome> {
  const previousImportId = await findPreviousImport(
    supabase,
    parsed.sourceType,
    parsed.contentDigest,
  );

  const rejected = parsed.issues
    .filter((i) => i.code === "missing_identity" || i.code === "empty_row")
    .reduce((sum, i) => sum + i.rows.length, 0);
  const duplicate = parsed.issues
    .filter((i) => i.code === "duplicate_row")
    .reduce((sum, i) => sum + i.rows.length, 0);

  const { data: created, error: createError } = await supabase
    .from("telesales_imports")
    .insert({
      source_type: parsed.sourceType,
      file_name: meta.fileName,
      file_size: meta.fileSize,
      sheet_name: parsed.sheetName || null,
      content_digest: parsed.contentDigest || null,
      status: "parsing",
      rows_total: parsed.rowsSeen,
      imported_by: meta.importedBy,
      actor_role: meta.actorRole,
      column_mapping: meta.columnMapping ?? null,
    })
    .select("id")
    .single();

  if (createError || !created) {
    throw new Error(`Could not record the import: ${createError?.message ?? "no row returned"}`);
  }

  const importId = (created as { id: string }).id;

  try {
    let stored = 0;
    for (let i = 0; i < parsed.records.length; i += WRITE_CHUNK) {
      const chunk = parsed.records.slice(i, i + WRITE_CHUNK).map((r) => toRow(importId, r));
      const { error } = await supabase.from("telesales_source_records").insert(chunk);
      if (error) throw new Error(error.message);
      stored += chunk.length;
    }

    await supabase
      .from("telesales_imports")
      .update({
        status: "completed",
        rows_stored: stored,
        rows_duplicate: duplicate,
        rows_rejected: rejected,
        /*
         * Counts and row numbers only.
         *
         * `issues` never carries a cell's contents. A customer name or a phone
         * number in an import summary would be operational data sitting in a
         * jsonb column that the whole management view reads, for no benefit —
         * the row number is what an operator needs to go and look.
         */
        issues: {
          items: parsed.issues.map((i) => ({
            code: i.code,
            message: i.message,
            rows: i.rows.slice(0, 50),
          })),
        },
      })
      .eq("id", importId);

    return {
      importId,
      sourceType: parsed.sourceType,
      rowsTotal: parsed.rowsSeen,
      rowsStored: stored,
      rowsDuplicate: duplicate,
      rowsRejected: rejected,
      previousImportId,
      issues: parsed.issues,
    };
  } catch (err) {
    /*
     * The rows that did land are kept, and the import is marked failed.
     *
     * Deleting them would be the tidier-looking choice and the wrong one: a
     * partial import is evidence of where the file broke, and the generator
     * ignores incomplete imports anyway because it reads by date window rather
     * than by import.
     */
    await supabase
      .from("telesales_imports")
      .update({
        status: "failed",
        error_summary: (err as Error)?.message?.slice(0, 500) ?? "unknown error",
      })
      .eq("id", importId);
    throw err;
  }
}

/** Recent imports, for the history table. Never selects `raw`. */
export async function listImports(supabase: any, limit = 20) {
  const { data, error } = await supabase
    .from("telesales_imports")
    .select(
      "id,source_type,file_name,file_size,sheet_name,status,rows_total,rows_stored,rows_duplicate,rows_rejected,issues,error_summary,imported_by,actor_role,imported_at",
    )
    .order("imported_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as any[]) ?? [];
}
