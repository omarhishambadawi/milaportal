/**
 * Durable CDR fetch progress, backed by the `cdr_progress` Supabase table
 * so it survives across Cloudflare Worker isolates (Prompt 1, item 3).
 *
 * All functions are async. Callers must `await`. Reads/writes go through
 * supabaseAdmin (service_role); there is no user-facing access to the table.
 */
export interface ProgressState {
  jobId: string;
  status: "pending" | "fetching" | "aggregating" | "done" | "error";
  page: number;
  totalPages: number | null;
  records: number;
  totalReported: number | null;
  message: string;
  updatedAt: number; // epoch ms, for API compatibility with the old shape
  error?: string;
}

const TTL_MS = 10 * 60_000;

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function fromRow(row: any): ProgressState {
  return {
    jobId: row.job_id,
    status: row.status,
    page: row.page ?? 0,
    totalPages: row.total_pages ?? null,
    records: row.records ?? 0,
    totalReported: row.total_reported ?? null,
    message: row.message ?? "",
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
    error: row.error ?? undefined,
  };
}

function toRow(patch: Partial<ProgressState>): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.page !== undefined) row.page = patch.page;
  if (patch.totalPages !== undefined) row.total_pages = patch.totalPages;
  if (patch.records !== undefined) row.records = patch.records;
  if (patch.totalReported !== undefined) row.total_reported = patch.totalReported;
  if (patch.message !== undefined) row.message = patch.message;
  if (patch.error !== undefined) row.error = patch.error;
  return row;
}

async function gc() {
  try {
    const db = await admin();
    const cutoff = new Date(Date.now() - TTL_MS).toISOString();
    await (db.from("cdr_progress" as any) as any).delete().lt("updated_at", cutoff);
  } catch {
    /* best-effort cleanup */
  }
}

export async function initJob(jobId: string): Promise<ProgressState> {
  await gc();
  const db = await admin();
  const state: ProgressState = {
    jobId,
    status: "pending",
    page: 0,
    totalPages: null,
    records: 0,
    totalReported: null,
    message: "Starting…",
    updatedAt: Date.now(),
  };
  await (db.from("cdr_progress" as any) as any).upsert({
    job_id: jobId,
    status: state.status,
    page: 0,
    total_pages: null,
    records: 0,
    total_reported: null,
    message: state.message,
    error: null,
    updated_at: new Date(state.updatedAt).toISOString(),
  });
  return state;
}

export async function updateJob(jobId: string, patch: Partial<ProgressState>): Promise<void> {
  const db = await admin();
  await (db.from("cdr_progress" as any) as any).update(toRow(patch)).eq("job_id", jobId);
}

export async function getJob(jobId: string): Promise<ProgressState | null> {
  const db = await admin();
  const { data } = await (db.from("cdr_progress" as any) as any)
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  return data ? fromRow(data) : null;
}

export async function finishJob(
  jobId: string,
  totalReported: number | null,
  records: number,
): Promise<void> {
  await updateJob(jobId, {
    status: "done",
    message: `Loaded ${records.toLocaleString()} records`,
    records,
    totalReported,
  });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await updateJob(jobId, { status: "error", error, message: error });
}
