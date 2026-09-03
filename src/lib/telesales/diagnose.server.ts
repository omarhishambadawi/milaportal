import { businessToday, cashWindow, wasfatyWindow, type BusinessDate } from "./dates";
import { dedupKeyForRetention, dedupKeyForSource } from "./dedup";
import { diagnoseImport, type DiagnosableRecord, type ImportDiagnosis } from "./diagnostics";
import { loadCatalog, loadSettings } from "./generate.server";
import type { LeadType, SourceType } from "./types";

/**
 * Explaining an import, against the real data.
 *
 * Server-only. Reads the import's rows and the lead keys already in existence,
 * hands both to the pure `diagnoseImport`, and returns counts. Every business
 * judgement is in the pure module and is unit tested there; this file is
 * transport and paging, exactly like `generate.server.ts`.
 *
 * ===========================================================================
 * What it costs
 * ===========================================================================
 * Two bounded reads and no per-row work of any kind:
 *
 *   1. the import's source rows, paged, projected to the columns the rules read
 *   2. the `dedup_key` of existing leads of that type, paged
 *
 * No lookup per row, no MIS call, and nothing written. It is a read-only report
 * run from a management screen, and it stays that way — a diagnostic that
 * mutates the thing it is diagnosing is not a diagnostic.
 *
 * The row cap is real and reported rather than silent. A truncated report that
 * looked complete would be worse than no report: the whole claim of this
 * feature is that the numbers reconcile.
 */

/** Rows per page when reading source records or lead keys. */
const PAGE = 1000;

/**
 * The most rows one diagnosis examines.
 *
 * The live Wasfaty import is 3,937 and the retention one 745, so this is roughly
 * 12x the largest real import. It exists so a future 173,008-row drop produces a
 * capped, honest report instead of an unbounded read.
 */
export const DIAGNOSIS_ROW_LIMIT = 50_000;

/** Only the columns the eligibility rules and the report actually read. */
const DIAGNOSIS_COLUMNS =
  "id,row_number,source_date,phone,customer_ref,customer_name,branch_no,city," +
  "item_code,item_name,patient_id,prescription_no,document_no";

export interface ImportDiagnosisResult extends ImportDiagnosis {
  importId: string;
  sourceType: SourceType;
  fileName: string;
  /** True when the import holds more rows than the cap examined. */
  truncated: boolean;
  rowsInImport: number;
}

/**
 * Which pipeline judges an import's rows.
 *
 * The source type is the lead type for all three, and saying so once here keeps
 * the mapping from being re-derived at each call site.
 */
function leadTypeFor(sourceType: SourceType): LeadType {
  return sourceType;
}

/**
 * The dedup key a row would produce, so "already generated" is answered by the
 * generator's own identity rule rather than by a second one.
 */
function dedupKeyFactory(sourceType: SourceType): (record: DiagnosableRecord) => string {
  if (sourceType === "retention") {
    /*
     * The retention backlog keys on the customer and product at cycle 1 — the
     * same call `generateRetentionBacklog` makes, including the document-number
     * discriminator it passes for rows with no usable phone.
     */
    return (record) =>
      dedupKeyForRetention({
        customerRef: record.customerRef,
        phone: record.phone ?? record.phoneRaw,
        customerName: record.customerName,
        itemCode: record.itemCode,
        itemName: record.itemName,
        cycleNumber: 1,
        documentNo: record.documentNo,
      });
  }
  return (record) => dedupKeyForSource(sourceType, record);
}

/** A source row, in the shape the pure rules expect. */
function toDiagnosable(row: any): DiagnosableRecord {
  return {
    id: row.id,
    sourceType: row.source_type,
    rowNumber: row.row_number ?? 0,
    contentHash: "",
    customerRef: row.customer_ref ?? null,
    customerName: row.customer_name ?? null,
    phoneRaw: null,
    phone: row.phone ?? null,
    phoneRejection: null,
    phoneAlternates: [],
    branchNo: row.branch_no ?? null,
    city: row.city ?? null,
    facility: null,
    itemCode: row.item_code ?? null,
    itemName: row.item_name ?? null,
    quantity: null,
    unitPrice: null,
    totalValue: null,
    sourceDate: row.source_date ?? null,
    fillDate: null,
    dispenseTime: null,
    documentNo: row.document_no ?? null,
    channel: null,
    patientId: row.patient_id ?? null,
    prescriptionNo: row.prescription_no ?? null,
    callbackDate: null,
    agentLabel: null,
    actionLabel: null,
    notes: null,
    raw: {},
  };
}

/** Every `dedup_key` already present for one lead type, archived leads included. */
async function fetchExistingKeys(supabase: any, leadType: LeadType): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("telesales_leads")
      .select("dedup_key")
      .eq("lead_type", leadType)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data as { dedup_key: string }[]) ?? [];
    for (const r of rows) keys.add(r.dedup_key);
    if (rows.length < PAGE) break;
  }
  return keys;
}

/**
 * Explain one import.
 *
 * `anchorDate` defaults to today in Riyadh, so the report answers "what would
 * happen if I generated now". Passing a date answers the same question for that
 * day, which is how the report and a backfill run can be compared.
 *
 * Archived leads count as generated. A row whose lead was archived has already
 * produced one, and re-running generation will not produce another — the unique
 * index does not care that the lead was archived — so reporting it as eligible
 * would promise leads that cannot appear.
 */
export async function diagnoseImportById(
  supabase: any,
  input: { importId: string; anchorDate?: BusinessDate },
): Promise<ImportDiagnosisResult | null> {
  const { data: imp } = await supabase
    .from("telesales_imports")
    .select("id,file_name,source_type,rows_stored")
    .eq("id", input.importId)
    .maybeSingle();
  if (!imp) return null;

  const sourceType = imp.source_type as SourceType;
  const leadType = leadTypeFor(sourceType);
  const anchorDate = input.anchorDate ?? businessToday();
  const settings = await loadSettings(supabase);

  /*
   * The window this pipeline would use today. Retention has none — the backlog
   * is taken as it stands — which `diagnoseImport` expects as null.
   */
  const window =
    sourceType === "cash"
      ? cashWindow(anchorDate, {
          days: settings.cashWindowDays,
          lagDays: settings.cashWindowLagDays,
        })
      : sourceType === "wasfaty"
        ? wasfatyWindow(anchorDate, { days: settings.wasfatyWindowDays })
        : null;

  const records: DiagnosableRecord[] = [];
  let truncated = false;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("telesales_source_records")
      .select(DIAGNOSIS_COLUMNS)
      .eq("import_id", input.importId)
      .is("archived_at", null)
      .order("row_number", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as any[]) ?? [];
    for (const row of rows) records.push(toDiagnosable({ ...row, source_type: sourceType }));
    if (rows.length < PAGE) break;
    if (records.length >= DIAGNOSIS_ROW_LIMIT) {
      truncated = true;
      break;
    }
  }

  const [catalog, existingDedupKeys] = await Promise.all([
    loadCatalog(supabase),
    fetchExistingKeys(supabase, leadType),
  ]);

  const diagnosis = diagnoseImport({
    leadType,
    anchorDate,
    window,
    records,
    catalog,
    existingDedupKeys,
    dedupKeyFor: dedupKeyFactory(sourceType),
  });

  return {
    ...diagnosis,
    importId: input.importId,
    sourceType,
    fileName: imp.file_name,
    truncated,
    rowsInImport: Number(imp.rows_stored ?? records.length),
  };
}
