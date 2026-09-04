import { businessToday, compareDates, type BusinessDate, type DateWindow } from "./dates";
import {
  generateCashLeads,
  generateRetentionBacklog,
  generateRetentionLeads,
  generateWasfatyLeads,
  type GenerationResult,
  type LeadDraft,
  type RetentionCandidate,
} from "./generation";
import { buildCatalog, type ProductCatalog } from "./products";
import {
  DEFAULT_SETTINGS,
  type LeadType,
  type SourceRecordInput,
  type TelesalesSettings,
} from "./types";

/**
 * Running lead generation.
 *
 * Server-only. Fetches candidates, calls the pure projection in
 * `generation.ts`, and writes the result. Every business decision lives in that
 * pure module and is unit tested there; this file is transport, batching and
 * bookkeeping.
 *
 * ===========================================================================
 * Idempotency, and why it is not a check
 * ===========================================================================
 * Running twice must not duplicate leads. This does not achieve that by asking
 * whether a lead exists before inserting one — that is a race, and the first
 * time it loses will be the morning somebody presses "Generate now" while the
 * cron job is already running.
 *
 * Instead every insert carries a `dedup_key`, `UNIQUE (lead_type, dedup_key)`
 * refuses the second, and the refusal is *counted* rather than raised. Postgres
 * arbitrates; the application reports.
 *
 * The mechanism is `.upsert(..., { onConflict: "lead_type,dedup_key",
 * ignoreDuplicates: true })`, which compiles to `ON CONFLICT DO NOTHING` and
 * returns only the rows that were actually inserted. The difference between the
 * chunk size and the returned length is the duplicate count.
 */

/** Leads per insert round trip. */
const WRITE_CHUNK = 250;
/** Source rows fetched per page when scanning a window. */
const READ_PAGE = 1000;

export interface GenerationSummary {
  runId: string | null;
  leadType: LeadType;
  anchorDate: BusinessDate;
  windowFrom: BusinessDate | null;
  windowTo: BusinessDate | null;
  candidates: number;
  created: number;
  skippedDuplicate: number;
  skippedIneligible: number;
  errors: number;
  errorSummary: string | null;
}

/* ------------------------------------------------------------------------- */
/* Configuration                                                             */
/* ------------------------------------------------------------------------- */

export async function loadSettings(supabase: any): Promise<TelesalesSettings> {
  const { data, error } = await supabase
    .from("telesales_settings")
    .select(
      "cash_window_days,cash_window_lag_days,wasfaty_window_days,retention_overdue_grace_days,automation_enabled,generation_hour",
    )
    .eq("id", true)
    .maybeSingle();

  // A missing settings row is not a reason to stop generating leads; the
  // defaults in `types.ts` are the same numbers the migration seeds.
  if (error || !data) return DEFAULT_SETTINGS;
  const row = data as Record<string, number | boolean>;
  return {
    cashWindowDays: Number(row.cash_window_days ?? DEFAULT_SETTINGS.cashWindowDays),
    cashWindowLagDays: Number(row.cash_window_lag_days ?? DEFAULT_SETTINGS.cashWindowLagDays),
    wasfatyWindowDays: Number(row.wasfaty_window_days ?? DEFAULT_SETTINGS.wasfatyWindowDays),
    retentionOverdueGraceDays: Number(
      row.retention_overdue_grace_days ?? DEFAULT_SETTINGS.retentionOverdueGraceDays,
    ),
    automationEnabled: Boolean(row.automation_enabled),
    generationHour: Number(row.generation_hour ?? DEFAULT_SETTINGS.generationHour),
  };
}

export async function loadCatalog(supabase: any): Promise<ProductCatalog> {
  const [{ data: products }, { data: patterns }] = await Promise.all([
    supabase
      .from("telesales_products")
      .select(
        "item_code,item_name,family,strength,category,eligible_cash,eligible_retention,refill_days,active",
      )
      .eq("active", true),
    supabase
      .from("telesales_product_patterns")
      .select("pattern,family,eligible,priority,active")
      .eq("active", true),
  ]);

  return buildCatalog(
    ((products as any[]) ?? []).map((p) => ({
      itemCode: p.item_code,
      itemName: p.item_name,
      family: p.family,
      strength: p.strength,
      category: p.category,
      eligibleCash: p.eligible_cash,
      eligibleRetention: p.eligible_retention,
      refillDays: p.refill_days,
      active: p.active,
    })),
    ((patterns as any[]) ?? []).map((p) => ({
      pattern: p.pattern,
      family: p.family,
      eligible: p.eligible,
      priority: p.priority,
      active: p.active,
    })),
  );
}

/* ------------------------------------------------------------------------- */
/* Reading candidates                                                        */
/* ------------------------------------------------------------------------- */

const SOURCE_COLUMNS =
  "id,source_type,row_number,content_hash,customer_ref,customer_name,phone_raw,phone," +
  "phone_rejection,phone_alternates," +
  "branch_no,city,facility,item_code,item_name,quantity,unit_price,total_value," +
  "source_date,fill_date,dispense_time,callback_date,document_no,channel,patient_id,prescription_no";

function toSourceRecord(row: any): SourceRecordInput & { id: string } {
  return {
    id: row.id,
    sourceType: row.source_type,
    rowNumber: row.row_number,
    contentHash: row.content_hash,
    customerRef: row.customer_ref,
    customerName: row.customer_name,
    phoneRaw: row.phone_raw,
    phone: row.phone,
    phoneRejection: row.phone_rejection ?? null,
    phoneAlternates: row.phone_alternates ?? [],
    branchNo: row.branch_no,
    city: row.city,
    facility: row.facility,
    itemCode: row.item_code,
    itemName: row.item_name,
    quantity: row.quantity == null ? null : Number(row.quantity),
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
    totalValue: row.total_value == null ? null : Number(row.total_value),
    sourceDate: row.source_date,
    fillDate: row.fill_date,
    dispenseTime: row.dispense_time,
    documentNo: row.document_no,
    channel: row.channel,
    patientId: row.patient_id,
    prescriptionNo: row.prescription_no,
    callbackDate: row.callback_date,
    agentLabel: null,
    actionLabel: null,
    notes: null,
    raw: {},
  };
}

/**
 * Narrowing a generation run to part of the available source data.
 *
 * Every field is optional and every one is applied **in the database**, not in
 * JavaScript — the point of filtering is to fetch less, and a filter that reads
 * every row and then discards most of them is a slower way to do the same run.
 *
 * These narrow *which rows are considered*. They never relax an eligibility
 * rule: a row inside the filter that fails `judgeCashRecord` is still refused,
 * and the same `dedup_key` still arbitrates duplicates. Filtering can only ever
 * produce a subset of what an unfiltered run would have produced.
 */
export interface GenerationFilters {
  /** Only rows from this import. */
  importId?: string | null;
  /** Only these branches. */
  branchNos?: string[] | null;
  /** Only these cities. */
  cities?: string[] | null;
  /** Only these product codes. */
  itemCodes?: string[] | null;
  /** True: only rows with a usable phone. False: only rows without one. */
  hasPhone?: boolean | null;
  /** Narrow the date window further. Never widens it — see `applyFilters`. */
  dateFrom?: BusinessDate | null;
  dateTo?: BusinessDate | null;
}

/** How many values one `in (...)` filter may carry, so the URL cannot overrun. */
const FILTER_VALUE_LIMIT = 200;

function cleanList(values: string[] | null | undefined): string[] | null {
  if (!values?.length) return null;
  const out = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  return out.length ? out.slice(0, FILTER_VALUE_LIMIT) : null;
}

/** Apply the optional narrowing to a PostgREST query builder. */
function applyFilters(query: any, filters: GenerationFilters | undefined): any {
  if (!filters) return query;
  let q = query;
  if (filters.importId) q = q.eq("import_id", filters.importId);

  const branches = cleanList(filters.branchNos);
  if (branches) q = q.in("branch_no", branches);

  const cities = cleanList(filters.cities);
  if (cities) q = q.in("city", cities);

  const codes = cleanList(filters.itemCodes);
  if (codes) q = q.in("item_code", codes);

  if (filters.hasPhone === true) q = q.not("phone", "is", null);
  else if (filters.hasPhone === false) q = q.is("phone", null);

  return q;
}

/**
 * Source rows whose operative date falls in a window.
 *
 * Paged, because the alternative is `select(...)` over a table that will hold
 * millions of rows and a PostgREST default limit quietly truncating the run to
 * the first thousand — which would look exactly like "the window was empty".
 *
 * The `source_date` filter is applied in the database, not in JavaScript. The
 * July extract is 173,008 rows and its eligible window is about 190; fetching
 * the former to find the latter is the Excel workflow with extra steps.
 *
 * Archived rows are excluded. Archiving an import takes its leads out of the
 * queue, and a generator that then re-created them from the same rows would
 * undo the archive on the next run — which is exactly what would have happened
 * here, silently, the first time somebody archived an import whose window was
 * still open.
 */
async function fetchWindow(
  supabase: any,
  sourceType: string,
  from: BusinessDate,
  to: BusinessDate,
  filters?: GenerationFilters,
): Promise<(SourceRecordInput & { id: string })[]> {
  const out: (SourceRecordInput & { id: string })[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await applyFilters(
      supabase
        .from("telesales_source_records")
        .select(SOURCE_COLUMNS)
        .eq("source_type", sourceType)
        .is("archived_at", null)
        .gte("source_date", from)
        .lte("source_date", to),
      filters,
    )
      .order("source_date", { ascending: true })
      .order("id", { ascending: true })
      .range(page * READ_PAGE, page * READ_PAGE + READ_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as any[]) ?? [];
    out.push(...rows.map(toSourceRecord));
    if (rows.length < READ_PAGE) break;
  }
  return out;
}

/**
 * The window a run actually reads, after any narrowing.
 *
 * A filter may only ever shrink the window. Letting `dateFrom` reach outside it
 * would turn a filter into a way to bypass the eligibility rule the window
 * exists to express — a Wasfaty run could be made to generate last March's
 * prescriptions by typing a date into a filter box, which is not a filter, it
 * is a different business decision.
 */
function narrowWindow(window: DateWindow, filters: GenerationFilters | undefined): DateWindow {
  if (!filters) return window;
  const from =
    filters.dateFrom && compareDates(filters.dateFrom, window.from) > 0
      ? filters.dateFrom
      : window.from;
  const to =
    filters.dateTo && compareDates(filters.dateTo, window.to) < 0 ? filters.dateTo : window.to;
  // An inverted range yields nothing rather than throwing: the operator asked
  // for an empty set and an empty set is a legitimate answer.
  return compareDates(from, to) > 0 ? { from, to: from } : { from, to };
}

/**
 * Numbers already found for Wasfaty patients.
 *
 * Loaded once per run so a patient whose number a colleague looked up last month
 * arrives dialable. Only the current number per patient — superseded rows are
 * history, not contact details.
 */
async function fetchKnownPhones(supabase: any): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("telesales_patient_contacts")
      .select("patient_id,phone")
      .is("superseded_at", null)
      .range(page * READ_PAGE, page * READ_PAGE + READ_PAGE - 1);
    if (error) break;
    const rows = (data as { patient_id: string; phone: string }[]) ?? [];
    for (const r of rows) map.set(r.patient_id, r.phone);
    if (rows.length < READ_PAGE) break;
  }
  return map;
}

/**
 * Converted leads whose next cycle has come due.
 *
 * The join that makes retention a lifecycle rather than a table: a lead that was
 * converted, whose follow-up is scheduled and due, and which has not already
 * produced a child cycle.
 *
 * The last clause is why this reads `parent_lead_id` back: without it a lead
 * whose next cycle was generated yesterday would be a candidate again today, and
 * only the unique index would stop it — correctly, but by counting a duplicate
 * every single day and burying the real numbers.
 */
async function fetchRetentionCandidates(
  supabase: any,
  from: BusinessDate,
  to: BusinessDate,
): Promise<RetentionCandidate[]> {
  const { data, error } = await supabase
    .from("telesales_followups")
    .select(
      "due_on,lead_id," +
        "telesales_leads!inner(id,lead_type,cycle_number,customer_ref,customer_name,phone," +
        "branch_no,city,channel,item_code,item_name,product_family,product_strength,status)",
    )
    .eq("status", "scheduled")
    .gte("due_on", from)
    .lte("due_on", to)
    .limit(5000);
  if (error) throw new Error(error.message);

  const rows = (data as any[]) ?? [];
  const leadIds = rows.map((r) => r.telesales_leads?.id).filter(Boolean);
  const alreadyChained = new Set<string>();
  if (leadIds.length > 0) {
    const { data: children } = await supabase
      .from("telesales_leads")
      .select("parent_lead_id")
      .in("parent_lead_id", leadIds);
    for (const c of (children as { parent_lead_id: string }[]) ?? []) {
      alreadyChained.add(c.parent_lead_id);
    }
  }

  const out: RetentionCandidate[] = [];
  for (const row of rows) {
    const lead = row.telesales_leads;
    if (!lead) continue;
    // Only a conversion begins a refill cycle. A follow-up on a lead still being
    // chased is the agent's own reminder, and it belongs in the queue as that
    // lead, not as a new one.
    if (lead.status !== "converted") continue;
    if (alreadyChained.has(lead.id)) continue;
    out.push({
      id: lead.id,
      leadType: lead.lead_type,
      cycleNumber: lead.cycle_number ?? 1,
      customerRef: lead.customer_ref,
      customerName: lead.customer_name,
      phone: lead.phone,
      branchNo: lead.branch_no,
      city: lead.city,
      channel: lead.channel,
      itemCode: lead.item_code,
      itemName: lead.item_name,
      productFamily: lead.product_family,
      productStrength: lead.product_strength,
      dueOn: row.due_on,
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Writing                                                                   */
/* ------------------------------------------------------------------------- */

function draftToRow(draft: LeadDraft, runId: string | null) {
  return {
    lead_type: draft.leadType,
    dedup_key: draft.dedupKey,
    source_record_id: draft.sourceRecordId,
    generation_run_id: runId,
    parent_lead_id: draft.parentLeadId,
    cycle_number: draft.cycleNumber,
    priority: draft.priority,
    status: "new",
    customer_ref: draft.customerRef,
    customer_name: draft.customerName,
    phone: draft.phone,
    phone_alternates: draft.phoneAlternates,
    branch_no: draft.branchNo,
    city: draft.city,
    facility: draft.facility,
    channel: draft.channel,
    item_code: draft.itemCode,
    item_name: draft.itemName,
    product_family: draft.productFamily,
    product_strength: draft.productStrength,
    quantity: draft.quantity,
    total_value: draft.totalValue,
    document_no: draft.documentNo,
    patient_id: draft.patientId,
    prescription_no: draft.prescriptionNo,
    source_date: draft.sourceDate,
    generation_reason: draft.generationReason,
  };
}

/**
 * Insert the drafts, letting the unique index arbitrate.
 *
 * Returns the created rows so the caller can write their `created` activity and
 * open the follow-ups the drafts asked for. A conflict yields no row and is
 * therefore invisible here, which is exactly right — a duplicate produced no
 * lead, so it produced no history either.
 */
async function insertDrafts(
  supabase: any,
  drafts: readonly LeadDraft[],
  runId: string | null,
): Promise<{ created: { id: string; draft: LeadDraft }[]; duplicates: number }> {
  const created: { id: string; draft: LeadDraft }[] = [];
  let duplicates = 0;

  for (let i = 0; i < drafts.length; i += WRITE_CHUNK) {
    const chunk = drafts.slice(i, i + WRITE_CHUNK);
    const { data, error } = await supabase
      .from("telesales_leads")
      .upsert(
        chunk.map((d) => draftToRow(d, runId)),
        { onConflict: "lead_type,dedup_key", ignoreDuplicates: true },
      )
      .select("id,dedup_key,lead_type");
    if (error) throw new Error(error.message);

    const rows = (data as { id: string; dedup_key: string }[]) ?? [];
    const byKey = new Map(rows.map((r) => [r.dedup_key, r.id]));
    for (const draft of chunk) {
      const id = byKey.get(draft.dedupKey);
      if (id) created.push({ id, draft });
      else duplicates++;
    }
  }

  return { created, duplicates };
}

/**
 * The opening entries: a `created` activity per lead, and the follow-up a draft
 * asked for.
 *
 * Written in bulk rather than per lead. A Cash morning is roughly 190 leads and
 * a Wasfaty one can be several hundred; 500 individual inserts to record that
 * they exist would dominate the run.
 */
async function writeOpeningEntries(
  supabase: any,
  created: readonly { id: string; draft: LeadDraft }[],
): Promise<void> {
  if (created.length === 0) return;

  for (let i = 0; i < created.length; i += WRITE_CHUNK) {
    const chunk = created.slice(i, i + WRITE_CHUNK);
    await supabase.from("telesales_lead_activities").insert(
      chunk.map(({ id, draft }) => ({
        lead_id: id,
        activity_type: draft.parentLeadId ? "cycle_started" : "created",
        to_status: "new",
        note: draft.generationReason,
        actor_name: "Lead generation",
        metadata: { lead_type: draft.leadType, cycle: draft.cycleNumber },
      })),
    );

    const followups = chunk
      .filter(({ draft }) => draft.followupDueOn)
      .map(({ id, draft }) => ({
        lead_id: id,
        due_on: draft.followupDueOn,
        reason: draft.generationReason,
        status: "scheduled",
      }));
    if (followups.length > 0) {
      await supabase.from("telesales_followups").insert(followups);
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The runs                                                                  */
/* ------------------------------------------------------------------------- */

async function openRun(
  supabase: any,
  input: {
    leadType: LeadType;
    executionSource: "scheduled" | "manual";
    anchorDate: BusinessDate;
    actorId: string | null;
    filters?: GenerationFilters;
  },
): Promise<string | null> {
  /*
   * The scope is recorded on the run, not just applied to it.
   *
   * "Why did Tuesday's run create 12 leads when Monday's created 400" is
   * unanswerable if a filtered run looks identical to a full one afterwards.
   * `import_id` is a column because it is the scope people ask about; the rest
   * travel as jsonb because they are a variable set and nothing joins on them.
   */
  const filters = input.filters ?? {};
  const scope: Record<string, unknown> = {};
  if (filters.branchNos?.length) scope.branch_nos = filters.branchNos;
  if (filters.cities?.length) scope.cities = filters.cities;
  if (filters.itemCodes?.length) scope.item_codes = filters.itemCodes;
  if (filters.hasPhone != null) scope.has_phone = filters.hasPhone;
  if (filters.dateFrom) scope.date_from = filters.dateFrom;
  if (filters.dateTo) scope.date_to = filters.dateTo;

  const { data } = await supabase
    .from("telesales_generation_runs")
    .insert({
      lead_type: input.leadType,
      execution_source: input.executionSource,
      anchor_date: input.anchorDate,
      status: "running",
      actor_id: input.actorId,
      import_id: filters.importId ?? null,
      filters: Object.keys(scope).length ? scope : null,
    })
    .select("id")
    .single();
  return (data as { id: string } | null)?.id ?? null;
}

async function closeRun(
  supabase: any,
  runId: string | null,
  summary: Omit<GenerationSummary, "runId" | "leadType" | "anchorDate">,
  status: "completed" | "failed",
): Promise<void> {
  if (!runId) return;
  await supabase
    .from("telesales_generation_runs")
    .update({
      status,
      window_from: summary.windowFrom,
      window_to: summary.windowTo,
      candidates: summary.candidates,
      leads_created: summary.created,
      skipped_duplicate: summary.skippedDuplicate,
      skipped_ineligible: summary.skippedIneligible,
      errors: summary.errors,
      error_summary: summary.errorSummary,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

function skipTotal(result: GenerationResult): number {
  return (
    result.skipped.ineligible_product +
    result.skipped.no_contact_identity +
    result.skipped.no_date +
    result.skipped.outside_window
  );
}

/**
 * Generate one pipeline for one anchor date.
 *
 * The anchor defaults to today in Riyadh and may be set explicitly, which is how
 * a backfill is run — and how the July workbook's own history could be
 * reproduced day by day if anybody wanted to.
 */
export async function runGeneration(
  supabase: any,
  input: {
    leadType: LeadType;
    anchorDate?: BusinessDate;
    executionSource?: "scheduled" | "manual";
    actorId?: string | null;
    /**
     * Narrow the run to part of the source data — one import, some branches,
     * only rows with a phone. Omitted, the run behaves exactly as it always
     * has: the whole window, every pipeline row in it.
     */
    filters?: GenerationFilters;
  },
): Promise<GenerationSummary> {
  const anchorDate = input.anchorDate ?? businessToday();
  const executionSource = input.executionSource ?? "scheduled";
  const runId = await openRun(supabase, {
    leadType: input.leadType,
    executionSource,
    anchorDate,
    actorId: input.actorId ?? null,
    filters: input.filters,
  });

  try {
    const settings = await loadSettings(supabase);
    let result: GenerationResult;

    if (input.leadType === "cash") {
      const catalog = await loadCatalog(supabase);
      const full = (await import("./dates")).cashWindow(anchorDate, {
        days: settings.cashWindowDays,
        lagDays: settings.cashWindowLagDays,
      });
      const window = narrowWindow(full, input.filters);
      const records = await fetchWindow(supabase, "cash", window.from, window.to, input.filters);
      result = generateCashLeads(anchorDate, records, catalog, settings);
      // The generator computes the full window itself; report the one actually read.
      result = { ...result, window };
    } else if (input.leadType === "wasfaty") {
      const full = (await import("./dates")).wasfatyWindow(anchorDate, {
        days: settings.wasfatyWindowDays,
      });
      const window = narrowWindow(full, input.filters);
      const [records, phones] = await Promise.all([
        fetchWindow(supabase, "wasfaty", window.from, window.to, input.filters),
        fetchKnownPhones(supabase),
      ]);
      result = generateWasfatyLeads(anchorDate, records, settings, phones);
      result = { ...result, window };
    } else {
      /*
       * Retention cycles cannot be scoped, and say so rather than pretending.
       *
       * A cycle is raised from a *converted lead's* due follow-up, not from an
       * import's source rows -- cycle 2 has no source record at all. So there is
       * nothing here for `import_id`, a branch or a phone filter to narrow, and
       * the reads below deliberately take none.
       *
       * Refused rather than ignored. Accepting a filter and not applying it
       * would record a run stamped with a scope it never honoured, which is
       * worse than an error: the run history is what "why did this create 400
       * leads" is answered from. Seeding a retention *import* is
       * `runRetentionBacklog`, which is import-scoped and is what the review
       * screen calls.
       */
      if (input.filters && Object.keys(input.filters).length > 0) {
        throw new Error(
          "Retention cycles are raised from due follow-ups, not from an import, so they cannot be filtered. Seed the retention backlog from the import instead.",
        );
      }
      const catalog = await loadCatalog(supabase);
      const window = (await import("./dates")).retentionWindow(anchorDate, {
        graceDays: settings.retentionOverdueGraceDays,
      });
      const candidates = await fetchRetentionCandidates(supabase, window.from, window.to);
      result = generateRetentionLeads(anchorDate, candidates, catalog, settings);
    }

    const { created, duplicates } = await insertDrafts(supabase, result.drafts, runId);
    await writeOpeningEntries(supabase, created);

    const summary: GenerationSummary = {
      runId,
      leadType: input.leadType,
      anchorDate,
      windowFrom: result.window.from,
      windowTo: result.window.to,
      candidates: result.candidates,
      created: created.length,
      skippedDuplicate: duplicates,
      skippedIneligible: skipTotal(result),
      errors: 0,
      errorSummary: null,
    };
    await closeRun(supabase, runId, summary, "completed");
    return summary;
  } catch (err) {
    const message = (err as Error)?.message?.slice(0, 500) ?? "unknown error";
    const summary: GenerationSummary = {
      runId,
      leadType: input.leadType,
      anchorDate,
      windowFrom: null,
      windowTo: null,
      candidates: 0,
      created: 0,
      skippedDuplicate: 0,
      skippedIneligible: 0,
      errors: 1,
      errorSummary: message,
    };
    await closeRun(supabase, runId, summary, "failed");
    return summary;
  }
}

/**
 * Seed the retention backlog from an import.
 *
 * The cutover path, run once per uploaded Retention workbook. Separate from
 * `runGeneration` because it has no date window — the point is to take the
 * backlog exactly as it stands, overdue rows included.
 */
export async function runRetentionBacklog(
  supabase: any,
  input: { importId: string; actorId: string | null },
): Promise<GenerationSummary> {
  const anchorDate = businessToday();
  const runId = await openRun(supabase, {
    leadType: "retention",
    executionSource: "manual",
    anchorDate,
    actorId: input.actorId,
  });

  try {
    const catalog = await loadCatalog(supabase);
    const records: (SourceRecordInput & { id: string })[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await supabase
        .from("telesales_source_records")
        .select(SOURCE_COLUMNS)
        .eq("import_id", input.importId)
        /*
         * Live rows only, matching `fetchWindow`.
         *
         * Archiving an import takes its rows and its leads out of the desk's
         * view; re-seeding from them would read rows that are no longer
         * supposed to exist. The unique index would refuse the resulting
         * duplicates today, so this is a latent hazard rather than a live bug --
         * but it is the same omission that was fixed in the windowed read, and
         * leaving one of the two uncorrected is how it comes back.
         */
        .is("archived_at", null)
        .order("row_number", { ascending: true })
        .range(page * READ_PAGE, page * READ_PAGE + READ_PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data as any[]) ?? [];
      records.push(...rows.map(toSourceRecord));
      if (rows.length < READ_PAGE) break;
    }

    const result = generateRetentionBacklog(records, catalog);
    const { created, duplicates } = await insertDrafts(supabase, result.drafts, runId);
    await writeOpeningEntries(supabase, created);

    const summary: GenerationSummary = {
      runId,
      leadType: "retention",
      anchorDate,
      windowFrom: null,
      windowTo: null,
      candidates: result.candidates,
      created: created.length,
      skippedDuplicate: duplicates,
      skippedIneligible: skipTotal(result),
      errors: 0,
      errorSummary: null,
    };
    await closeRun(supabase, runId, summary, "completed");
    return summary;
  } catch (err) {
    const summary: GenerationSummary = {
      runId,
      leadType: "retention",
      anchorDate,
      windowFrom: null,
      windowTo: null,
      candidates: 0,
      created: 0,
      skippedDuplicate: 0,
      skippedIneligible: 0,
      errors: 1,
      errorSummary: (err as Error)?.message?.slice(0, 500) ?? "unknown error",
    };
    await closeRun(supabase, runId, summary, "failed");
    return summary;
  }
}

/**
 * The daily sweep: all three pipelines, in order.
 *
 * Cash and Wasfaty first, retention last, because retention reads the leads the
 * other two may have just converted — running it first would defer every cycle
 * that came due on the same morning it was earned by a day.
 */
export async function runDailyGeneration(
  supabase: any,
  input: {
    anchorDate?: BusinessDate;
    executionSource?: "scheduled" | "manual";
    actorId?: string | null;
  } = {},
): Promise<GenerationSummary[]> {
  const out: GenerationSummary[] = [];
  for (const leadType of ["cash", "wasfaty", "retention"] as LeadType[]) {
    out.push(await runGeneration(supabase, { ...input, leadType }));
  }
  return out;
}
