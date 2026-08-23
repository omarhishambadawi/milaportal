/**
 * One isolate, many agents — and no agent ever holding another's session.
 *
 * ## Why this is a security test, not a caching one
 *
 * Shams CRM derives `created_by_user_id` and `created_by_username` from the
 * authenticated session, and has confirmed it does not accept caller-supplied
 * attribution. So the session *is* the identity: whichever credential logged in
 * is who the CRM records as having created the order.
 *
 * The client used to hold one module-level `session`. A Worker isolate is
 * long-lived and serves many people, so that single mutable slot meant a request
 * made on behalf of agent B could go out under agent A's token — and be recorded
 * against agent A. Not a stale read; the wrong person's name on a delivery.
 *
 * Sessions are therefore keyed by principal, and these tests pin the properties
 * that keying has to have. The key is always derived from verified claims; there
 * is deliberately no way to pass one in from outside.
 *
 * Nothing here reaches the network — `fetch` is stubbed — and no test contains a
 * real credential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _crmSessionCount,
  _resetCrmSession,
  getCrmSessionToken,
  invalidateCrmSession,
  SERVICE_PRINCIPAL,
  type CrmPrincipal,
} from "@/lib/shams-crm/client.server";

/** Obviously fake, and never a real credential. */
const AGENT_A: CrmPrincipal = {
  kind: "agent",
  agentId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  username: "agent-a@example.test",
  password: "test-only-a",
};
const AGENT_B: CrmPrincipal = {
  kind: "agent",
  agentId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  username: "agent-b@example.test",
  password: "test-only-b",
};

/** Records which username each login used, so attribution is observable. */
let logins: string[];

function stubLogin(tokenFor: (username: string) => string, status = 200) {
  logins = [];
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    logins.push(body.username);
    return {
      status,
      text: async () =>
        JSON.stringify({
          session_token: tokenFor(body.username),
          id: body.username,
          username: body.username,
        }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  _resetCrmSession();
  process.env.SHAMS_CRM_USERNAME = "service@example.test";
  process.env.SHAMS_CRM_PASSWORD = "test-only-service";
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCrmSession();
  delete process.env.SHAMS_CRM_USERNAME;
  delete process.env.SHAMS_CRM_PASSWORD;
});

/* ------------------------------------------------------------------------- */
/* 1 & 2 — each agent authenticates as themselves                            */
/* ------------------------------------------------------------------------- */

describe("each principal logs in as itself", () => {
  it("uses agent A's own credential for agent A", async () => {
    stubLogin((u) => `token-for-${u}`);
    const token = await getCrmSessionToken(AGENT_A);
    expect(token).toBe("token-for-agent-a@example.test");
    expect(logins).toEqual(["agent-a@example.test"]);
  });

  it("uses agent B's own credential for agent B", async () => {
    stubLogin((u) => `token-for-${u}`);
    const token = await getCrmSessionToken(AGENT_B);
    expect(token).toBe("token-for-agent-b@example.test");
    expect(logins).toEqual(["agent-b@example.test"]);
  });

  /** The shared reads keep the deployment credential; nothing about them changed. */
  it("still uses the service credential by default", async () => {
    stubLogin((u) => `token-for-${u}`);
    const token = await getCrmSessionToken();
    expect(token).toBe("token-for-service@example.test");
    expect(logins).toEqual(["service@example.test"]);
  });
});

/* ------------------------------------------------------------------------- */
/* 3 — no agent inherits another's session                                   */
/* ------------------------------------------------------------------------- */

describe("sessions do not leak between principals", () => {
  it("gives A and B different tokens, and logs in once each", async () => {
    stubLogin((u) => `token-for-${u}`);

    const a = await getCrmSessionToken(AGENT_A);
    const b = await getCrmSessionToken(AGENT_B);
    expect(a).not.toBe(b);
    expect(logins).toEqual(["agent-a@example.test", "agent-b@example.test"]);

    // Cached per principal: neither repeat causes a second login, and neither
    // returns the other's token.
    expect(await getCrmSessionToken(AGENT_A)).toBe(a);
    expect(await getCrmSessionToken(AGENT_B)).toBe(b);
    expect(logins).toHaveLength(2);
  });

  /** A's session is never what the service principal gets, and vice versa. */
  it("keeps the service session separate from every agent", async () => {
    stubLogin((u) => `token-for-${u}`);
    const service = await getCrmSessionToken(SERVICE_PRINCIPAL);
    const a = await getCrmSessionToken(AGENT_A);
    expect(service).not.toBe(a);
    expect(_crmSessionCount()).toBe(2);
  });

  /** Concurrent callers for one principal share a login; two do not. */
  it("single-flights per principal rather than globally", async () => {
    stubLogin((u) => `token-for-${u}`);
    const [a1, a2, b1] = await Promise.all([
      getCrmSessionToken(AGENT_A),
      getCrmSessionToken(AGENT_A),
      getCrmSessionToken(AGENT_B),
    ]);
    expect(a1).toBe(a2);
    expect(b1).not.toBe(a1);
    // One login for A despite two concurrent callers, and one for B.
    expect(logins.sort()).toEqual(["agent-a@example.test", "agent-b@example.test"]);
  });
});

/* ------------------------------------------------------------------------- */
/* 11 — a refusal invalidates one principal only                             */
/* ------------------------------------------------------------------------- */

describe("invalidation is scoped", () => {
  it("drops only the named principal's session", async () => {
    stubLogin((u) => `token-for-${u}`);
    await getCrmSessionToken(AGENT_A);
    await getCrmSessionToken(AGENT_B);
    expect(_crmSessionCount()).toBe(2);

    invalidateCrmSession(AGENT_A);
    expect(_crmSessionCount()).toBe(1);

    // B is served from cache — no new login. A logs in again.
    await getCrmSessionToken(AGENT_B);
    expect(logins).toHaveLength(2);
    await getCrmSessionToken(AGENT_A);
    expect(logins).toHaveLength(3);
    expect(logins[2]).toBe("agent-a@example.test");
  });

  /** A failed login for one agent leaves every other session intact. */
  it("does not disturb other principals when one login fails", async () => {
    stubLogin((u) => `token-for-${u}`);
    await getCrmSessionToken(AGENT_B);

    stubLogin(() => "", 401);
    await expect(getCrmSessionToken(AGENT_A)).rejects.toMatchObject({ kind: "auth_failed" });

    // B's session survived A's refusal.
    expect(_crmSessionCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------------- */
/* 10 — a missing credential fails closed, never falls back                  */
/* ------------------------------------------------------------------------- */

describe("a missing agent credential fails closed", () => {
  /**
   * The most important test here. Falling back to the service account would
   * send the order — and record it against the wrong person, silently. It must
   * refuse instead, and say which case it is.
   */
  it("refuses rather than borrowing the service credential", async () => {
    const fetchMock = stubLogin((u) => `token-for-${u}`);
    const noCredential = {
      kind: "agent",
      agentId: "cccccccc-3333-4333-8333-cccccccccccc",
      username: "",
      password: "",
    } as CrmPrincipal;

    await expect(getCrmSessionToken(noCredential)).rejects.toMatchObject({
      kind: "not_configured",
    });
    // Nothing was sent at all — no login attempt under any identity.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(_crmSessionCount()).toBe(0);
  });

  it("says it is the agent that is unconfigured, not the deployment", async () => {
    stubLogin((u) => `token-for-${u}`);
    await getCrmSessionToken(SERVICE_PRINCIPAL).catch(() => null);
    const err = await getCrmSessionToken({
      kind: "agent",
      agentId: "dddddddd-4444-4444-8444-dddddddddddd",
      username: "",
      password: "",
    } as CrmPrincipal).catch((e) => e);
    expect(String(err.message)).toMatch(/agent/i);
    // And never repeats a credential in the message.
    expect(String(err.message)).not.toMatch(/password|token/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Long-lived isolates do not grow without bound                             */
/* ------------------------------------------------------------------------- */

describe("the session cache is bounded", () => {
  it("evicts agent sessions past the cap and keeps the service one", async () => {
    stubLogin((u) => `token-for-${u}`);
    await getCrmSessionToken(SERVICE_PRINCIPAL);

    for (let i = 0; i < 80; i++) {
      await getCrmSessionToken({
        kind: "agent",
        agentId: `agent-${i}`,
        username: `a${i}@example.test`,
        password: "test-only",
      } as CrmPrincipal);
    }

    expect(_crmSessionCount()).toBeLessThanOrEqual(64);
    // The service session is never the one evicted, so the shared reads never
    // pay for a burst of agent logins.
    const before = logins.length;
    await getCrmSessionToken(SERVICE_PRINCIPAL);
    expect(logins).toHaveLength(before);
  });
});

/* ------------------------------------------------------------------------- */
/* 12 — nothing here or in the client can leak a credential                  */
/* ------------------------------------------------------------------------- */

describe("credentials do not escape", () => {
  it("keeps the environment reader private and logs nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../client.server.ts", import.meta.url)),
      "utf8",
    );
    // The one function that holds the password is not exported.
    expect(source).not.toMatch(/export\s+function\s+readCrmEnv/);
    // No logging of any kind in the client.
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)/);
    // The principal type carries a credential, so it must never be serialised.
    expect(source).not.toMatch(/JSON\.stringify\(\s*principal/);
  });
});
