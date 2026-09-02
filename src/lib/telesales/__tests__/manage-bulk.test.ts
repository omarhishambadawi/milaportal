import { describe, expect, it } from "vitest";
import { BULK_LIMIT, bulkArchive, bulkAssign, bulkRestore } from "../manage.server";

/**
 * Bulk operations, against a fake PostgREST client.
 *
 * `manage.server.ts` takes its client as an argument, which is what makes these
 * testable without a database. The fake records every call, so a test can
 * assert not only the result but the *shape* of what was sent — that one bulk
 * update went out rather than fifty, that the update carried a guard condition,
 * that the audit rows describe leads that actually changed.
 */

interface LeadRow {
  id: string;
  status?: string;
  assigned_to?: string | null;
  archived_at?: string | null;
}

interface Recorded {
  table: string;
  op: "select" | "update" | "insert";
  ids?: string[];
  payload?: Record<string, unknown>;
  /** Extra `.not()` / `.eq()` guards applied to a write. */
  guards: string[];
  rows?: unknown[];
}

/**
 * Enough of the PostgREST builder to run these functions.
 *
 * Thenable, so `await` on the builder resolves like the real client does, and
 * chainable in any order the code under test happens to use.
 */
function fakeClient(seed: LeadRow[]) {
  const calls: Recorded[] = [];
  const rows = new Map(seed.map((r) => [r.id, { archived_at: null, ...r }]));

  function builder(table: string) {
    const rec: Recorded = { table, op: "select", guards: [] };
    let ids: string[] | null = null;

    const self: any = {
      select(_cols: string) {
        rec.op = "select";
        return self;
      },
      update(payload: Record<string, unknown>) {
        rec.op = "update";
        rec.payload = payload;
        return self;
      },
      insert(values: unknown[]) {
        rec.op = "insert";
        rec.rows = values;
        calls.push(rec);
        return Promise.resolve({ data: null, error: null });
      },
      in(col: string, values: string[]) {
        if (col === "id" || col === "lead_id") ids = values;
        else rec.guards.push(`in:${col}`);
        return self;
      },
      eq(col: string, value: unknown) {
        rec.guards.push(`eq:${col}=${String(value)}`);
        return self;
      },
      not(col: string, op: string, value: unknown) {
        rec.guards.push(`not:${col} ${op} ${String(value)}`);
        return self;
      },
      is(col: string, value: unknown) {
        rec.guards.push(`is:${col}=${String(value)}`);
        return self;
      },
      then(resolve: (v: unknown) => void) {
        rec.ids = ids ?? undefined;
        calls.push(rec);

        if (rec.op === "select") {
          const found = (ids ?? []).map((id) => rows.get(id)).filter(Boolean);
          return Promise.resolve({ data: found, error: null }).then(resolve);
        }

        // Apply the update to the fake store so later reads see it.
        for (const id of ids ?? []) {
          const row = rows.get(id);
          if (!row) continue;
          const wantsArchived = rec.guards.some((g) => g.startsWith("not:archived_at"));
          if (wantsArchived && !row.archived_at) continue;
          Object.assign(row, rec.payload);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return self;
  }

  return {
    client: { from: (table: string) => builder(table) },
    calls,
    rows,
  };
}

const actor = { userId: "u-super", name: "Sam Supervisor", role: "admin" } as any;

/* ===================================================================== */
/* Archive                                                               */
/* ===================================================================== */

describe("bulkArchive", () => {
  it("archives one lead and records who did it and when", async () => {
    const { client, calls, rows } = fakeClient([{ id: "a" }]);
    const r = await bulkArchive(client as any, {
      leadIds: ["a"],
      reason: "Backlog cleanup",
      actor,
    });

    expect(r).toEqual({ requested: 1, changed: 1, skipped: [] });
    const row = rows.get("a")!;
    expect(row.archived_at).toBeTruthy();
    expect((row as any).archived_by).toBe("u-super");
    expect((row as any).archive_reason).toBe("Backlog cleanup");

    // A soft state on the lead. Nothing was deleted.
    expect(calls.some((c) => c.op === "update" && c.table === "telesales_leads")).toBe(true);
    expect(calls.every((c) => c.op !== ("delete" as never))).toBe(true);
  });

  it("archives many leads in ONE update, not one request per lead", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `lead-${i}`);
    const { client, calls } = fakeClient(ids.map((id) => ({ id })));
    const r = await bulkArchive(client as any, { leadIds: ids, reason: "Cleanup", actor });

    expect(r.changed).toBe(40);
    const leadUpdates = calls.filter((c) => c.table === "telesales_leads" && c.op === "update");
    expect(leadUpdates).toHaveLength(1);
    expect(leadUpdates[0].ids).toHaveLength(40);
  });

  it("cancels open follow-ups so an archived lead stops being due", async () => {
    const { client, calls } = fakeClient([{ id: "a" }]);
    await bulkArchive(client as any, { leadIds: ["a"], reason: "Cleanup", actor });

    const followups = calls.find((c) => c.table === "telesales_followups");
    expect(followups?.op).toBe("update");
    expect(followups?.payload).toMatchObject({ status: "cancelled" });
    expect(followups?.guards).toContain("eq:status=scheduled");
  });

  it("writes one audit row per archived lead", async () => {
    const { client, calls } = fakeClient([{ id: "a" }, { id: "b" }]);
    await bulkArchive(client as any, { leadIds: ["a", "b"], reason: "Cleanup", actor });

    const audit = calls.find((c) => c.table === "telesales_lead_activities");
    expect(audit?.rows).toHaveLength(2);
    expect(audit?.rows?.[0]).toMatchObject({
      lead_id: "a",
      actor_id: "u-super",
      actor_name: "Sam Supervisor",
    });
  });

  it("skips a lead somebody else already archived, and says so", async () => {
    // The concurrency case: two supervisors working the same backlog.
    const { client } = fakeClient([{ id: "a" }, { id: "b", archived_at: "2026-08-01T00:00:00Z" }]);
    const r = await bulkArchive(client as any, { leadIds: ["a", "b"], reason: "Cleanup", actor });

    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual([{ id: "b", reason: "already archived" }]);
    expect(r.requested).toBe(2);
  });

  it("counts a duplicated selection once", async () => {
    const { client } = fakeClient([{ id: "a" }]);
    const r = await bulkArchive(client as any, {
      leadIds: ["a", "a", "a"],
      reason: "Cleanup",
      actor,
    });
    expect(r.requested).toBe(1);
    expect(r.changed).toBe(1);
  });

  it("does nothing at all on an empty selection", async () => {
    const { client, calls } = fakeClient([]);
    const r = await bulkArchive(client as any, { leadIds: [], reason: "Cleanup", actor });
    expect(r).toEqual({ requested: 0, changed: 0, skipped: [] });
    expect(calls).toHaveLength(0);
  });

  it("refuses to touch more than the bulk limit in one call", async () => {
    const ids = Array.from({ length: BULK_LIMIT + 50 }, (_, i) => `lead-${i}`);
    const { client } = fakeClient(ids.map((id) => ({ id })));
    const r = await bulkArchive(client as any, { leadIds: ids, reason: "Cleanup", actor });
    expect(r.requested).toBe(BULK_LIMIT);
  });
});

/* ===================================================================== */
/* Restore                                                               */
/* ===================================================================== */

describe("bulkRestore", () => {
  it("restores an archived lead and clears the archive metadata", async () => {
    const { client, rows } = fakeClient([{ id: "a", archived_at: "2026-01-05T00:00:00Z" }]);
    const r = await bulkRestore(client as any, { leadIds: ["a"], actor });

    expect(r.changed).toBe(1);
    const row = rows.get("a")!;
    expect(row.archived_at).toBeNull();
    expect((row as any).archived_by).toBeNull();
    expect((row as any).archive_reason).toBeNull();
  });

  it("reports only what it actually restored", async () => {
    /*
     * The defect this test exists for. Restoring used to report every selected
     * id as changed, so a supervisor selecting twenty rows of which five were
     * archived was told twenty were restored.
     */
    const { client } = fakeClient([
      { id: "a", archived_at: "2026-01-05T00:00:00Z" },
      { id: "b" },
      { id: "c" },
    ]);
    const r = await bulkRestore(client as any, { leadIds: ["a", "b", "c"], actor });

    expect(r.requested).toBe(3);
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual([
      { id: "b", reason: "not archived" },
      { id: "c", reason: "not archived" },
    ]);
  });

  it("audits only the leads it restored", async () => {
    // The other half of the same defect: a live lead must not gain a "reopened"
    // entry describing something that never happened to it.
    const { client, calls } = fakeClient([
      { id: "a", archived_at: "2026-01-05T00:00:00Z" },
      { id: "b" },
    ]);
    await bulkRestore(client as any, { leadIds: ["a", "b"], actor });

    const audit = calls.find((c) => c.table === "telesales_lead_activities");
    expect(audit?.rows).toHaveLength(1);
    expect(audit?.rows?.[0]).toMatchObject({ lead_id: "a", activity_type: "reopened" });
  });

  it("guards the write so a concurrent restore cannot double-apply", async () => {
    const { client, calls } = fakeClient([{ id: "a", archived_at: "2026-01-05T00:00:00Z" }]);
    await bulkRestore(client as any, { leadIds: ["a"], actor });

    const update = calls.find((c) => c.table === "telesales_leads" && c.op === "update");
    expect(update?.guards.some((g) => g.startsWith("not:archived_at"))).toBe(true);
  });

  it("leaves the refill dates alone, so a stale lead comes back stale", async () => {
    /*
     * Restoring returns a lead to the queue; it does not make it current. The
     * lifecycle is derived from the due date, and restoring is not an event
     * that changes a due date — so nothing here may touch one.
     */
    const { client, calls } = fakeClient([{ id: "a", archived_at: "2026-01-05T00:00:00Z" }]);
    await bulkRestore(client as any, { leadIds: ["a"], actor });

    const update = calls.find((c) => c.table === "telesales_leads" && c.op === "update");
    expect(Object.keys(update?.payload ?? {}).sort()).toEqual([
      "archive_reason",
      "archived_at",
      "archived_by",
    ]);
    expect(update?.payload).not.toHaveProperty("next_followup_on");
    expect(update?.payload).not.toHaveProperty("source_date");
    expect(update?.payload).not.toHaveProperty("status");
  });

  it("does nothing on an empty selection", async () => {
    const { client, calls } = fakeClient([]);
    expect(await bulkRestore(client as any, { leadIds: [], actor })).toEqual({
      requested: 0,
      changed: 0,
      skipped: [],
    });
    expect(calls).toHaveLength(0);
  });
});

/* ===================================================================== */
/* Assign                                                                */
/* ===================================================================== */

describe("bulkAssign", () => {
  it("refuses to assign an archived lead", async () => {
    // An archived lead is not work; handing it to an agent would put it in a
    // queue it is excluded from.
    const { client } = fakeClient([{ id: "a", archived_at: "2026-01-05T00:00:00Z" }]);
    const r = await bulkAssign(client as any, { leadIds: ["a"], assigneeId: "agent-1", actor });
    expect(r.changed).toBe(0);
    expect(r.skipped).toEqual([{ id: "a", reason: "archived" }]);
  });

  it("skips a lead already assigned to that agent rather than rewriting it", async () => {
    const { client } = fakeClient([{ id: "a", assigned_to: "agent-1" }]);
    const r = await bulkAssign(client as any, { leadIds: ["a"], assigneeId: "agent-1", actor });
    expect(r.changed).toBe(0);
    expect(r.skipped[0].reason).toContain("already assigned");
  });

  it("unassigns in one update", async () => {
    const { client, calls } = fakeClient([
      { id: "a", assigned_to: "agent-1" },
      { id: "b", assigned_to: "agent-2" },
    ]);
    const r = await bulkAssign(client as any, { leadIds: ["a", "b"], assigneeId: null, actor });

    expect(r.changed).toBe(2);
    const updates = calls.filter((c) => c.table === "telesales_leads" && c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ assigned_to: null, assigned_at: null });
  });

  it("promotes only a new lead to assigned, leaving worked leads alone", async () => {
    const { client, calls } = fakeClient([
      { id: "a", status: "new" },
      { id: "b", status: "in_progress" },
    ]);
    await bulkAssign(client as any, { leadIds: ["a", "b"], assigneeId: "agent-1", actor });

    // The status promotion is a separate, guarded update: only rows still `new`.
    const promotion = calls.find(
      (c) => c.op === "update" && c.payload && (c.payload as any).status === "assigned",
    );
    expect(promotion?.guards).toContain("eq:status=new");
  });
});
