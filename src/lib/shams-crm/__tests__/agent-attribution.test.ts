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
/** A supervisor: full edit rights, and deliberately no Shams CRM account. */
const SUPERVISOR = "cccccccc-3333-4333-8333-cccccccccccc";
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
        /**
         * The stale-claim sweep, and the only caller that filters on `<`.
         *
         * This fake holds no rows in `processing`, so the sweep matches nothing
         * — and its patch, recorded optimistically by `update` above, is taken
         * back off the list so it is not counted as a write these tests are
         * about.
         */
        lt: () => {
          updates.pop();
          return chain;
        },
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

/**
 * One dispatch request.
 *
 * Two ids, because they are two different questions. `orderAgentId` is whose
 * delivery it is — the order's assignee, and the CRM identity it goes out under.
 * `actorId` is who pressed send, which is only ever `dispatched_by`. They are
 * the same person for an agent dispatching their own order, which is why the
 * caller defaults to the agent.
 */
function request(orderAgentId: string, actorId: string = orderAgentId): DispatchRequest {
  return {
    orderId: "11111111-2222-3333-4444-555555555555",
    displayNo: "#9767",
    branchNo: BRANCH_NO,
    userId: actorId,
    orderAgentId,
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
/* TEST A — ASAP goes out as the order's agent                               */
/* ------------------------------------------------------------------------- */

describe("A: an immediate dispatch is attributed to the order's agent", () => {
  it("POSTs under agent A's own CRM identity", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(
      request(AGENT_A),
      supabase as any,
      deps({ live: true }),
    );

    expect(result.kind).toBe("dispatched");
    expect(sentAs).toHaveLength(1);
    // The identity is the order's agent, resolved server-side, which is what
    // the CRM will stamp the order with. Here they are also the caller.
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
      "crm_agent_id",
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
/* TEST C & F — execution sends as the order agent, and looks ordinary       */
/* ------------------------------------------------------------------------- */

describe("C: the worker sends as the order's agent", () => {
  function dueRow(over: Record<string, unknown> = {}) {
    return {
      id: "row-1",
      order_id: "11111111-2222-3333-4444-555555555555",
      client_order_id: "9767",
      scheduled_for: "2026-08-21T18:00:00Z",
      scheduled_by: AGENT_A,
      crm_agent_id: AGENT_A,
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

  it("logs in as the recorded agent, not as the service account", async () => {
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
  it("blocks a due row that names no agent at all", async () => {
    const supabase = fakeSupabase([dueRow({ scheduled_by: null, crm_agent_id: null })]);
    const summary = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(summary.blocked).toBe(1);
    expect(sentAs).toHaveLength(0);
  });

  /**
   * The order's agent wins over the approver.
   *
   * A supervisor scheduled it; the delivery is still the agent's, and the worker
   * must log in as them however many hours later it runs.
   */
  it("logs in as crm_agent_id, not as the supervisor who scheduled it", async () => {
    const supabase = fakeSupabase([dueRow({ scheduled_by: SUPERVISOR, crm_agent_id: AGENT_A })]);
    const summary = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(summary.accepted).toBe(1);
    expect(sentAs[0]!.agentId).toBe(AGENT_A);
    expect(sentAs[0]!.agentId).not.toBe(SUPERVISOR);
  });

  /**
   * Rows written before `crm_agent_id` existed still go out.
   *
   * They were all approved by agents for their own orders, so `scheduled_by` is
   * the same person the new column would hold — the fallback is compatibility,
   * not a guess.
   */
  it("falls back to scheduled_by for a row written before crm_agent_id", async () => {
    const supabase = fakeSupabase([dueRow({ crm_agent_id: null, scheduled_by: AGENT_B })]);
    const summary = await runDueAlShrouqDispatches(supabase as any, deps({ live: true }));

    expect(summary.accepted).toBe(1);
    expect(sentAs[0]!.agentId).toBe(AGENT_B);
  });
});

/* ------------------------------------------------------------------------- */
/* TEST G — a handover made on an agent's behalf                             */
/*                                                                           */
/* The case the per-agent design originally got wrong: supervisors and       */
/* administrators hold `edit_all_orders`, have no Shams CRM account of their  */
/* own by design, and hand orders to the agents who service them. Attributing */
/* those deliveries to the person who clicked was both impossible — there is  */
/* no credential to log in with — and wrong.                                  */
/* ------------------------------------------------------------------------- */

describe("G: a dispatch made on an agent's behalf goes out as that agent", () => {
  /** Only agents are linked. A supervisor asking for a credential gets nothing. */
  const agentsOnly = (userId: string): AgentCredentialResult =>
    userId === SUPERVISOR
      ? { ok: false, problem: "not_configured" }
      : {
          ok: true,
          principal: {
            kind: "agent",
            agentId: userId,
            username: `${userId}@example.test`,
            password: "test-only",
          },
          crmUsername: `${userId}@example.test`,
          crmUserId: "99001",
        };

  it("POSTs under the order agent's identity, not the caller's", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(
      request(AGENT_A, SUPERVISOR),
      supabase as any,
      deps({ live: true, credentialFor: agentsOnly }),
    );

    expect(result.kind).toBe("dispatched");
    expect(sentAs).toHaveLength(1);
    expect(sentAs[0]!.agentId).toBe(AGENT_A);
    expect(sentAs[0]!.username).toBe(`${AGENT_A}@example.test`);
  });

  /** Who acted is still recorded — on the row, where it belongs. */
  it("still records the supervisor as the one who dispatched it", async () => {
    const supabase = fakeSupabase();
    await dispatchOrderToAlShrouq(
      request(AGENT_A, SUPERVISOR),
      supabase as any,
      deps({ live: true, credentialFor: agentsOnly }),
    );

    expect(supabase.inserts).toHaveLength(1);
    expect(supabase.inserts[0]!.dispatched_by).toBe(SUPERVISOR);
  });

  /** Scheduling keeps the two apart in the row it writes. */
  it("freezes the order agent beside the payload when scheduling", async () => {
    const supabase = fakeSupabase();
    const when = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const result = await scheduleAlShrouqDispatch(
      request(AGENT_A, SUPERVISOR),
      when,
      supabase as any,
      deps({ live: true, credentialFor: agentsOnly }),
    );

    expect(result.kind).toBe("scheduled");
    const row = supabase.inserts[0]!;
    expect(row.crm_agent_id).toBe(AGENT_A);
    expect(row.scheduled_by).toBe(SUPERVISOR);
  });

  /**
   * The caller's own missing link is no longer the question, so it cannot block
   * a handover for an agent who *is* linked. This is the reported bug, pinned.
   */
  it("does not consult the caller's CRM link at all", async () => {
    const asked: string[] = [];
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(
      request(AGENT_A, SUPERVISOR),
      supabase as any,
      deps({
        live: true,
        credentialFor: (userId) => {
          asked.push(userId);
          return agentsOnly(userId);
        },
      }),
    );

    expect(result.kind).toBe("dispatched");
    expect(asked).toEqual([AGENT_A]);
  });

  /**
   * An order with no agent has nobody to attribute the delivery to, and fails
   * closed rather than falling back to the caller.
   */
  it("refuses an order that names no agent", async () => {
    const supabase = fakeSupabase();
    const req = { ...request(AGENT_A, SUPERVISOR), orderAgentId: null };
    const result = await dispatchOrderToAlShrouq(
      req,
      supabase as any,
      deps({ live: true, credentialFor: agentsOnly }),
    );

    expect(result.kind).toBe("agent_not_configured");
    expect(sentAs).toHaveLength(0);
    expect(supabase.inserts).toHaveLength(0);
  });

  /** And an unconfigured agent still blocks, however senior the caller is. */
  it("still blocks when the order's own agent is not linked", async () => {
    const supabase = fakeSupabase();
    const result = await dispatchOrderToAlShrouq(
      request(SUPERVISOR, SUPERVISOR),
      supabase as any,
      deps({ live: true, credentialFor: agentsOnly }),
    );

    expect(result.kind).toBe("agent_not_configured");
    if (result.kind === "agent_not_configured") expect(result.problem).toBe("not_configured");
    expect(sentAs).toHaveLength(0);
    expect(supabase.inserts).toHaveLength(0);
  });
});
