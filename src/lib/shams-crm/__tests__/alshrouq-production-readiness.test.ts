/**
 * Production readiness: the properties that have to hold before the courier gate
 * is ever opened.
 *
 * Race safety and the safety gate are exercised at runtime against a fake
 * Postgres that actually honours compare-and-swap, because "two workers cannot
 * both send" is a claim about concurrency and nothing else would demonstrate it.
 * The scheduler chain — cron registration, the SQL waker, endpoint
 * authentication — is asserted against the migration and route *source*, because
 * those links are SQL and HTTP handlers that this suite cannot execute, and an
 * unasserted migration is exactly how a scheduler stops existing without anyone
 * noticing.
 *
 * Nothing here contacts AlShrouq. The transport is a mock in every test and the
 * gate is a parameter to the fake, never the real environment variable.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  cancelScheduledAlShrouqDispatch,
  runDueAlShrouqDispatches,
} from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { DispatchDeps } from "@/lib/shams-crm/alshrouq-dispatch.server";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const schedulerMigration = read(
  "../../../../supabase/migrations/20260821210000_alshrouq_scheduled_dispatch.sql",
);
const attributionMigration = read(
  "../../../../supabase/migrations/20260822120000_alshrouq_cancellation_attribution.sql",
);
const route = read("../../../routes/api/alshrouq-run-scheduled.ts");
const serverFns = read("../../shams.functions.ts");
const scheduler = read("../alshrouq-scheduler.server.ts");
const dispatchService = read("../alshrouq-dispatch.server.ts");

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "99999999-8888-7777-6666-555555555555";

/* ------------------------------------------------------------------------- */
/* A fake Postgres that honours compare-and-swap                             */
/* ------------------------------------------------------------------------- */

/**
 * One row, and updates that apply only when their `.eq()` guards still match.
 *
 * That is the whole mechanism under test: Postgres serialises two updates to a
 * row, so the second one's `dispatch_status='scheduled'` predicate no longer
 * matches. Modelling anything more would be modelling Postgres; modelling
 * anything less would not test the claim.
 */
function fakeDb(initial: Record<string, unknown>) {
  const state = { row: { ...initial } as Record<string, unknown> | null };
  const updates: Record<string, unknown>[] = [];

  return {
    state,
    updates,
    from() {
      const eq: Record<string, unknown> = {};
      const isNull: string[] = [];
      let pending: Record<string, unknown> | null = null;
      let limited = false;

      const matches = () => {
        const row = state.row;
        if (!row) return false;
        for (const [k, v] of Object.entries(eq)) if (row[k] !== v) return false;
        for (const c of isNull) if (row[c] != null) return false;
        return true;
      };

      const chain: any = {
        select: () => chain,
        order: () => chain,
        lte: () => chain,
        limit: () => {
          limited = true;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          eq[c] = v;
          return chain;
        },
        is: (c: string, v: unknown) => {
          if (v === null) isNull.push(c);
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          pending = patch;
          return chain;
        },
        maybeSingle: async () => {
          if (pending) {
            if (!matches()) return { data: null, error: null };
            Object.assign(state.row!, pending);
            updates.push(pending);
            const applied = pending;
            pending = null;
            return { data: { id: state.row!.id, ...applied }, error: null };
          }
          return { data: matches() ? state.row : null, error: null };
        },
        // The due-rows read: an array, filtered by the same predicates.
        then: (resolve: any) => {
          if (pending) {
            const ok = matches();
            if (ok) {
              Object.assign(state.row!, pending);
              updates.push(pending);
            }
            pending = null;
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          const rows = matches() ? [state.row] : [];
          return Promise.resolve({ data: limited ? rows.slice(0, 25) : rows, error: null }).then(
            resolve,
          );
        },
      };
      return chain;
    },
  };
}

function scheduledRow() {
  return {
    id: "row-1",
    order_id: ORDER_ID,
    client_order_id: "9540",
    dispatch_status: "scheduled",
    cancelled_at: null,
    scheduled_for: "2026-08-21T12:30:00.000Z",
    scheduled_by: "99999999-8888-7777-6666-555555555555",
    payload_snapshot: {
      branch_id: "9999927657247",
      client_order_id: "9540",
      customer_name: "Ahmed",
      customer_phone: "0500000000",
      payment_type: 3,
      order_value: 0,
    },
  };
}

function deps(live: boolean, createOrder: any): Partial<DispatchDeps> {
  return {
    createOrder,
    reconcile: async () =>
      ({
        id: 5263,
        externalOrderId: 6099196,
        clientOrderId: "9540",
        statusLabel: "Order Created",
        trackingUrl: null,
        isCancelled: false,
      }) as any,
    newOperationId: () => "op-1",
    liveEnabled: () => live,
    // The worker sends under the approving agent's CRM identity. Stubbed so
    // these tests exercise claiming, racing and retry rather than the
    // credential lookup, which has its own suite.
    agentPrincipal: async (userId: string) => ({
      ok: true as const,
      principal: {
        kind: "agent" as const,
        agentId: userId,
        username: "agent@example.test",
        password: "test-only",
      },
      crmUsername: "agent@example.test",
      crmUserId: "99001",
    }),
    fetchOptions: async () => ({ branchOptions: [], paymentOptions: [] }),
  };
}

/* ------------------------------------------------------------------------- */
/* Part 3 — idempotency and race safety                                      */
/* ------------------------------------------------------------------------- */

describe("two workers, one scheduled order", () => {
  /**
   * The claim is a compare-and-swap, so the second worker's update matches
   * nothing and it never reaches the transport. Exactly one POST, whichever
   * worker wins.
   */
  it("dispatches exactly once when two runs race the same row", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const db = fakeDb(scheduledRow());

    const [a, b] = await Promise.all([
      runDueAlShrouqDispatches(db as any, deps(true, createOrder)),
      runDueAlShrouqDispatches(db as any, deps(true, createOrder)),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(a.accepted + b.accepted).toBe(1);
    // The one thing that must never happen twice.
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(db.state.row!.dispatch_status).toBe("accepted");
  });

  /** A run that loses the claim leaves the row completely alone. */
  it("the losing worker writes nothing", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const db = fakeDb({ ...scheduledRow(), dispatch_status: "processing" });

    const summary = await runDueAlShrouqDispatches(db as any, deps(true, createOrder));

    // Not even selected as due: the query asks for `scheduled`.
    expect(summary.due).toBe(0);
    expect(summary.claimed).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(0);
    expect(db.updates).toHaveLength(0);
  });
});

describe("cancellation racing the worker", () => {
  /** Both want the same transition out of `scheduled`. Exactly one wins. */
  it("cancel and claim cannot both succeed", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const db = fakeDb(scheduledRow());

    const [cancelled, run] = await Promise.all([
      cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, db as any),
      runDueAlShrouqDispatches(db as any, deps(true, createOrder)),
    ]);

    const cancelWon = cancelled.kind === "cancelled";
    if (cancelWon) {
      // Nothing was sent, and the row is off the worker's list for good.
      expect(createOrder).toHaveBeenCalledTimes(0);
      expect(run.claimed).toBe(0);
      expect(db.state.row!.dispatch_status).toBe("cancelled");
      expect(db.state.row!.cancelled_at).toBeTruthy();
    } else {
      // The worker won; the cancellation says so rather than pretending.
      expect(cancelled.kind).toBe("conflict");
      expect(db.state.row!.cancelled_at).toBeNull();
    }
  });

  /** A cancelled row can never be picked up afterwards. */
  it("a cancelled row is never claimed by a later run", async () => {
    const createOrder = vi.fn();
    const db = fakeDb(scheduledRow());

    expect((await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, db as any)).kind).toBe(
      "cancelled",
    );
    const summary = await runDueAlShrouqDispatches(db as any, deps(true, createOrder as any));

    expect(summary.due).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Part 8 — the safety gate, at the worker                                   */
/* ------------------------------------------------------------------------- */

describe("the safety gate stops the worker before it claims anything", () => {
  it("claims nothing, sends nothing and invents no status", async () => {
    const createOrder = vi.fn();
    const db = fakeDb(scheduledRow());

    const summary = await runDueAlShrouqDispatches(db as any, deps(false, createOrder as any));

    expect(summary.due).toBe(1);
    expect(summary.skippedDisabled).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(summary.accepted).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(0);
    // The row is untouched and will be picked up whenever the gate opens.
    expect(db.state.row!.dispatch_status).toBe("scheduled");
    expect(db.updates).toHaveLength(0);
  });

  it("reads the gate from the environment, never from a request", () => {
    expect(dispatchService).toContain('process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED === "true"');
    expect(route).not.toContain("ALSHROUQ_LIVE_DISPATCH_ENABLED =");
    // No caller-supplied override anywhere in the chain.
    expect(dispatchService).not.toMatch(/\blive\s*\??\s*:\s*boolean/);
  });
});

/* ------------------------------------------------------------------------- */
/* Part 2 — the scheduler chain, link by link                                */
/* ------------------------------------------------------------------------- */

describe("the scheduler is registered by migration", () => {
  it("schedules the job every minute, idempotently", () => {
    expect(schedulerMigration).toContain("cron.unschedule('alshrouq-dispatch-due')");
    expect(schedulerMigration).toContain("cron.schedule(");
    expect(schedulerMigration).toContain("'alshrouq-dispatch-due'");
    expect(schedulerMigration).toContain("'* * * * *'");
    // Guarded, so applying it where pg_cron is absent is a no-op rather than an
    // error that fails the whole push.
    expect(schedulerMigration).toContain("WHERE extname = 'pg_cron'");
  });

  it("keeps the endpoint and the secret out of cron.job", () => {
    // `cron.job` is readable by anyone who can read the catalog, so the command
    // is a bare function call and the function reads vault itself.
    expect(schedulerMigration).toContain("SELECT public.alshrouq_dispatch_due();");
    expect(schedulerMigration).toContain("vault.decrypted_secrets");
    expect(schedulerMigration).toContain("alshrouq_scheduler_url");
    expect(schedulerMigration).toContain("alshrouq_scheduler_secret");
  });

  /** Unconfigured means inert, not broken. */
  it("is a no-op when the vault secrets are absent", () => {
    expect(schedulerMigration).toContain("IF endpoint IS NULL OR secret IS NULL THEN");
    // And it does not call out at all when there is no due work.
    expect(schedulerMigration).toContain("IF due_count = 0 THEN");
  });

  it("is not callable by an ordinary session", () => {
    expect(schedulerMigration).toContain(
      "REVOKE ALL ON FUNCTION public.alshrouq_dispatch_due() FROM PUBLIC, anon, authenticated",
    );
  });
});

describe("the scheduler endpoint", () => {
  it("authenticates with a constant-time comparison", () => {
    expect(route).toContain("x-alshrouq-scheduler-secret");
    // `!==` on a secret leaks its prefix through timing.
    expect(route).toContain("diff |=");
    expect(route).not.toMatch(/provided\s*!==\s*expected/);
  });

  /** An unset secret must not mean "anyone may run the worker". */
  it("fails closed when the secret is unset", () => {
    expect(route).toContain("if (!expected || !provided) return false;");
  });

  it("never dispatches from a health check", () => {
    const get = route.slice(route.indexOf("GET:"), route.indexOf("POST:"));
    expect(get).not.toContain("runDueAlShrouqDispatches");
  });

  /**
   * The dry-run instrument.
   *
   * `GET` is how the whole chain is checked without any chance of a courier
   * request: it reports whether the worker is configured, how much work is
   * waiting, and — the field that matters most before go-live — whether the
   * safety gate is open. Phase 10K leans on all three, so the shape is pinned
   * here rather than left to be discovered when it is next needed.
   */
  it("reports configuration, due count and the gate — and only those", () => {
    const get = route.slice(route.indexOf("GET:"), route.indexOf("POST:"));
    expect(get).toContain("configured:");
    expect(get).toContain("due:");
    expect(get).toContain("liveDispatchEnabled: isAlShrouqLiveDispatchEnabled()");
    // An unconfigured deployment answers rather than erroring, so a health check
    // can distinguish "not set up" from "unreachable".
    expect(get).toContain("{ configured: false, due: null }");
    // Nothing sensitive in the response body itself — the header name is read
    // from the request a few lines above, which is not a leak.
    const body = get.slice(get.indexOf("return json({\n          configured: true"));
    for (const leak of ["customer", "payload_snapshot", "secret", "client_order_id"]) {
      expect(body).not.toContain(leak);
    }
  });

  /**
   * Both methods are behind the same secret, so a health check cannot be used to
   * enumerate scheduled work either.
   */
  it("authenticates the health check as strictly as the run", () => {
    const get = route.slice(route.indexOf("GET:"), route.indexOf("POST:"));
    expect(get).toContain("x-alshrouq-scheduler-secret");
    expect(get).toContain('json({ error: "unauthorized" }, 401)');
  });
});

/* ------------------------------------------------------------------------- */
/* Part 7 — observability                                                    */
/* ------------------------------------------------------------------------- */

describe("the scheduler cannot fail silently", () => {
  it.each([
    ["a rejected caller", "scheduler request rejected"],
    ["a missing configuration", "scheduler not configured"],
    ["a run", "scheduled run"],
  ])("logs %s", (_label, phrase) => {
    expect(route).toContain(phrase);
  });

  /** "0 accepted" reads the same whether the gate was shut or nothing was due. */
  it("states the gate alongside the run summary", () => {
    expect(route).toContain("liveDispatchEnabled: isAlShrouqLiveDispatchEnabled()");
  });

  /**
   * The summary is six integers, so logging it cannot leak a customer. This is
   * the assertion that keeps it that way.
   */
  it("logs counts and never a customer, a payload or a credential", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "accepted" as const,
      operationId: "op-1",
      status: 201,
      body: null,
    }));
    const db = fakeDb(scheduledRow());

    const summary = await runDueAlShrouqDispatches(db as any, deps(true, createOrder));

    expect(Object.keys(summary).sort()).toEqual(
      // `blocked` counts due rows returned to `scheduled` because the approving
      // agent's CRM identity was unusable. An integer like the rest — the point
      // of this assertion is that the summary carries counts and nothing else.
      [
        "accepted",
        "blocked",
        "claimed",
        "due",
        "failed",
        "indeterminate",
        "skippedDisabled",
      ].sort(),
    );
    for (const value of Object.values(summary)) expect(typeof value).toBe("number");

    const serialised = JSON.stringify(summary);
    for (const leak of ["Ahmed", "0500000000", "payload", "snapshot", "secret", "Bearer"]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it("logs an error's name rather than its message or stack", () => {
    expect(route).toContain('(err as Error)?.name ?? "unknown"');
    expect(route).not.toMatch(/console\.error\([^)]*err\s*\)/);
  });
});

/* ------------------------------------------------------------------------- */
/* Part 1 — the write path and its permission boundary                       */
/* ------------------------------------------------------------------------- */

describe("the dispatch write path", () => {
  /**
   * Writes run as the service role, because the table's only RLS policy is
   * SELECT and a command with no permissive policy is denied. Verified against
   * the live database in Phase 10H — see docs.
   */
  it("uses the admin client for dispatch and cancellation writes", () => {
    expect(serverFns).toContain('await import("@/integrations/supabase/client.server")');
    expect(serverFns).toContain("dispatchOrderToAlShrouq(request, supabaseAdmin)");
    expect(serverFns).toContain("scheduleAlShrouqDispatch(request, scheduledFor, supabaseAdmin)");
    expect(serverFns).toContain(
      "cancelScheduledAlShrouqDispatch(data.orderId, userId, supabaseAdmin)",
    );
  });

  /**
   * And only ever *after* the handler has decided the caller may. The admin
   * client bypasses RLS, so the permission check is the whole boundary.
   */
  it("checks permission before it reaches the admin client", () => {
    for (const fn of ["alshrouqDispatchOrder", "alshrouqCancelScheduledDispatch"]) {
      const start = serverFns.indexOf(`export const ${fn} =`);
      const end = serverFns.indexOf("export const ", start + 10);
      const body = serverFns.slice(start, end === -1 ? undefined : end);

      const guard = body.indexOf("Forbidden: insufficient permissions");
      const admin = body.indexOf("client.server");
      expect(guard).toBeGreaterThan(-1);
      expect(admin).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(admin);
      // The same rule the order form uses to allow editing. No new key.
      expect(body).toContain("edit_all_orders");
      expect(body).toContain("edit_orders");
    }
  });

  /** The caller's own client still does the reads, where RLS should decide. */
  it("keeps the order read and the permission RPCs on the caller's client", () => {
    const start = serverFns.indexOf("export const alshrouqDispatchOrder =");
    const body = serverFns.slice(start, serverFns.indexOf("export const ", start + 10));
    expect(body).toContain('supabase\n      .from("orders")');
    expect(body).toContain('supabase.rpc("has_permission"');
  });
});

/* ------------------------------------------------------------------------- */
/* Part 5 — cancellation attribution                                         */
/* ------------------------------------------------------------------------- */

describe("cancellation attribution", () => {
  it("adds the column additively and idempotently", () => {
    expect(attributionMigration).toContain(
      "ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id)",
    );
    expect(attributionMigration).toContain("CREATE INDEX IF NOT EXISTS");
    // Nothing destructive, and nothing outside this table.
    expect(attributionMigration).not.toMatch(/DROP (TABLE|COLUMN)|DELETE FROM|TRUNCATE/i);
    expect(attributionMigration).not.toContain("public.orders");
  });

  it("records the actor on a successful cancellation", async () => {
    const db = fakeDb(scheduledRow());
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, db as any);

    expect(r.kind).toBe("cancelled");
    expect(db.state.row!.cancelled_by).toBe(USER_ID);
  });

  /**
   * The actor is the verified session's subject. The server function's validator
   * accepts an order id and nothing else, so there is no field through which a
   * browser could attribute a cancellation to somebody else.
   */
  it("takes no actor from the request", () => {
    const start = serverFns.indexOf("export const alshrouqCancelScheduledDispatch =");
    const body = serverFns.slice(start, serverFns.indexOf("export const ", start + 10));
    expect(body).toContain("z.object({ orderId: z.string().uuid() }).parse(d)");
    expect(body).not.toMatch(/data\.(userId|actorId|cancelledBy)/);
  });

  /** A refused cancellation attributes nothing. */
  it("records no actor when it refuses", async () => {
    const db = fakeDb({ ...scheduledRow(), dispatch_status: "accepted" });
    const r = await cancelScheduledAlShrouqDispatch(ORDER_ID, USER_ID, db as any);

    expect(r.kind).toBe("conflict");
    expect(db.state.row!.cancelled_by).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* Parts 4 & 6 — what this phase deliberately did NOT do                     */
/* ------------------------------------------------------------------------- */

describe("no automatic retry, anywhere", () => {
  it("never re-POSTs an indeterminate dispatch", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "indeterminate" as const,
      operationId: "op-1",
      errorKind: "timeout",
      message: "unknown",
    }));
    const db = fakeDb(scheduledRow());

    const summary = await runDueAlShrouqDispatches(db as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });

    expect(summary.indeterminate).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(db.state.row!.dispatch_status).toBe("indeterminate");

    // A second run must not pick it back up. It is terminal.
    const again = await runDueAlShrouqDispatches(db as any, {
      ...deps(true, createOrder),
      reconcile: async () => null,
    });
    expect(again.due).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("never re-POSTs a failed dispatch", async () => {
    const createOrder = vi.fn(async () => ({
      kind: "rejected" as const,
      operationId: "op-1",
      status: 422,
      body: null,
    }));
    const db = fakeDb(scheduledRow());

    await runDueAlShrouqDispatches(db as any, deps(true, createOrder));
    expect(db.state.row!.dispatch_status).toBe("failed");

    const again = await runDueAlShrouqDispatches(db as any, deps(true, createOrder));
    expect(again.due).toBe(0);
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  /** No timer, no backoff, no re-queue anywhere in the worker. */
  it("has no retry mechanism in the scheduler at all", () => {
    expect(scheduler).not.toMatch(/setTimeout|setInterval|retryCount|backoff|requeue/i);
    expect(scheduler).toContain("attempt_count: 1");
  });
});

describe("the email queue is left alone", () => {
  /**
   * Phase 10C recorded that `process-email-queue` had been lost in the revert.
   * Verified against the live database on 2026-08-22, that was wrong:
   * `email_queue_dispatch()` unschedules itself when both pgmq queues drain, and
   * an AFTER INSERT trigger (`email_queue_wake`) re-arms it on the next enqueue.
   * An empty `cron.job` beside empty queues is that design's idle state.
   *
   * So no migration registers it. Adding one would fight the self-disarm and
   * "restore" something that was never broken.
   */
  it("registers no email cron job in any AlShrouq migration", () => {
    // The *executable* SQL, not the prose: the migration explains this finding
    // at length in its header, and naming the job there is the point.
    for (const migration of [schedulerMigration, attributionMigration]) {
      const sql = migration
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(sql).not.toContain("process-email-queue");
      expect(sql).not.toContain("email_queue_dispatch");
      expect(sql).not.toContain("email_queue_wake");
    }
  });

  it("records why, so the claim is not re-derived from the old note", () => {
    expect(schedulerMigration).toContain("unschedules itself");
    expect(schedulerMigration).toContain("email_queue_wake");
  });
});
