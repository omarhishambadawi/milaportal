/**
 * Whose name ends up on the delivery — the six flows, asserted end to end.
 *
 * Shams CRM stamps `created_by_user_id` and `created_by_username` from the
 * authenticated session and accepts no caller-supplied attribution. So the
 * credential the POST goes out under *is* the attribution, and every test here
 * is really one question: which credential logged in?
 *
 * The dangerous failure is not an error. It is a dispatch that succeeds under
 * the deployment's own account and quietly records somebody else's delivery
 * against it — which is why the "no fallback" tests below matter more than the
 * happy paths.
 *
 * No real credential appears in this file.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchOrderToAlShrouq,
  type DispatchDeps,
  type DispatchRequest,
} from "@/lib/shams-crm/alshrouq-dispatch.server";
import {
  scheduleAlShrouqDispatch,
  runDueAlShrouqDispatches,
} from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { AgentCredentialResult } from "@/lib/shams-crm/agent-credentials.server";

const AGENT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BRANCH_ID = "9999927657247";
const BRANCH_NO = "P0002";

const BRANCH_OPTIONS = [
  {
    id: BRANCH_ID,
    internal_code: BRANCH_NO,
    branch_name: "الرياض",
    label: "P0002 | الرياض",
    covered: true,
    note: null,
  },
];

afterEach(() => {
  delete process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED;
});

/** Records the principal every POST went out under. That is the attribution. */
let sentAs: { agentId: string | null; username: string | null }[];
let sentPayloads: Record<string, unknown>[];

function deps(
  over: {
    live?: boolean;
    credentialFor?: (userId: string) => AgentCredentialResult;
  } = {},
): Partial<DispatchDeps> {
  sentAs = [];
  sentPayloads = [];
  const createOrder = vi.fn(async (payload: any, _opId: string, principal: any) => {
    sentAs.push({
      agentId: principal?.kind === "agent" ? principal.agentId : null,
      username: principal?.kind === "agent" ? principal.username : null,
    });
    sentPayloads.push(payload);
    return { kind: "accepted" as const, operationId: "op-1", status: 201, body: null };
  });

  return {
    createOrder: createOrder as any,
    reconcile: async () => null as any,
    newOperationId: () => "op-1",
    liveEnabled: () => over.live === true,
    fetchOptions: async () => ({
      branchOptions: BRANCH_OPTIONS,
      paymentOptions: [
        { id: 1, label: "COD" },
        { id: 3, label: "SPAN Machine" },
      ],
    }),
    agentPrincipal: async (userId: string) =>
      over.credentialFor
        ? over.credentialFor(userId)
        : ({
            ok: true,
            principal: {
              kind: "agent",
              agentId: userId,
              username: `${userId}@example.test`,
              password: "test-only",
            },
            crmUsername: `${userId}@example.test`,
            crmUserId: "99001",
          } as AgentCredentialResult),
  };
}

function fakeSupabase(due: Record<string, unknown>[] = []) {
  const inserts: any[] = [];
  const updates: any[] = [];
  return {
    inserts,
    updates,
    from() {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        lte: () => chain,
        limit: async () => ({ data: due, error: null }),
        maybeSingle: async () => ({ data: chain.__claim ?? null, error: null }),
        // Chainable: `persist` does `.insert(row).select(...).maybeSingle()`.
        insert: (row: any) => {
          inserts.push(row);
          chain.__claim = null;
          return chain;
        },
        update: (row: any) => {
          updates.push(row);
          chain.__claim = { id: due[0]?.id ?? "row-1" };
          return chain;
        },
        order: () => chain,
      };
      return chain;
    },
  };
}

function request(userId: string): DispatchRequest {
  return {
    orderId: "11111111-2222-3333-4444-555555555555",
    displayNo: "#9767",
    branchNo: BRANCH_NO,
    userId,
    form: {
      customerName: "Test Customer",
      customerPhone: "0500000000",
      paymentType: "3",
      mapUrl: "https://maps.app.goo.gl/kQ7xR2vN8mP4tL9s",
      lat: "24.8060200",
      lng: "46.7752300",
      orderValue: "150",
      details: "Second floor.",
    },
  };
}

/* ------------------------------------------------------------------------- */
/* TEST A — ASAP goes out as the logged-in agent                             */
/* ------------------------------------------------------------------------- */

describe("A: an immediate dispatch is attributed to the agent who made it", () => {
  it("POSTs under agent A's own CRM identity", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(
      request(AGENT_A),
      supabase as any,
      deps({ live: true }),
    );

    expect(result.kind).toBe("dispatched");
    expect(sentAs).toHaveLength(1);
    // The identity is the verified MilaPortal user id from the request, which is
    // what the CRM will stamp the order with.
    expect(sentAs[0]!.agentId).toBe(AGENT_A);
    expect(sentAs[0]!.username).toBe(`${AGENT_A}@example.test`);
  });

  /** The payload is the ordinary AlShrouq one — no MilaPortal identifiers. */
  it("sends no MilaPortal identity in the payload itself", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(request(AGENT_A), supabase as any, deps({ live: true }));

    const payload = sentPayloads[0]!;
    for (const forbidden of [
      "scheduled_by",
      "dispatched_by",
      "agent_id",
      "user_id",
      "created_by",
      "milaportal_user_id",
    ]) {
      expect(Object.keys(payload)).not.toContain(forbidden);
    }
    // Attribution travels in the session, never in the body.
    expect(payload.branch_id).toBe(BRANCH_ID);
  });
});

/* ------------------------------------------------------------------------- */
/* TEST E — two agents, two identities, no leakage                           */
/* ------------------------------------------------------------------------- */

describe("E: concurrent agents never cross-attribute", () => {
  it("sends A's order as A and B's as B", async () => {
    const d = deps({ live: true });
    await Promise.all([
      dispatchOrderToAlShrouq(request(AGENT_A), fakeSupabase() as any, d),
      dispatchOrderToAlShrouq(request(AGENT_B), fakeSupabase() as any, d),
    ]);

    expect(sentAs).toHaveLength(2);
    const ids = sentAs.map((s) => s.agentId).sort();
    expect(ids).toEqual([AGENT_A, AGENT_B].sort());
    // And neither went out as the other.
    for (const s of sentAs) expect(s.username).toBe(`${s.agentId}@example.test`);
  });
});

/* ------------------------------------------------------------------------- */
/* TEST D — no service-account fallback, ever                                */
/* ------------------------------------------------------------------------- */

describe("D: an agent without a CRM identity blocks rather than falling back", () => {
  it.each(["not_configured", "inactive", "missing_secret"] as const)(
    "refuses to send when the credential is %s",
    async (problem) => {
      const supabase = fakeSupabase();
      const result = await dispatchOrderToAlShrouq(
        request(AGENT_A),
        supabase as any,
        deps({ live: true, credentialFor: () => ({ ok: false, problem }) }),
      );

      expect(result.kind).toBe("agent_not_configured");
      if (result.kind === "agent_not_configured") expect(result.problem).toBe(problem);
      // The decisive assertions: nothing was sent, under any identity, and no
      // dispatch row was written that could look like a delivery.
      expect(sentAs).toHaveLength(0);
      expect(supabase.inserts).toHaveLength(0);
    },
  );

  /**
   * The service credential is not reachable from this path at all. Even with
   * the gate open and everything else valid, a missing agent identity stops it.
   */
  it("never substitutes the service principal", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(
      request(AGENT_A),
      supabase as any,
      deps({ live: true, credentialFor: () => ({ ok: false, problem: "not_configured" }) }),
    );
    expect(sentAs.some((s) => s.agentId === null)).toBe(false);
    expect(sentAs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* TEST B — scheduling contacts nobody                                       */
/* ------------------------------------------------------------------------- */

describe("B: scheduling makes zero CRM requests", () => {
  it("writes one local row, records the agent, and logs in to nothing", async () => {
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const result = await scheduleAlShrouqDispatch(
      request(AGENT_A),
      when,
      supabase as any,
      deps({ live: true }),
    );

    expect(result.kind).toBe("scheduled");
    // No POST, and therefore no login: the CRM is not contacted at all.
    expect(sentAs).toHaveLength(0);
    expect(supabase.inserts).toHaveLength(1);

    const row = supabase.inserts[0]!;
    expect(row.dispatch_status).toBe("scheduled");
    // The agent is recorded now so the worker can become them later.
    expect(row.scheduled_by).toBe(AGENT_A);
    expect(row.scheduled_for).toBe(when.toISOString());
  });
});

/* ------------------------------------------------------------------------- */
/* TEST C & F — execution sends as scheduled_by, and looks ordinary          */
/* ------------------------------------------------------------------------- */

describe("C: the worker sends as the agent who approved it", () => {
  function dueRow(over: Record<string, unknown> = {}) {
    return {
      id: "row-1",
      order_id: "11111111-2222-3333-4444-555555555555",
      client_order_id: "9767",
      scheduled_for: "2026-08-21T18:00:00Z",
      scheduled_by: AGENT_A,
      payload_snapshot: {
        branch_id: BRANCH_ID,
        client_order_id: "9767",
        customer_name: "Test Customer",
        customer_phone: "0500000000",
        payment_type: 3,
        order_value: 150,
      },
      ...over,
    };
  }

  it("logs in as scheduled_by, not as the service account", async () => {
    const supabase = fakeSupabase([dueRow()]);
    const summary = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(summary.accepted).toBe(1);
    expect(sentAs).toHaveLength(1);
    // Hours after approval, with the agent long gone, the delivery still goes
    // out under their CRM identity.
    expect(sentAs[0]!.agentId).toBe(AGENT_A);
  });

  /**
   * F — what the CRM receives is the ordinary create payload. The snapshot is
   * sent verbatim, and none of MilaPortal's scheduling bookkeeping travels with
   * it.
   */
  it("sends the ordinary payload with no scheduling metadata", async () => {
    const supabase = fakeSupabase([dueRow()]);
    await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    const payload = sentPayloads[0]!;
    for (const forbidden of [
      "scheduled_for",
      "scheduled_at",
      "scheduled_by",
      "dispatch_status",
      "payload_snapshot",
      "mila_schedule",
      "future_delivery",
      "id",
    ]) {
      expect(Object.keys(payload)).not.toContain(forbidden);
    }
    // It is exactly the snapshot, which is exactly what ASAP would have sent.
    expect(payload).toEqual(dueRow().payload_snapshot);
  });

  /** D again, at execution time: a missing credential blocks and stays due. */
  it("blocks and keeps the schedule when the agent's credential is gone", async () => {
    const supabase = fakeSupabase([dueRow()]);
    const summary = await runDueAlShrouqDispatches(
      supabase as any,
      deps({ live: true, credentialFor: () => ({ ok: false, problem: "not_configured" }) }),
    );

    expect(summary.blocked).toBe(1);
    expect(summary.accepted).toBe(0);
    // Nothing was sent under anyone.
    expect(sentAs).toHaveLength(0);
    // And the row went back to `scheduled`, so it goes out once the link is
    // fixed rather than being lost or marked failed.
    const back = supabase.updates.find((u) => u.dispatch_status === "scheduled");
    expect(back).toBeTruthy();
    expect(String(back.last_error)).toMatch(/Shams CRM account is unavailable/i);
    // The reason names no credential.
    expect(String(back.last_error)).not.toMatch(/password|token/i);
  });

  /** A row with no recorded agent is blocked rather than sent by anybody. */
  it("blocks a due row that has no scheduled_by", async () => {
    const supabase = fakeSupabase([dueRow({ scheduled_by: null })]);
    const summary = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(summary.blocked).toBe(1);
    expect(sentAs).toHaveLength(0);
  });
});
