#!/usr/bin/env node
/**
 * Permission parity guard (H-4).
 *
 * Authorization is defined in TWO places that must agree:
 *   - SQL  : public.has_permission(uuid, text) — the per-role `_allowed` /
 *            `_defaults` arrays (+ the shared `_auditor_safe` list) in the
 *            newest supabase/migrations/*.sql that (re)defines the function.
 *   - TS   : src/lib/permissions.ts — ROLE_ALLOWED_PERMS / ROLE_DEFAULTS and the
 *            AUDITOR_PERMS / SUPERVISOR_* arrays they are built from.
 *
 * If these drift, the UI and the database enforce different rules. This script
 * parses both sources (as text — it never executes app code, needs no test
 * runner, and adds no dependencies) and asserts the per-role permission SETS are
 * identical. It exits non-zero on any mismatch so it can gate CI / pre-commit.
 *
 * It changes no permissions. To intentionally change a permission, edit BOTH
 * sources; this guard only fails when they disagree.
 *
 * Run: `npm run check:permissions`
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_PATH = join(ROOT, "src", "lib", "permissions.ts");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

// Roles whose permission arrays are enumerated in SQL (owner/admin short-circuit
// to full access on both sides and have no array to compare).
//
// `call_center` was removed here when the role was retired
// (20260725001000): its branch is gone from has_permission() and from
// permissions.ts, so there is no longer a pair of arrays to compare. The enum
// value still exists in Postgres (values cannot be dropped without recreating the
// type) but nothing may hold it, and has_permission() now denies it by default
// via the ELSE arm.
const ENUMERATED_ROLES = ["supervisor", "customer_care", "telesales", "auditor"];

function fail(msg) {
  console.error(`\n✖ Permission parity check FAILED\n\n${msg}\n`);
  process.exit(1);
}

/** Extract quoted permission keys (single or double quoted) from a text block. */
function keysIn(block) {
  const out = [];
  const re = /['"]([a-z_]+)['"]/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** Compare two key lists as sets; returns { ok, onlyA, onlyB }. */
function diffSets(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  const onlyA = [...sa].filter((k) => !sb.has(k)).sort();
  const onlyB = [...sb].filter((k) => !sa.has(k)).sort();
  return { ok: onlyA.length === 0 && onlyB.length === 0, onlyA, onlyB };
}

// ---------------------------------------------------------------------------
// SQL side
// ---------------------------------------------------------------------------

function loadSqlDefinition() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // timestamp-prefixed => lexical sort is chronological
  // Newest migration that (re)defines has_permission is authoritative.
  let chosen = null;
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    if (/CREATE OR REPLACE FUNCTION\s+public\.has_permission/i.test(text)) chosen = { f, text };
  }
  if (!chosen) fail(`No migration defines public.has_permission in ${MIGRATIONS_DIR}`);
  return chosen;
}

function parseSql(text, file) {
  // Guard: owner/admin must still short-circuit to full access.
  if (!/_role IN \('admin'::public\.app_role, 'owner'::public\.app_role\)[\s\S]*?RETURN true/i.test(text)) {
    fail(`SQL has_permission (${file}) no longer short-circuits owner/admin to full access.`);
  }

  const auditorSafeMatch = text.match(/_auditor_safe\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/);
  if (!auditorSafeMatch) fail(`Could not find _auditor_safe ARRAY in SQL (${file}).`);
  const auditorSafe = keysIn(auditorSafeMatch[1]);

  const allowed = {};
  const defaults = {};
  for (const role of ENUMERATED_ROLES) {
    if (role === "auditor") {
      // auditor branch assigns _allowed := _auditor_safe; _defaults := _auditor_safe;
      allowed[role] = auditorSafe;
      defaults[role] = auditorSafe;
      continue;
    }
    // The lookbehind matters: `_role` must be the whole variable, not the tail of
    // a longer identifier. Without it, an unrelated column named e.g. `target_role`
    // elsewhere in the migration matches `_role = 'telesales'`, and the lazy scan
    // then runs forward into a DIFFERENT role's arrays — silently comparing the
    // wrong permission sets. A parity guard that can mis-anchor is worse than none.
    const re = new RegExp(
      `(?<![A-Za-z0-9_])_role\\s*=\\s*'${role}'[\\s\\S]*?_allowed\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\][\\s\\S]*?_defaults\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\]`,
    );
    const m = text.match(re);
    if (!m) fail(`Could not parse _allowed/_defaults for role '${role}' in SQL (${file}).`);
    allowed[role] = keysIn(m[1]);
    defaults[role] = keysIn(m[2]);
  }
  return { allowed, defaults, auditorSafe };
}

// ---------------------------------------------------------------------------
// TypeScript side
// ---------------------------------------------------------------------------

/** Grab a top-level `const NAME... = [ ... ];` string array by name. */
function namedArray(text, name) {
  const re = new RegExp(`const\\s+${name}\\s*:[^=]*=\\s*\\[([\\s\\S]*?)\\]`);
  const m = text.match(re);
  if (!m) fail(`Could not find TS array const ${name} in permissions.ts`);
  return keysIn(m[1]);
}

/** Slice the body of a `const NAME... = { ... };` object literal. */
function objectBody(text, name) {
  const start = text.search(new RegExp(`const\\s+${name}\\s*:[^=]*=\\s*\\{`));
  if (start === -1) fail(`Could not find TS object const ${name} in permissions.ts`);
  const braceStart = text.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(braceStart + 1, i);
    }
  }
  fail(`Unbalanced braces reading TS object ${name}`);
}

/** Read one role entry's inline `[ ... ]` array from an object body. */
function inlineRoleArray(objBody, role, objName) {
  const re = new RegExp(`\\b${role}\\s*:\\s*\\[([\\s\\S]*?)\\]`);
  const m = objBody.match(re);
  if (!m) fail(`Role '${role}' is not an inline array in ${objName} (permissions.ts).`);
  return keysIn(m[1]);
}

function parseTs(text) {
  const auditorPerms = namedArray(text, "AUDITOR_PERMS");
  const supervisorAllowed = namedArray(text, "SUPERVISOR_ALLOWED_PERMS");
  const supervisorDefaults = namedArray(text, "SUPERVISOR_DEFAULT_PERMS");

  const allowedBody = objectBody(text, "ROLE_ALLOWED_PERMS");
  const defaultsBody = objectBody(text, "ROLE_DEFAULTS");

  // ROLE_ALLOWED_PERMS.supervisor / ROLE_DEFAULTS.supervisor reference the named
  // SUPERVISOR_* arrays rather than inlining, so they are read from those.
  const allowed = {
    supervisor: supervisorAllowed,
    // ROLE_ALLOWED_PERMS.auditor === AUDITOR_SAFE_READ_PERMS === [...AUDITOR_PERMS]
    auditor: auditorPerms,
    customer_care: inlineRoleArray(allowedBody, "customer_care", "ROLE_ALLOWED_PERMS"),
    telesales: inlineRoleArray(allowedBody, "telesales", "ROLE_ALLOWED_PERMS"),
  };
  const defaults = {
    supervisor: supervisorDefaults,
    auditor: auditorPerms, // ROLE_DEFAULTS.auditor === AUDITOR_PERMS
    customer_care: inlineRoleArray(defaultsBody, "customer_care", "ROLE_DEFAULTS"),
    telesales: inlineRoleArray(defaultsBody, "telesales", "ROLE_DEFAULTS"),
  };
  return { allowed, defaults, auditorSafe: auditorPerms };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function main() {
  const { f: sqlFile, text: sqlText } = loadSqlDefinition();
  const sql = parseSql(sqlText, sqlFile);
  const ts = parseTs(readFileSync(TS_PATH, "utf8"));

  const problems = [];
  const check = (label, aList, bList) => {
    const d = diffSets(aList, bList);
    if (!d.ok) {
      problems.push(
        `${label}\n    only in SQL: [${d.onlyA.join(", ") || "—"}]\n    only in TS:  [${d.onlyB.join(", ") || "—"}]`,
      );
    }
  };

  // Shared auditor read list.
  check("_auditor_safe  vs  AUDITOR_PERMS", sql.auditorSafe, ts.auditorSafe);

  for (const role of ENUMERATED_ROLES) {
    check(`${role}: _allowed  vs  ROLE_ALLOWED_PERMS`, sql.allowed[role], ts.allowed[role]);
    check(`${role}: _defaults vs  ROLE_DEFAULTS`, sql.defaults[role], ts.defaults[role]);
  }

  if (problems.length > 0) {
    fail(
      `SQL (${sqlFile}) and src/lib/permissions.ts disagree:\n\n  ` +
        problems.join("\n\n  ") +
        `\n\nEdit BOTH sources so the role permission sets match, then re-run.`,
    );
  }

  const roleCount = ENUMERATED_ROLES.length;
  console.log(
    `✔ Permission parity OK — ${roleCount} roles × {allowed, defaults} + auditor-safe list ` +
      `match between SQL (${sqlFile}) and src/lib/permissions.ts`,
  );
}

main();
