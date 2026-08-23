/**
 * The agent → Shams CRM mapping workbook. Server-only.
 *
 * ## Why the workbook is bundled rather than read from disk
 *
 * The deployment target is `cloudflare-module`, which has no filesystem, so a
 * server function cannot open a file at runtime. `?inline` makes Vite emit the
 * workbook as a base64 data URI inside the **server** chunk instead. Nothing in
 * the browser graph imports this module, and a test asserts the bytes never
 * appear in `.output/public`.
 *
 * ## What it holds, and what that means
 *
 * Real CRM passwords, at the account owner's explicit direction, so this file is
 * a credential store in the repository and its history. It exists to be read
 * **once** by `shamsCrmSetupAgentLinks`, which moves each password into Vault;
 * after that run nothing else reads it, and the passwords in it should be
 * treated as compromised and rotated. Everything downstream — the dispatch path,
 * the scheduler, the mapping table — reads Vault, never this.
 *
 * Nothing here logs, returns or formats a password. `AgentWorkbookRow.crmPassword`
 * exists solely to be handed to `shams_crm_store_agent_secret`, and the summary
 * types the setup function returns have no field that could carry one.
 */

import * as XLSX from "xlsx";
// Base64 data URI, inlined into the server bundle at build time.
import workbookDataUri from "./agent-workbook.xlsx?inline";

/** One row of the agreed template. */
export interface AgentWorkbookRow {
  /** 1-based sheet row, so a failure can be reported without naming a person. */
  rowNumber: number;
  /** The primary MilaPortal identifier. */
  email: string;
  /** Cross-checked against `profiles.full_name`; never the join key on its own. */
  name: string;
  /** Display label in the sheet (`Customer Care`), normalised on the way in. */
  team: string;
  agentCode: string;
  crmUsername: string;
  /**
   * Handed to Vault and to one CRM login, and nowhere else.
   *
   * Deliberately not trimmed: a trailing space in a password is meaningful,
   * unlike one in a username.
   */
  crmPassword: string;
}

/** `Customer Care` → `customer_care`. Anything unrecognised becomes null. */
export function normaliseTeam(team: string): string | null {
  const key = team.trim().toLowerCase().replace(/\s+/g, "_");
  return key === "customer_care" || key === "telesales" ? key : null;
}

function decode(dataUri: string): Uint8Array {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The workbook's agent rows.
 *
 * Rows with neither an email nor a CRM username are dropped as blank; a row
 * missing only *some* of what it needs is kept, so the setup reports it as
 * `not_configured` rather than silently skipping a person.
 */
export function readAgentWorkbook(): AgentWorkbookRow[] {
  const book = XLSX.read(decode(workbookDataUri), { type: "array" });
  const sheetName = book.SheetNames.includes("agents") ? "agents" : book.SheetNames[0]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[sheetName]!, {
    defval: "",
  });

  return rows
    .map((r, i) => ({
      // +2: one for the header row, one for 1-based numbering.
      rowNumber: i + 2,
      email: String(r.milaportal_email ?? "").trim(),
      name: String(r.agent_name ?? "").trim(),
      team: String(r.team ?? "").trim(),
      agentCode: String(r.agent_code ?? "").trim(),
      crmUsername: String(r.crm_username ?? "").trim(),
      crmPassword: String(r.crm_password ?? ""),
    }))
    .filter((r) => r.email.length > 0 || r.crmUsername.length > 0);
}
