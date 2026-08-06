/**
 * The CDR mirror — Supabase-side reads and writes for the synchronized rows.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it deliberately is not
 * ---------------------------------------------------------------------------
 * Yeastar is the SOURCE OF TRUTH. This module maintains a mirror of rows the
 * PBX has already emitted so the dashboards can read a window from Postgres
 * instead of waiting on a live sweep. It stores `raw` — the row exactly as the
 * PBX sent it — and hands that same object back on read, so every consumer
 * downstream (`classifyRecords`, the metrics engine, Call Lookup) receives
 * byte-identical input whichever tier answered. No KPI is computed here, and no
 * field is reinterpreted; the columns beside `raw` exist only to be indexed.
 *
 * ---------------------------------------------------------------------------
 * Idempotency
 * ---------------------------------------------------------------------------
 * Every write is an upsert on `row_id`, so re-synchronizing an overlapping
 * window — which the incremental sync does on purpose (see `cdr-sync.server`) —
 * rewrites the same rows rather than adding new ones. `row_id` is the PBX's own
 * `new_id`, which is ROW-unique on this firmware; `uid` and `call_id` are
 * CALL-level and would collapse a multi-leg call to one leg. `cdrRowKey` is the
 * single definition of that key and mirrors the de-dup key `fetchCdrByNumber`
 * already uses, down to the composite fallback for a row with no `new_id`.
 */
import type { CdrRecord } from "./cdr.server";
import { fetchAllPaginated } from "@/lib/supabase-paginate";
import { businessDayOf, enumerateDays } from "./cdr-days";

/** Rows per upsert request. Large enough to be few round-trips, small enough
 *  that one statement stays well inside a Worker's CPU and body limits. */
const UPSERT_CHUNK = 500;

/** How many days one `.in()` filter may name. Keeps the URL inside PostgREST's
 *  length limit on a wide (multi-month) window. */
const DAY_FILTER_CHUNK = 45;

/**
 * Whether the mirror can be reached at all.
 *
 * The mirror is service-role only, so without those two variables every call
 * below would throw on first property access. Checked up front rather than
 * caught after the fact: an environment with no service-role key (a unit test,
 * a preview sandbox that lost its `.env`) should quietly fall back to the live
 * PBX path, not log a stack trace per request.
 */
export function isStoreConfigured(): boolean {
  return !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** The tables are absent from the generated `types.ts` (see docs/project.md,
 *  Known Technical Debt #2), so reads and writes go through the same `as any`
 *  adapter `progress.server.ts` uses. Confined to this one helper. */
function table(db: any, name: "cdr_records" | "cdr_sync_days" | "cdr_sync_state") {
  return db.from(name as any) as any;
}

/**
 * The idempotency key for one CDR row.
 *
 * `new_id` when the PBX supplied it; otherwise a composite of the fields that
 * identify a leg. The composite is deterministic, so a re-sync of the same row
 * produces the same key and upserts rather than duplicates.
 */
export function cdrRowKey(r: CdrRecord): string {
  if (r.new_id != null && String(r.new_id).length > 0) return `n:${r.new_id}`;
  return `c:${r.call_id ?? ""}|${r.timestamp ?? ""}|${r.call_to_number ?? ""}|${r.call_from_number ?? ""}`;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export interface SyncedDay {
  /** Rows the mirror holds for this day. */
  rowCount: number;
  /** Epoch ms of the last sync that covered it. */
  syncedAt: number;
}

/**
 * May the mirror answer for `day`?
 *
 * The one definition of that rule, because two callers ask it — the window
 * store and Call Lookup — and a dashboard that trusts the mirror further than
 * the lookup does would show two different answers for the same calls.
 *
 * A day that has ENDED is immutable on this PBX, so its age is irrelevant.
 * Today is still being written to, so it is trusted only while the sync is
 * recent — the same freshness contract the in-memory day cache applies.
 */
export function isSyncedDayUsable(
  day: string,
  hit: SyncedDay | undefined,
  now: number,
  today: string,
  liveTtlMs: number,
): boolean {
  if (!hit) return false;
  return day < today || now - hit.syncedAt < liveTtlMs;
}

/**
 * Does the mirror cover EVERY day of `[from, to]`?
 *
 * All-or-nothing on purpose. A partially covered window would answer from the
 * days it holds and silently omit the rest, which for Call Lookup means
 * reporting "nobody has spoken to them" about a gap — strictly worse than being
 * slow. Returns false rather than throwing when the mirror is unreachable.
 */
export async function storeCoversWindow(
  from: string,
  to: string,
  liveTtlMs: number,
): Promise<boolean> {
  if (!isStoreConfigured()) return false;
  try {
    const now = Date.now();
    const today = businessDayOf(now);
    const days = enumerateDays(from, to);
    if (days.length === 0) return false;
    const synced = await readSyncedDays(days);
    return days.every((d) => isSyncedDayUsable(d, synced.get(d), now, today, liveTtlMs));
  } catch (e) {
    console.warn(
      `[yeastar cdr] mirror coverage check failed: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }
}

/** Which of `days` the mirror covers, and how recently. Never fetches. */
export async function readSyncedDays(days: string[]): Promise<Map<string, SyncedDay>> {
  const out = new Map<string, SyncedDay>();
  if (days.length === 0) return out;
  const db = await admin();
  for (let i = 0; i < days.length; i += DAY_FILTER_CHUNK) {
    const slice = days.slice(i, i + DAY_FILTER_CHUNK);
    const { data, error } = await table(db, "cdr_sync_days")
      .select("business_day,row_count,synced_at")
      .in("business_day", slice);
    if (error) throw error;
    for (const row of (data ?? []) as any[]) {
      out.set(String(row.business_day).slice(0, 10), {
        rowCount: row.row_count ?? 0,
        syncedAt: row.synced_at ? Date.parse(row.synced_at) : 0,
      });
    }
  }
  return out;
}

/**
 * The mirrored rows for `days`, bucketed by business day.
 *
 * Every requested day gets an entry, including days the mirror knows to be
 * empty — the caller uses the presence of a bucket to decide it need not ask
 * the PBX, and a missing bucket for a quiet day would re-sweep it forever.
 */
export async function readCdrDays(days: string[]): Promise<Map<string, CdrRecord[]>> {
  const byDay = new Map<string, CdrRecord[]>();
  for (const d of days) byDay.set(d, []);
  if (days.length === 0) return byDay;

  const db = await admin();
  for (let i = 0; i < days.length; i += DAY_FILTER_CHUNK) {
    const slice = days.slice(i, i + DAY_FILTER_CHUNK);
    // Ordered by the primary key: `fetchAllPaginated` walks with `.range()`, and
    // an unordered scan can repeat or skip rows between pages.
    const rows = await fetchAllPaginated<any>(() =>
      table(db, "cdr_records")
        .select("business_day,raw")
        .in("business_day", slice)
        .order("row_id", { ascending: true }),
    );
    for (const row of rows) {
      const day = String(row.business_day).slice(0, 10);
      const bucket = byDay.get(day);
      if (bucket) bucket.push(row.raw as CdrRecord);
    }
  }
  return byDay;
}

/**
 * Upsert `rows` and record every day in `days` as covered.
 *
 * `days` is the range that was actually swept, not the days that happened to
 * contain a call — recording only the latter would leave quiet days looking
 * unsynced. Returns how many rows were written.
 */
export async function persistCdrRows(rows: CdrRecord[], days: string[]): Promise<number> {
  const db = await admin();
  const perDay = new Map<string, number>();
  for (const d of days) perDay.set(d, 0);

  const payload: any[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.timestamp !== "number") continue;
    const day = businessDayOf(r.timestamp * 1000);
    const key = cdrRowKey(r);
    // A single upsert statement may not name the same conflict target twice
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), and the
    // PBX can repeat a row across pages of the same sweep.
    if (seen.has(key)) continue;
    seen.add(key);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    payload.push({
      row_id: key,
      call_id: str(r.call_id),
      ts: r.timestamp,
      business_day: day,
      call_from_number: str(r.call_from_number),
      call_to_number: str(r.call_to_number),
      raw: r,
      synced_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < payload.length; i += UPSERT_CHUNK) {
    const { error } = await table(db, "cdr_records").upsert(payload.slice(i, i + UPSERT_CHUNK), {
      onConflict: "row_id",
    });
    if (error) throw error;
  }

  const dayRows = [...perDay.entries()].map(([business_day, row_count]) => ({
    business_day,
    row_count,
    synced_at: new Date().toISOString(),
  }));
  for (let i = 0; i < dayRows.length; i += UPSERT_CHUNK) {
    const { error } = await table(db, "cdr_sync_days").upsert(dayRows.slice(i, i + UPSERT_CHUNK), {
      onConflict: "business_day",
    });
    if (error) throw error;
  }

  return payload.length;
}

/**
 * Mirrored rows for one subscriber over `[from, to]`.
 *
 * The counterpart of `fetchCdrByNumber`, answered from Postgres. Both ends are
 * matched because inbound records the customer in `call_from_number` and
 * outbound in `call_to_number`, and every leg of an inbound call repeats the
 * customer's number — so `call_id` grouping downstream still sees the agent leg.
 * As with the PBX path this is only ever a PRE-filter: the caller re-applies its
 * own authoritative suffix match.
 */
export async function readCdrByNumber(
  from: string,
  to: string,
  variants: string[],
): Promise<CdrRecord[]> {
  const wanted = variants.filter((v) => v && v.length > 0);
  if (wanted.length === 0) return [];
  const db = await admin();
  const byKey = new Map<string, CdrRecord>();
  for (const column of ["call_from_number", "call_to_number"] as const) {
    const rows = await fetchAllPaginated<any>(() =>
      table(db, "cdr_records")
        .select("row_id,raw")
        .gte("business_day", from)
        .lte("business_day", to)
        .in(column, wanted)
        .order("row_id", { ascending: true }),
    );
    for (const row of rows) byKey.set(String(row.row_id), row.raw as CdrRecord);
  }
  return [...byKey.values()];
}

// ---- Sync state -------------------------------------------------------------

export interface CdrSyncState {
  /** High-water mark of `cdr_records.ts`, in epoch seconds. Null before the
   *  first run. */
  lastSyncedEpoch: number | null;
  lastRunAt: number | null;
  lastStatus: string;
  lastError: string | null;
  lastRows: number;
  lastDays: number;
  leaseUntil: number | null;
}

export async function readSyncState(): Promise<CdrSyncState> {
  const db = await admin();
  const { data } = await table(db, "cdr_sync_state").select("*").eq("id", 1).maybeSingle();
  const row = (data ?? {}) as any;
  return {
    lastSyncedEpoch: row.last_synced_epoch ?? null,
    lastRunAt: row.last_run_at ? Date.parse(row.last_run_at) : null,
    lastStatus: row.last_status ?? "idle",
    lastError: row.last_error ?? null,
    lastRows: row.last_rows ?? 0,
    lastDays: row.last_days ?? 0,
    leaseUntil: row.lease_until ? Date.parse(row.lease_until) : null,
  };
}

export async function writeSyncState(patch: {
  lastSyncedEpoch?: number | null;
  lastRunAt?: number;
  lastStatus?: string;
  lastError?: string | null;
  lastRows?: number;
  lastDays?: number;
  leaseUntil?: number | null;
}): Promise<void> {
  const db = await admin();
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (patch.lastSyncedEpoch !== undefined) row.last_synced_epoch = patch.lastSyncedEpoch;
  if (patch.lastRunAt !== undefined) row.last_run_at = new Date(patch.lastRunAt).toISOString();
  if (patch.lastStatus !== undefined) row.last_status = patch.lastStatus;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.lastRows !== undefined) row.last_rows = patch.lastRows;
  if (patch.lastDays !== undefined) row.last_days = patch.lastDays;
  if (patch.leaseUntil !== undefined)
    row.lease_until = patch.leaseUntil == null ? null : new Date(patch.leaseUntil).toISOString();
  await table(db, "cdr_sync_state").upsert(row, { onConflict: "id" });
}

/**
 * Take the single-writer lease, or report that someone else holds it.
 *
 * The `.or()` predicate is what makes this a lease rather than a flag: the
 * UPDATE only lands when the stored lease is absent or already expired, so two
 * isolates racing produce exactly one winner and the loser sees zero rows
 * returned. A crashed run therefore self-heals after `holdMs` instead of
 * blocking synchronization forever.
 */
export async function claimSyncLease(holdMs: number): Promise<boolean> {
  const db = await admin();
  const now = new Date();
  const { data, error } = await table(db, "cdr_sync_state")
    .update({
      lease_until: new Date(now.getTime() + holdMs).toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", 1)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) throw error;
  return ((data ?? []) as any[]).length > 0;
}

export async function releaseSyncLease(): Promise<void> {
  await writeSyncState({ leaseUntil: null });
}

/** Mirror coverage over a window, for diagnostics. Never fetches from the PBX. */
export async function cdrStoreStats(
  from: string,
  to: string,
): Promise<{ days: number; daysSynced: number; rows: number; oldestSyncedAt: number | null }> {
  const days = enumerateDays(from, to);
  const synced = await readSyncedDays(days);
  let rows = 0;
  let oldest: number | null = null;
  for (const s of synced.values()) {
    rows += s.rowCount;
    if (oldest == null || s.syncedAt < oldest) oldest = s.syncedAt;
  }
  return { days: days.length, daysSynced: synced.size, rows, oldestSyncedAt: oldest };
}
