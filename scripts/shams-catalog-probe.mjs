#!/usr/bin/env node
/**
 * Shams MIS catalog-source probe.
 *
 * Standalone and read-only. It imports nothing from `src/` and exists to answer
 * three questions that cannot be settled from a machine without credentials:
 *
 *   1. **Does the MIS expose a catalog dump?** PharmacyCRM Desktop builds its
 *      search from `GET /products/names` on `shams-crm.cloud` — a bare JSON
 *      array of 8 484 `{code, name, price}` rows — authenticated with an
 *      `X-Session-Token` from a per-user branch login. That is a different host
 *      and a different credential from this portal's machine Bearer token, so
 *      whether *this* API serves the same list is unknown. Section A probes the
 *      paths it could plausibly live under.
 *
 *   2. **Does `product/search?q=` truncate?** Its whole signature is `?q=` — no
 *      `limit`, `page` or `offset` — so a server-side cap cannot be ruled out
 *      from the client, and the portal's wildcard search depends on the answer:
 *      a truncated superset is not a superset. Section B asks broad terms and
 *      looks for a suspiciously round ceiling.
 *
 *   3. **Does the MIS hold the products the desktop holds?** Section C runs the
 *      reported queries and reports whether the NAN OPTIPRO range — the rows
 *      `nan*op` is supposed to find — is present upstream at all.
 *
 * Run it where the credentials live (CI, or a machine with a populated .env):
 *
 *   SHAMS_MIS_BASE_URL=https://mis.example.com \
 *   SHAMS_MIS_ACCOUNT_IDENTIFIER=... SHAMS_MIS_API_KEY=... \
 *   node scripts/shams-catalog-probe.mjs
 *
 * Writes `docs/shams/catalog-probe-results.{md,json}` and prints the report.
 *
 * ## Safety
 *
 * **Every probe is a GET, and the path table is allow-listed by hand.** The one
 * POST is the token exchange, which is how the API is entered at all. Nothing
 * here writes, and no path should ever be added that could.
 *
 * The API key, the account identifier and the access token are never printed,
 * never written to the output files, and never put in a query string. Row
 * *counts* and item codes are recorded; customer-bearing endpoints
 * (`crm/data`, `sales/details`) are deliberately absent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "docs", "shams");

/** Politeness gap between probes, in ms. */
const DELAY_MS = 250;
/** Per-request timeout. A broad catalog read is allowed to be slow. */
const TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Paths a catalog dump could live under.
 *
 * `/products/names` is first and is the only one with evidence behind it: it is
 * what PharmacyCRM calls, verbatim, including the missing `/api/v2` prefix. The
 * rest are conventional spellings — if none of them answers, the conclusion is
 * that this API has no catalog endpoint, not that the right guess is still out
 * there.
 */
const CATALOG_PATHS = [
  { path: "/products/names", note: "PharmacyCRM's path, no /api/v2 prefix" },
  { path: "/api/v2/products/names", note: "same, under the versioned prefix" },
  { path: "/api/v2/product/names", note: "singular, matching product/info" },
  { path: "/api/v2/product/list", note: "conventional" },
  { path: "/api/v2/product/all", note: "conventional" },
  { path: "/api/v2/products", note: "conventional" },
  { path: "/api/v2/product/catalog", note: "conventional" },
  { path: "/api/v2/stock/sync/status", note: "PharmacyCRM's refresh marker" },
  { path: "/stock/sync/status", note: "same, unprefixed" },
];

/** Broad terms, to see whether a big result set stops at a round number. */
const TRUNCATION_TERMS = ["a", "e", "in", "ta", "co"];

/** The queries this investigation was opened against. */
const REPORTED_TERMS = ["nan", "op", "pana", "extra", "omega", "10400746"];

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Left null; `bodyKind` below records that it was not JSON.
    }
    return {
      httpStatus: response.status,
      durationMs: Date.now() - started,
      contentType: response.headers.get("content-type") ?? null,
      bytes: text.length,
      json,
      snippet: json === null ? text.slice(0, 200) : null,
    };
  } catch (error) {
    return {
      httpStatus: null,
      durationMs: Date.now() - started,
      contentType: null,
      bytes: 0,
      json: null,
      snippet: null,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `{success, count, data:[…]}`, a bare array, or something else entirely. */
function describeBody(json) {
  if (Array.isArray(json)) {
    return { bodyKind: "array", rows: json.length, fields: fieldsOf(json[0]) };
  }
  if (json && typeof json === "object") {
    const data = json.data ?? json.items ?? json.products ?? null;
    if (Array.isArray(data)) {
      return {
        bodyKind: "envelope",
        rows: data.length,
        declaredCount: typeof json.count === "number" ? json.count : null,
        fields: fieldsOf(data[0]),
      };
    }
    return { bodyKind: "object", rows: null, keys: Object.keys(json).slice(0, 12) };
  }
  return { bodyKind: json === null ? "non-json" : typeof json, rows: null };
}

function fieldsOf(row) {
  return row && typeof row === "object" ? Object.keys(row).slice(0, 12) : null;
}

async function getToken(baseUrl, accountIdentifier, apiKey) {
  const response = await request(`${baseUrl}/api/v2/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ account_identifier: accountIdentifier, api_key: apiKey }),
  });
  const token = response.json?.access_token;
  if (!token) {
    throw new Error(
      `token exchange failed (HTTP ${response.httpStatus ?? response.error}); no access_token in the response`,
    );
  }
  return token;
}

async function main() {
  const rawBase = env("SHAMS_MIS_BASE_URL");
  const accountIdentifier = env("SHAMS_MIS_ACCOUNT_IDENTIFIER");
  const apiKey = env("SHAMS_MIS_API_KEY");
  if (!rawBase || !accountIdentifier || !apiKey) {
    throw new Error(
      "set SHAMS_MIS_BASE_URL, SHAMS_MIS_ACCOUNT_IDENTIFIER and SHAMS_MIS_API_KEY " +
        "(all three; a partial configuration is treated as none)",
    );
  }
  const trimmed = rawBase.replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  console.error(`[probe] authenticating against ${baseUrl}`);
  const token = await getToken(baseUrl, accountIdentifier, apiKey);
  console.error("[probe] token acquired; reusing it for every probe");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  const get = async (path, params) => {
    const query = params ? `?${new URLSearchParams(params)}` : "";
    const response = await request(`${baseUrl}${path}${query}`, { headers });
    await sleep(DELAY_MS);
    return response;
  };

  // --- A. Is there a catalog dump? -----------------------------------------
  const catalog = [];
  for (const spec of CATALOG_PATHS) {
    const response = await get(spec.path);
    const shape = describeBody(response.json);
    catalog.push({ ...spec, ...pick(response), ...shape });
    console.error(
      `[probe] A ${spec.path.padEnd(30)} HTTP ${String(response.httpStatus ?? response.error).padEnd(7)} ${shape.bodyKind} rows=${shape.rows ?? "—"}`,
    );
  }

  // --- B. Does product/search truncate? ------------------------------------
  const truncation = [];
  for (const q of TRUNCATION_TERMS) {
    const response = await get("/api/v2/product/search", { q });
    const shape = describeBody(response.json);
    truncation.push({ q, ...pick(response), ...shape });
    console.error(
      `[probe] B q=${q.padEnd(4)} rows=${String(shape.rows ?? "—").padEnd(6)} declared=${shape.declaredCount ?? "—"}`,
    );
  }

  // --- C. What does the MIS hold for the reported queries? -----------------
  const reported = [];
  for (const q of REPORTED_TERMS) {
    const response = await get("/api/v2/product/search", { q });
    const shape = describeBody(response.json);
    const rows = rowsOf(response.json);
    reported.push({
      q,
      ...pick(response),
      ...shape,
      // The rows `nan*op` must find. Their presence upstream is the whole
      // question: local matching cannot recover what search never returned.
      nanOptipro: rows.filter((r) => /^nan\b.*\bop/i.test(String(r.itemName ?? ""))).length,
      sample: rows.slice(0, 5).map((r) => ({ itemCode: r.itemCode, itemName: r.itemName })),
    });
    console.error(`[probe] C q=${q.padEnd(10)} rows=${shape.rows ?? "—"}`);
  }

  const probedAt = new Date().toISOString();
  const anyCatalog = catalog.filter((r) => r.httpStatus === 200 && (r.rows ?? 0) > 100);
  const ceiling = [...new Set(truncation.map((r) => r.rows).filter((n) => typeof n === "number"))];

  const md = [
    "# Shams MIS catalog-source probe — live results",
    "",
    `- Probed at: ${probedAt}`,
    `- Base URL: ${baseUrl}`,
    "",
    "## A. Is there a catalog endpoint?",
    "",
    anyCatalog.length > 0
      ? `**Yes** — ${anyCatalog.map((r) => `\`${r.path}\` (${r.rows} rows)`).join(", ")}.`
      : "**No.** No allow-listed path returned a list of products.",
    "",
    "| Path | Note | HTTP | Body | Rows | Fields |",
    "| --- | --- | --- | --- | --- | --- |",
    ...catalog.map(
      (r) =>
        `| \`${r.path}\` | ${r.note} | ${r.httpStatus ?? r.error} | ${r.bodyKind} | ${r.rows ?? "—"} | ${r.fields?.join(", ") ?? r.keys?.join(", ") ?? "—"} |`,
    ),
    "",
    "## B. Does `product/search` truncate?",
    "",
    ceiling.length === 1 && TRUNCATION_TERMS.length > 1
      ? `**Likely yes** — every broad term returned exactly ${ceiling[0]} rows, which reads as a server-side cap.`
      : "**No single ceiling observed** — broad terms returned differing row counts.",
    "",
    "| q | HTTP | Rows | `count` | ms |",
    "| --- | --- | --- | --- | --- |",
    ...truncation.map(
      (r) =>
        `| \`${r.q}\` | ${r.httpStatus ?? r.error} | ${r.rows ?? "—"} | ${r.declaredCount ?? "—"} | ${r.durationMs} |`,
    ),
    "",
    "## C. The reported queries",
    "",
    "`NAN OPTIPRO` counts rows whose name reads `nan … op` — what `nan*op` must find.",
    "",
    "| q | HTTP | Rows | NAN OPTIPRO | ms |",
    "| --- | --- | --- | --- | --- |",
    ...reported.map(
      (r) =>
        `| \`${r.q}\` | ${r.httpStatus ?? r.error} | ${r.rows ?? "—"} | ${r.nanOptipro} | ${r.durationMs} |`,
    ),
    "",
    "See the accompanying `.json` for per-query samples.",
    "",
  ].join("\n");

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "catalog-probe-results.md"), md, "utf8");
  await writeFile(
    resolve(OUT_DIR, "catalog-probe-results.json"),
    JSON.stringify({ probedAt, baseUrl, catalog, truncation, reported }, null, 2),
    "utf8",
  );

  console.log(md);
  console.error(`[probe] wrote ${OUT_DIR}/catalog-probe-results.{md,json}`);
}

/** The transport facts worth keeping, without the body. */
function pick(response) {
  return {
    httpStatus: response.httpStatus,
    durationMs: response.durationMs,
    bytes: response.bytes,
    contentType: response.contentType,
    error: response.error ?? null,
    snippet: response.snippet ?? null,
  };
}

function rowsOf(json) {
  if (Array.isArray(json)) return json;
  const data = json?.data ?? json?.items ?? json?.products;
  return Array.isArray(data) ? data : [];
}

main().catch((error) => {
  console.error(`[probe] ${error.message}`);
  process.exit(1);
});
