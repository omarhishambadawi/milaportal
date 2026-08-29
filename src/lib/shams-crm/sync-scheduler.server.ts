/**
 * The Shams sync scheduler: starting the daily runs without anyone's browser
 * being open, and finding out afterwards how they went. Server-only.
 *
 * ## The three parts
 *
 *   `runShamsSyncTick`       — the entry point, from `pg_cron` via
 *                              `shams_sync_tick()`. Evaluates the configured
 *                              schedule slots, acts on whatever is due, then
 *                              reconciles. Contains no schedule arithmetic of
 *                              its own; that is `sync-schedule.ts`.
 *
 *   `runShamsSyncTriggers`   — claims, checks, triggers, records. Shared by the
 *                              schedule and by the Control Center's manual
 *                              buttons, so both inherit the same guards. This is
 *                              the only function that can start a sync.
 *
 *   `runShamsSyncReconcile`  — reads status and closes rows. Triggers nothing,
 *                              ever.
 *
 * Keeping the dangerous part small is the point: exactly one function starts
 * syncs, and every caller reaches it through `RunTriggersOptions` rather than by
 * reimplementing it.
 *
 * ## Three guards, none of them trusted alone
 *
 *   1. `shams_sync_runs_active_key` — a partial unique index on
 *      `(sync_type) WHERE status IN ('triggered','running')`. Two MilaPortal
 *      executions cannot both hold a claim; the loser's insert fails and it
 *      stops. This is a race we fully control, so it is made impossible rather
 *      than unlikely.
 *
 *   2. The CRM's own `is_running`, read immediately before every trigger. This
 *      catches a run started by something we do not control — the Desktop, an
 *      operator, or the CRM's dormant internal scheduler.
 *
 *   3. The stale-claim reaper. Without it the first guard becomes a permanent
 *      stall: one row stuck in `running` because reconciliation could never
 *      reach the CRM would block every future night, silently.
 *
 * Guard 2 is what makes guard 3 safe. Reaping only frees *our* claim; it makes
 * no claim about the CRM, and the status pre-check still runs before anything is
 * triggered. A reaped row whose run is genuinely still going results in a skip,
 * not a second run.
 *
 * ## Nothing here retries a trigger
 *
 * A trigger whose outcome is unknown is recorded `indeterminate` and left for a
 * person. Phase 1 could not verify what `POST /stock/sync` does while a run is
 * already active, and an automatic retry against an unverified concurrency
 * contract — unattended, at one in the morning — is precisely the thing this
 * design exists to avoid. `alshrouq-scheduler.server.ts` refuses for the same
 * reason and states it in the same words.
 */

import type { ShamsSyncKind, ShamsSyncStatus } from "./sync-status";
import { classifyRun } from "./sync-status";
import { getSyncStatus, isSyncConfigured, triggerSync } from "./sync.server";

interface SupabaseLike {
  from: (table: string) => any;
}

const RUNS = "shams_sync_runs";

/** Both kinds, in a fixed order so a run's log reads the same way every night. */
const KINDS: readonly ShamsSyncKind[] = ["stock", "promotions"] as const;

/**
 * When a claim of ours is considered abandoned.
 *
 * The two observed runs took 24 and 26 minutes. Four hours is far beyond any
 * plausible run and far short of the next night's attempt, so a claim orphaned
 * by a deploy or a platform timeout is cleared long before it can block
 * anything — while a genuinely slow run is never reaped out from under itself.
 */
const STALE_CLAIM_MS = 4 * 60 * 60 * 1000;

/** Postgres unique-violation. The expected outcome of losing a claim race. */
const UNIQUE_VIOLATION = "23505";

/**
 * What one invocation of the trigger path is being asked to do.
 *
 * Everything here used to be hardcoded — both kinds, always `scheduled`. Opening
 * these four seams is what lets the Control Center's manual buttons and the
 * schedule's per-slot targeting share one code path, and therefore one set of
 * guards. There is deliberately no second implementation of "start a sync".
 */
export interface RunTriggersOptions {
  /** Which kinds to attempt. Defaults to both. */
  kinds?: readonly ShamsSyncKind[];
  /** Recorded on the row, and it decides whether the reaper runs. */
  source?: "scheduled" | "manual";
  /** The verified administrator, for a manual run. Never a browser-supplied id. */
  requestedBy?: string | null;
  /**
   * The occurrence this run belongs to. Set for scheduled runs, null for manual
   * ones — which is the whole of the "manual does not consume a slot" rule.
   */
  scheduledFor?: Date | null;
  slotId?: string | null;
  now?: Date;
}

export interface ShamsSyncTriggerSummary {
  /** Kinds that reached the CRM and started a run. */
  triggered: number;
  /** Kinds skipped because a run was already active — at the CRM or locally. */
  skipped: number;
  /** The CRM refused, or could not be read. Nothing was started. */
  failed: number;
  /** Sent, outcome unknown. Needs a person. */
  indeterminate: number;
  /** Claims abandoned by an earlier execution and cleared by this one. */
  reaped: number;
  /** True when the deployment holds no Shams CRM credentials at all. */
  notConfigured: boolean;
}

export interface ShamsSyncReconcileSummary {
  /** Open rows examined. */
  observed: number;
  /** Rows closed as a completed run. */
  completed: number;
  /** Rows closed as a failed run. */
  failed: number;
  /** Rows the CRM can no longer account for. */
  lost: number;
  /** Rows still legitimately in progress. */
  stillRunning: number;
  /** Rows left untouched because the CRM could not be read this tick. */
  unreadable: number;
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Reduce any thrown value to one short sentence.
 *
 * `error_summary` is read by an administrator and stored indefinitely, so an
 * upstream body, a URL or a header must never reach it. `ShamsCrmError` is
 * already shaped for exactly this — it carries a `kind` and never a credential —
 * and anything unrecognised collapses to a generic line rather than being
 * stringified.
 */
async function summarizeError(err: unknown): Promise<string> {
  const { ShamsCrmError } = await import("./client.server");
  if (err instanceof ShamsCrmError) {
    return err.httpStatus
      ? `${err.message} (${err.kind}, HTTP ${err.httpStatus})`
      : `${err.message} (${err.kind})`;
  }
  console.warn("[shams-sync] unexpected failure:", (err as Error)?.name ?? "unknown");
  return "An unexpected error occurred while contacting Shams CRM.";
}

/** The fields a status read contributes to a history row. */
function metricsFrom(status: ShamsSyncStatus, runId: string | null) {
  const run =
    status.activeRun?.runId === runId
      ? status.activeRun
      : status.latestRun?.runId === runId
        ? status.latestRun
        : null;
  if (!run) return { source_timestamps_corrected: status.timestampsCorrected };
  return {
    started_at: run.startedAt,
    completed_at: run.completedAt,
    duration_seconds: run.durationSeconds,
    rows_seen: run.rowsSeen,
    rows_changed: run.rowsChanged,
    pages_fetched: run.pagesFetched,
    branches_seen: run.branchesSeen,
    branches_targeted: run.branchesTargeted,
    source_timestamps_corrected: status.timestampsCorrected,
  };
}

async function closeRow(
  supabase: SupabaseLike,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from(RUNS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

/* -------------------------------------------------------------------------- */
/* Triggering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Clear claims an earlier execution abandoned.
 *
 * Recorded `indeterminate` rather than `failed`: we genuinely do not know what
 * became of the run, and saying "failed" would put a false statement into the
 * history an administrator uses to judge whether the integration is healthy.
 */
async function reapStaleClaims(supabase: SupabaseLike, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();

  const { data } = await supabase
    .from(RUNS)
    .update({
      status: "indeterminate",
      error_summary:
        "This run was still open after four hours and was closed by the scheduler. " +
        "Whether it finished at Shams is unknown.",
      updated_at: now.toISOString(),
    })
    .in("status", ["triggered", "running"])
    .lt("triggered_at", cutoff)
    .select("id");

  return data?.length ?? 0;
}

/**
 * Start today's runs.
 *
 * Idempotent by construction: the claim insert is the only way to proceed, and
 * only one execution can hold it. A retried invocation of this function finds
 * the claim taken and stops — which is what makes the scheduler safe to poke
 * twice, whether by a duplicate cron tick or by an operator re-running the job.
 *
 * Stock and promotions are independent and are attempted independently: Phase 1
 * observed both running concurrently, six seconds apart, and found no evidence
 * of a dependency in either direction. A failure of one therefore does not
 * prevent the other.
 */
export async function runShamsSyncTriggers(
  supabase: SupabaseLike,
  options: RunTriggersOptions = {},
): Promise<ShamsSyncTriggerSummary> {
  const {
    kinds = KINDS,
    source = "scheduled",
    requestedBy = null,
    scheduledFor = null,
    slotId = null,
    now = new Date(),
  } = options;

  const summary: ShamsSyncTriggerSummary = {
    triggered: 0,
    skipped: 0,
    failed: 0,
    indeterminate: 0,
    reaped: 0,
    notConfigured: false,
  };

  if (!isSyncConfigured()) {
    /*
     * No credentials on this deployment. Reported as its own fact rather than as
     * a failure per kind: it is a deployment state, not a sync outcome, and
     * writing two `failed` rows every night would bury the real history.
     */
    summary.notConfigured = true;
    console.error("[shams-sync] not configured: SHAMS_CRM_USERNAME / SHAMS_CRM_PASSWORD missing");
    return summary;
  }

  /*
   * Reaping is a scheduled-path concern only. A manual click should not quietly
   * close somebody else's stuck run as a side effect of pressing a button.
   */
  if (source === "scheduled") summary.reaped = await reapStaleClaims(supabase, now);

  for (const kind of kinds) {
    /*
     * The claim. `status: 'triggered'` is written *before* the CRM is contacted,
     * so the window in which two executions could both decide to trigger does
     * not exist — the second one's insert violates the partial unique index and
     * it stops here.
     */
    const { data: claim, error: claimError } = await supabase
      .from(RUNS)
      .insert({
        sync_type: kind,
        status: "triggered",
        execution_source: source,
        triggered_at: now.toISOString(),
        /*
         * `scheduled_for` is what `shams_sync_runs_occurrence_key` keys on, so
         * writing it here is what makes an occurrence run exactly once. Manual
         * runs leave it null and sit outside that index entirely — which is
         * precisely why a manual run cannot consume a scheduled slot.
         */
        scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
        schedule_slot_id: slotId,
        requested_by: requestedBy,
      })
      .select("id")
      .single();

    if (claimError || !claim) {
      if ((claimError as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        /*
         * Either guard may have fired: a run of this kind is already open
         * (`shams_sync_runs_active_key`), or this exact occurrence has already
         * been handled (`shams_sync_runs_occurrence_key`). Both mean the same
         * thing operationally — a row for this work already exists and is the
         * record of it — so neither is an error and neither writes a second row.
         */
        summary.skipped++;
        console.info(`[shams-sync] ${kind}: already claimed; not triggering`);
        continue;
      }
      summary.failed++;
      console.error(`[shams-sync] ${kind}: could not record a run; not triggering`);
      continue;
    }

    const rowId = claim.id as string;

    /*
     * The second guard. Read the CRM before asking it to do anything: this is
     * the only thing standing between us and a second concurrent run when the
     * Desktop, an operator, or the CRM's own scheduler started one.
     */
    let status: ShamsSyncStatus;
    try {
      status = await getSyncStatus(kind, now.getTime());
    } catch (err) {
      summary.failed++;
      await closeRow(supabase, rowId, {
        status: "failed",
        error_summary: await summarizeError(err),
        last_observed_at: now.toISOString(),
      });
      continue;
    }

    if (status.isRunning) {
      summary.skipped++;
      await closeRow(supabase, rowId, {
        status: "skipped",
        skip_reason: "A synchronisation was already running at Shams CRM.",
        shams_run_id: status.activeRun?.runId ?? null,
        last_observed_at: now.toISOString(),
        source_timestamps_corrected: status.timestampsCorrected,
      });
      console.info(`[shams-sync] ${kind}: already running at Shams; skipped`);
      continue;
    }

    const result = await triggerSync(kind);

    if (result.kind === "triggered") {
      summary.triggered++;
      await closeRow(supabase, rowId, {
        status: "running",
        shams_run_id: result.runId,
        last_observed_at: now.toISOString(),
      });
      console.info(`[shams-sync] ${kind}: started`);
      continue;
    }

    if (result.kind === "rejected") {
      summary.failed++;
      await closeRow(supabase, rowId, {
        status: "failed",
        error_summary: result.message,
        last_observed_at: now.toISOString(),
      });
      console.warn(`[shams-sync] ${kind}: refused by Shams`);
      continue;
    }

    /*
     * Indeterminate. The row stays as the record that we asked, and the next
     * reconcile tick will not resolve it — we have no run id to match on — so it
     * is closed now and surfaced for a person. Deliberately not retried.
     */
    summary.indeterminate++;
    await closeRow(supabase, rowId, {
      status: "indeterminate",
      error_summary: result.message,
      last_observed_at: now.toISOString(),
    });
    console.warn(`[shams-sync] ${kind}: outcome unknown; left for review`);
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Reconciling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Bring open rows up to date with what the CRM says.
 *
 * Reads only. Nothing in this path can start a synchronisation, which is why it
 * is safe to run it every five minutes and why the poll that calls it is allowed
 * to be the frequent one.
 *
 * One status read serves every open row of a kind, so a tick costs at most two
 * requests however many rows are open — and in the ordinary case, none at all,
 * because `shams_sync_due('reconcile')` does not poke the application when
 * nothing is open.
 */
export async function runShamsSyncReconcile(
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<ShamsSyncReconcileSummary> {
  const summary: ShamsSyncReconcileSummary = {
    observed: 0,
    completed: 0,
    failed: 0,
    lost: 0,
    stillRunning: 0,
    unreadable: 0,
  };

  const { data: open } = await supabase
    .from(RUNS)
    .select("id,sync_type,shams_run_id,status")
    .in("status", ["triggered", "running"])
    .order("triggered_at", { ascending: true });

  const rows = (open ?? []) as Array<{
    id: string;
    sync_type: ShamsSyncKind;
    shams_run_id: string | null;
  }>;
  if (rows.length === 0) return summary;

  if (!isSyncConfigured()) {
    summary.unreadable = rows.length;
    return summary;
  }

  /** One read per kind, shared by every open row of that kind. */
  const statuses = new Map<ShamsSyncKind, ShamsSyncStatus | null>();
  for (const kind of KINDS) {
    if (!rows.some((r) => r.sync_type === kind)) continue;
    try {
      statuses.set(kind, await getSyncStatus(kind, now.getTime()));
    } catch {
      // Transient as far as this tick is concerned. The row is left exactly as
      // it is and tried again in five minutes; only the reaper's four-hour bound
      // ever forces the issue.
      statuses.set(kind, null);
    }
  }

  const observedAt = now.toISOString();

  for (const row of rows) {
    summary.observed++;
    const status = statuses.get(row.sync_type) ?? null;

    if (!status) {
      summary.unreadable++;
      continue;
    }

    const seen = classifyRun(row.shams_run_id, status);

    if (seen.kind === "running") {
      summary.stillRunning++;
      await closeRow(supabase, row.id, {
        status: "running",
        last_observed_at: observedAt,
        ...metricsFrom(status, row.shams_run_id),
      });
      continue;
    }

    if (seen.kind === "terminal") {
      const ok = seen.outcome === "success";
      if (ok) summary.completed++;
      else summary.failed++;
      await closeRow(supabase, row.id, {
        status: seen.outcome,
        last_observed_at: observedAt,
        error_summary: ok
          ? null
          : `Shams CRM reported the run as "${seen.run.status ?? "unknown"}".`,
        ...metricsFrom(status, row.shams_run_id),
      });
      continue;
    }

    /*
     * Lost. The CRM reports only its latest run, so once a different run has
     * taken that slot ours is unrecoverable. Recorded as `indeterminate` — never
     * as success or failure, both of which would be fabrications.
     */
    summary.lost++;
    await closeRow(supabase, row.id, {
      status: "indeterminate",
      last_observed_at: observedAt,
      error_summary: "Shams CRM no longer reports this run, so how it ended cannot be determined.",
      source_timestamps_corrected: status.timestampsCorrected,
    });
  }

  return summary;
}

/* -------------------------------------------------------------------------- */
/* The tick — schedule evaluation                                              */
/* -------------------------------------------------------------------------- */

export interface ShamsSyncTickSummary {
  /** Slots whose occurrence came due and was acted on. */
  slotsDue: number;
  /** Slots whose occurrence was abandoned as too late to be useful. */
  slotsMissed: number;
  triggered: number;
  skipped: number;
  failed: number;
  indeterminate: number;
  reaped: number;
  /** Open rows brought up to date in the same pass. */
  reconciled: number;
  notConfigured: boolean;
  automationEnabled: boolean;
}

/**
 * One evaluation of the business schedule, plus reconciliation.
 *
 * Called from `pg_cron` every minute via `shams_sync_tick()` — but only when
 * that function has already established there is something to do, so this is not
 * running 1,440 times a day.
 *
 * ## Order matters
 *
 * Reconciliation runs **after** triggering, not before, so a run started in this
 * same pass is picked up on the next tick rather than being read back a
 * millisecond after it was queued.
 *
 * ## A missed occurrence is recorded, not discarded
 *
 * When a slot is more than the grace window late, its kinds are written as
 * `skipped` rows carrying the original `scheduled_for`. That costs one row and
 * buys the only thing that makes a gap in the history explicable later: the
 * difference between "the scheduler never ran" and "the scheduler ran and
 * decided this was too stale to be useful".
 */
export async function runShamsSyncTick(
  supabase: SupabaseLike,
  now: Date = new Date(),
): Promise<ShamsSyncTickSummary> {
  const summary: ShamsSyncTickSummary = {
    slotsDue: 0,
    slotsMissed: 0,
    triggered: 0,
    skipped: 0,
    failed: 0,
    indeterminate: 0,
    reaped: 0,
    reconciled: 0,
    notConfigured: false,
    automationEnabled: false,
  };

  const { readScheduleSlots, readSyncSettings, advanceSlot } =
    await import("./sync-settings.server");
  const { evaluateSlots } = await import("./sync-schedule");

  const settings = await readSyncSettings(supabase);
  summary.automationEnabled = settings.automationEnabled;

  const slots = await readScheduleSlots(supabase);
  const decisions = evaluateSlots(slots, settings.automationEnabled, now);

  for (const decision of decisions) {
    if (decision.verdict === "not_due") {
      /*
       * A slot that has never been evaluated acquires its first due time here.
       * Only written when it actually changes, so an idle tick does not rewrite
       * every row every minute.
       */
      const current = decision.slot.nextDueAt;
      const computed = decision.nextDueAt?.toISOString() ?? null;
      if (settings.automationEnabled && current !== computed && current === null) {
        await advanceSlot(supabase, decision.slot.id, null, decision.nextDueAt, now);
      }
      continue;
    }

    if (decision.verdict === "missed") {
      summary.slotsMissed++;
      const lateMinutes = Math.round(decision.lateMs / 60_000);
      try {
        for (const kind of decision.kinds) {
          /*
           * Recorded through the same insert the trigger path uses, so the
           * occurrence index applies here too: a missed slot cannot be recorded
           * twice, and a slot that was recorded as missed can never later be run.
           */
          const { error } = await supabase.from(RUNS).insert({
            sync_type: kind,
            status: "skipped",
            execution_source: "scheduled",
            skip_reason:
              `Missed its scheduled window — the scheduler reached it ${lateMinutes} minutes late, ` +
              `beyond the two-hour catch-up limit.`,
            triggered_at: now.toISOString(),
            scheduled_for: decision.occurrence.toISOString(),
            schedule_slot_id: decision.slot.id,
            last_observed_at: now.toISOString(),
          });
          if (!error) summary.skipped++;
        }
      } finally {
        // See the `finally` on the due branch below: the advance is what stops
        // the occurrence being reconsidered, so it must survive a failed write.
        await advanceSlot(supabase, decision.slot.id, decision.occurrence, decision.nextDueAt, now);
      }
      console.warn(
        `[shams-sync] slot ${decision.slot.localTime}: missed by ${lateMinutes}m; recorded and advanced`,
      );
      continue;
    }

    // Due.
    summary.slotsDue++;
    try {
      const result = await runShamsSyncTriggers(supabase, {
        kinds: decision.kinds,
        source: "scheduled",
        scheduledFor: decision.occurrence,
        slotId: decision.slot.id,
        now,
      });

      summary.triggered += result.triggered;
      summary.skipped += result.skipped;
      summary.failed += result.failed;
      summary.indeterminate += result.indeterminate;
      summary.reaped += result.reaped;
      if (result.notConfigured) summary.notConfigured = true;
    } catch (err) {
      /*
       * An unexpected throw — a database write that failed, not a sync outcome.
       * Counted as a failure of this occurrence and swallowed here rather than
       * propagated, so one bad slot cannot stop the remaining slots or the
       * reconciliation pass from running.
       */
      summary.failed += decision.kinds.length;
      console.error(
        `[shams-sync] slot ${decision.slot.localTime}: evaluation failed:`,
        (err as Error)?.name ?? "unknown",
      );
    } finally {
      /*
       * Advanced whatever the outcome — triggered, skipped, failed,
       * indeterminate, or an exception on the way through.
       *
       * This is the whole of the no-retry-loop guarantee, and it is in a
       * `finally` because an advance that only happened on the happy path would
       * leave a failed occurrence due: it would be reattempted every minute for
       * two hours and then recorded as missed, which is precisely the retry
       * loop Phase 2A's rule exists to prevent. The occurrence keeps its own
       * `failed` or `indeterminate` row as the record of what happened, and
       * `Update Now` is the explicit human retry.
       */
      await advanceSlot(supabase, decision.slot.id, decision.occurrence, decision.nextDueAt, now);
    }
  }

  const reconcile = await runShamsSyncReconcile(supabase, now);
  summary.reconciled = reconcile.completed + reconcile.failed + reconcile.lost;

  return summary;
}
