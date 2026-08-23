/**
 * One agent's Shams CRM identity. Server-only.
 *
 * Shams CRM stamps `created_by_user_id` and `created_by_username` from the
 * authenticated session and accepts no caller-supplied attribution, so the only
 * way an AlShrouq order is recorded against the agent who made it is to log in
 * as that agent. This module is what turns a verified MilaPortal user id into
 * the `CrmPrincipal` that makes that possible.
 *
 * ## What it will not do
 *
 * Fall back. A missing, inactive or unreadable credential returns a *reason*,
 * never the service principal — sending under the deployment's own account
 * would succeed, look fine, and put the wrong person's name on a delivery.
 * That is the failure this whole design exists to prevent, so it is a returned
 * outcome rather than a `catch` somewhere upstream.
 *
 * ## What it never returns
 *
 * The password, to anything but the client that is about to log in with it. It
 * is read from Vault through a `SECURITY DEFINER` function, lives in the
 * returned principal, and is never logged, never persisted outside Vault, and
 * never placed on a response an HTTP handler could serialise.
 */

import type { CrmPrincipal } from "./client.server";

/**
 * Why an agent cannot dispatch. Classifications, never messages from the CRM —
 * an upstream body can carry a username, and these end up on screens.
 */
export type AgentCredentialProblem =
  /** No row at all: this agent has never been linked to a CRM account. */
  | "not_configured"
  /** Linked, but the link is switched off or was never verified. */
  | "inactive"
  /** Linked and active, yet Vault has no secret. A half-finished setup. */
  | "missing_secret";

export type AgentCredentialResult =
  | { ok: true; principal: CrmPrincipal; crmUsername: string; crmUserId: string | null }
  | { ok: false; problem: AgentCredentialProblem };

/** The columns this module reads. Deliberately not a generated row type. */
interface AgentLinkRow {
  crm_username: string | null;
  crm_user_id: string | null;
  active: boolean | null;
  vault_key: string | null;
}

/** The Supabase surface used, so tests need no client. */
export interface AgentCredentialDeps {
  /** Reads `shams_crm_agent_links` for one agent. Service-role only. */
  readLink: (userId: string) => Promise<AgentLinkRow | null>;
  /** `shams_crm_agent_secret(uuid)`. Returns null when there is nothing to read. */
  readSecret: (userId: string) => Promise<string | null>;
}

/**
 * The agent's CRM principal, or why there isn't one.
 *
 * `userId` must be a MilaPortal id the **server** established: either the caller
 * from `requireSupabaseAuth`'s claims, or `orders.agent_id` read from the order
 * after the caller passed that order's edit check. It is never a form field — a
 * caller who could name the agent could dispatch under somebody else's CRM
 * identity, which is precisely the thing the CRM's own refusal of
 * caller-supplied attribution is meant to make impossible.
 */
export async function agentCrmPrincipal(
  userId: string,
  deps: AgentCredentialDeps,
): Promise<AgentCredentialResult> {
  const link = await deps.readLink(userId);
  if (!link || !link.crm_username) return { ok: false, problem: "not_configured" };
  if (link.active !== true || !link.vault_key) return { ok: false, problem: "inactive" };

  const password = await deps.readSecret(userId);
  // Active with no secret is a broken link, not an unconfigured agent, and the
  // two lead an admin to different places — so they are told apart.
  if (!password) return { ok: false, problem: "missing_secret" };

  return {
    ok: true,
    principal: {
      kind: "agent",
      agentId: userId,
      username: link.crm_username,
      password,
    },
    crmUsername: link.crm_username,
    crmUserId: link.crm_user_id ?? null,
  };
}

/**
 * What the person dispatching is told when the CRM identity cannot be used.
 *
 * Says what to do about it and names no credential. "Not configured" is the
 * common case on a deployment mid-rollout and must not read as a fault of the
 * order — the order is fine; a CRM link is what is missing.
 *
 * Phrased around **the order's agent**, not "your account", because the identity
 * is the assignee's and the reader is often not them: a supervisor handing an
 * order to an agent was previously told to get their own account linked, which
 * is neither the problem nor something they should do.
 */
export function explainAgentCredentialProblem(problem: AgentCredentialProblem): string {
  switch (problem) {
    case "not_configured":
      return "The agent this order is assigned to has no Shams CRM account. An administrator needs to link it before the order can be handed over.";
    case "inactive":
      return "The Shams CRM link for this order's agent is switched off, so AlShrouq deliveries cannot be sent for it. An administrator can re-verify it.";
    case "missing_secret":
      return "The Shams CRM link for this order's agent is incomplete and cannot be used. An administrator needs to re-enter the CRM credentials.";
  }
}

/**
 * The default deps, bound to the service-role client.
 *
 * Imported lazily by callers so this module stays free of a Supabase import at
 * module scope — the same shape the server functions already use.
 */
export function supabaseAgentCredentialDeps(supabaseAdmin: {
  from: (t: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}): AgentCredentialDeps {
  return {
    async readLink(userId) {
      const { data } = await supabaseAdmin
        .from("shams_crm_agent_links")
        .select("crm_username,crm_user_id,active,vault_key")
        .eq("user_id", userId)
        .maybeSingle();
      return (data as AgentLinkRow | null) ?? null;
    },
    async readSecret(userId) {
      const { data, error } = await supabaseAdmin.rpc("shams_crm_agent_secret", {
        _user_id: userId,
      });
      if (error) return null;
      return typeof data === "string" && data.length > 0 ? data : null;
    },
  };
}
