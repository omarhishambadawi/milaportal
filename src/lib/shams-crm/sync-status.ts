/**
 * Shams CRM sync status — wire shapes, parsing, and the one timestamp
 * workaround. PURE: no I/O, no imports, no clock of its own.
 *
 * The CRM's two sync status endpoints answer with the same envelope:
 *
 *   GET /stock/sync/status
 *   GET /promotions/sync/status
 *
 * Everything this module models was read off a real cached response of each,
 * captured from the Desktop client's local store during the Phase 1
 * investigation. Fields that were never observed are not modelled, and no field
 * is required — the CRM is a third-party system and a shape that changed under
 * us should degrade to `null`, not throw inside a scheduled job at 01:00.
 *
 * ## Why this file is pure
 *
 * The only genuinely subtle logic in this integration is deciding whether a
 * timestamp means what it says. That decision is worth testing directly, and it
 * cannot be tested directly if it is tangled with `fetch`. So the transport
 * lives in `sync.server.ts` and every judgement lives here, taking `now` as an
 * argument rather than reading the clock.
 */

export type ShamsSyncKind = "stock" | "promotions";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** One run, as the CRM reports it. Every field optional — none is trusted. */
export interface RawShamsSyncRun {
  id?: number | string | null;
  sync_type?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  pages_fetched?: number | null;
  rows_seen?: number | null;
  rows_changed?: number | null;
  notes?: string | null;
}

/** `GET /{stock|promotions}/sync/status`. */
export interface RawShamsSyncStatus {
  latest_run?: RawShamsSyncRun | null;
  active_run?: RawShamsSyncRun | null;
  last_success_at_utc?: string | null;
  last_success_at_riyadh?: string | null;
  next_scheduled_sync_at_utc?: string | null;
  next_scheduled_sync_at_riyadh?: string | null;
  sync_interval_minutes?: number | null;
  is_running?: boolean | null;
}

/**
 * `POST /{stock|promotions}/sync`.
 *
 * The Desktop reads `run_id` off the trigger response and shows it to the
 * operator ("Stock update started in background. Run ID: …"), which is the whole
 * of what this integration needs from it.
 */
export interface RawShamsSyncTrigger {
  run_id?: number | string | null;
  status?: string | null;
  message?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                  */
/* -------------------------------------------------------------------------- */

/** Riyadh is UTC+3 year-round. Saudi Arabia observes no daylight saving. */
export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * How far ahead of our clock a "completed" timestamp may sit before we stop
 * believing it is UTC.
 *
 * Not zero: our clock and theirs are different machines, and a run that finished
 * two seconds ago must not be reclassified because of ordinary skew. Five
 * minutes is far below the three-hour signal this is trying to detect, so the
 * two cannot be confused for one another.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Parse a CRM timestamp to epoch milliseconds.
 *
 * Two traps, both live:
 *
 *  1. The CRM sends naive timestamps — `2026-08-27T17:49:01.539894`, no zone.
 *     `new Date()` reads an offset-less date-time as **local time**, so on a
 *     machine that is not on UTC the value silently shifts. Every naive value is
 *     therefore explicitly anchored to UTC here, which is what the field claims
 *     to be; whether that claim is true is `assessTimestamp`'s problem, not this
 *     function's.
 *
 *  2. Fractional seconds arrive with six digits. That is more precision than the
 *     format allows and engines differ on it, so it is truncated to
 *     milliseconds rather than trusted to a parser.
 */
export function parseCrmTimestamp(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  // An explicit zone means the sender said what it meant; take it at its word.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const truncated = text.replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(zoned ? truncated : `${truncated}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * What we concluded about one timestamp the CRM labelled UTC.
 *
 * `raw` is always preserved. Nothing downstream is given a corrected value
 * without also being told that it was corrected.
 */
export interface TimestampAssessment {
  /** Exactly what the CRM sent, untouched. */
  raw: string | null;
  /** The value to display and compare on, as an ISO instant. */
  iso: string | null;
  /**
   * True when the raw value could not be UTC and subtracting the Riyadh offset
   * makes it coherent — the defect described in the Phase 1 report, observed on
   * `/promotions/sync/status` and not on `/stock/sync/status`.
   */
  correctedFromRiyadh: boolean;
  /**
   * True when the value is in the future by more than tolerance and the Riyadh
   * offset does **not** explain it. Nothing is corrected in that case: an
   * unexplained timestamp is reported as unexplained.
   */
  unexplainedFuture: boolean;
}

/**
 * Decide whether a timestamp labelled UTC is actually Riyadh local time.
 *
 * ## Why this is inferred at runtime rather than configured
 *
 * Phase 1 established the defect by contradiction: a response *cached at*
 * 18:27:13 UTC reported a promotions run *starting at* 20:24:31. A completed run
 * cannot lie in the future of the response describing it, so the value was not
 * UTC. That same contradiction is checkable on every single response, and it is
 * the only honest basis for correcting anything — so it is what this function
 * checks, rather than a hardcoded "promotions is broken" flag.
 *
 * Three consequences, all deliberate:
 *
 *  * **It cannot fire on a healthy field.** A correct UTC timestamp is never
 *    three hours in our future, so stock is never touched.
 *  * **It removes itself.** The day Shams fixes the source, timestamps stop
 *    arriving in the future, no correction is applied, and this code becomes
 *    inert without anyone deploying anything.
 *  * **It refuses to guess.** A timestamp the Riyadh offset does not explain is
 *    left exactly as sent and flagged, because "wrong in a way I do not
 *    understand" must not be quietly rewritten into a plausible-looking value.
 *
 * `now` is a parameter so the behaviour is testable at any instant.
 */
export function assessTimestamp(raw: string | null | undefined, now: number): TimestampAssessment {
  const rawText = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const parsed = parseCrmTimestamp(rawText);

  if (parsed === null) {
    return { raw: rawText, iso: null, correctedFromRiyadh: false, unexplainedFuture: false };
  }

  const limit = now + CLOCK_SKEW_TOLERANCE_MS;

  // Plausible as UTC. The overwhelmingly common case, and the only one for a
  // healthy endpoint.
  if (parsed <= limit) {
    return {
      raw: rawText,
      iso: new Date(parsed).toISOString(),
      correctedFromRiyadh: false,
      unexplainedFuture: false,
    };
  }

  // Not plausible as UTC. Does the Riyadh offset account for it exactly?
  const shifted = parsed - RIYADH_OFFSET_MS;
  if (shifted <= limit) {
    return {
      raw: rawText,
      iso: new Date(shifted).toISOString(),
      correctedFromRiyadh: true,
      unexplainedFuture: false,
    };
  }

  // Still in the future after the correction. Report it; do not invent a value.
  return {
    raw: rawText,
    iso: new Date(parsed).toISOString(),
    correctedFromRiyadh: false,
    unexplainedFuture: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Split the server-composed `notes` string into its key/value pairs.
 *
 * Observed, verbatim:
 *
 *   stock       "itm_cd= wh_cd= worker_pid=1831399 completed_at=… status=success
 *                max_pages=20000 sync_mode=branch_by_branch"
 *   promotions  "docno_mode=sequential branch_code= vendor=cash completed_at=…
 *                status=success branches_targeted=138 branches_seen=138"
 *
 * Empty values are real and meaningful — `itm_cd=` is how an unfiltered run
 * reports that it filtered on nothing — so they are kept rather than dropped.
 *
 * This is a convenience for display, never a contract. Every caller treats a
 * missing key as "not reported"; none requires one to be present.
 */
export function parseSyncNotes(notes: string | null | undefined): Record<string, string> {
  if (typeof notes !== "string") return {};
  const out: Record<string, string> = {};
  for (const token of notes.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

/** A non-negative integer from notes, or null. Never NaN, never negative. */
function noteInt(notes: Record<string, string>, key: string): number | null {
  const raw = notes[key];
  if (raw === undefined || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Normalized models                                                           */
/* -------------------------------------------------------------------------- */

/** One run, normalized. */
export interface ShamsSyncRun {
  /** The CRM's run id, as text — it is an identifier, never arithmetic. */
  runId: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Whole seconds, when both ends are known and ordered. Never negative. */
  durationSeconds: number | null;
  pagesFetched: number | null;
  rowsSeen: number | null;
  rowsChanged: number | null;
  /**
   * Promotions reports its unit of work in `notes` as `branches_seen`, where
   * stock reports pages in a first-class field. Surfaced here so the monitoring
   * page can name what was actually covered for each kind.
   */
  branchesSeen: number | null;
  branchesTargeted: number | null;
  notes: string | null;
}

/** A whole status response, normalized. */
export interface ShamsSyncStatus {
  isRunning: boolean;
  latestRun: ShamsSyncRun | null;
  activeRun: ShamsSyncRun | null;
  /** Normalized per `assessTimestamp`. */
  lastSuccessAt: string | null;
  /** Exactly what the CRM sent, for the admin page to show beside it. */
  lastSuccessAtRaw: string | null;
  /**
   * True when any timestamp in this response had to be corrected from Riyadh
   * local time. Surfaced rather than hidden: it is a live statement about a
   * third-party defect and it should stop being true when Shams fixes it.
   */
  timestampsCorrected: boolean;
  /** True when a timestamp is in the future for reasons we cannot explain. */
  timestampsUnexplained: boolean;
  /**
   * The CRM's own scheduler. Observed as `0` / `null` on both endpoints, i.e.
   * server-side scheduling exists in the contract and is switched off. Read so
   * the admin page can say whether that is still true, and so that if Shams
   * ever enables it we find out by looking rather than by collision.
   */
  syncIntervalMinutes: number | null;
  nextScheduledAt: string | null;
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * Normalize one run.
 *
 * Duration is computed from the two ends rather than read from anywhere, and is
 * withheld when they are missing or out of order — a negative duration is a
 * symptom worth seeing as "unknown" rather than rendering as a negative number.
 *
 * Both ends go through `assessTimestamp` with the same `now`, so a run whose
 * timestamps are shifted is shifted consistently and its duration stays right.
 */
export function normalizeSyncRun(
  raw: RawShamsSyncRun | null | undefined,
  now: number,
): { run: ShamsSyncRun; corrected: boolean; unexplained: boolean } | null {
  if (!raw || typeof raw !== "object") return null;

  const started = assessTimestamp(raw.started_at, now);
  const completed = assessTimestamp(raw.completed_at, now);
  const notes = parseSyncNotes(raw.notes);

  const startMs = started.iso ? Date.parse(started.iso) : null;
  const endMs = completed.iso ? Date.parse(completed.iso) : null;
  const durationSeconds =
    startMs !== null && endMs !== null && endMs >= startMs
      ? Math.round((endMs - startMs) / 1000)
      : null;

  return {
    run: {
      runId: toText(raw.id),
      status: toText(raw.status),
      startedAt: started.iso,
      completedAt: completed.iso,
      durationSeconds,
      pagesFetched: toCount(raw.pages_fetched),
      rowsSeen: toCount(raw.rows_seen),
      rowsChanged: toCount(raw.rows_changed),
      branchesSeen: noteInt(notes, "branches_seen"),
      branchesTargeted: noteInt(notes, "branches_targeted"),
      notes: toText(raw.notes),
    },
    corrected: started.correctedFromRiyadh || completed.correctedFromRiyadh,
    unexplained: started.unexplainedFuture || completed.unexplainedFuture,
  };
}

/** Normalize a whole status response. */
export function normalizeSyncStatus(
  raw: RawShamsSyncStatus | null | undefined,
  now: number,
): ShamsSyncStatus {
  const source = raw && typeof raw === "object" ? raw : {};

  const latest = normalizeSyncRun(source.latest_run, now);
  const active = normalizeSyncRun(source.active_run, now);
  const lastSuccess = assessTimestamp(source.last_success_at_utc, now);
  const nextScheduled = assessTimestamp(source.next_scheduled_sync_at_utc, now);

  return {
    /*
     * Running is asserted by either signal.
     *
     * `is_running` and a populated `active_run` were always consistent in the
     * captures, but this is the guard on a *trigger*, and the cost of the two
     * disagreeing is asymmetric: believing a run is active when it is not costs
     * one skipped night, while believing it is idle when it is not risks a
     * second concurrent run against a contract that has never been tested for
     * it. So either one is enough to hold the trigger back.
     */
    isRunning: source.is_running === true || active !== null,
    latestRun: latest?.run ?? null,
    activeRun: active?.run ?? null,
    lastSuccessAt: lastSuccess.iso,
    lastSuccessAtRaw: lastSuccess.raw,
    timestampsCorrected:
      lastSuccess.correctedFromRiyadh ||
      nextScheduled.correctedFromRiyadh ||
      (latest?.corrected ?? false) ||
      (active?.corrected ?? false),
    timestampsUnexplained:
      lastSuccess.unexplainedFuture ||
      nextScheduled.unexplainedFuture ||
      (latest?.unexplained ?? false) ||
      (active?.unexplained ?? false),
    syncIntervalMinutes: toCount(source.sync_interval_minutes),
    nextScheduledAt: nextScheduled.iso,
  };
}

/**
 * The run id from a trigger response.
 *
 * Returns null when the CRM answered 2xx without one. That is not treated as
 * success by the caller: a trigger we cannot name is a trigger we cannot
 * reconcile, and it is recorded as indeterminate rather than as a run.
 */
export function readTriggerRunId(raw: RawShamsSyncTrigger | null | undefined): string | null {
  if (!raw || typeof raw !== "object") return null;
  return toText(raw.run_id);
}

/* -------------------------------------------------------------------------- */
/* The catalogue refresh marker                                                */
/* -------------------------------------------------------------------------- */

/**
 * One string standing for "the last time a stock sync succeeded upstream".
 *
 * PharmacyCRM Desktop's `_extract_stock_sync_success_marker`, transcribed: the
 * latest run's `completed_at` — falling back to its `started_at` — when that run
 * says `success`, and otherwise the envelope's `last_success_at_utc`. When the
 * marker differs from the one the cached catalogue was built against, the
 * catalogue is re-fetched; when it does not, nothing is downloaded.
 *
 * That is a better refresh trigger than a clock, and the reason is in the data:
 * the catalogue changes when Shams' own sync changes it, roughly 0.3 % of rows a
 * day and never on a schedule anyone here controls
 * (`docs/shams/api-discovery.md` §10.6). A TTL either re-downloads 700 KB for
 * nothing or serves rows that moved hours ago; the marker does neither.
 *
 * Returns null when the CRM reports no successful run at all, which callers read
 * as "no opinion" — not as "unchanged".
 */
export function stockSyncMarker(status: ShamsSyncStatus): string | null {
  const latest = status.latestRun;
  if (latest && latest.status?.toLowerCase() === "success") {
    const marker = latest.completedAt ?? latest.startedAt;
    if (marker) return marker;
  }
  return status.lastSuccessAt;
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What one status read says about a run we started.
 *
 * `lost` is the honest answer to a real situation: the CRM reports only its
 * latest run, so if another run started and finished after ours, our outcome is
 * simply no longer available anywhere. That becomes `indeterminate` on the row
 * — never `success`, and never `failed` — because both would be inventions.
 */
export type SyncObservation =
  | { kind: "running"; run: ShamsSyncRun | null }
  | { kind: "terminal"; outcome: "success" | "failed"; run: ShamsSyncRun }
  | { kind: "lost" };

/**
 * Match a run we started against what the CRM currently reports.
 *
 * The comparison is on run id and never on timing. Timing is exactly what this
 * integration cannot trust — one of the two endpoints reports its clock in the
 * wrong zone — so a run is identified by the id the trigger returned, which is
 * the one field with no ambiguity in it.
 *
 * An active run whose id we cannot read is still treated as ours when we have a
 * run open and the CRM says something is running. The alternative is to declare
 * our run lost while a sync is visibly in progress, which would be both wrong
 * and self-inflicted: only one run of a kind can be active at a time.
 */
export function classifyRun(ourRunId: string | null, status: ShamsSyncStatus): SyncObservation {
  const active = status.activeRun;

  if (status.isRunning && (active === null || active.runId === null || active.runId === ourRunId)) {
    return { kind: "running", run: active };
  }

  // Something else is running. Ours is therefore not, and the CRM is not going
  // to tell us how it ended.
  if (status.isRunning) return { kind: "lost" };

  const latest = status.latestRun;
  if (!latest || latest.runId === null || latest.runId !== ourRunId) return { kind: "lost" };

  /*
   * `success` is required to be stated. Anything else the CRM calls a finished
   * run is a failure — including a status string we have never seen, because an
   * unrecognised outcome must not be optimistically read as a good one.
   */
  const outcome = latest.status?.toLowerCase() === "success" ? "success" : "failed";
  return { kind: "terminal", outcome, run: latest };
}
