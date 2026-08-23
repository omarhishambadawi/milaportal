/**
 * The agent setup script, checked as source.
 *
 * The script itself is run by a person on their own machine against the live
 * CRM and a real service-role key, so it is not executed here. What *can* be
 * asserted without running it is the set of properties that make it safe to run
 * at all — that it cannot print a credential, cannot write one to a file, and
 * cannot store one anywhere but Vault.
 *
 * These are the same guarantees the migration and the client already carry, and
 * they matter most here because this is the one place in the system that ever
 * holds seven real passwords at once.
 *
 * No real credential appears in this file.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../../../../scripts/shams-crm-agent-setup.mjs", import.meta.url)),
  "utf8",
);

describe("the script cannot leak a credential", () => {
  /** Nothing is printed but the labels and classifications it builds itself. */
  it("never prints a password, a token or a header", () => {
    const logged = [...source.matchAll(/console\.(log|error|warn|info)\(([^\n]*)/g)].map(
      (m) => m[2],
    );
    for (const line of logged) {
      for (const forbidden of ["password", "crmPassword", "token", "session_token", "headers"]) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  /** No file is written at all — no log, no cache, no "temp" JSON. */
  it("writes no files", () => {
    for (const forbidden of [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "createWriteStream",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  /** The workbook is read from wherever it lives, never copied. */
  it("reads the workbook from an environment path and never copies it", () => {
    expect(source).toContain('env("SHAMS_CRM_AGENT_WORKBOOK")');
    expect(source).not.toContain("copyFile");
    expect(source).not.toMatch(/\.xlsx["']/);
  });

  /** Credentials come from the environment, never from the source. */
  it("embeds no credential and takes the service key from the environment", () => {
    expect(source).toContain('env("SUPABASE_SERVICE_ROLE_KEY")');
    expect(source).toContain('env("SUPABASE_URL")');
    // No assignment of a literal to anything credential-shaped.
    expect(source).not.toMatch(/(password|secret|token)\s*=\s*["'][^"']{4,}["']/i);
    // And the publishable key is not a substitute for the service key.
    expect(source).not.toContain("PUBLISHABLE");
  });
});

describe("it stores through the existing architecture", () => {
  /** The Vault function from the migration, not a second mechanism. */
  it("uses the existing SECURITY DEFINER function", () => {
    expect(source).toContain("shams_crm_store_agent_secret");
    // And writes metadata to the existing table.
    expect(source).toContain("shams_crm_agent_links");
  });

  /** The password reaches the RPC and nothing else. */
  it("puts the password in no other call", () => {
    const passwordUses = [...source.matchAll(/crmPassword/g)].length;
    // Read from the row, guarded for emptiness, passed to verifyCrm and to the
    // RPC. Any further use would be a new place a secret travels.
    expect(passwordUses).toBeLessThanOrEqual(5);
    expect(source).toContain("_password: row.crmPassword");
    // It is never part of the row written to the table. Sliced from the actual
    // call, not from the first mention of the table name in the docstring.
    const upsert = source.slice(source.indexOf('from("shams_crm_agent_links")'));
    const upsertBlock = upsert.slice(0, upsert.indexOf("onConflict"));
    for (const forbidden of ["crmPassword", "password", "_password"]) {
      expect(upsertBlock).not.toContain(forbidden);
    }
  });

  /** Vault first, so a half-failure cannot leave an active link with no secret. */
  it("writes Vault before the metadata row", () => {
    expect(source.indexOf("shams_crm_store_agent_secret")).toBeLessThan(
      source.indexOf('from("shams_crm_agent_links")'),
    );
  });
});

describe("it is safe to run twice", () => {
  it("upserts on the agent rather than inserting", () => {
    expect(source).toContain('onConflict: "user_id"');
    expect(source).not.toMatch(/\.insert\(\s*\{\s*user_id/);
  });

  /**
   * A failure must not deactivate a working agent. The failure path only
   * records a result for the report — there is no write on it at all, so a
   * transient CRM outage leaves seven good links exactly as they were.
   */
  it("never deactivates an agent on failure", () => {
    expect(source).not.toMatch(/active:\s*false/);
    const failFn = source.slice(source.indexOf("const fail ="), source.indexOf("if (!row.email"));
    expect(failFn).not.toContain("supabase");
  });

  /** One agent failing does not stop the batch. */
  it("continues past a failed agent", () => {
    // The loop body only — the slice must stop before the summary and the
    // top-level catch, which legitimately throws and prints.
    const loop = source.slice(
      source.indexOf("for (const row of rows)"),
      source.indexOf("const failed ="),
    );
    expect((loop.match(/continue;/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(loop).not.toContain("break;");
    expect(loop).not.toContain("throw");
  });
});

describe("verification happens before storage", () => {
  it("checks username, active and the AlShrouq feature", () => {
    expect(source).toContain("username_mismatch");
    expect(source).toContain("me.active === false");
    expect(source).toContain('features.includes("alshrouq_delivery")');
    expect(source).toContain("missing_permission");
  });

  it("cross-checks the MilaPortal identity, not just the email", () => {
    expect(source).toContain("name_mismatch");
    expect(source).toContain("agent_code_mismatch");
    expect(source).toContain("unmapped");
  });

  /** The CRM check must precede the store call in the loop. */
  it("verifies before it stores", () => {
    const loop = source.slice(source.indexOf("for (const row of rows)"));
    expect(loop.indexOf("await verifyCrm(")).toBeLessThan(loop.indexOf("await store("));
  });

  /** A dry run proves the mapping without writing anything. */
  it("offers a dry run", () => {
    expect(source).toContain("--dry-run");
    expect(source).toContain("if (DRY_RUN)");
  });
});
