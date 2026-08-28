/**
 * What the administrator monitoring page reads. Server-only, read-only.
 *
 * Three sources, assembled into one answer:
 *
 *   1. Shams CRM's live status for each kind — is a run happening right now, and
 *      how did the last one go.
 *   2. MilaPortal's own `shams_sync_runs` history — the CRM keeps none.
 *   3. `shams_sync_scheduler_state` — whether the poll itself is alive.
 *
 * The third is the one people forget, and it is the one that matters most. A
 * page showing only Shams's status would have looked perfectly healthy
 * throughout the AlShrouq outage, where the scheduler had not made a single HTTP
 * request in 5,769 consecutive "successful" cron runs. "Shams is fine" and "we
 * are asking Shams" are different claims and this page makes both.
 *
 * Nothing here writes, and nothing here can trigger a synchronisation. The
 * manual controls are deliberately out of scope for this phase; the Desktop
 * remains the manual fallback.
 */

import type { ShamsSyncKind, ShamsSyncStatus } from "./sync-status";
import { getSyncStatus, isSyncConfigured } from "./sync.server";

interface SupabaseLike {
  from: (table: string) => any;
}

/** A failure shaped for a browser: a kind and a sentence, never a body. */
export interface SyncMonitorFailure {
  kind: string;
  message: string;
}

/** One row of MilaPortal's own history. */
export interface ShamsSyncRunRecord {
  id: string;
  syncType: ShamsSyncKind;
  shamsRunId: string | null;
  executionSource: string;
  status: string;
  skipReason: string | null;
  triggeredAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  rowsSeen: number | null;
  rowsChanged: number | null;
  pagesFetched: number | null;
  branchesSeen: number | null;
  branchesTargeted: number | null;
  errorSummary: string | null;
  sourceTimestampsCorrected: boolean;
  lastObservedAt: string | null;
}

/** What the poll last did. Null when the row has never been written. */
export interface ShamsSchedulerState {
  lastPollAt: string | null;
  lastPokeAt: string | null;
  lastTask: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

/** Live status for one kind, or why it could not be read. */
export interface ShamsSyncSide {
  status: ShamsSyncStatus | null;
  error: SyncMonitorFailure | null;
}

export interface ShamsSyncMonitorReport {
  /** Whether this deployment holds Shams CRM credentials at all. */
  configured: boolean;
  stock: ShamsSyncSide;
  promotions: ShamsSyncSide;
  scheduler: ShamsSchedulerState | null;
  history: ShamsSyncRunRecord[];
  /** When this report was assembled, for the "as of" line. */
  observedAt: string;
}

/** How many history rows the page shows. Two kinds, so ~10 nights. */
const HISTORY_LIMIT = 20;

async function toFailure(err: unknown): Promise<SyncMonitorFailure> {
  const { ShamsCrmError } = await import("./client.server");
  if (err instanceof ShamsCrmError) return { kind: err.kind, message: err.message };
  console.warn("[shams-sync] monitor read failed:", (err as Error)?.name ?? "unknown");
  return { kind: "unknown", message: "The Shams CRM status could not be read." };
}

/**
 * Read one side.
 *
 * A failure on one kind never prevents the other from being reported: they are
 * independent syncs against independent endpoints, and an administrator opening
 * this page during a partial outage needs to see which half is working.
 */
async function readSide(kind: ShamsSyncKind, now: number): Promise<ShamsSyncSide> {
  try {
    return { status: await getSyncStatus(kind, now), error: null };
  } catch (err) {
    return { status: null, error: await toFailure(err) };
  }
}

function toRecord(row: Record<string, any>): ShamsSyncRunRecord {
  return {
    id: row.id,
    syncType: row.sync_type,
    shamsRunId: row.shams_run_id ?? null,
    executionSource: row.execution_source,
    status: row.status,
    skipReason: row.skip_reason ?? null,
    triggeredAt: row.triggered_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    durationSeconds: row.duration_seconds ?? null,
    rowsSeen: row.rows_seen ?? null,
    rowsChanged: row.rows_changed ?? null,
    pagesFetched: row.pages_fetched ?? null,
    branchesSeen: row.branches_seen ?? null,
    branchesTargeted: row.branches_targeted ?? null,
    errorSummary: row.error_summary ?? null,
    sourceTimestampsCorrected: row.source_timestamps_corrected === true,
    lastObservedAt: row.last_observed_at ?? null,
  };
}

/**
 * Assemble the report.
 *
 * The two CRM reads run concurrently — they are independent GETs against a
 * third-party host and serialising them would double the page's slowest path for
 * no benefit. The database reads join them in the same wait.
 */
export async function readShamsSyncMonitor(
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<ShamsSyncMonitorReport> {
  const configured = isSyncConfigured();

  const [stock, promotions, historyResult, stateResult] = await Promise.all([
    configured
      ? readSide("stock", now.getTime())
      : Promise.resolve<ShamsSyncSide>({ status: null, error: null }),
    configured
      ? readSide("promotions", now.getTime())
      : Promise.resolve<ShamsSyncSide>({ status: null, error: null }),
    supabase
      .from("shams_sync_runs")
      .select("*")
      .order("triggered_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase.from("shams_sync_scheduler_state").select("*").eq("id", 1).maybeSingle(),
  ]);

  const stateRow = (stateResult as { data?: Record<string, any> | null })?.data ?? null;

  return {
    configured,
    stock,
    promotions,
    scheduler: stateRow
      ? {
          lastPollAt: stateRow.last_poll_at ?? null,
          lastPokeAt: stateRow.last_poke_at ?? null,
          lastTask: stateRow.last_task ?? null,
          lastOutcome: stateRow.last_outcome ?? null,
          lastError: stateRow.last_error ?? null,
          updatedAt: stateRow.updated_at ?? null,
        }
      : null,
    history: (
      ((historyResult as { data?: Record<string, any>[] | null })?.data ?? []) as Record<
        string,
        any
      >[]
    ).map(toRecord),
    observedAt: now.toISOString(),
  };
}
