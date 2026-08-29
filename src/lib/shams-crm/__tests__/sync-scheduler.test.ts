/**
 * The guards that stand between a scheduled job and a second concurrent sync.
 *
 * Phase 1 could not verify what `POST /stock/sync` does while a run is already
 * active. Every test in this file exists because of that one unknown: the
 * scheduler must never be the thing that finds out, unattended, at one in the
 * morning.
 *
 * So the assertions are mostly negative — *did not trigger* — and that is the
 * point. The dangerous failure here is not an error; it is a second run starting
 * quietly while the first is still going.
 *
 * No real credential appears in this file, and no network call is made: the
 * transport module is mocked wholesale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shams-crm/sync.server", () => ({
  isSyncConfigured: vi.fn(() => true),
  getSyncStatus: vi.fn(),
  triggerSync: vi.fn(),
}));

import { runShamsSyncReconcile, runShamsSyncTriggers } from "@/lib/shams-crm/sync-scheduler.server";
import { getSyncStatus, isSyncConfigured, triggerSync } from "@/lib/shams-crm/sync.server";
import { normalizeSyncStatus } from "@/lib/shams-crm/sync-status";

const NOW = new Date("2026-08-28T22:00:00Z");

/* -------------------------------------------------------------------------- */
/* A Supabase stand-in                                                         */
/* -------------------------------------------------------------------------- */

interface DbOptions {
  /** Set to fail the claim insert the way the partial unique index would. */
  claimConflict?: boolean;
  /** Rows the reaper should report having cleared. */
  staleRows?: { id: string }[];
  /** Rows the reconcile pass should find open. */
  openRows?: { id: string; sync_type: string; shams_run_id: string | null }[];
}

function makeDb(opts: DbOptions = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: { id?: string; patch: Record<string, unknown> }[] = [];

  function chain() {
    const state: {
      op: string | null;
      payload: any;
      filters: Record<string, unknown>;
    } = { op: null, payload: null, filters: {} };

    const settle = () => {
      if (state.op === "insert") {
        inserts.push(state.payload);
        if (opts.claimConflict) {
          // Exactly what Postgres returns when the partial unique index bites.
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        return { data: { id: `row-${inserts.length}` }, error: null };
      }
      if (state.op === "update") {
        if (state.filters["lt:triggered_at"]) return { data: opts.staleRows ?? [], error: null };
        updates.push({ id: state.filters.id as string, patch: state.payload });
        return { data: null, error: null };
      }
      return { data: opts.openRows ?? [], error: null };
    };

    const api: any = {
      insert: (v: unknown) => ((state.op = "insert"), (state.payload = v), api),
      update: (v: unknown) => ((state.op = "update"), (state.payload = v), api),
      select: () => api,
      single: () => api,
      maybeSingle: () => api,
      eq: (k: string, v: unknown) => ((state.filters[k] = v), api),
      in: (k: string, v: unknown) => ((state.filters[k] = v), api),
      lt: (k: string, v: unknown) => ((state.filters[`lt:${k}`] = v), api),
      order: () => api,
      limit: () => api,
      then: (res: any, rej: any) => Promise.resolve(settle()).then(res, rej),
    };
    return api;
  }

  return { supabase: { from: () => chain() }, inserts, updates };
}

const idle = normalizeSyncStatus({ is_running: false }, NOW.getTime());
const busy = normalizeSyncStatus(
  { is_running: true, active_run: { id: 500, status: "running" } },
  NOW.getTime(),
);

beforeEach(() => {
  vi.mocked(isSyncConfigured).mockReturnValue(true);
  vi.mocked(getSyncStatus).mockReset();
  vi.mocked(triggerSync).mockReset();
});

/* -------------------------------------------------------------------------- */

describe("runShamsSyncTriggers — the guards", () => {
  it("does not trigger when Shams says a run is already active", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(busy);
    const { supabase, updates } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    // The assertion that matters.
    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(2);
    expect(summary.triggered).toBe(0);

    // And it is recorded as a skip, not a failure: nothing is wrong.
    expect(updates.every((u) => u.patch.status === "skipped")).toBe(true);
    expect(updates[0].patch.skip_reason).toMatch(/already running/i);
  });

  it("does not trigger when another execution already holds the claim", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    const { supabase } = makeDb({ claimConflict: true });

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    // The local guard fires before the CRM is contacted at all.
    expect(getSyncStatus).not.toHaveBeenCalled();
    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(2);
  });

  it("records the run id when a trigger is accepted", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    vi.mocked(triggerSync).mockResolvedValue({ kind: "triggered", runId: "348" });
    const { supabase, inserts, updates } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    expect(summary.triggered).toBe(2);
    expect(inserts).toHaveLength(2);
    // The claim is written before the CRM is contacted, so the window in which
    // two executions could both decide to trigger does not exist.
    expect(inserts[0]).toMatchObject({ status: "triggered", execution_source: "scheduled" });
    expect(updates[0].patch).toMatchObject({ status: "running", shams_run_id: "348" });
  });

  it("never retries a trigger whose outcome is unknown", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    vi.mocked(triggerSync).mockResolvedValue({
      kind: "indeterminate",
      errorKind: "timeout",
      message: "Shams CRM did not respond in time. Whether a run started is unknown.",
    });
    const { supabase, updates } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    expect(summary.indeterminate).toBe(2);
    // One attempt per kind. Never two.
    expect(triggerSync).toHaveBeenCalledTimes(2);
    expect(updates[0].patch.status).toBe("indeterminate");
  });

  it("does not trigger when the status read fails", async () => {
    vi.mocked(getSyncStatus).mockRejectedValue(new Error("network"));
    const { supabase, updates } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    // Unable to check the guard means unable to proceed.
    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.failed).toBe(2);
    expect(updates[0].patch.status).toBe("failed");
  });

  it("treats the two kinds independently", async () => {
    vi.mocked(getSyncStatus).mockImplementation(async (kind) => (kind === "stock" ? busy : idle));
    vi.mocked(triggerSync).mockResolvedValue({ kind: "triggered", runId: "76" });
    const { supabase } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    // Stock being busy must not hold promotions back: Phase 1 observed both
    // running concurrently and found no dependency in either direction.
    expect(summary.skipped).toBe(1);
    expect(summary.triggered).toBe(1);
    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith("promotions");
  });

  it("does nothing at all when the deployment holds no credentials", async () => {
    vi.mocked(isSyncConfigured).mockReturnValue(false);
    const { supabase, inserts } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    expect(summary.notConfigured).toBe(true);
    expect(triggerSync).not.toHaveBeenCalled();
    // No history rows either: an unconfigured deployment is a deployment state,
    // not two failed syncs every night burying the real history.
    expect(inserts).toHaveLength(0);
  });

  it("clears an abandoned claim so one stuck night cannot block every future one", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    vi.mocked(triggerSync).mockResolvedValue({ kind: "triggered", runId: "349" });
    const { supabase } = makeDb({ staleRows: [{ id: "orphan" }] });

    const summary = await runShamsSyncTriggers(supabase, { now: NOW });

    expect(summary.reaped).toBe(1);
    /*
     * Reaping frees only our own claim. The CRM status check still runs before
     * anything is triggered, which is what makes it safe: a reaped row whose run
     * is genuinely still going results in a skip, not a second run.
     */
    expect(getSyncStatus).toHaveBeenCalled();
  });
});

describe("runShamsSyncReconcile", () => {
  it("cannot start a synchronisation, whatever it finds", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    const { supabase } = makeDb({
      openRows: [{ id: "a", sync_type: "stock", shams_run_id: "347" }],
    });

    await runShamsSyncReconcile(supabase, NOW);

    // The structural property that lets this run every five minutes.
    expect(triggerSync).not.toHaveBeenCalled();
  });

  it("closes a run the CRM reports as finished", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(
      normalizeSyncStatus(
        {
          is_running: false,
          latest_run: {
            id: 347,
            status: "success",
            started_at: "2026-08-28T21:00:00",
            completed_at: "2026-08-28T21:24:24",
            rows_seen: 772594,
            rows_changed: 9970,
            pages_fetched: 839,
          },
        },
        NOW.getTime(),
      ),
    );
    const { supabase, updates } = makeDb({
      openRows: [{ id: "a", sync_type: "stock", shams_run_id: "347" }],
    });

    const summary = await runShamsSyncReconcile(supabase, NOW);

    expect(summary.completed).toBe(1);
    expect(updates[0].patch).toMatchObject({
      status: "success",
      rows_seen: 772594,
      duration_seconds: 1464,
    });
  });

  it("marks a run the CRM has moved past as indeterminate, never as success", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(
      normalizeSyncStatus(
        { is_running: false, latest_run: { id: 999, status: "success" } },
        NOW.getTime(),
      ),
    );
    const { supabase, updates } = makeDb({
      openRows: [{ id: "a", sync_type: "stock", shams_run_id: "347" }],
    });

    const summary = await runShamsSyncReconcile(supabase, NOW);

    expect(summary.lost).toBe(1);
    // Writing "success" here would be a fabrication in the history an
    // administrator uses to judge whether this integration works.
    expect(updates[0].patch.status).toBe("indeterminate");
  });

  it("leaves a row untouched when the CRM cannot be read this tick", async () => {
    vi.mocked(getSyncStatus).mockRejectedValue(new Error("timeout"));
    const { supabase, updates } = makeDb({
      openRows: [{ id: "a", sync_type: "stock", shams_run_id: "347" }],
    });

    const summary = await runShamsSyncReconcile(supabase, NOW);

    expect(summary.unreadable).toBe(1);
    // Transient. Tried again in five minutes; only the four-hour reaper ever
    // forces the issue.
    expect(updates).toHaveLength(0);
  });

  it("costs one status read per kind however many rows are open", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    const { supabase } = makeDb({
      openRows: [
        { id: "a", sync_type: "stock", shams_run_id: "347" },
        { id: "b", sync_type: "stock", shams_run_id: "348" },
        { id: "c", sync_type: "promotions", shams_run_id: "75" },
      ],
    });

    await runShamsSyncReconcile(supabase, NOW);

    expect(getSyncStatus).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there is nothing open", async () => {
    const { supabase } = makeDb({ openRows: [] });
    const summary = await runShamsSyncReconcile(supabase, NOW);
    expect(summary.observed).toBe(0);
    expect(getSyncStatus).not.toHaveBeenCalled();
  });
});

describe("what leaves the scheduler", () => {
  /**
   * The summaries are logged and returned over HTTP, so their shape is a
   * containment boundary rather than a convenience. Asserted structurally: every
   * value must be a number or a boolean, which no credential, run payload or
   * upstream body can ever be.
   */
  it("returns counts only — never a credential, a payload or an upstream body", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(idle);
    vi.mocked(triggerSync).mockResolvedValue({ kind: "triggered", runId: "348" });
    const { supabase } = makeDb();

    const trigger = await runShamsSyncTriggers(supabase, { now: NOW });
    const reconcile = await runShamsSyncReconcile(makeDb({ openRows: [] }).supabase, NOW);

    for (const summary of [trigger, reconcile]) {
      for (const value of Object.values(summary)) {
        expect(["number", "boolean"]).toContain(typeof value);
      }
    }
  });

  it("keeps an upstream failure's detail out of the stored error summary", async () => {
    vi.mocked(getSyncStatus).mockRejectedValue(
      // A realistic hostile case: an error whose message carries a URL and a body.
      new Error('https://shams-crm.cloud/stock/sync/status returned {"password":"hunter2"}'),
    );
    const { supabase, updates } = makeDb();

    await runShamsSyncTriggers(supabase, { now: NOW });

    for (const update of updates) {
      const text = String(update.patch.error_summary ?? "");
      expect(text).not.toMatch(/hunter2|shams-crm\.cloud|password/i);
    }
  });
});
