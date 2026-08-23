/**
 * Moving credentials out of the workbook and into Vault.
 *
 * The workbook is in the repository at the account owner's explicit direction,
 * which makes these tests the guard rails around the one file in the system that
 * holds plaintext CRM passwords: nothing may be stored unverified, nothing may
 * be attached to the wrong person, a failure may not disturb a working link, and
 * the bytes may never reach a browser.
 *
 * Every credential here is fake.
 */

import { describe, expect, it, vi } from "vitest";
import {
  setUpAgentCrmLinks,
  type AgentSetupDeps,
  type AgentSetupFailure,
} from "@/lib/shams-crm/agent-setup.server";
import { normaliseTeam } from "@/lib/shams-crm/agent-workbook.server";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function row(over: Record<string, unknown> = {}) {
  return {
    rowNumber: 2,
    email: "agent@example.test",
    name: "Test Agent",
    team: "Customer Care",
    agentCode: "4001",
    crmUsername: "crm-agent@example.test",
    crmPassword: "test-only",
    ...over,
  };
}

function deps(over: Partial<AgentSetupDeps> = {}, rows = [row()]): AgentSetupDeps {
  return {
    readWorkbook: () => rows as never,
    loadPortalAgents: async () =>
      new Map([
        ["agent@example.test", { id: AGENT_ID, full_name: "Test Agent", agent_code: "4001" }],
      ]),
    verifyCrm: async () => ({ ok: true, crmUserId: "99001" }),
    storeSecret: async () => `shams_crm_agent_${AGENT_ID}`,
    upsertLink: async () => ({ ok: true }),
    ...over,
  };
}

describe("a verified agent is stored", () => {
  it("writes Vault and the metadata row, and reports no secret", async () => {
    const upsert = vi.fn<AgentSetupDeps["upsertLink"]>(async () => ({ ok: true as const }));
    const summary = await setUpAgentCrmLinks(deps({ upsertLink: upsert }));

    expect(summary).toMatchObject({ verified: 1, stored: 1, failed: 0 });
    expect(summary.rows[0]).toMatchObject({
      agent: "Test Agent",
      status: "stored",
      reason: "verified",
      crmUserId: "99001",
    });

    // The row written carries no credential — the display label is normalised.
    const written = upsert.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(written.team).toBe("customer_care");
    expect(written.crm_username).toBe("crm-agent@example.test");
    for (const forbidden of ["crm_password", "password", "crmPassword", "secret"]) {
      expect(Object.keys(written)).not.toContain(forbidden);
    }
    // The whole summary, serialised, contains no password.
    expect(JSON.stringify(summary)).not.toContain("test-only");
  });

  /** Vault before the row, so a half-failure never leaves an active broken link. */
  it("stores the secret before the metadata", async () => {
    const order: string[] = [];
    await setUpAgentCrmLinks(
      deps({
        storeSecret: async () => {
          order.push("vault");
          return "key";
        },
        upsertLink: async () => {
          order.push("row");
          return { ok: true };
        },
      }),
    );
    expect(order).toEqual(["vault", "row"]);
  });
});

describe("nothing is stored unverified", () => {
  it.each<[string, Partial<AgentSetupDeps>, AgentSetupFailure]>([
    [
      "the CRM refuses it",
      { verifyCrm: async () => ({ ok: false, reason: "auth_failed" }) },
      "auth_failed",
    ],
    [
      "the account is inactive",
      { verifyCrm: async () => ({ ok: false, reason: "inactive" }) },
      "inactive",
    ],
    [
      "it cannot dispatch",
      { verifyCrm: async () => ({ ok: false, reason: "missing_permission" }) },
      "missing_permission",
    ],
    [
      "/me names a different account",
      { verifyCrm: async () => ({ ok: false, reason: "username_mismatch" }) },
      "username_mismatch",
    ],
    [
      "the CRM is unreachable",
      { verifyCrm: async () => ({ ok: false, reason: "crm_unreachable" }) },
      "crm_unreachable",
    ],
  ])("refuses to store when %s", async (_label, over, reason) => {
    const store = vi.fn(async () => "key");
    const upsert = vi.fn(async () => ({ ok: true as const }));
    const summary = await setUpAgentCrmLinks(
      deps({ ...over, storeSecret: store, upsertLink: upsert }),
    );

    expect(summary.stored).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.rows[0]!.reason).toBe(reason);
    // The decisive part: no write of any kind happened.
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  /** A dry run proves the mapping and writes nothing. */
  it("writes nothing on a dry run", async () => {
    const store = vi.fn(async () => "key");
    const summary = await setUpAgentCrmLinks(deps({ storeSecret: store }), { dryRun: true });

    expect(summary.verified).toBe(1);
    expect(summary.stored).toBe(0);
    expect(summary.rows[0]!.status).toBe("verified");
    expect(store).not.toHaveBeenCalled();
  });
});

describe("a credential is never attached to the wrong person", () => {
  it.each<[string, Partial<AgentSetupDeps>, AgentSetupFailure]>([
    ["no MilaPortal account matches", { loadPortalAgents: async () => new Map() }, "unmapped"],
    [
      "the profile name disagrees",
      {
        loadPortalAgents: async () =>
          new Map([
            ["agent@example.test", { id: AGENT_ID, full_name: "Someone Else", agent_code: "4001" }],
          ]),
      },
      "name_mismatch",
    ],
    [
      "the agent code disagrees",
      {
        loadPortalAgents: async () =>
          new Map([
            ["agent@example.test", { id: AGENT_ID, full_name: "Test Agent", agent_code: "9999" }],
          ]),
      },
      "agent_code_mismatch",
    ],
  ])("stops when %s", async (_label, over, reason) => {
    const store = vi.fn(async () => "key");
    const summary = await setUpAgentCrmLinks(deps({ ...over, storeSecret: store }));

    expect(summary.stored).toBe(0);
    expect(summary.rows[0]!.reason).toBe(reason);
    expect(store).not.toHaveBeenCalled();
  });

  /** Whitespace is not a different person — one real profile has a leading space. */
  it("tolerates surrounding whitespace in the profile name", async () => {
    const summary = await setUpAgentCrmLinks(
      deps({
        loadPortalAgents: async () =>
          new Map([
            ["agent@example.test", { id: AGENT_ID, full_name: " Test Agent", agent_code: "4001" }],
          ]),
      }),
    );
    expect(summary.stored).toBe(1);
  });

  /** Two agents cannot share one CRM account. */
  it("reports a CRM username already linked elsewhere", async () => {
    const summary = await setUpAgentCrmLinks(
      deps({ upsertLink: async () => ({ ok: false, duplicate: true }) }),
    );
    expect(summary.rows[0]!.reason).toBe("crm_username_already_linked");
    expect(summary.stored).toBe(0);
  });
});

describe("a batch survives one bad row", () => {
  it("keeps going and reports each outcome", async () => {
    const rows = [
      row({ email: "a@example.test", name: "Agent A" }),
      row({ email: "missing@example.test", name: "Agent B" }),
      row({ email: "c@example.test", name: "Agent C" }),
    ];
    const summary = await setUpAgentCrmLinks(
      deps(
        {
          loadPortalAgents: async () =>
            new Map([
              ["a@example.test", { id: AGENT_ID, full_name: "Agent A", agent_code: "4001" }],
              ["c@example.test", { id: AGENT_ID, full_name: "Agent C", agent_code: "4001" }],
            ]),
        },
        rows,
      ),
    );

    expect(summary.stored).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.rows.map((r) => r.status)).toEqual(["stored", "failed", "stored"]);
    expect(summary.rows[1]!.reason).toBe("unmapped");
  });

  /** A row missing any of its three essentials is reported, not skipped. */
  it("reports an incomplete row rather than ignoring it", async () => {
    const summary = await setUpAgentCrmLinks(deps({}, [row({ crmPassword: "" })]));
    expect(summary.rows[0]!.reason).toBe("not_configured");
    expect(summary.failed).toBe(1);
  });
});

describe("team labels are normalised", () => {
  it.each([
    ["Customer Care", "customer_care"],
    ["customer_care", "customer_care"],
    ["Telesales", "telesales"],
    ["  telesales  ", "telesales"],
  ])("maps %s to %s", (input, expected) => {
    expect(normaliseTeam(input)).toBe(expected);
  });

  it("refuses to guess an unknown team", () => {
    expect(normaliseTeam("Logistics")).toBeNull();
    expect(normaliseTeam("")).toBeNull();
  });
});
