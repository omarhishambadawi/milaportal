/**
 * Resolve dispatch: an operator writing down what happened, and every guarantee
 * that it is only ever a record.
 *
 * The assertion this suite exists for is the negative one — **zero courier
 * calls, on every path**. A workflow that reconciles an uncertain delivery is
 * one keystroke away from being a workflow that resends it, and the difference
 * has to be provable rather than intended.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ALSHROUQ_RESOLUTION_OUTCOMES,
  ALSHROUQ_RESOLVABLE_STATUSES,
  RESOLUTION_ACTIVITY_ACTION,
  canResolveDispatch,
  describeResolutionOutcome,
  describeResolveRefusal,
  isResolutionOutcome,
  isValidResolutionNote,
  normaliseResolutionNote,
  resolutionWarningFor,
  type AlShrouqResolutionOutcome,
} from "@/lib/shams-crm/alshrouq-resolution";
import { resolveAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-resolve.server";
import {
  ALSHROUQ_DISPATCH_STATUSES,
  blocksNewDispatch,
} from "@/lib/shams-crm/alshrouq-dispatch-state";
import { cancelScheduledAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { summariseAlShrouqDispatch } from "@/features/alshrouq/dispatch-timeline";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const resolveService = read("../alshrouq-resolve.server.ts");
const contract = read("../alshrouq-resolution.ts");
const serverFns = read("../../shams.functions.ts");
const card = read("../../../features/alshrouq/components/dispatch-section.tsx");
const migration = read(
  "../../../../supabase/migrations/20260823120000_alshrouq_dispatch_resolution.sql",
);

const DISPATCH_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const OPERATOR = "99999999-8888-7777-6666-555555555555";

/* ------------------------------------------------------------------------- */
/* The contract                                                              */
/* ------------------------------------------------------------------------- */

describe("the resolution contract", () => {
  it("allows exactly the two states the machine gave up on", () => {
    expect([...ALSHROUQ_RESOLVABLE_STATUSES].sort()).toEqual(["failed", "indeterminate"]);
    for (const status of ALSHROUQ_DISPATCH_STATUSES) {
      const expected = status === "indeterminate" || status === "failed";
      expect(canResolveDispatch(status)).toBe(expected);
    }
    expect(canResolveDispatch(null)).toBe(false);
    expect(canResolveDispatch("something-new")).toBe(false);
  });

  it("offers exactly three outcomes, and none of them is a retry", () => {
    expect([...ALSHROUQ_RESOLUTION_OUTCOMES]).toEqual([
      "delivered",
      "not_delivered",
      "undetermined",
    ]);
    for (const outcome of ALSHROUQ_RESOLUTION_OUTCOMES) {
      expect(describeResolutionOutcome(outcome)).not.toMatch(/retry|resend|send again/i);
    }
    expect(isResolutionOutcome("retry")).toBe(false);
    expect(isResolutionOutcome("accepted")).toBe(false);
  });

  /** An answer already recorded is not open to a second opinion. */
  it("refuses a row that already carries an answer", () => {
    expect(canResolveDispatch("indeterminate", "delivered")).toBe(false);
    expect(canResolveDispatch("failed", "undetermined")).toBe(false);
    expect(describeResolveRefusal("indeterminate", "delivered")).toContain("already been resolved");
  });

  /** Both warnings must end the same way: recording is not acting. */
  it.each(["indeterminate", "failed"])("warns that resolving %s sends nothing", (status) => {
    const warning = resolutionWarningFor(status);
    expect(warning).toMatch(/will not (resend|retry)/i);
  });

  it("requires a note, and bounds it", () => {
    expect(isValidResolutionNote("")).toBe(false);
    expect(isValidResolutionNote("  ")).toBe(false);
    expect(isValidResolutionNote("ok")).toBe(false);
    expect(isValidResolutionNote("Confirmed by phone with AlShrouq.")).toBe(true);
    expect(normaliseResolutionNote("  spaced  ")).toBe("spaced");
    expect(normaliseResolutionNote("x".repeat(500))).toHaveLength(280);
  });

  /** The state machine is untouched: resolving changes nothing about slots. */
  it("does not weaken blocksNewDispatch", () => {
    for (const status of ALSHROUQ_DISPATCH_STATUSES) {
      expect(blocksNewDispatch(status)).toBe(status !== "cancelled");
    }
  });
});

/* ------------------------------------------------------------------------- */
/* A fake Postgres honouring the compare-and-swap                            */
/* ------------------------------------------------------------------------- */

function fakeDb(initial: Record<string, unknown> | null) {
  const state = { row: initial ? { ...initial } : null };
  const activity: Record<string, unknown>[] = [];

  return {
    state,
    activity,
    from(table: string) {
      const eq: Record<string, unknown> = {};
      const isNull: string[] = [];
      let inFilter: { col: string; values: unknown[] } | null = null;
      let pending: Record<string, unknown> | null = null;

      const matches = () => {
        const row = state.row;
        if (!row) return false;
        for (const [k, v] of Object.entries(eq)) if (row[k] !== v) return false;
        for (const c of isNull) if (row[c] != null) return false;
        if (inFilter && !inFilter.values.includes(row[inFilter.col])) return false;
        return true;
      };

      const chain: any = {
        select: () => chain,
        // The cancellation path orders and limits before maybeSingle; this fake
        // holds one row, so both are pass-throughs.
        order: () => chain,
        limit: () => chain,
        eq: (c: string, v: unknown) => {
          eq[c] = v;
          return chain;
        },
        is: (c: string, v: unknown) => {
          if (v === null) isNull.push(c);
          return chain;
        },
        in: (c: string, values: unknown[]) => {
          inFilter = { col: c, values };
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          pending = patch;
          return chain;
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === "order_activity") activity.push(row);
          return { data: null, error: null };
        },
        maybeSingle: async () => {
          if (pending) {
            if (!matches()) return { data: null, error: null };
            Object.assign(state.row!, pending);
            pending = null;
            return { data: { ...state.row }, error: null };
          }
          return { data: matches() ? state.row : null, error: null };
        },
      };
      return chain;
    },
  };
}

function stuckRow(over: Record<string, unknown> = {}) {
  return {
    id: DISPATCH_ID,
    order_id: ORDER_ID,
    dispatch_status: "indeterminate",
    cancelled_at: null,
    resolution_outcome: null,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    payload_snapshot: { client_order_id: "9540", customer_name: "Ahmed" },
    ...over,
  };
}

const input = (over: Partial<Parameters<typeof resolveAlShrouqDispatch>[0]> = {}) => ({
  dispatchId: DISPATCH_ID,
  outcome: "delivered" as AlShrouqResolutionOutcome,
  note: "Confirmed by phone with AlShrouq operations.",
  resolvedBy: OPERATOR,
  ...over,
});

/* ------------------------------------------------------------------------- */
/* Persistence                                                               */
/* ------------------------------------------------------------------------- */

describe("recording a resolution", () => {
  it.each(ALSHROUQ_RESOLUTION_OUTCOMES)(
    "records %s against the right dispatch",
    async (outcome) => {
      const db = fakeDb(stuckRow());
      const at = new Date("2026-08-23T10:00:00.000Z");

      const r = await resolveAlShrouqDispatch(input({ outcome }), db as any, at);

      expect(r.kind).toBe("resolved");
      expect(db.state.row!.resolution_outcome).toBe(outcome);
      expect(db.state.row!.resolved_by).toBe(OPERATOR);
      expect(db.state.row!.resolved_at).toBe("2026-08-23T10:00:00.000Z");
      expect(db.state.row!.resolution_note).toBe("Confirmed by phone with AlShrouq operations.");
    },
  );

  /**
   * The lifecycle field is the machine's record of what it observed. An
   * operator's conclusion goes beside it, never over it.
   */
  it.each(ALSHROUQ_RESOLUTION_OUTCOMES)(
    "leaves dispatch_status untouched for %s",
    async (outcome) => {
      const db = fakeDb(stuckRow());
      await resolveAlShrouqDispatch(input({ outcome }), db as any);
      expect(db.state.row!.dispatch_status).toBe("indeterminate");
    },
  );

  /**
   * The slot stays taken, deliberately — including for "confirmed not
   * delivered". Recording what happened and re-authorising a courier are
   * separate decisions.
   */
  it.each(ALSHROUQ_RESOLUTION_OUTCOMES)("never frees the dispatch slot for %s", async (outcome) => {
    const db = fakeDb(stuckRow());
    await resolveAlShrouqDispatch(input({ outcome }), db as any);

    expect(db.state.row!.cancelled_at).toBeNull();
    expect(blocksNewDispatch(db.state.row!.dispatch_status as string)).toBe(true);
  });

  it("never touches the frozen payload", async () => {
    const db = fakeDb(stuckRow());
    const before = JSON.stringify(db.state.row!.payload_snapshot);

    await resolveAlShrouqDispatch(input(), db as any);

    expect(JSON.stringify(db.state.row!.payload_snapshot)).toBe(before);
    expect(resolveService).not.toContain("payload_snapshot");
  });

  it("resolves a failed dispatch as readily as an indeterminate one", async () => {
    const db = fakeDb(stuckRow({ dispatch_status: "failed" }));
    const r = await resolveAlShrouqDispatch(input({ outcome: "not_delivered" }), db as any);

    expect(r.kind).toBe("resolved");
    expect(db.state.row!.dispatch_status).toBe("failed");
  });

  it.each(["scheduled", "processing", "accepted", "cancelled"])(
    "refuses a %s dispatch and explains why",
    async (status) => {
      const db = fakeDb(stuckRow({ dispatch_status: status }));
      const r = await resolveAlShrouqDispatch(input(), db as any);

      expect(r.kind).toBe("conflict");
      if (r.kind !== "conflict") throw new Error("unreachable");
      expect(r.status).toBe(status);
      expect(r.message.length).toBeGreaterThan(10);
      expect(db.state.row!.resolution_outcome).toBeNull();
    },
  );

  it("reports an unknown dispatch id rather than inventing a row", async () => {
    const db = fakeDb(null);
    expect((await resolveAlShrouqDispatch(input(), db as any)).kind).toBe("not_found");
    expect(db.activity).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Concurrency                                                               */
/* ------------------------------------------------------------------------- */

describe("concurrency", () => {
  /** The first operator's account is the one that stands. */
  it("two resolutions produce exactly one record", async () => {
    const db = fakeDb(stuckRow());

    const [a, b] = await Promise.all([
      resolveAlShrouqDispatch(input({ outcome: "delivered", note: "First operator." }), db as any),
      resolveAlShrouqDispatch(
        input({ outcome: "not_delivered", note: "Second operator." }),
        db as any,
      ),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already_resolved", "resolved"]);
    // Exactly one audit event, and the loser overwrote nothing.
    expect(db.activity).toHaveLength(1);
    expect(db.state.row!.resolution_note).toBe(
      a.kind === "resolved" ? "First operator." : "Second operator.",
    );
  });

  it("a second attempt on an already-resolved row is refused", async () => {
    const db = fakeDb(
      stuckRow({
        resolution_outcome: "delivered",
        resolved_at: "2026-08-23T09:00:00.000Z",
        resolved_by: OPERATOR,
      }),
    );

    const r = await resolveAlShrouqDispatch(input({ outcome: "undetermined" }), db as any);

    expect(r.kind).toBe("already_resolved");
    expect(db.state.row!.resolution_outcome).toBe("delivered");
    expect(db.activity).toHaveLength(0);
  });

  /**
   * Cancellation and resolution guard disjoint states — `scheduled` versus
   * `indeterminate`/`failed` — so they cannot both apply to one row. Whichever
   * the row is in, the other is refused.
   */
  it("cannot collide with cancellation", async () => {
    const stuck = fakeDb(stuckRow());
    const cancelAttempt = await cancelScheduledAlShrouqDispatch(ORDER_ID, OPERATOR, stuck as any);
    expect(cancelAttempt.kind).toBe("conflict");
    expect(stuck.state.row!.cancelled_at).toBeNull();

    const parked = fakeDb(stuckRow({ dispatch_status: "scheduled" }));
    const resolveAttempt = await resolveAlShrouqDispatch(input(), parked as any);
    expect(resolveAttempt.kind).toBe("conflict");
    expect(parked.state.row!.resolution_outcome).toBeNull();
  });

  /** The worker claims only `scheduled`, which is never resolvable. */
  it("cannot collide with the scheduler claim", () => {
    for (const status of ALSHROUQ_RESOLVABLE_STATUSES) {
      // A resolvable row is not one the worker will ever select or claim.
      expect(status).not.toBe("scheduled");
      expect(canResolveDispatch(status)).toBe(true);
    }
    expect(canResolveDispatch("scheduled")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Zero courier calls — the point of the suite                               */
/* ------------------------------------------------------------------------- */

describe("resolution never contacts AlShrouq", () => {
  it.each(ALSHROUQ_RESOLUTION_OUTCOMES)("makes no request for %s", async (outcome) => {
    const db = fakeDb(stuckRow());
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const r = await resolveAlShrouqDispatch(input({ outcome }), db as any);
      expect(r.kind).toBe("resolved");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Not one outbound request, for any of the three answers.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * And it could not make one: the transport is not in this module's import
   * graph, so there is no call to add by accident.
   */
  it("imports no transport at all", () => {
    // The import statements, not the prose: the header explains at length that
    // this module does not import the transport, and naming it there is the
    // whole point of the sentence.
    const imports = (source: string) =>
      source
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import "))
        .join("\n");

    for (const source of [resolveService, contract]) {
      expect(imports(source)).not.toContain("createAlshrouqOrder");
      expect(imports(source)).not.toContain("alshrouq-create.server");
      expect(imports(source)).not.toContain("client.server");
    }
    // And no call of any kind.
    expect(resolveService).not.toMatch(/crmFetch\(/);
    expect(resolveService).not.toMatch(/await fetch\(|= fetch\(|\bfetch\(url/);
  });

  it("creates no new dispatch and mutates no order", async () => {
    const db = fakeDb(stuckRow());
    await resolveAlShrouqDispatch(input(), db as any);

    // The only insert is the audit event, on order_activity.
    expect(db.activity).toHaveLength(1);
    expect(resolveService).not.toContain('from("orders")');
    expect(resolveService).not.toContain("scheduleAlShrouqDispatch");
    expect(resolveService).not.toContain("dispatchOrderToAlShrouq");
  });

  it("uses no word that implies a resend", () => {
    for (const source of [resolveService, contract]) {
      expect(source).not.toMatch(/\bretryDispatch\b|\bresendDispatch\b/);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Audit                                                                     */
/* ------------------------------------------------------------------------- */

describe("the audit event", () => {
  it("records the outcome, the operator and the note on the order's history", async () => {
    const db = fakeDb(stuckRow());
    await resolveAlShrouqDispatch(input({ outcome: "not_delivered" }), db as any);

    expect(db.activity).toHaveLength(1);
    const event = db.activity[0] as any;
    expect(event.order_id).toBe(ORDER_ID);
    expect(event.actor_id).toBe(OPERATOR);
    expect(event.action).toBe(RESOLUTION_ACTIVITY_ACTION);
    expect(event.details.outcome).toBe("not_delivered");
    expect(event.details.note).toBe("Confirmed by phone with AlShrouq operations.");
    // The lifecycle state it was resolved from, for context.
    expect(event.details.dispatch_status).toBe("indeterminate");
  });

  /** Nothing sensitive travels with it. */
  it("carries no payload, courier body or customer identity", async () => {
    const db = fakeDb(stuckRow());
    await resolveAlShrouqDispatch(input(), db as any);

    const serialised = JSON.stringify(db.activity[0]);
    for (const leak of [
      "payload_snapshot",
      "customer_name",
      "customer_phone",
      "customer_address",
      "last_response",
      "Ahmed",
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("writes no event when nothing was resolved", async () => {
    const db = fakeDb(stuckRow({ dispatch_status: "accepted" }));
    await resolveAlShrouqDispatch(input(), db as any);
    expect(db.activity).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Authorization                                                             */
/* ------------------------------------------------------------------------- */

describe("the server function's boundary", () => {
  const body = (() => {
    const start = serverFns.indexOf("export const alshrouqResolveDispatch =");
    const end = serverFns.indexOf("export const ", start + 10);
    return serverFns.slice(start, end === -1 ? undefined : end);
  })();

  it("requires an existing supervisory permission rather than a new key", () => {
    expect(body).toContain('assertPermission(supabase, userId, "admin_access")');
    // No parallel permission system, and no new key to keep in parity.
    expect(body).not.toMatch(/resolve_alshrouq|manage_dispatch/);
  });

  it("authorizes before it reaches the admin client", () => {
    const guard = body.indexOf("assertPermission");
    const admin = body.indexOf("client.server");
    expect(guard).toBeGreaterThan(-1);
    expect(admin).toBeGreaterThan(guard);
  });

  /** Identity and time are derived, never accepted. */
  it("takes no resolver, timestamp or status from the caller", () => {
    expect(body).toContain("resolvedBy: userId");
    expect(body).not.toMatch(/data\.(resolvedBy|resolvedAt|userId|actorId|dispatchStatus|status)/);
    // The validator accepts exactly three fields.
    expect(body).toContain("dispatchId: z.string().uuid()");
    expect(body).toContain('outcome: z.enum(["delivered", "not_delivered", "undetermined"])');
    expect(body).toContain("note: z.string().min(3).max(280)");
  });

  /** A dispatch the caller cannot see is absent, not forbidden. */
  it("checks visibility on the caller's own RLS-bound client", () => {
    expect(body).toContain('.from("alshrouq_dispatches")');
    expect(body).toContain('return { kind: "not_found" }');
    const visibility = body.indexOf('.from("alshrouq_dispatches")');
    expect(visibility).toBeLessThan(body.indexOf("client.server"));
  });
});

/* ------------------------------------------------------------------------- */
/* Migration and UI contract                                                 */
/* ------------------------------------------------------------------------- */

describe("the migration", () => {
  it("is additive and idempotent", () => {
    for (const column of ["resolution_outcome", "resolved_at", "resolved_by", "resolution_note"]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);
  });

  /** The three vocabularies stay separate at the schema level. */
  it("constrains the outcome to operator values, never lifecycle ones", () => {
    expect(migration).toContain("resolution_outcome IN (");
    expect(migration).toContain("'delivered', 'not_delivered', 'undetermined'");
    expect(migration).not.toMatch(/dispatch_status\s*=\s*'(delivered|not_delivered|undetermined)'/);
  });

  it("refuses a half-written audit record", () => {
    expect(migration).toContain("alshrouq_dispatches_resolution_complete");
  });

  /** Nothing outside this table, and nothing the other phases own. */
  it("touches no unrelated schema", () => {
    // The executable SQL, not the header — which explains at length which things
    // this migration deliberately leaves alone, and has to name them to do so.
    const sql = migration
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    for (const forbidden of [
      "public.orders",
      "cron.",
      "vault",
      "alshrouq_dispatch_due",
      "ALSHROUQ_LIVE_DISPATCH_ENABLED",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    // Exactly one table is altered, and it is this one.
    const altered = sql.match(/ALTER TABLE (\S+)/g) ?? [];
    expect(altered.length).toBeGreaterThan(0);
    expect(altered.every((m) => m.includes("alshrouq_dispatches"))).toBe(true);
  });
});

describe("the card's resolve action", () => {
  it("appears only for a stuck, unresolved dispatch", () => {
    expect(card).toContain("{summary.awaitingResolution && current && (");
    expect(card.match(/Resolve dispatch/g) ?? []).toHaveLength(1);
  });

  /** `awaitingResolution` is the contract's own answer, not a local guess. */
  it("derives visibility from the shared contract", () => {
    const timeline = read("../../../features/alshrouq/dispatch-timeline.ts");
    expect(timeline).toContain("canResolveDispatch(status, row.resolution_outcome)");
  });

  it.each(["scheduled", "processing", "accepted", "cancelled"])(
    "is hidden for a %s dispatch",
    (status) => {
      const summary = summariseAlShrouqDispatch({
        dispatch_status: status,
        scheduled_for: null,
        scheduled_at: null,
        last_attempt_at: null,
        dispatched_at: null,
        cancelled_at: status === "cancelled" ? "2026-08-23T09:00:00.000Z" : null,
        external_order_id: null,
        tracking_url: null,
        refreshed_at: null,
        last_error: null,
        status: null,
        resolution_outcome: null,
        resolved_at: null,
        resolution_note: null,
      });
      expect(summary.awaitingResolution).toBe(false);
    },
  );

  it("is hidden once an answer has been recorded", () => {
    const summary = summariseAlShrouqDispatch({
      dispatch_status: "indeterminate",
      scheduled_for: null,
      scheduled_at: null,
      last_attempt_at: null,
      dispatched_at: null,
      cancelled_at: null,
      external_order_id: null,
      tracking_url: null,
      refreshed_at: null,
      last_error: null,
      status: null,
      resolution_outcome: "delivered",
      resolved_at: "2026-08-23T09:00:00.000Z",
      resolution_note: "Confirmed.",
    });
    expect(summary.awaitingResolution).toBe(false);
    expect(summary.resolutionOutcome).toBe("delivered");
  });

  it("requires an outcome and a note before it will submit", () => {
    expect(card).toContain(
      "disabled={resolve.isPending || !outcome || !isValidResolutionNote(note)}",
    );
  });

  it("re-reads the dispatch and the timeline afterwards", () => {
    expect(card).toContain("queryKeys.orders.dispatch(orderId)");
    expect(card).toContain("queryKeys.orders.activity(orderId!)");
  });

  /** The card must never present an operator's answer as a courier update. */
  it("attributes a recorded resolution to the operator", () => {
    expect(card).toContain("Resolved by operator:");
    expect(card).toContain("not a courier update");
  });
});
