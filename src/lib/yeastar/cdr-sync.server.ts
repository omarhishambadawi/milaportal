/**
 * Background CDR synchronization.
 *
 * ---------------------------------------------------------------------------
 * What it does
 * ---------------------------------------------------------------------------
 * Walks a rolling horizon of business days, fetches the ones the mirror does not
 * already cover, and upserts them into `cdr_records`. Yeastar stays the source
 * of truth — this only moves rows the PBX has already emitted into a store the
 * dashboards can read without waiting for a sweep.
 *
 * ---------------------------------------------------------------------------
 * What makes it incremental
 * ---------------------------------------------------------------------------
 * `cdr_sync_days` — not a timestamp cursor. A day that has ENDED is immutable on
 * this PBX, so once it is recorded it is never fetched again; today is refetched
 * on every run because it is still accruing. That is the finest granularity the
 * PBX's own API offers (`/cdr/search` is a window query), and it is exact: a
 * quiet day is recorded with zero rows, so it is never mistaken for a gap.
 *
 * A row-level cursor would be worse here, not better. CDR is written when a call
 * ENDS but timestamped when it STARTED, so a call spanning the cursor is filed
 * behind it and a cursor-exact resume would skip it permanently.
 *
 * ---------------------------------------------------------------------------
 * What makes it idempotent
 * ---------------------------------------------------------------------------
 * Every write is an upsert keyed on the PBX's own row-unique `new_id`
 * (`cdrRowKey`). Running twice over the same window, running while a dashboard
 * sweep persists the same days, or re-running after a crash mid-way all
 * converge on the same rows — so overlap is a correctness tool, not a hazard.
 *
 * ---------------------------------------------------------------------------
 * Bounding
 * ---------------------------------------------------------------------------
 * One run sweeps at most `MAX_DAYS_PER_RUN` days, because it executes inside a
 * request whose runtime is bounded. Backfill therefore walks: each run takes the
 * live days plus the oldest days still missing, and successive runs converge on
 * a fully covered horizon. Live days are selected FIRST — falling behind on
 * today to make progress on a three-week-old gap is the wrong trade.
 */
import { fetchCdrRange, type CdrRecord } from "./cdr.server";
import { businessDayOf, contiguousRanges, enumerateDays, shiftDay } from "./cdr-days";
import {
  claimSyncLease,
  isStoreConfigured,
  persistCdrRows,
  readSyncState,
  readSyncedDays,
  releaseSyncLease,
  writeSyncState,
} from "./cdr-store.server";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** How far back the mirror is kept complete. The Calls dashboards' widest
 *  preset is a month and Call Lookup's ceiling is 90 days. */
const horizonDays = () => envInt("YEASTAR_CDR_SYNC_HORIZON_DAYS", 90, 1, 400);

/** Days one run may sweep. Bounds the run inside a request timeout. */
const maxDaysPerRun = () => envInt("YEASTAR_CDR_SYNC_MAX_DAYS_PER_RUN", 7, 1, 60);

/**
 * Days at the head of the horizon that are always refetched.
 *
 * Today because it is still accruing, and yesterday because a call that ends
 * after midnight is written to the PBX after the day it is timestamped in has
 * already been recorded as covered.
 */
const LIVE_TAIL_DAYS = 2;

/** Lease hold. Longer than a bounded run, short enough that a crashed isolate
 *  does not block synchronization for more than one cron interval. */
const LEASE_MS = 5 * 60_000;

export interface CdrSyncResult {
  ok: boolean;
  /** False when the lease was held by another run — not a failure. */
  ran: boolean;
  /** Business days swept by this run. */
  days: string[];
  /** PBX sweeps issued (contiguous ranges, not days). */
  sweeps: number;
  /** Rows upserted. Re-synced rows count here too — the upsert is idempotent,
   *  so this is work done, not rows added. */
  rows: number;
  /** Days still missing from the horizon after this run. Non-zero while a
   *  backfill is walking. */
  remaining: number;
  /** Newest CDR timestamp the mirror holds, epoch seconds. */
  watermark: number | null;
  elapsedMs: number;
  error?: string;
}

export interface RunCdrSyncOptions {
  /** Explicit window, for a targeted backfill. Defaults to the rolling horizon.
   *  Both must be `YYYY-MM-DD` in the business timezone. */
  from?: string;
  to?: string;
  /** Re-sweep days the mirror already covers. Off by default: a closed day
   *  cannot change, so refetching it is pure PBX load. */
  force?: boolean;
  /** Override the per-run day cap. Still clamped to a sane ceiling. */
  maxDays?: number;
}

/**
 * The days this run should sweep, oldest-first within each priority band.
 *
 * Exported for the unit tests: the selection rule (live tail always, then the
 * oldest gaps, capped) is the whole behaviour of the scheduler and is worth
 * asserting without a PBX or a database.
 */
export function selectDueDays(
  days: string[],
  covered: Set<string>,
  today: string,
  maxDays: number,
  force: boolean,
): string[] {
  // The live tail is `LIVE_TAIL_DAYS` ending at today, expressed as a date
  // string so the comparison stays lexicographic like every other day compare
  // in this module.
  const tailStart = shiftDay(today, -(LIVE_TAIL_DAYS - 1));
  const due = days.filter((d) => force || !covered.has(d) || d >= tailStart);
  const live = due.filter((d) => d >= tailStart);
  const back = due.filter((d) => d < tailStart);
  const room = Math.max(0, maxDays - live.length);
  return [...live, ...back.slice(0, room)].sort();
}

/**
 * Run one synchronization pass.
 *
 * Never throws: a sync failure must not take down whatever triggered it. The
 * outcome is returned and recorded on `cdr_sync_state` for the diagnostics
 * surface.
 */
export async function runCdrSync(opts: RunCdrSyncOptions = {}): Promise<CdrSyncResult> {
  const started = Date.now();
  const empty: CdrSyncResult = {
    ok: true,
    ran: false,
    days: [],
    sweeps: 0,
    rows: 0,
    remaining: 0,
    watermark: null,
    elapsedMs: 0,
  };

  const { isConfigured } = await import("./client.server");
  if (!isConfigured()) {
    return { ...empty, ok: false, error: "Yeastar is not configured", elapsedMs: 0 };
  }
  if (!isStoreConfigured()) {
    return { ...empty, ok: false, error: "Supabase service role is not configured", elapsedMs: 0 };
  }

  let leased = false;
  try {
    leased = await claimSyncLease(LEASE_MS);
  } catch (e) {
    return {
      ...empty,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started,
    };
  }
  // Another isolate is already sweeping. Reporting this as a failure would make
  // a healthy concurrent trigger look broken.
  if (!leased) return { ...empty, elapsedMs: Date.now() - started };

  try {
    const now = Date.now();
    const today = businessDayOf(now);
    const to = opts.to ?? today;
    const from = opts.from ?? businessDayOf(now - (horizonDays() - 1) * 86_400_000);
    const cap = Math.min(60, Math.max(1, opts.maxDays ?? maxDaysPerRun()));

    const days = enumerateDays(from, to);
    const covered = new Set((await readSyncedDays(days)).keys());
    const selected = selectDueDays(days, covered, today, cap, !!opts.force);

    if (selected.length === 0) {
      const state = await readSyncState();
      await writeSyncState({
        lastRunAt: now,
        lastStatus: "idle",
        lastError: null,
        lastRows: 0,
        lastDays: 0,
      });
      return {
        ...empty,
        ran: true,
        watermark: state.lastSyncedEpoch,
        elapsedMs: Date.now() - started,
      };
    }

    await writeSyncState({ lastRunAt: now, lastStatus: "running", lastError: null });

    // Contiguous ranges, for the same reason the in-memory day store uses them:
    // a cold week is one PBX sweep, not seven round-trips.
    const ranges = contiguousRanges(selected);
    let rows = 0;
    let watermark: number | null = null;
    for (const range of ranges) {
      const res = await fetchCdrRange({ from: range.from, to: range.to });
      rows += await persistCdrRows(res.records, enumerateDays(range.from, range.to));
      for (const r of res.records) {
        if (typeof r.timestamp === "number" && (watermark == null || r.timestamp > watermark)) {
          watermark = r.timestamp;
        }
      }
    }

    const prior = await readSyncState();
    const nextWatermark =
      watermark != null && (prior.lastSyncedEpoch == null || watermark > prior.lastSyncedEpoch)
        ? watermark
        : prior.lastSyncedEpoch;

    const remaining = Math.max(0, days.filter((d) => !covered.has(d)).length - selected.length);
    await writeSyncState({
      lastRunAt: now,
      lastStatus: remaining > 0 ? "catching-up" : "ok",
      lastError: null,
      lastRows: rows,
      lastDays: selected.length,
      lastSyncedEpoch: nextWatermark,
    });

    console.log(
      `[cdr sync] days=${selected.length} sweeps=${ranges.length} rows=${rows} remaining=${remaining}`,
    );

    return {
      ok: true,
      ran: true,
      days: selected,
      sweeps: ranges.length,
      rows,
      remaining,
      watermark: nextWatermark,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[cdr sync] failed: ${message}`);
    try {
      await writeSyncState({ lastStatus: "error", lastError: message });
    } catch {
      /* the failure is already being reported to the caller */
    }
    return {
      ...empty,
      ok: false,
      ran: true,
      error: message,
      elapsedMs: Date.now() - started,
    };
  } finally {
    try {
      await releaseSyncLease();
    } catch {
      /* the lease expires on its own; blocking on the release would be worse */
    }
  }
}

/**
 * Persist days a dashboard just swept live.
 *
 * The read path is the cheapest possible backfill: those rows have already been
 * paid for over the wire, so writing them means the next reader — any page, any
 * user, any isolate — gets them from Postgres. Best-effort by design: a mirror
 * write must never fail a dashboard that already has its answer.
 */
export async function persistSweptDays(records: CdrRecord[], days: string[]): Promise<void> {
  if (days.length === 0 || !isStoreConfigured()) return;
  try {
    await persistCdrRows(records, days);
  } catch (e) {
    console.warn(`[cdr sync] read-path persist failed: ${e instanceof Error ? e.message : e}`);
  }
}
