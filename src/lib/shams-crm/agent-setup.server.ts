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
 *
 * ## And cheap to run again
 *
 * An agent who already holds a usable link to the *same* CRM account is skipped
 * before the CRM is contacted at all, so re-running after a one-row change to
 * the workbook verifies that one row rather than the whole sheet.
 *
 * That is a safety property and not merely an efficiency one. Verifying a row
 * means attempting a login, and a login attempted with a credential the workbook
 * no longer holds — a scrubbed column, a rotated password nobody copied back —
 * is a *failed* login against a working agent's real CRM account. Repeated over
 * a sheet on every run, the accounts being knocked on are precisely the ones
 * that still work. Skipping them leaves them alone.
 *
 * The skip is deliberately blind to the password: nothing here can read the
 * stored one back to compare against, so a rotated password in the workbook is
 * invisible to it. `force` exists for exactly that case and is the only way to
 * push a changed credential through.
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
  /**
   * `skipped` means this agent already holds a usable link to this same CRM
   * account, so nothing was verified and nothing was written. It is a success
   * rather than a milder `failed`: the mapping the row describes is already in
   * force, which is the state the run was trying to reach.
   */
  status: "stored" | "verified" | "failed" | "skipped";
  /** `verified` on success, otherwise the classification. */
  reason: string;
  /** From `/me`. An identifier the CRM already publishes, never a secret. */
  crmUserId: string | null;
}

export interface AgentSetupSummary {
  verified: number;
  stored: number;
  failed: number;
  /** Rows left untouched because the link they describe is already in force. */
  skipped: number;
  rows: AgentSetupRow[];
}

/**
 * A link as it stands before this run, for deciding whether to leave it alone.
 *
 * Metadata only. There is no password here and no way to reach one: the point of
 * the comparison is which CRM *account* an agent is attached to, which is public
 * within the deployment, not whether the credential still matches.
 */
export interface ExistingAgentLink {
  crm_username: string | null;
  crm_user_id: string | null;
  active: boolean | null;
  vault_key: string | null;
  verified_at: string | null;
}

/** The Supabase surface used. Service-role; RLS denies every client role. */
export interface AgentSetupDeps {
  /** email (lowercased) → the MilaPortal profile. */
  loadPortalAgents: () => Promise<
    Map<string, { id: string; full_name?: string | null; agent_code?: string | null }>
  >;
  /**
   * `user_id` → the link that agent already holds, for every linked agent.
   *
   * Read once for the whole run rather than per row: the sheet is small, but a
   * query per row would make the cost of a re-run scale with the thing this
   * change exists to stop scaling.
   */
  loadExistingLinks: () => Promise<Map<string, ExistingAgentLink>>;
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
 * Is this link one the dispatch path could actually use right now?
 *
 * The same three conditions `agentCrmPrincipal` applies, in the same order, and
 * for the same reason: a link that fails any of them is not a working mapping,
 * so re-verifying it is repair rather than redundant work. Kept deliberately in
 * step with that module — a link this says to leave alone must be one dispatch
 * can use, or a run would "skip" an agent who cannot send anything.
 */
function isUsableLink(link: ExistingAgentLink | undefined): link is ExistingAgentLink {
  return (
    !!link && !!link.crm_username && link.active === true && !!link.vault_key && !!link.verified_at
  );
}

/**
 * The same CRM account, ignoring case.
 *
 * The CRM itself treats usernames case-insensitively — `verifyAgentAgainstCrm`
 * compares `/me` against the workbook lowercased — so `Ahmed` and `ahmed` are
 * one account, and re-verifying because somebody changed a capital letter in a
 * spreadsheet would defeat the point. A genuinely different username is a
 * different account and is verified in full.
 */
function sameCrmAccount(stored: string | null, fromWorkbook: string): boolean {
  if (!stored || !fromWorkbook) return false;
  return stored.trim().toLowerCase() === fromWorkbook.trim().toLowerCase();
}

/**
 * Verify every workbook row and store the ones that pass.
 *
 * `dryRun` proves the whole mapping — resolution, cross-checks, CRM login — and
 * writes nothing, so the setup can be confirmed before anything is committed to
 * Vault.
 *
 * `force` re-verifies rows that would otherwise be skipped. It is what a
 * credential rotation needs: a new password under an unchanged username is
 * indistinguishable from no change at all to anything this function can read.
 */
export async function setUpAgentCrmLinks(
  deps: AgentSetupDeps,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<AgentSetupSummary> {
  const rows = (deps.readWorkbook ?? readAgentWorkbook)();
  const portal = await deps.loadPortalAgents();
  const links = await deps.loadExistingLinks();

  const results: AgentSetupRow[] = [];
  let verified = 0;
  let stored = 0;
  let skipped = 0;

  for (const row of rows) {
    const agent = row.name || `row ${row.rowNumber}`;
    const fail = (reason: AgentSetupFailure) =>
      results.push({ agent, status: "failed" as const, reason, crmUserId: null });

    // An email is what resolves the row to a person, so it is checked before
    // anything can be looked up. The username and password are checked *after*
    // the skip below: an agent whose link already works must not be reported as
    // unconfigured merely because the sheet's credential columns have since been
    // scrubbed — that row is fine, and nothing is being asked of it.
    if (!row.email) {
      fail("not_configured");
      continue;
    }

    const profile = portal.get(row.email.toLowerCase());
    if (!profile?.id) {
      fail("unmapped");
      continue;
    }

    /* ---------------------------------------------------------------------- */
    /* ALREADY IN FORCE                                                        */
    /*                                                                         */
    /* Before the CRM is touched, because touching it is the cost being        */
    /* avoided: a login attempted on behalf of an already-linked agent can      */
    /* only either confirm what is already known or fail against that agent's   */
    /* real account. Neither is worth a request.                                */
    /*                                                                         */
    /* The cross-checks below are skipped along with it, and that is correct:   */
    /* they exist to stop a credential being attached to the wrong person, and  */
    /* nothing is being attached. The person→account pair is unchanged from the */
    /* one that was verified when this link was written.                        */
    /* ---------------------------------------------------------------------- */
    const existing = links.get(profile.id);
    if (
      !options.force &&
      isUsableLink(existing) &&
      sameCrmAccount(existing.crm_username, row.crmUsername)
    ) {
      skipped += 1;
      results.push({
        agent,
        status: "skipped",
        reason: "already linked and verified",
        crmUserId: existing.crm_user_id ?? null,
      });
      continue;
    }

    if (!row.crmUsername || !row.crmPassword) {
      fail("not_configured");
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
    skipped,
    rows: results,
  };
}
