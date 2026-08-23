#!/usr/bin/env node
/**
 * One-time (and repeatable) setup of per-agent Shams CRM identities.
 *
 * Shams CRM stamps `created_by_user_id` and `created_by_username` from the
 * authenticated session and accepts no caller-supplied attribution, so the only
 * way an AlShrouq order is recorded against the agent who made it is to log in
 * as that agent. This script is what puts those credentials somewhere the server
 * can reach them.
 *
 * ## It runs on your machine, deliberately
 *
 * The passwords never leave it. They are read from the workbook, used for one
 * CRM login each, handed to Vault through the existing `SECURITY DEFINER`
 * function, and dropped. They are never printed, never logged, never written to
 * a file, and never placed in a normal database column — the mapping table has
 * no column that could hold one.
 *
 * ## What it does per agent
 *
 *   workbook row → resolve the MilaPortal user by email
 *                → cross-check full_name and agent_code
 *                → CRM /login  (verifies the password is real)
 *                → CRM /me     (verifies username, active, alshrouq_delivery)
 *                → vault: shams_crm_store_agent_secret()
 *                → upsert shams_crm_agent_links (metadata only)
 *
 * Nothing is stored unless every check passes. One agent failing does not stop
 * the batch — the rest are processed and the failure is reported by name and
 * reason, never with a credential.
 *
 * ## Idempotent
 *
 * Re-running it re-verifies and updates in place. `shams_crm_store_agent_secret`
 * updates the existing Vault entry rather than creating a second one, and the
 * upsert is keyed on `user_id`, so there is exactly one row and one secret per
 * agent however many times this runs. An agent that fails verification on a
 * re-run is reported and left **as it was** — a transient CRM outage must not
 * deactivate seven working agents.
 *
 * ## Requires
 *
 *   SUPABASE_URL                  your project URL
 *   SUPABASE_SERVICE_ROLE_KEY     service role key (never the publishable one)
 *   SHAMS_CRM_AGENT_WORKBOOK      absolute path to the mapping workbook
 *
 * Run:
 *   node scripts/shams-crm-agent-setup.mjs
 *   node scripts/shams-crm-agent-setup.mjs --dry-run   (verify only, store nothing)
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const CRM_BASE = "https://shams-crm.cloud";
const DRY_RUN = process.argv.includes("--dry-run");

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
  return value;
}

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const WORKBOOK = env("SHAMS_CRM_AGENT_WORKBOOK");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* -------------------------------------------------------------------------- */
/* Workbook                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The rows, as the agreed template spells them.
 *
 * Read straight from the path given — the workbook stays wherever you keep it
 * and is never copied into the repository.
 */
function readWorkbook(path) {
  const book = XLSX.readFile(path);
  const sheetName = book.SheetNames.includes("agents") ? "agents" : book.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: "" });

  return rows
    .map((r, i) => ({
      // +2: one for the header row, one for 1-based numbering.
      rowNumber: i + 2,
      email: String(r.milaportal_email ?? "").trim(),
      name: String(r.agent_name ?? "").trim(),
      team: String(r.team ?? "").trim(),
      agentCode: String(r.agent_code ?? "").trim(),
      crmUsername: String(r.crm_username ?? "").trim(),
      // Not trimmed: a trailing space in a password is meaningful.
      crmPassword: String(r.crm_password ?? ""),
    }))
    .filter((r) => r.email || r.crmUsername);
}

/** `Customer Care` → `customer_care`. The workbook uses display labels. */
function normaliseTeam(team) {
  const key = team.toLowerCase().replace(/\s+/g, "_");
  return key === "customer_care" || key === "telesales" ? key : null;
}

/* -------------------------------------------------------------------------- */
/* MilaPortal identity                                                         */
/* -------------------------------------------------------------------------- */

/**
 * email → { id, full_name, agent_code }.
 *
 * Paginated for the same reason `listAuthEmails` in admin.functions.ts is: a
 * single large `perPage` silently returns only the first page.
 */
async function loadPortalAgents() {
  const byEmail = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list MilaPortal users: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) if (u.email) byEmail.set(u.email.toLowerCase(), { id: u.id });
    if (users.length < 200) break;
  }

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id,full_name,agent_code,active");
  if (error) throw new Error(`Could not read profiles: ${error.message}`);

  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  for (const entry of byEmail.values()) Object.assign(entry, byId.get(entry.id) ?? {});
  return byEmail;
}

/* -------------------------------------------------------------------------- */
/* Shams CRM verification                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Log in and read `/me`.
 *
 * Returns a classification, never a body and never a token. Nothing that comes
 * back from the CRM is printed by the caller — an upstream message can carry a
 * username, and these end up on a terminal somebody screenshots.
 */
async function verifyCrm(username, password) {
  let token;
  try {
    const res = await fetch(`${CRM_BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password, client_name: "milaserv-portal-setup" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      return { ok: false, reason: "auth_failed" };
    }
    if (!res.ok) return { ok: false, reason: "crm_unreachable" };
    const body = await res.json().catch(() => null);
    token = body?.session_token;
    if (!token) return { ok: false, reason: "auth_failed" };
  } catch {
    return { ok: false, reason: "crm_unreachable" };
  }

  try {
    const res = await fetch(`${CRM_BASE}/me`, {
      headers: { accept: "application/json", "X-Session-Token": token },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: "crm_unreachable" };
    const me = await res.json().catch(() => null);
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
    if (!features.includes("alshrouq_delivery")) {
      return { ok: false, reason: "missing_permission" };
    }
    return { ok: true, crmUserId: me.id == null ? null : String(me.id) };
  } catch {
    return { ok: false, reason: "crm_unreachable" };
  } finally {
    // The token is function-scoped and goes out of scope here. It is never
    // returned, stored or printed.
    token = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Storage — Vault first, then metadata                                        */
/* -------------------------------------------------------------------------- */

/**
 * Vault, then the row.
 *
 * In that order deliberately: the CHECK constraint requires an active link to
 * carry a `vault_key`, so a failure between the two leaves a row that is simply
 * not active rather than one that claims to be usable and is not.
 */
async function store(agent, row, crmUserId) {
  const { data: vaultKey, error: vaultError } = await supabase.rpc("shams_crm_store_agent_secret", {
    _user_id: agent.id,
    _password: row.crmPassword,
  });
  if (vaultError) return { ok: false, reason: "vault_write_failed" };

  const { error: upsertError } = await supabase.from("shams_crm_agent_links").upsert(
    {
      user_id: agent.id,
      crm_username: row.crmUsername,
      crm_user_id: crmUserId,
      team: normaliseTeam(row.team),
      active: true,
      verified_at: new Date().toISOString(),
      last_error: null,
      vault_key: vaultKey,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (upsertError) {
    // A unique violation here means the CRM username is already linked to a
    // different agent, which is a mapping error a person must resolve — two
    // agents sharing one CRM account would make attribution ambiguous.
    const duplicate = String(upsertError.code) === "23505";
    return { ok: false, reason: duplicate ? "crm_username_already_linked" : "db_write_failed" };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function main() {
  const rows = readWorkbook(WORKBOOK);
  const portal = await loadPortalAgents();

  const results = [];
  let verified = 0;
  let stored = 0;

  for (const row of rows) {
    const label = row.name || row.email || `row ${row.rowNumber}`;
    const fail = (reason) => results.push({ label, status: "failed", reason });

    if (!row.email || !row.crmUsername || !row.crmPassword) {
      fail("not_configured");
      continue;
    }

    const agent = portal.get(row.email.toLowerCase());
    if (!agent?.id) {
      fail("unmapped");
      continue;
    }

    // Never trust name similarity alone — but a mismatch is still a stop, so a
    // credential is not attached to the wrong person. Trimmed: at least one
    // profile carries a leading space.
    const portalName = String(agent.full_name ?? "")
      .trim()
      .toLowerCase();
    if (portalName && portalName !== row.name.trim().toLowerCase()) {
      fail("name_mismatch");
      continue;
    }
    const portalCode = String(agent.agent_code ?? "").trim();
    if (row.agentCode && portalCode && portalCode !== row.agentCode) {
      fail("agent_code_mismatch");
      continue;
    }

    const check = await verifyCrm(row.crmUsername, row.crmPassword);
    if (!check.ok) {
      fail(check.reason);
      continue;
    }
    verified += 1;

    if (DRY_RUN) {
      results.push({ label, status: "verified", reason: "dry-run, nothing stored" });
      continue;
    }

    const written = await store(agent, row, check.crmUserId);
    if (!written.ok) {
      fail(written.reason);
      continue;
    }
    stored += 1;
    results.push({ label, status: "stored", reason: "verified" });
  }

  const failed = results.filter((r) => r.status === "failed").length;

  console.log(`\nVerified: ${verified}`);
  console.log(`Stored:   ${stored}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Failed:   ${failed}\n`);

  const width = Math.max(10, ...results.map((r) => r.label.length));
  console.log(`${"Agent".padEnd(width)} | Status   | Reason`);
  console.log(`${"-".repeat(width)}-+----------+--------------------------`);
  for (const r of results) {
    console.log(`${r.label.padEnd(width)} | ${r.status.padEnd(8)} | ${r.reason}`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  // The message only ever comes from this file's own throws, which name no
  // credential. An unexpected error prints its name, not its payload.
  console.error(`Setup failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(2);
});
