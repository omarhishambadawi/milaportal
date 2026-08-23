/**
 * Turning a MilaPortal agent into a CRM identity — and refusing to, safely.
 *
 * The property under test is mostly a *negative* one. Shams CRM records the
 * order against whichever credential logged in, so the dangerous failure is not
 * an error: it is a dispatch that succeeds under the wrong identity. Every path
 * that cannot produce the agent's own credential must therefore return a reason
 * and no principal, and never the service one.
 *
 * No real credential appears here.
 */

import { describe, expect, it } from "vitest";
import {
  agentCrmPrincipal,
  explainAgentCredentialProblem,
  type AgentCredentialDeps,
  type AgentCredentialProblem,
} from "@/lib/shams-crm/agent-credentials.server";

const AGENT = "3f2a9c14-1111-4111-8111-aaaaaaaaaaaa";

function deps(
  link: Record<string, unknown> | null,
  secret: string | null = "test-only-secret",
): AgentCredentialDeps {
  return {
    readLink: async () => link as never,
    readSecret: async () => secret,
  };
}

const VERIFIED_LINK = {
  crm_username: "agent@example.test",
  crm_user_id: "99001",
  active: true,
  vault_key: `shams_crm_agent_${AGENT}`,
};

describe("a verified link produces the agent's own principal", () => {
  it("carries the agent id, username and the Vault secret", async () => {
    const result = await agentCrmPrincipal(AGENT, deps(VERIFIED_LINK));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.principal.kind).toBe("agent");
    if (result.principal.kind !== "agent") return;
    // The key the session cache uses is the verified MilaPortal id, so one
    // agent's session can never be served to another.
    expect(result.principal.agentId).toBe(AGENT);
    expect(result.principal.username).toBe("agent@example.test");
    expect(result.principal.password).toBe("test-only-secret");
    expect(result.crmUserId).toBe("99001");
  });
});

describe("every failure refuses rather than falling back", () => {
  it.each<[string, Record<string, unknown> | null, string | null, AgentCredentialProblem]>([
    ["no row at all", null, "s", "not_configured"],
    ["a row with no username", { ...VERIFIED_LINK, crm_username: null }, "s", "not_configured"],
    ["a link that is switched off", { ...VERIFIED_LINK, active: false }, "s", "inactive"],
    ["a link never verified", { ...VERIFIED_LINK, vault_key: null }, "s", "inactive"],
    ["an active link whose secret is gone", VERIFIED_LINK, null, "missing_secret"],
  ])("reports %s as %s", async (_label, link, secret, problem) => {
    const result = await agentCrmPrincipal(AGENT, deps(link, secret));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe(problem);
  });

  /**
   * The one that matters most. A refusal must never hand back something usable:
   * dispatching under the service account would succeed and be recorded against
   * the wrong person, which is worse than not dispatching at all.
   */
  it("never returns a service principal on any failure path", async () => {
    for (const [link, secret] of [
      [null, "s"],
      [{ ...VERIFIED_LINK, active: false }, "s"],
      [VERIFIED_LINK, null],
    ] as const) {
      const result = await agentCrmPrincipal(AGENT, deps(link as never, secret));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("service");
      expect(result).not.toHaveProperty("principal");
    }
  });

  /** An inactive link and an absent one lead an admin to different places. */
  it("distinguishes an unconfigured agent from a broken link", async () => {
    const none = await agentCrmPrincipal(AGENT, deps(null));
    const broken = await agentCrmPrincipal(AGENT, deps(VERIFIED_LINK, null));
    expect(none.ok).toBe(false);
    expect(broken.ok).toBe(false);
    if (none.ok || broken.ok) return;
    expect(none.problem).not.toBe(broken.problem);
  });
});

describe("what the agent is told", () => {
  it.each<AgentCredentialProblem>(["not_configured", "inactive", "missing_secret"])(
    "explains %s without naming a credential",
    (problem) => {
      const sentence = explainAgentCredentialProblem(problem);
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(/password|secret value|token/i);
      // Says who fixes it, so the agent does not retry forever.
      expect(sentence).toMatch(/administrator/i);
    },
  );

  it("does not blame the order for an unconfigured account", () => {
    expect(explainAgentCredentialProblem("not_configured")).toMatch(/your account/i);
  });
});

/* ------------------------------------------------------------------------- */
/* The secret does not escape the module                                     */
/* ------------------------------------------------------------------------- */

describe("the credential path cannot leak", () => {
  it("never logs, and stores no password in the mapping table", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    const source = readFileSync(
      fileURLToPath(new URL("../agent-credentials.server.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)/);

    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../supabase/migrations/20260824090000_shams_crm_agent_links.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const table = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS public.shams_crm_agent_links"),
      migration.indexOf("COMMENT ON TABLE"),
    );
    // Column definitions only. The prose explains *why* there is no password
    // column, so the word appears in the comments on purpose — it is the
    // declarations that must not name one, not the documentation.
    const columns = table
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("--") === -1 ? undefined : line.indexOf("--")))
      .join("\n");
    // No column can hold a secret — not plaintext, not an encrypted blob.
    for (const forbidden of ["crm_password", "password", "secret_value", "token"]) {
      expect(columns).not.toContain(forbidden);
    }
    // The one secret-adjacent column holds a *name*, and says so in its type.
    expect(columns).toMatch(/vault_key\s+text/);
    // And no client role may read the table or ask the database for a password.
    expect(migration).toContain(
      "REVOKE ALL ON public.shams_crm_agent_links FROM anon, authenticated",
    );
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.shams_crm_agent_secret\(uuid\) FROM public, anon, authenticated/,
    );
    // An active link must be verified and have somewhere to read a password from.
    expect(migration).toContain("shams_crm_agent_links_active_is_verified");
    // Two agents cannot share one CRM account.
    expect(migration).toContain("shams_crm_agent_links_username_unique");
  });
});
