/**
 * Moving agent credentials from the workbook into Vault. Server-only.
 *
 * Run once per change to the mapping, by an administrator. Every password takes
 * exactly one journey — workbook → one CRM login → Vault — and no other. Nothing
 * here logs, returns or formats one, and `AgentSetupRow` has no field that could
 * carry one back to a browser.
 *
 * ## Nothing is stored unverified
 *
 * A credential that does not authenticate is worse than a missing one: it looks
 * configured and fails at the moment an agent is trying to send a delivery. So
 * each row is proved against the CRM first — `/login` proves the password,
 * `/me` proves the account is the right one, is active, and can dispatch — and
 * only then written.
 *
 * ## And nothing is guessed
 *
 * The MilaPortal agent is resolved by email, then cross-checked against
 * `full_name` and `agent_code`. A mismatch stops that row: attaching a CRM
 * credential to the wrong person would put their name on somebody else's
 * deliveries, which is the exact failure this whole feature exists to prevent.
 *
 * ## Safe to run again
 *
 * `shams_crm_store_agent_secret` updates an existing Vault entry rather than
 * adding a second, and the upsert is keyed on `user_id` — one row and one secret
 * per agent however many times this runs. A row that fails is reported and left
 * **exactly as it was**: there is no write on the failure path, so a CRM outage
 * cannot deactivate a set of working agents.
 */

import { readAgentWorkbook, normaliseTeam, type AgentWorkbookRow } from "./agent-workbook.server";

const CRM_BASE = "https://shams-crm.cloud";
const TIMEOUT_MS = 30_000;

/** Why a row was not stored. Classifications only — never an upstream message. */
export type AgentSetupFailure =
  /** No MilaPortal account matches the email. */
  | "unmapped"
  /** The workbook name or agent code disagrees with the MilaPortal profile. */
  | "name_mismatch"
  | "agent_code_mismatch"
  /** The row is missing an email, a username or a password. */
  | "not_configured"
  /** The CRM refused the credential. */
  | "auth_failed"
  /** `/me` returned a different username than the workbook claims. */
  | "username_mismatch"
  | "inactive"
  | "missing_permission"
  | "crm_unreachable"
  /** The write failed. The credential is not stored and not usable. */
  | "vault_write_failed"
  | "db_write_failed"
  /** That CRM account is already linked to a different MilaPortal agent. */
  | "crm_username_already_linked";

/** One row's outcome. Carries no credential — by shape, not by discipline. */
export interface AgentSetupRow {
  /** The agent's name, or the sheet row when there is not one. */
  agent: string;
  status: "stored" | "verified" | "failed";
  /** `verified` on success, otherwise the classification. */
  reason: string;
  /** From `/me`. An identifier the CRM already publishes, never a secret. */
  crmUserId: string | null;
}

export interface AgentSetupSummary {
  verified: number;
  stored: number;
  failed: number;
  rows: AgentSetupRow[];
}

/** The Supabase surface used. Service-role; RLS denies every client role. */
export interface AgentSetupDeps {
  /** email (lowercased) → the MilaPortal profile. */
  loadPortalAgents: () => Promise<
    Map<string, { id: string; full_name?: string | null; agent_code?: string | null }>
  >;
  /** `/login` then `/me`. Returns a classification and the CRM id, never a token. */
  verifyCrm: (
    username: string,
    password: string,
  ) => Promise<{ ok: true; crmUserId: string | null } | { ok: false; reason: AgentSetupFailure }>;
  /** `shams_crm_store_agent_secret`. Returns the Vault *name*, never the value. */
  storeSecret: (userId: string, password: string) => Promise<string | null>;
  /** Upserts `shams_crm_agent_links`. Metadata only. */
  upsertLink: (row: {
    user_id: string;
    crm_username: string;
    crm_user_id: string | null;
    team: string | null;
    vault_key: string;
  }) => Promise<{ ok: true } | { ok: false; duplicate: boolean }>;
  readWorkbook?: () => AgentWorkbookRow[];
}

/**
 * Log in and read `/me`.
 *
 * The token is local to this function and is neither returned nor stored — the
 * only thing that leaves is a classification and the CRM's own user id. Upstream
 * bodies are never surfaced: they can carry a username, and these outcomes end
 * up on an admin screen.
 */
export async function verifyAgentAgainstCrm(
  username: string,
  password: string,
): Promise<{ ok: true; crmUserId: string | null } | { ok: false; reason: AgentSetupFailure }> {
  let token: string | undefined;
  try {
    const res = await fetch(`${CRM_BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password, client_name: "milaserv-portal-setup" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      return { ok: false, reason: "auth_failed" };
    }
    if (!res.ok) return { ok: false, reason: "crm_unreachable" };
    const body = (await res.json().catch(() => null)) as { session_token?: string } | null;
    token = body?.session_token;
    if (!token) return { ok: false, reason: "auth_failed" };
  } catch {
    return { ok: false, reason: "crm_unreachable" };
  }

  try {
    const res = await fetch(`${CRM_BASE}/me`, {
      headers: { accept: "application/json", "X-Session-Token": token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: "crm_unreachable" };
    const me = (await res.json().catch(() => null)) as {
      id?: unknown;
      username?: unknown;
      active?: unknown;
      allowed_features?: unknown;
    } | null;
    if (!me) return { ok: false, reason: "crm_unreachable" };

    if (
      String(me.username ?? "")
        .trim()
        .toLowerCase() !== username.toLowerCase()
    ) {
      return { ok: false, reason: "username_mismatch" };
    }
    if (me.active === false) return { ok: false, reason: "inactive" };
    const features = Array.isArray(me.allowed_features) ? me.allowed_features : [];
    if (!features.includes("alshrouq_delivery")) return { ok: false, reason: "missing_permission" };

    return { ok: true, crmUserId: me.id == null ? null : String(me.id) };
  } catch {
    return { ok: false, reason: "crm_unreachable" };
  }
}

/**
 * Verify every workbook row and store the ones that pass.
 *
 * `dryRun` proves the whole mapping — resolution, cross-checks, CRM login — and
 * writes nothing, so the setup can be confirmed before anything is committed to
 * Vault.
 */
export async function setUpAgentCrmLinks(
  deps: AgentSetupDeps,
  options: { dryRun?: boolean } = {},
): Promise<AgentSetupSummary> {
  const rows = (deps.readWorkbook ?? readAgentWorkbook)();
  const portal = await deps.loadPortalAgents();

  const results: AgentSetupRow[] = [];
  let verified = 0;
  let stored = 0;

  for (const row of rows) {
    const agent = row.name || `row ${row.rowNumber}`;
    const fail = (reason: AgentSetupFailure) =>
      results.push({ agent, status: "failed" as const, reason, crmUserId: null });

    if (!row.email || !row.crmUsername || !row.crmPassword) {
      fail("not_configured");
      continue;
    }

    const profile = portal.get(row.email.toLowerCase());
    if (!profile?.id) {
      fail("unmapped");
      continue;
    }

    // Trimmed on both sides: at least one profile carries a leading space, and a
    // whitespace difference is not a different person.
    const portalName = String(profile.full_name ?? "")
      .trim()
      .toLowerCase();
    if (portalName && portalName !== row.name.trim().toLowerCase()) {
      fail("name_mismatch");
      continue;
    }
    const portalCode = String(profile.agent_code ?? "").trim();
    if (row.agentCode && portalCode && portalCode !== row.agentCode) {
      fail("agent_code_mismatch");
      continue;
    }

    const check = await deps.verifyCrm(row.crmUsername, row.crmPassword);
    if (!check.ok) {
      fail(check.reason);
      continue;
    }
    verified += 1;

    if (options.dryRun) {
      results.push({
        agent,
        status: "verified",
        reason: "dry run — nothing stored",
        crmUserId: check.crmUserId,
      });
      continue;
    }

    // Vault first: the CHECK constraint requires an active link to carry a
    // `vault_key`, so a failure between the two leaves a row that is simply not
    // active rather than one that claims to be usable and is not.
    const vaultKey = await deps.storeSecret(profile.id, row.crmPassword);
    if (!vaultKey) {
      fail("vault_write_failed");
      continue;
    }

    const written = await deps.upsertLink({
      user_id: profile.id,
      crm_username: row.crmUsername,
      crm_user_id: check.crmUserId,
      team: normaliseTeam(row.team),
      vault_key: vaultKey,
    });
    if (!written.ok) {
      fail(written.duplicate ? "crm_username_already_linked" : "db_write_failed");
      continue;
    }

    stored += 1;
    results.push({ agent, status: "stored", reason: "verified", crmUserId: check.crmUserId });
  }

  return {
    verified,
    stored,
    failed: results.filter((r) => r.status === "failed").length,
    rows: results,
  };
}
