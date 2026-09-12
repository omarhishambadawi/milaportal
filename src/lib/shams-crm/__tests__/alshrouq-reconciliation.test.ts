/**
 * The reconciliation centre, and the refusal it is built around.
 *
 * Three deliveries from the 2026-09-10 outage — 12389, 12422 and 12428 — were
 * dealt with by hand, and the standing instruction is that **nothing at all** is
 * to be sent to AlShrouq about them. This suite is what makes that a property of
 * the code rather than of a screen.
 *
 * So the assertions here are mostly negative, and they are deliberately made at
 * the **service boundary** rather than against a rendered component: a test that
 * only proves a button is hidden proves nothing about the function the button
 * would have called. Where a network call is the thing being ruled out,
 * `globalThis.fetch` is replaced by a spy that fails the test if it is ever
 * reached.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_CONTACT_BLOCKED_MESSAGE,
  MANUALLY_HANDLED_BADGE,
  MANUALLY_HANDLED_DISPATCHES,
  OFFLINE_RESOLUTION_OUTCOMES,
  canLookUpExternally,
  describeEvidenceConflict,
  isExternalContactBlocked,
  isManuallyHandledDispatch,
} from "@/lib/shams-crm/alshrouq-reconciliation";
import { ALSHROUQ_RESOLUTION_OUTCOMES } from "@/lib/shams-crm/alshrouq-resolution";
import { resolveAlShrouqDispatch } from "@/lib/shams-crm/alshrouq-resolve.server";
import { runDueAlShrouqDispatches } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { isWorkerClaimable, blocksNewDispatch } from "@/lib/shams-crm/alshrouq-dispatch-state";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const guard = read("../alshrouq-reconciliation.ts");
const serverFns = read("../../shams.functions.ts");
const page = read("../../../routes/_app.admin.alshrouq-reconciliation.tsx");
const migration = read(
  "../../../../supabase/migrations/20260918120000_alshrouq_handled_manually.sql",
);

/** The three, exactly as the business established them. */
const BLOCKED = ["12389", "12422", "12428"] as const;

/* ========================================================================== */
/* 1. The guard itself                                                        */
/* ========================================================================== */

describe("the manually-handled refusal", () => {
  it("names exactly the three deliveries that were handled by hand", () => {
    expect(MANUALLY_HANDLED_DISPATCHES.map((d) => d.clientOrderId).sort()).toEqual(
      [...BLOCKED].sort(),
    );
  });

  it.each(BLOCKED)("blocks external contact for %s by client order id", (clientOrderId) => {
    expect(isManuallyHandledDispatch({ clientOrderId })).toBe(true);
    expect(isExternalContactBlocked({ clientOrderId })).toBe(true);
    expect(canLookUpExternally({ clientOrderId, dispatchStatus: "indeterminate" })).toBe(false);
  });

  it.each(MANUALLY_HANDLED_DISPATCHES.map((d) => d.dispatchId))(
    "blocks external contact for dispatch %s by uuid alone",
    (dispatchId) => {
      // By uuid with no other context, which is what the server function has
      // before it reads anything.
      expect(isExternalContactBlocked({ dispatchId })).toBe(true);
      expect(isExternalContactBlocked({ dispatchId: dispatchId.toUpperCase() })).toBe(true);
    },
  );

  it("ignores surrounding whitespace rather than letting it through", () => {
    expect(isExternalContactBlocked({ clientOrderId: "  12389  " })).toBe(true);
  });

  /** The rule generalises once recorded, so the list is not the only defence. */
  it("blocks anything already resolved as handled manually", () => {
    expect(
      isExternalContactBlocked({ clientOrderId: "99999", resolutionOutcome: "handled_manually" }),
    ).toBe(true);
  });

  it("leaves an ordinary indeterminate dispatch alone", () => {
    expect(isExternalContactBlocked({ clientOrderId: "12419", dispatchId: "abc" })).toBe(false);
    expect(canLookUpExternally({ clientOrderId: "12419", dispatchStatus: "indeterminate" })).toBe(
      true,
    );
  });

  /** A lookup is only meaningful for a row the machine gave up on. */
  it("offers no lookup for a row that is still in play or has no reference", () => {
    expect(canLookUpExternally({ clientOrderId: "12419", dispatchStatus: "scheduled" })).toBe(
      false,
    );
    expect(canLookUpExternally({ clientOrderId: "12419", dispatchStatus: "accepted" })).toBe(false);
    expect(canLookUpExternally({ clientOrderId: "", dispatchStatus: "indeterminate" })).toBe(false);
    expect(canLookUpExternally({ clientOrderId: null, dispatchStatus: "indeterminate" })).toBe(
      false,
    );
  });

  /**
   * The default is refusal.
   *
   * Wrongly refusing costs an operator a telephone call. Wrongly permitting
   * costs a customer a second driver.
   */
  it("refuses rather than guesses when a row says nothing useful", () => {
    expect(canLookUpExternally({})).toBe(false);
    expect(canLookUpExternally({ dispatchStatus: "indeterminate" })).toBe(false);
  });

  /**
   * The guard cannot become the thing it guards against.
   *
   * It has no transport in its import graph, so there is no call for a future
   * edit to add by accident.
   */
  it("imports nothing that could make a request", () => {
    const imports = guard
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "))
      .join("\n");
    expect(imports).not.toContain("client.server");
    expect(imports).not.toContain("alshrouq-create.server");
    expect(imports).not.toContain("supabase");
    expect(guard).not.toMatch(/fetch\(|crmFetch\(/);
  });
});

/* ========================================================================== */
/* 2. The wording — an audit trail that cannot be misread                     */
/* ========================================================================== */

describe("what a manually-handled dispatch is called", () => {
  it("says no automated dispatch was required, not that one succeeded", () => {
    expect(MANUALLY_HANDLED_BADGE).toBe("Handled manually — no automated dispatch required");
    expect(MANUALLY_HANDLED_BADGE).not.toMatch(/delivered|success|complete|dispatched/i);
  });

  it("tells an operator nothing was sent, and names no credential", () => {
    expect(EXTERNAL_CONTACT_BLOCKED_MESSAGE).toMatch(/handled manually/i);
    expect(EXTERNAL_CONTACT_BLOCKED_MESSAGE).toMatch(/Nothing is sent to AlShrouq/i);
    expect(EXTERNAL_CONTACT_BLOCKED_MESSAGE).not.toMatch(
      /token|password|secret|bearer|session|api[_-]?key/i,
    );
  });

  /** The only outcome recordable without having contacted the courier. */
  it("offers exactly one offline outcome, and it is a real outcome", () => {
    expect([...OFFLINE_RESOLUTION_OUTCOMES]).toEqual(["handled_manually"]);
    for (const outcome of OFFLINE_RESOLUTION_OUTCOMES) {
      expect(ALSHROUQ_RESOLUTION_OUTCOMES).toContain(outcome);
    }
  });

  it("is admitted by the database's CHECK, alongside the original three", () => {
    expect(migration).toContain("handled_manually");
    for (const kept of ["delivered", "not_delivered", "undetermined"]) {
      expect(migration).toContain(kept);
    }
    // And the migration reads its own constraint back rather than assuming it.
    expect(migration).toMatch(/RAISE EXCEPTION[\s\S]{0,200}handled_manually/);
  });
});

/* ========================================================================== */
/* 2b. A recorded outcome that contradicts the row's own evidence             */
/* ========================================================================== */

/**
 * On 2026-09-12 at 01:06–01:07 all three manually-handled deliveries were
 * resolved as `delivered` — including 12389, where `attempt_count` is 0 and no
 * request ever left the machine. `resolveAlShrouqDispatch` will not overwrite an
 * operator's account, so the contradiction cannot be papered over. It can be
 * shown, and this is what shows it.
 */
describe("evidence conflicts in a recorded outcome", () => {
  it.each(BLOCKED)("flags %s recorded as delivered when AlShrouq was never asked", (id) => {
    const conflict = describeEvidenceConflict({
      clientOrderId: id,
      resolutionOutcome: "delivered",
      dispatchStatus: "indeterminate",
      attemptCount: 1,
    });
    expect(conflict).toMatch(/handled manually/i);
    expect(conflict).toMatch(/never asked/i);
    expect(conflict).toMatch(/could not have been obtained/i);
  });

  it("flags a delivery recorded against a dispatch that was never transmitted", () => {
    expect(
      describeEvidenceConflict({
        clientOrderId: "99999",
        resolutionOutcome: "delivered",
        dispatchStatus: "indeterminate",
        attemptCount: 0,
      }),
    ).toMatch(/no request ever reached AlShrouq/i);
  });

  /** The two outcomes that assert nothing about the courier cannot conflict. */
  it("flags nothing for handled_manually or undetermined", () => {
    for (const outcome of ["handled_manually", "undetermined"] as const) {
      expect(
        describeEvidenceConflict({
          clientOrderId: "12389",
          resolutionOutcome: outcome,
          dispatchStatus: "indeterminate",
          attemptCount: 0,
        }),
      ).toBeNull();
    }
  });

  it("flags nothing for an unresolved row, or one whose record and evidence agree", () => {
    expect(
      describeEvidenceConflict({ clientOrderId: "12419", resolutionOutcome: null }),
    ).toBeNull();
    expect(
      describeEvidenceConflict({
        clientOrderId: "12419",
        resolutionOutcome: "delivered",
        dispatchStatus: "indeterminate",
        attemptCount: 1,
      }),
    ).toBeNull();
  });

  /** It reports. It never edits — there is no write anywhere in the guard. */
  it("corrects nothing", () => {
    expect(guard).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  });
});

/* ========================================================================== */
/* 3. The service boundary — no request can leave                             */
/* ========================================================================== */

/**
 * A Supabase stand-in for the server functions' own reads.
 *
 * `has_permission` answers true so the permission gate is never what stops a
 * call — otherwise a test could pass because the operator was refused rather
 * than because the dispatch was.
 */
function fakeClient(row: Record<string, unknown> | null) {
  return {
    rpc: async () => ({ data: true }),
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        then: (resolve: any) =>
          Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve),
      };
      return chain;
    },
  };
}

/** Runs `fn` with `fetch` replaced by a spy, and returns the spy. */
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

describe("the lookup action", () => {
  /**
   * The refusal is checked on the dispatch id **before** the permission read and
   * before the row is fetched, so there is no ordering of this handler's steps
   * in which a request could go out for one of the three.
   */
  it("refuses the three on their id alone, before anything is read", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqLookupDispatch"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );

    const blockIndex = handler.indexOf("isExternalContactBlocked({ dispatchId: data.dispatchId })");
    const permissionIndex = handler.indexOf("assertPermission");
    const transportIndex = handler.indexOf("findAlshrouqOrderByClientOrderId");

    expect(blockIndex).toBeGreaterThan(-1);
    // Before the permission check, and before the transport is even imported.
    expect(blockIndex).toBeLessThan(permissionIndex);
    expect(blockIndex).toBeLessThan(transportIndex);
    // And it returns rather than falling through.
    expect(handler).toMatch(
      /isExternalContactBlocked\(\{ dispatchId[\s\S]{0,160}return \{ kind: "blocked"/,
    );
  });

  /** Checked a second time against the row, for anything resolved since. */
  it("re-checks the row's own reference and outcome before contacting anyone", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqLookupDispatch"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    expect(handler.match(/isExternalContactBlocked\(/g) ?? []).toHaveLength(2);
    expect(handler).toContain("resolutionOutcome: row.resolution_outcome");
  });

  /** The transport it reaches for is a GET, and there is no create in sight. */
  it("can only ever read", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqLookupDispatch"),
      serverFns.indexOf("export const alshrouqResolveDispatch"),
    );
    expect(handler).toContain("findAlshrouqOrderByClientOrderId");
    expect(handler).not.toContain("createAlshrouqOrder");
    expect(handler).not.toContain("dispatchOrderToAlShrouq");
    expect(handler).not.toContain("scheduleAlShrouqDispatch");
    expect(handler).not.toContain("runDueAlShrouqDispatches");
  });
});

describe("the worklist", () => {
  it("reads rows and contacts nobody", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqUnresolvedDispatches"),
      serverFns.indexOf("export type AlShrouqLookupResult"),
    );
    // Only the two states a person may settle.
    expect(handler).toContain('.in("dispatch_status", ["indeterminate", "failed"])');
    // No transport of any kind.
    expect(handler).not.toContain("createAlshrouqOrder");
    expect(handler).not.toContain("findAlshrouqOrderByClientOrderId");
    expect(handler).not.toContain("crmFetch");
    expect(handler).not.toMatch(/\bfetch\(/);
    // Gated, and read through the caller's client so RLS decides visibility.
    expect(handler).toContain('assertPermission(supabase, userId, "admin_access")');
  });

  it("carries no payload, credential or customer identity", () => {
    const handler = serverFns.slice(
      serverFns.indexOf("export const alshrouqUnresolvedDispatches"),
      serverFns.indexOf("export type AlShrouqLookupResult"),
    );
    for (const forbidden of [
      "payload_snapshot",
      "customer_phone",
      "customer_name",
      "customer_address",
      "vault",
      "password",
    ]) {
      expect(handler).not.toContain(forbidden);
    }
  });
});

describe("the resolve action", () => {
  /**
   * A blocked dispatch may only be given the one outcome that asserts nothing
   * about the courier. `delivered` on 12389 would be a courier delivery recorded
   * for a request that never left the machine.
   */
  it("refuses a courier-confirming outcome for a manually-handled dispatch", () => {
    const handler = serverFns.slice(serverFns.indexOf("export const alshrouqResolveDispatch"));
    expect(handler).toContain("OFFLINE_RESOLUTION_OUTCOMES");
    expect(handler).toMatch(/blocked && !OFFLINE_RESOLUTION_OUTCOMES\.includes\(data\.outcome\)/);
    expect(handler).toContain("can only be recorded as handled manually");
  });

  it("still writes the audit record for handled_manually", async () => {
    const writes: Record<string, unknown>[] = [];
    const activity: Record<string, unknown>[] = [];
    const db = {
      from(table: string) {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          is: () => chain,
          update: (patch: Record<string, unknown>) => {
            writes.push(patch);
            return chain;
          },
          maybeSingle: async () => ({
            data: { id: "d-1", order_id: "o-1", dispatch_status: "indeterminate" },
            error: null,
          }),
          insert: async (r: Record<string, unknown>) => {
            if (table === "order_activity") activity.push(r);
            return { error: null };
          },
        };
        return chain;
      },
    };

    const spy = await withFetchSpy(async () => {
      const r = await resolveAlShrouqDispatch(
        {
          dispatchId: "d-1",
          outcome: "handled_manually",
          note: "Branch delivered it with their own driver.",
          resolvedBy: "99999999-8888-7777-6666-555555555555",
        },
        db as any,
      );
      expect(r.kind).toBe("resolved");
    });

    // Not one outbound request.
    expect(spy).not.toHaveBeenCalled();

    // The four audited columns, and the operator's identity among them.
    const patch = writes[0]!;
    expect(patch.resolution_outcome).toBe("handled_manually");
    expect(patch.resolved_by).toBe("99999999-8888-7777-6666-555555555555");
    expect(patch.resolved_at).toBeTruthy();
    expect(patch.resolution_note).toBe("Branch delivered it with their own driver.");

    // And the order's own history records that a person did this.
    expect(activity).toHaveLength(1);
    expect(activity[0]!.action).toBe("alshrouq_dispatch_resolved");
    expect((activity[0]!.details as Record<string, unknown>).outcome).toBe("handled_manually");
    // The lifecycle is not overwritten: the machine's observation stands.
    expect(patch).not.toHaveProperty("dispatch_status");
    expect(patch).not.toHaveProperty("cancelled_at");
  });

  /**
   * Two operators at once produce one resolution and one honest conflict. The
   * guard is `.is(resolution_outcome, null)`, which Postgres serialises.
   */
  it("cannot record two answers for one dispatch", async () => {
    let outcomeSet = false;
    const db = {
      from() {
        let updating = false;
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          is: () => chain,
          update: () => {
            updating = true;
            return chain;
          },
          maybeSingle: async () => {
            if (updating) {
              // The first writer wins; the second matches nothing.
              if (outcomeSet) return { data: null, error: null };
              outcomeSet = true;
              return { data: { id: "d-1", order_id: "o-1", dispatch_status: "indeterminate" } };
            }
            return {
              data: outcomeSet
                ? { dispatch_status: "indeterminate", resolution_outcome: "handled_manually" }
                : { dispatch_status: "indeterminate", resolution_outcome: null },
              error: null,
            };
          },
          insert: async () => ({ error: null }),
        };
        return chain;
      },
    };

    const input = (note: string) => ({
      dispatchId: "d-1",
      outcome: "handled_manually" as const,
      note,
      resolvedBy: "99999999-8888-7777-6666-555555555555",
    });

    const first = await resolveAlShrouqDispatch(input("First operator's account."), db as any);
    const second = await resolveAlShrouqDispatch(input("Second operator's account."), db as any);

    expect(first.kind).toBe("resolved");
    expect(second.kind).toBe("already_resolved");
  });
});

/* ========================================================================== */
/* 4. The scheduler cannot pick any of this up                                */
/* ========================================================================== */

describe("a resolved dispatch is out of the scheduler's reach", () => {
  /** The claim predicate is `scheduled`, and nothing resolvable is scheduled. */
  it("is not claimable in any resolvable state", () => {
    for (const status of ["indeterminate", "failed"]) {
      expect(isWorkerClaimable(status)).toBe(false);
      // And it still owns the order's slot, so no second dispatch can be made.
      expect(blocksNewDispatch(status)).toBe(true);
    }
  });

  /**
   * The due query asks for `dispatch_status = 'scheduled'`, so a settled row is
   * not merely skipped — it is never selected. Proven against the worker rather
   * than asserted about it.
   */
  it("is never selected by a due run", async () => {
    const selected: Record<string, unknown> = {};
    const supabase = {
      from() {
        const chain: any = {
          select: () => chain,
          eq: (col: string, v: unknown) => {
            selected[col] = v;
            return chain;
          },
          is: () => chain,
          lte: () => chain,
          order: () => chain,
          lt: () => {
            chain.then = (r: any) => Promise.resolve({ data: [], error: null }).then(r);
            return chain;
          },
          update: () => chain,
          limit: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return chain;
      },
    };

    const spy = await withFetchSpy(async () => {
      const summary = await runDueAlShrouqDispatches(
        supabase as any,
        {
          liveEnabled: () => true,
        } as any,
      );
      expect(summary.due).toBe(0);
      expect(summary.claimed).toBe(0);
    });

    expect(spy).not.toHaveBeenCalled();
    // The predicate that makes a resolved or indeterminate row invisible here.
    expect(selected.dispatch_status).toBe("scheduled");
  });
});

/* ========================================================================== */
/* 5. The page offers no way to send anything                                 */
/* ========================================================================== */

describe("the reconciliation page", () => {
  /**
   * Asserted against the source rather than a render, because what matters is
   * that the module has no path to the transport at all — a rendering test
   * would only show that a button is absent from one state of one component.
   */
  it("has no retry, resend or dispatch control anywhere in it", () => {
    // The structural half: no path to anything that creates a delivery.
    expect(page).not.toMatch(/alshrouqDispatchOrder|alshrouqScheduleDispatch|createAlshrouqOrder/);
    expect(page).not.toMatch(/\bfetch\(/);

    /*
     * And the visible half: no *control* offering one.
     *
     * Matched as element text — `>Retry<` — rather than as a bare word, because
     * the page says "It does not resend the delivery" on purpose. Forbidding
     * the word outright would forbid the sentence that reassures an operator,
     * which is the opposite of what this test is for.
     */
    const controlLabels = [...page.matchAll(/>\s*([A-Z][^<>{}\n]{0,30}?)\s*</g)].map((m) => m[1]);
    for (const label of controlLabels) {
      expect(label).not.toMatch(/^(Retry|Resend|Re-?dispatch|Send again|Dispatch)$/i);
    }
  });

  it("calls only the three read/record server functions", () => {
    const imported = page.slice(
      page.indexOf('from "@/lib/shams.functions"') - 400,
      page.indexOf('from "@/lib/shams.functions"'),
    );
    expect(imported).toContain("alshrouqUnresolvedDispatches");
    expect(imported).toContain("alshrouqLookupDispatch");
    expect(imported).toContain("alshrouqResolveDispatch");
    expect(imported).not.toContain("alshrouqDispatchOrder");
  });

  /** The badge is rendered from the shared constant, not retyped. */
  it("shows the manually-handled badge from the one source of that wording", () => {
    expect(page).toContain("MANUALLY_HANDLED_BADGE");
    expect(page).toContain("OFFLINE_RESOLUTION_OUTCOMES");
  });

  /**
   * A row whose POST was transmitted gets a warning before anyone decides. The
   * evidence field has three values, and "unknown" has to stay one of them.
   */
  it("distinguishes sent, never sent and unknown", () => {
    expect(page).toContain("confirmed_sent");
    expect(page).toContain("never_sent");
    expect(page).toContain("Unknown");
    expect(page).toMatch(/driver may already/i);
  });
});
