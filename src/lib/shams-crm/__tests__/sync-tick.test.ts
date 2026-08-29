/**
 * The tick: turning configured slots into runs, exactly once each.
 *
 * The schedule arithmetic itself is tested in `sync-schedule.test.ts`. What is
 * tested here is the part that can start work on a production system — which
 * slot fires, what it records, and every case where it must decline.
 *
 * The assertions are again mostly negative. A scheduler that runs when it should
 * not is a worse failure than one that errors, because it is silent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/shams-crm/sync.server", () => ({
  isSyncConfigured: vi.fn(() => true),
  getSyncStatus: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock("@/lib/shams-crm/sync-settings.server", () => ({
  readSyncSettings: vi.fn(),
  readScheduleSlots: vi.fn(),
  advanceSlot: vi.fn(async () => {}),
}));

import { runShamsSyncTick, runShamsSyncTriggers } from "@/lib/shams-crm/sync-scheduler.server";
import { getSyncStatus, isSyncConfigured, triggerSync } from "@/lib/shams-crm/sync.server";
import {
  advanceSlot,
  readScheduleSlots,
  readSyncSettings,
} from "@/lib/shams-crm/sync-settings.server";
import { normalizeSyncStatus } from "@/lib/shams-crm/sync-status";

/** 15:00 Riyadh on 29 Aug 2026 is 12:00Z; the tick runs 30 seconds later. */
const OCCURRENCE = "2026-08-29T12:00:00.000Z";
const NOW = new Date("2026-08-29T12:00:30Z");

function slot(over: Record<string, unknown> = {}) {
  return {
    id: "slot-15",
    enabled: true,
    localTime: "15:00",
    timeZone: "Asia/Riyadh",
    syncStock: true,
    syncPromotions: true,
    nextDueAt: OCCURRENCE,
    lastScheduledFor: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    updatedBy: null,
    ...over,
  } as any;
}

interface DbOptions {
  claimConflict?: boolean;
  openRows?: { id: string; sync_type: string; shams_run_id: string | null }[];
}

function makeDb(opts: DbOptions = {}) {
  const inserts: Record<string, any>[] = [];
  const updates: { id?: string; patch: Record<string, any> }[] = [];

  function chain() {
    const state: { op: string | null; payload: any; filters: Record<string, unknown> } = {
      op: null,
      payload: null,
      filters: {},
    };
    const settle = () => {
      if (state.op === "insert") {
        inserts.push(state.payload);
        if (opts.claimConflict) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        return { data: { id: `row-${inserts.length}` }, error: null };
      }
      if (state.op === "update") {
        if (state.filters["lt:triggered_at"]) return { data: [], error: null };
        updates.push({ id: state.filters.id as string, patch: state.payload });
        return { data: null, error: null };
      }
      return { data: opts.openRows ?? [], error: null };
    };
    const api: any = {
      insert: (v: unknown) => ((state.op = "insert"), (state.payload = v), api),
      update: (v: unknown) => ((state.op = "update"), (state.payload = v), api),
      delete: () => ((state.op = "delete"), api),
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
  { is_running: true, active_run: { id: 900, status: "running" } },
  NOW.getTime(),
);

beforeEach(() => {
  vi.mocked(isSyncConfigured).mockReturnValue(true);
  vi.mocked(getSyncStatus).mockReset().mockResolvedValue(idle);
  vi.mocked(triggerSync).mockReset().mockResolvedValue({ kind: "triggered", runId: "500" });
  vi.mocked(advanceSlot).mockClear();
  vi.mocked(readSyncSettings).mockResolvedValue({
    automationEnabled: true,
    updatedAt: null,
    updatedBy: null,
  });
  vi.mocked(readScheduleSlots).mockResolvedValue([slot()]);
});

/* -------------------------------------------------------------------------- */

describe("global automation switch", () => {
  it("OFF prevents scheduled execution entirely", async () => {
    vi.mocked(readSyncSettings).mockResolvedValue({
      automationEnabled: false,
      updatedAt: null,
      updatedBy: null,
    });
    const { supabase, inserts } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(triggerSync).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(summary.slotsDue).toBe(0);
    expect(summary.automationEnabled).toBe(false);
  });

  it("ON allows a due slot to execute", async () => {
    const { supabase } = makeDb();
    const summary = await runShamsSyncTick(supabase, NOW);

    expect(summary.slotsDue).toBe(1);
    expect(summary.triggered).toBe(2);
    expect(triggerSync).toHaveBeenCalledTimes(2);
  });
});

describe("slot targeting", () => {
  it("a Stock-only slot triggers Stock alone", async () => {
    vi.mocked(readScheduleSlots).mockResolvedValue([slot({ syncPromotions: false })]);
    const { supabase } = makeDb();

    await runShamsSyncTick(supabase, NOW);

    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith("stock");
  });

  it("a Promotions-only slot triggers Promotions alone", async () => {
    vi.mocked(readScheduleSlots).mockResolvedValue([slot({ syncStock: false })]);
    const { supabase } = makeDb();

    await runShamsSyncTick(supabase, NOW);

    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(triggerSync).toHaveBeenCalledWith("promotions");
  });

  it("a Both slot produces one occurrence per kind, not two per kind", async () => {
    const { supabase, inserts } = makeDb();
    await runShamsSyncTick(supabase, NOW);

    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.sync_type).sort()).toEqual(["promotions", "stock"]);
    // Both carry the same occurrence — that is what the unique index keys on.
    expect(inserts.every((i) => i.scheduled_for === OCCURRENCE)).toBe(true);
  });

  it("a disabled slot does not execute", async () => {
    vi.mocked(readScheduleSlots).mockResolvedValue([slot({ enabled: false })]);
    const { supabase } = makeDb();

    await runShamsSyncTick(supabase, NOW);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});

describe("exactly once per occurrence", () => {
  it("stamps the occurrence and the slot on every scheduled row", async () => {
    const { supabase, inserts } = makeDb();
    await runShamsSyncTick(supabase, NOW);

    for (const row of inserts) {
      expect(row.execution_source).toBe("scheduled");
      expect(row.scheduled_for).toBe(OCCURRENCE);
      expect(row.schedule_slot_id).toBe("slot-15");
      expect(row.requested_by).toBeNull();
    }
  });

  it("a duplicate invocation starts nothing when the occurrence is already claimed", async () => {
    // Exactly what Postgres returns when shams_sync_runs_occurrence_key bites —
    // whether the duplicate came from a second cron tick, a racing worker, a
    // redeploy mid-evaluation or a pg_net retry.
    const { supabase } = makeDb({ claimConflict: true });

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.triggered).toBe(0);
    expect(summary.skipped).toBe(2);
  });

  it("records a failed occurrence and advances, so it is never reattempted", async () => {
    vi.mocked(triggerSync).mockResolvedValue({
      kind: "rejected",
      errorKind: "http_error",
      httpStatus: 500,
      message: "Shams CRM declined to start the run (HTTP 500).",
    });
    const { supabase, inserts, updates } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(summary.failed).toBe(2);
    // The occurrence is stamped on the row, so the unique index alone would now
    // refuse a second attempt at it even if the advance were lost.
    expect(inserts.every((i) => i.scheduled_for === OCCURRENCE)).toBe(true);
    expect(updates.some((u) => u.patch.status === "failed")).toBe(true);
    expect(advanceSlot).toHaveBeenCalledTimes(1);
  });

  it("records an indeterminate occurrence and advances, without retrying", async () => {
    vi.mocked(triggerSync).mockResolvedValue({
      kind: "indeterminate",
      errorKind: "timeout",
      message: "Shams CRM did not respond in time. Whether a run started is unknown.",
    });
    const { supabase, updates } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(summary.indeterminate).toBe(2);
    expect(updates.some((u) => u.patch.status === "indeterminate")).toBe(true);
    // One attempt per kind, never two, and the slot moves on.
    expect(triggerSync).toHaveBeenCalledTimes(2);
    expect(advanceSlot).toHaveBeenCalledTimes(1);
  });

  it("advances even when the evaluation throws, so a bad slot cannot loop", async () => {
    // The gap a plain happy-path advance would leave: an unexpected database
    // error would leave the occurrence due and reattempt it every minute.
    vi.mocked(getSyncStatus).mockRejectedValue(new Error("boom"));
    vi.mocked(triggerSync).mockImplementation(() => {
      throw new Error("should not be reached");
    });
    const { supabase } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(advanceSlot).toHaveBeenCalledTimes(1);
    expect(summary.failed).toBeGreaterThan(0);
  });

  it("advances after an already-running skip, preserving Phase 2A behaviour", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(busy);
    const { supabase } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(summary.skipped).toBe(2);
    expect(triggerSync).not.toHaveBeenCalled();
    expect(advanceSlot).toHaveBeenCalledTimes(1);
  });

  it("advances the slot even when the trigger failed, so it cannot retry every minute", async () => {
    vi.mocked(triggerSync).mockResolvedValue({
      kind: "rejected",
      errorKind: "http_error",
      httpStatus: 500,
      message: "Shams CRM declined to start the run (HTTP 500).",
    });
    const { supabase } = makeDb();

    await runShamsSyncTick(supabase, NOW);

    expect(advanceSlot).toHaveBeenCalledTimes(1);
  });
});

describe("catch-up", () => {
  it("records a missed occurrence without triggering, then advances", async () => {
    const { supabase, inserts } = makeDb();

    const summary = await runShamsSyncTick(
      supabase,
      new Date("2026-08-29T15:30:00Z"), // 3.5 hours late
    );

    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.slotsMissed).toBe(1);
    expect(inserts).toHaveLength(2);
    for (const row of inserts) {
      expect(row.status).toBe("skipped");
      // Recorded against the time it should have run, not the time we noticed.
      expect(row.scheduled_for).toBe(OCCURRENCE);
      expect(row.skip_reason).toMatch(/Missed its scheduled window/);
    }
    expect(advanceSlot).toHaveBeenCalledTimes(1);
  });

  it("never produces a burst after a long outage", async () => {
    vi.mocked(readScheduleSlots).mockResolvedValue([
      slot({ nextDueAt: "2026-08-26T12:00:00.000Z" }),
    ]);
    const { supabase, inserts } = makeDb();

    const summary = await runShamsSyncTick(supabase, new Date("2026-08-29T13:00:00Z"));

    // Three days of arrears produce one skipped occurrence per kind. Not nine.
    expect(summary.slotsMissed).toBe(1);
    expect(inserts).toHaveLength(2);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});

describe("the Shams guard still applies to scheduled runs", () => {
  it("skips when Shams reports a run already active", async () => {
    vi.mocked(getSyncStatus).mockResolvedValue(busy);
    const { supabase } = makeDb();

    const summary = await runShamsSyncTick(supabase, NOW);

    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(2);
  });
});

describe("manual runs", () => {
  it("are recorded as manual, attributed, and carry NO occurrence", async () => {
    const { supabase, inserts } = makeDb();

    await runShamsSyncTriggers(supabase, {
      kinds: ["stock"],
      source: "manual",
      requestedBy: "admin-uuid",
      now: NOW,
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      sync_type: "stock",
      execution_source: "manual",
      requested_by: "admin-uuid",
      // The whole of the "manual does not consume a slot" rule: with no
      // scheduled_for, the occurrence index does not apply to this row.
      scheduled_for: null,
      schedule_slot_id: null,
    });
  });

  it("do not consume the scheduled occurrence — the slot still fires afterwards", async () => {
    const manualDb = makeDb();
    await runShamsSyncTriggers(manualDb.supabase, {
      kinds: ["stock"],
      source: "manual",
      requestedBy: "admin-uuid",
      now: new Date("2026-08-29T10:00:00Z"),
    });
    expect(manualDb.inserts[0].scheduled_for).toBeNull();

    // The schedule, evaluated later, is entirely unaffected by the manual run.
    vi.mocked(triggerSync).mockClear();
    const scheduledDb = makeDb();
    const summary = await runShamsSyncTick(scheduledDb.supabase, NOW);

    expect(summary.slotsDue).toBe(1);
    expect(summary.triggered).toBe(2);
  });

  it("are safely skipped while a Shams run is already in progress", async () => {
    // Covers both the Desktop-originated case and an active scheduled run: the
    // scheduler cannot tell them apart and does not need to.
    vi.mocked(getSyncStatus).mockResolvedValue(busy);
    const { supabase } = makeDb();

    const summary = await runShamsSyncTriggers(supabase, {
      kinds: ["stock", "promotions"],
      source: "manual",
      requestedBy: "admin-uuid",
      now: NOW,
    });

    expect(triggerSync).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(2);
  });

  it("do not reap another execution's stuck claim as a side effect", async () => {
    const { supabase, updates } = makeDb();
    await runShamsSyncTriggers(supabase, {
      kinds: ["stock"],
      source: "manual",
      requestedBy: "admin-uuid",
      now: NOW,
    });
    // Pressing a button must not quietly close somebody else's open run.
    expect(updates.every((u) => u.patch.status !== "indeterminate")).toBe(true);
  });
});

describe("what leaves the tick", () => {
  it("returns counts and booleans only", async () => {
    const { supabase } = makeDb();
    const summary = await runShamsSyncTick(supabase, NOW);
    for (const value of Object.values(summary)) {
      expect(["number", "boolean"]).toContain(typeof value);
    }
  });
});
