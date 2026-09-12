/**
 * Correcting a resolution the evidence contradicts, and the narrowness of the
 * door it comes through.
 *
 * Three dispatches were recorded as `delivered` — "AlShrouq confirmed the
 * delivery exists and was completed" — when AlShrouq had never been asked about
 * any of them, and for 12389 no request had ever left the machine. This suite
 * proves the correction can reach exactly those rows, that it can never reach an
 * ordinary `delivered`, and that it contacts nobody on any path.
 *
 * Assertions are made at the **service boundary**. Where a network call is the
 * thing being ruled out, `globalThis.fetch` is replaced by a spy that fails the
 * test if it is ever reached.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { correctAlShrouqResolutionToHandledManually } from "@/lib/shams-crm/alshrouq-correct.server";
import {
  CORRECTABLE_FROM_OUTCOME,
  CORRECTION_TARGET_OUTCOME,
  RESOLUTION_ACTIVITY_ACTION,
  RESOLUTION_CORRECTION_ACTIVITY_ACTION,
  isValidCorrectionReason,
} from "@/lib/shams-crm/alshrouq-resolution";
import { MANUALLY_HANDLED_DISPATCHES } from "@/lib/shams-crm/alshrouq-reconciliation";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const service = read("../alshrouq-correct.server.ts");
const serverFns = read("../../shams.functions.ts");
const page = read("../../../routes/_app.admin.alshrouq-reconciliation.tsx");

const OPERATOR = "99999999-8888-7777-6666-555555555555";
const ORIGINAL_AUTHOR = "2b794883-b34c-4eea-af7e-4d2bc47104e9";
const REASON = "Handled manually after the outage; AlShrouq was never asked.";

/* -------------------------------------------------------------------------- */
/* A fake Postgres honouring the compare-and-swap                             */
/* -------------------------------------------------------------------------- */

/**
 * One row, and an update that applies only while its `.eq()` guards still match
 * — which is the whole mechanism the concurrency test exercises. Modelling more
 * would be modelling Postgres; modelling less would not test the claim.
 */
function fakeDb(initial: Record<string, unknown> | null) {
  const state = { row: initial ? { ...initial } : null };
  const activity: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const tablesTouched: string[] = [];

  return {
    state,
    activity,
    patches,
    tablesTouched,
    from(table: string) {
      tablesTouched.push(table);
      const eq: Record<string, unknown> = {};
      let pending: Record<string, unknown> | null = null;

      const matches = () => {
        const row = state.row;
        if (!row) return false;
        for (const [k, v] of Object.entries(eq)) if (row[k] !== v) return false;
        return true;
      };

      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          eq[c] = v;
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          pending = patch;
          return chain;
        },
        maybeSingle: async () => {
          if (pending) {
            if (!matches()) return { data: null, error: null };
            patches.push(pending);
            Object.assign(state.row!, pending);
            const applied = pending;
            pending = null;
            return { data: { id: state.row!.id, order_id: state.row!.order_id, ...applied } };
          }
          return { data: matches() ? { ...state.row } : null, error: null };
        },
        insert: async (r: Record<string, unknown>) => {
          if (table === "order_activity") activity.push(r);
          return { error: null };
        },
      };
      return chain;
    },
  };
}

/** A row as production actually holds it, for one of the three. */
function conflictedRow(over: Record<string, unknown> = {}) {
  return {
    id: "d0497719-c2dc-4e21-a4ec-9477dea4dd28",
    order_id: "56371c9d-b103-46c9-95e0-25d7e02c6b08",
    client_order_id: "12389",
    dispatch_status: "indeterminate",
    cancelled_at: null,
    resolution_outcome: "delivered",
    resolution_note: "sada",
    resolved_at: "2026-09-12T01:07:17.552Z",
    resolved_by: ORIGINAL_AUTHOR,
    attempt_count: 0,
    last_attempt_at: "2026-09-10T18:25:00.665Z",
    last_error: "The delivery was being sent when the process stopped.",
    ...over,
  };
}

function input(
  over: Partial<Parameters<typeof correctAlShrouqResolutionToHandledManually>[0]> = {},
) {
  return { dispatchId: conflictedRow().id, reason: REASON, correctedBy: OPERATOR, ...over };
}

/** Runs `fn` with `fetch` replaced by a spy that throws if reached. */
async function withFetchSpy(fn: () => Promise<unknown>) {
  const original = globalThis.fetch;
  const spy = vi.fn(async () => {
    throw new Error("a request was made when none was permitted");
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return spy;
}

/* ========================================================================== */
/* 1. The correction works, for exactly the three                             */
/* ========================================================================== */

describe("correcting an eligible record", () => {
  it("changes delivered to handled_manually and says what it was", async () => {
    const db = fakeDb(conflictedRow());
    const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(r).toMatchObject({ kind: "corrected", previousOutcome: "delivered" });
    expect(db.state.row!.resolution_outcome).toBe("handled_manually");
  });

  /** All three incident records, by their real client_order_id and uuid. */
  it.each(MANUALLY_HANDLED_DISPATCHES)(
    "corrects $clientOrderId",
    async ({ clientOrderId, dispatchId }) => {
      const db = fakeDb(
        conflictedRow({
          id: dispatchId,
          client_order_id: clientOrderId,
          // 12422 and 12428 were transmitted; only 12389 has attempt_count 0.
          attempt_count: clientOrderId === "12389" ? 0 : 1,
        }),
      );
      const r = await correctAlShrouqResolutionToHandledManually(input({ dispatchId }), db as any);

      expect(r.kind).toBe("corrected");
      expect(db.state.row!.resolution_outcome).toBe("handled_manually");
    },
  );

  /**
   * The patch is four columns and no more. Everything the machine observed is
   * absent from it on purpose.
   */
  it("touches the outcome, the reason and the corrector — and nothing else", async () => {
    const db = fakeDb(conflictedRow());
    await correctAlShrouqResolutionToHandledManually(input(), db as any);

    const patch = db.patches[0]!;
    expect(Object.keys(patch).sort()).toEqual(
      ["resolution_note", "resolution_outcome", "resolved_at", "resolved_by"].sort(),
    );

    // The lifecycle, the slot and the attempt record are untouched.
    expect(patch).not.toHaveProperty("dispatch_status");
    expect(patch).not.toHaveProperty("cancelled_at");
    expect(patch).not.toHaveProperty("attempt_count");
    expect(patch).not.toHaveProperty("last_attempt_at");
    expect(db.state.row!.dispatch_status).toBe("indeterminate");
    expect(db.state.row!.cancelled_at).toBeNull();
    expect(db.state.row!.attempt_count).toBe(0);
  });

  /** The order is never read and never written. Only two tables are touched. */
  it("never touches the orders table", async () => {
    const db = fakeDb(conflictedRow());
    await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(db.tablesTouched).not.toContain("orders");
    expect(new Set(db.tablesTouched)).toEqual(new Set(["alshrouq_dispatches", "order_activity"]));
  });
});

/* ========================================================================== */
/* 2. The audit record                                                        */
/* ========================================================================== */

describe("the correction audit record", () => {
  it("carries everything needed to reconstruct the change", async () => {
    const db = fakeDb(conflictedRow());
    await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(db.activity).toHaveLength(1);
    const entry = db.activity[0]!;
    const d = entry.details as Record<string, unknown>;

    // Its own action, never a second `alshrouq_dispatch_resolved`.
    expect(entry.action).toBe(RESOLUTION_CORRECTION_ACTIVITY_ACTION);
    expect(entry.action).not.toBe(RESOLUTION_ACTIVITY_ACTION);

    expect(entry.order_id).toBe("56371c9d-b103-46c9-95e0-25d7e02c6b08");
    // The corrector is the authenticated caller, never the original author.
    expect(entry.actor_id).toBe(OPERATOR);
    expect(entry.actor_id).not.toBe(ORIGINAL_AUTHOR);

    expect(d.previous_outcome).toBe("delivered");
    expect(d.corrected_outcome).toBe("handled_manually");
    expect(d.reason).toBe(REASON);
    expect(d.dispatch_id).toBe("d0497719-c2dc-4e21-a4ec-9477dea4dd28");
    // The original author and timestamp survive inside the correction entry.
    expect(d.previous_resolved_by).toBe(ORIGINAL_AUTHOR);
    expect(d.previous_resolved_at).toBe("2026-09-12T01:07:17.552Z");
    expect(d.previous_note).toBe("sada");
    // Stated in the record, not merely true of the code.
    expect(d.external_confirmation_used).toBe(false);
    expect(d.evidence_conflict).toMatch(/never asked/i);
  });

  it("carries no payload, customer identity or credential", async () => {
    const db = fakeDb(conflictedRow());
    await correctAlShrouqResolutionToHandledManually(input(), db as any);

    const serialized = JSON.stringify(db.activity[0]);
    for (const forbidden of ["payload", "customer", "token", "password", "secret", "phone"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  /** A reason is the evidence for the change, so it is not optional. */
  it("requires a reason", () => {
    expect(isValidCorrectionReason("")).toBe(false);
    expect(isValidCorrectionReason("  ")).toBe(false);
    expect(isValidCorrectionReason("ok")).toBe(false);
    expect(isValidCorrectionReason(REASON)).toBe(true);

    // And the server function's validator enforces it too, not just the screen.
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqCorrectResolution"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    expect(handler).toContain("reason: z.string().min(3).max(280)");
  });
});

/* ========================================================================== */
/* 3. Everything it must refuse                                               */
/* ========================================================================== */

describe("what the correction refuses", () => {
  /** The one that matters: an ordinary delivered is unreachable. */
  it("refuses a delivered record whose evidence does not contradict it", async () => {
    const db = fakeDb(
      conflictedRow({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        client_order_id: "12419",
        attempt_count: 1,
      }),
    );
    const r = await correctAlShrouqResolutionToHandledManually(
      input({ dispatchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      db as any,
    );

    expect(r.kind).toBe("ineligible");
    expect(db.state.row!.resolution_outcome).toBe("delivered");
    expect(db.patches).toHaveLength(0);
    expect(db.activity).toHaveLength(0);
  });

  it("refuses a record that is already handled_manually", async () => {
    const db = fakeDb(conflictedRow({ resolution_outcome: "handled_manually" }));
    const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(r.kind).toBe("ineligible");
    expect((r as { message: string }).message).toMatch(/already recorded as handled manually/i);
    expect(db.patches).toHaveLength(0);
  });

  it.each(["not_delivered", "undetermined"])("refuses a record recorded as %s", async (outcome) => {
    const db = fakeDb(conflictedRow({ resolution_outcome: outcome }));
    const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(r.kind).toBe("ineligible");
    expect(db.state.row!.resolution_outcome).toBe(outcome);
  });

  it("refuses an unresolved record", async () => {
    const db = fakeDb(conflictedRow({ resolution_outcome: null, resolved_by: null }));
    const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(r.kind).toBe("ineligible");
    expect((r as { message: string }).message).toMatch(/nothing to correct/i);
  });

  it("refuses a dispatch that does not exist", async () => {
    const db = fakeDb(null);
    const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);

    expect(r.kind).toBe("not_found");
    expect(db.patches).toHaveLength(0);
    expect(db.activity).toHaveLength(0);
  });

  /**
   * Two operators at once produce one correction and one honest refusal. The
   * guard is `.eq(resolution_outcome, 'delivered')`, which Postgres serialises.
   */
  it("cannot correct the same record twice concurrently", async () => {
    const db = fakeDb(conflictedRow());

    const [a, b] = await Promise.all([
      correctAlShrouqResolutionToHandledManually(input({ reason: "First operator." }), db as any),
      correctAlShrouqResolutionToHandledManually(input({ reason: "Second operator." }), db as any),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["corrected", "ineligible"]);
    // Exactly one write, and exactly one audit entry.
    expect(db.patches).toHaveLength(1);
    expect(db.activity).toHaveLength(1);
    expect(db.state.row!.resolution_outcome).toBe("handled_manually");
  });

  /** Admin-only, asserted at the boundary rather than in the screen. */
  it("is gated on admin_access before anything is read", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqCorrectResolution"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    const gate = handler.indexOf('assertPermission(supabase, userId, "admin_access")');
    const write = handler.indexOf("correctAlShrouqResolutionToHandledManually");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(write);

    // The corrector is the verified session subject, never a caller-supplied id.
    expect(handler).toContain("correctedBy: userId");
    expect(handler).not.toMatch(/data\.(correctedBy|userId|actorId|resolvedBy)/);
  });

  /**
   * The transition is a property of the operation, not a parameter. A caller who
   * could name the target could rewrite any resolution to anything.
   */
  it("takes no outcome from the caller", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqCorrectResolution"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    expect(handler).not.toMatch(/outcome:\s*z\./);
    expect(handler).not.toMatch(/data\.outcome/);
    expect(CORRECTABLE_FROM_OUTCOME).toBe("delivered");
    expect(CORRECTION_TARGET_OUTCOME).toBe("handled_manually");
  });
});

/* ========================================================================== */
/* 4. Zero external requests, on every path                                   */
/* ========================================================================== */

describe("the correction never contacts AlShrouq", () => {
  it("makes no request when it succeeds", async () => {
    const db = fakeDb(conflictedRow());
    const spy = await withFetchSpy(async () => {
      const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);
      expect(r.kind).toBe("corrected");
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes no request when it refuses", async () => {
    const db = fakeDb(conflictedRow({ resolution_outcome: "undetermined" }));
    const spy = await withFetchSpy(async () => {
      const r = await correctAlShrouqResolutionToHandledManually(input(), db as any);
      expect(r.kind).toBe("ineligible");
    });
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * And it could not make one: the transport is not in this module's import
   * graph, so there is no call to add by accident.
   */
  it("imports no transport at all", () => {
    const imports = service
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "))
      .join("\n");

    expect(imports).not.toContain("alshrouq-create.server");
    expect(imports).not.toContain("client.server");
    expect(imports).not.toContain("alshrouq-dispatch.server");
    expect(imports).not.toContain("alshrouq-status.server");

    /*
     * The code, not the prose.
     *
     * The header explains at length that this module does not import the
     * transport, and naming the functions there is the whole point of the
     * sentence — the same reading `alshrouq-resolution.test.ts` takes of its own
     * service. What must not exist is a *call*.
     */
    const code = service
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    expect(code).not.toContain("findAlshrouqOrderByClientOrderId");
    expect(code).not.toContain("createAlshrouqOrder");
    expect(code).not.toContain("refreshAlShrouqOrderStatus");
    expect(code).not.toMatch(/crmFetch\(|\bfetch\(/);
  });

  /** The server function reaches only the transport-free correction module. */
  it("is wired to nothing that could dispatch", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqCorrectResolution"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    expect(handler).toContain("alshrouq-correct.server");
    expect(handler).not.toContain("createAlshrouqOrder");
    expect(handler).not.toContain("findAlshrouqOrderByClientOrderId");
    expect(handler).not.toContain("alshrouqLookupDispatch");
    expect(handler).not.toContain("dispatchOrderToAlShrouq");
  });
});

/* ========================================================================== */
/* 5. The screen                                                              */
/* ========================================================================== */

describe("the correction control", () => {
  /** Individually confirmed. A bulk control would hide what was reviewed. */
  it("is offered per row and never in bulk", () => {
    expect(page).toContain("row.correctionAvailable");
    expect(page).not.toMatch(/correctAll|bulkCorrect|selectedRows|Correct all/i);
  });

  /** The four statements the operator must see before pressing it. */
  it("states exactly what the correction does and does not do", () => {
    expect(page).toMatch(/No request will be sent to AlShrouq/i);
    expect(page).toMatch(/does not change the order status/i);
    expect(page).toMatch(/does not create or cancel a courier dispatch/i);
    expect(page).toMatch(/permanently audited/i);
    expect(page).toMatch(/from <strong>Delivered<\/strong> to\{" "\}\s*<strong>Handled manually/);
  });

  it("cannot be submitted without a reason", () => {
    expect(page).toContain("!isValidCorrectionReason(reason)");
  });

  /**
   * Eligibility is computed from the same conflict the server enforces, so the
   * button cannot appear where the correction would be refused.
   */
  it("derives eligibility from the evidence conflict, not from a list", () => {
    expect(serverFns).toContain(
      'correctionAvailable: conflict !== null && r.resolution_outcome === "delivered"',
    );
  });
});
