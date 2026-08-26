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

/** A link in the state the dispatch path can actually use. */
function link(over: Record<string, unknown> = {}) {
  return {
    crm_username: "crm-agent@example.test",
    crm_user_id: "99001",
    active: true,
    vault_key: `shams_crm_agent_${AGENT_ID}`,
    verified_at: "2026-08-23T00:00:00.000Z",
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
    // Nothing linked yet, so by default every row is a new mapping and takes the
    // full verification path — which is what the pre-existing cases assert.
    loadExistingLinks: async () => new Map(),
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

/**
 * Re-running after a workbook change.
 *
 * The property that matters is not speed: verifying a row means attempting a
 * login, so a run that re-verifies everyone spends a *failed* login on every
 * agent whose password the workbook no longer carries — against the real CRM
 * accounts of the agents who currently work. These pin that such an agent is not
 * touched, while a new or changed mapping still goes through in full.
 */
describe("a re-run leaves working links alone", () => {
  it("skips an agent already linked to the same CRM account, without contacting the CRM", async () => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99001",
    }));
    const store = vi.fn(async () => "key");
    const upsert = vi.fn(async () => ({ ok: true as const }));

    const summary = await setUpAgentCrmLinks(
      deps({
        loadExistingLinks: async () => new Map([[AGENT_ID, link()]]),
        verifyCrm: verify,
        storeSecret: store,
        upsertLink: upsert,
      }),
    );

    expect(summary).toMatchObject({ verified: 0, stored: 0, failed: 0, skipped: 1 });
    expect(summary.rows[0]).toMatchObject({
      agent: "Test Agent",
      status: "skipped",
      crmUserId: "99001",
    });
    // The decisive part: no login was attempted, and nothing was written.
    expect(verify).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * The live shape of the problem: the seven pre-existing rows in the workbook
   * carry a scrubbed password. Re-verifying them would refuse seven times over
   * against accounts that are working perfectly well.
   */
  it("skips a linked agent whose workbook credential has since been scrubbed", async () => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: false as const,
      reason: "auth_failed" as const,
    }));

    const summary = await setUpAgentCrmLinks(
      deps({ loadExistingLinks: async () => new Map([[AGENT_ID, link()]]), verifyCrm: verify }, [
        row({ crmPassword: "0" }),
      ]),
    );

    expect(summary).toMatchObject({ skipped: 1, failed: 0 });
    expect(verify).not.toHaveBeenCalled();
  });

  /** A new agent in the sheet is exactly what a re-run is for. */
  it("still stores an agent who has no link yet, alongside skipped ones", async () => {
    const NEW_ID = "22222222-2222-4222-8222-222222222222";
    const rows = [
      row({ email: "linked@example.test", name: "Linked Agent" }),
      row({
        email: "new@example.test",
        name: "New Agent",
        agentCode: "4007",
        crmUsername: "new-crm-account",
      }),
    ];
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99002",
    }));
    const upsert = vi.fn<AgentSetupDeps["upsertLink"]>(async () => ({ ok: true as const }));

    const summary = await setUpAgentCrmLinks(
      deps(
        {
          loadPortalAgents: async () =>
            new Map([
              [
                "linked@example.test",
                { id: AGENT_ID, full_name: "Linked Agent", agent_code: "4001" },
              ],
              ["new@example.test", { id: NEW_ID, full_name: "New Agent", agent_code: "4007" }],
            ]),
          loadExistingLinks: async () => new Map([[AGENT_ID, link()]]),
          verifyCrm: verify,
          upsertLink: upsert,
        },
        rows,
      ),
    );

    expect(summary).toMatchObject({ verified: 1, stored: 1, skipped: 1, failed: 0 });
    expect(summary.rows.map((r) => r.status)).toEqual(["skipped", "stored"]);
    // Only the unlinked agent was logged in as.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe("new-crm-account");
    expect((upsert.mock.calls[0]![0] as unknown as Record<string, unknown>).user_id).toBe(NEW_ID);
  });

  /** Case is not a different account — the CRM compares usernames case-blind. */
  it("treats a username differing only in case as the same account", async () => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99001",
    }));
    const summary = await setUpAgentCrmLinks(
      deps({
        loadExistingLinks: async () =>
          new Map([[AGENT_ID, link({ crm_username: "CRM-Agent@Example.Test" })]]),
        verifyCrm: verify,
      }),
    );
    expect(summary.skipped).toBe(1);
    expect(verify).not.toHaveBeenCalled();
  });

  /**
   * A link the dispatch path could not use is not a working mapping, so it is
   * repaired rather than skipped. These are the same three conditions
   * `agentCrmPrincipal` applies before it will hand out a principal.
   */
  it.each([
    ["a different CRM account", link({ crm_username: "someone-else@example.test" })],
    ["the link is switched off", link({ active: false })],
    ["Vault holds nothing for it", link({ vault_key: null })],
    ["it was never verified", link({ verified_at: null })],
  ])("re-verifies when %s", async (_label, existing) => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99001",
    }));
    const summary = await setUpAgentCrmLinks(
      deps({ loadExistingLinks: async () => new Map([[AGENT_ID, existing]]), verifyCrm: verify }),
    );

    expect(summary).toMatchObject({ verified: 1, stored: 1, skipped: 0 });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  /**
   * A rotated password is invisible — nothing here can read the stored one back
   * — so `force` is the only way to push one through.
   */
  it("re-verifies everything under force", async () => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99001",
    }));
    const summary = await setUpAgentCrmLinks(
      deps({ loadExistingLinks: async () => new Map([[AGENT_ID, link()]]), verifyCrm: verify }),
      { force: true },
    );

    expect(summary).toMatchObject({ verified: 1, stored: 1, skipped: 0 });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  /** A skip is not a write, so a dry run and a real run agree about it. */
  it("skips identically on a dry run", async () => {
    const summary = await setUpAgentCrmLinks(
      deps({ loadExistingLinks: async () => new Map([[AGENT_ID, link()]]) }),
      { dryRun: true },
    );
    expect(summary).toMatchObject({ skipped: 1, verified: 0, stored: 0 });
  });

  /** Skipping happens per agent, so an unrelated link cannot cause one. */
  it("does not skip an agent on the strength of somebody else's link", async () => {
    const verify = vi.fn<AgentSetupDeps["verifyCrm"]>(async () => ({
      ok: true as const,
      crmUserId: "99001",
    }));
    const summary = await setUpAgentCrmLinks(
      deps({
        loadExistingLinks: async () => new Map([["99999999-9999-4999-8999-999999999999", link()]]),
        verifyCrm: verify,
      }),
    );
    expect(summary).toMatchObject({ stored: 1, skipped: 0 });
    expect(verify).toHaveBeenCalledTimes(1);
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
