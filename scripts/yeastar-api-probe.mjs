#!/usr/bin/env node
/**
 * Yeastar OpenAPI discovery probe — Sprint 1, firmware 37.23.x.
 *
 * Standalone and read-only. It imports nothing from `src/`, touches no analytics
 * code, and exists purely to produce the live half of the discovery: what this
 * specific PBX answers, per endpoint, per API version.
 *
 * Run it where the credentials live (CI, or a machine with a populated .env):
 *
 *   YEASTAR_BASE_URL=https://pbx.example.com:8088 \
 *   YEASTAR_CLIENT_ID=... YEASTAR_CLIENT_SECRET=... \
 *   node scripts/yeastar-api-probe.mjs
 *
 * Writes `docs/yeastar/api-probe-results.md` and `.json` next to this repo's
 * other Yeastar docs, and prints the matrix to stdout.
 *
 * ## Safety
 *
 * **Every probe is a GET, and the endpoint table is allow-listed by hand.** The
 * documented API also carries `queue/create`, `queue/update`, `queue/delete`,
 * `extension/create` and friends; none of them appear below and none should ever
 * be added. A discovery script that writes to a production PBX is not a
 * discovery script. The single POST is `get_token`, which is how the API is
 * entered at all.
 *
 * ## Rate limiting
 *
 * `get_token` is rate-limited hard — `errcode 60002` is "MAX LIMITATION
 * EXCEEDED", and tripping it locks the integration out for a while, which is why
 * the app caches tokens in Postgres. So: exactly one token for the whole run,
 * reused across every probe, with a small delay between calls.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "docs", "yeastar");

/** Politeness gap between probes, in ms. */
const DELAY_MS = 250;
/** Per-request timeout. A hung PBX must not hang the whole discovery. */
const TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * The endpoints to probe, transcribed from the official Appliance-Edition
 * documentation rather than from this repo's existing calls.
 *
 * `documented` records whether the path appears in the official
 * "API Interfaces & Events Summary" for P-Series Appliance Edition. The three
 * `documented: false` rows are deliberate: they are what the current integration
 * calls, they are absent from the summary, and confirming what the live PBX says
 * about them is the whole "INTERFACE NOT EXISTED" investigation.
 */
const ENDPOINTS = [
  // --- capability / identity -------------------------------------------------
  {
    group: "System",
    path: "system/information",
    versions: ["v1.0", "v2.0"],
    documented: "unlisted",
    params: {},
  },

  // --- CDR -------------------------------------------------------------------
  {
    group: "CDR",
    path: "cdr/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { page: 1, page_size: 1 },
  },
  {
    group: "CDR",
    path: "cdr/search",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { page: 1, page_size: 1 },
  },
  {
    group: "CDR",
    path: "cdr/detail",
    versions: ["v2.0"],
    documented: true,
    params: {},
    expectParamError: true,
  },

  // --- Call Report -----------------------------------------------------------
  {
    group: "Call Report",
    path: "myreport/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: {},
  },
  {
    group: "Call Report",
    path: "call_report/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "extcallstatistics" },
  },
  {
    group: "Call Report",
    path: "call_report/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "queueperformance" },
    label: "call_report/list?type=queueperformance",
  },
  {
    group: "Call Report",
    path: "call_report/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "queueagentperformance" },
    label: "call_report/list?type=queueagentperformance",
  },
  {
    group: "Call Report",
    path: "call_report/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "queueavgwaittalktime" },
    label: "call_report/list?type=queueavgwaittalktime",
  },
  {
    group: "Call Report",
    path: "call_report/detail",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "queueperformance" },
    label: "call_report/detail?type=queueperformance",
  },
  {
    group: "Call Report",
    path: "call_report/detail",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { type: "queueagentperformance" },
    label: "call_report/detail?type=queueagentperformance",
  },

  // --- Queue -----------------------------------------------------------------
  { group: "Queue", path: "queue/list", versions: ["v1.0", "v2.0"], documented: true, params: {} },
  { group: "Queue", path: "queue/query", versions: ["v1.0", "v2.0"], documented: true, params: {} },
  {
    group: "Queue",
    path: "queue/call_status",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: {},
  },
  {
    group: "Queue",
    path: "queue/agent_status",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: {},
  },
  {
    group: "Queue",
    path: "queue_pause_reason/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: {},
  },

  // --- Extension -------------------------------------------------------------
  {
    group: "Extension",
    path: "extension/list",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: { page: 1, page_size: 1 },
  },
  {
    group: "Extension",
    path: "extension/query",
    versions: ["v1.0", "v2.0"],
    documented: true,
    params: {},
  },

  // --- Absent from the official summary: the current integration's calls ------
  {
    group: "Undocumented (in use)",
    path: "queue/callstatistics",
    versions: ["v1.0", "v2.0"],
    documented: false,
    params: {},
  },
  {
    group: "Undocumented (in use)",
    path: "queue/panel/callstatistics",
    versions: ["v1.0", "v2.0"],
    documented: false,
    params: {},
  },
  {
    group: "Undocumented (in use)",
    path: "extension/callstatistics",
    versions: ["v1.0", "v2.0"],
    documented: false,
    params: {},
  },
];

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body is itself a finding */
    }
    return { httpStatus: res.status, json, text };
  } catch (error) {
    return { httpStatus: 0, json: null, text: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(baseUrl, clientId, clientSecret) {
  const { httpStatus, json, text } = await request(`${baseUrl}/openapi/v1.0/get_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: clientId, password: clientSecret }),
  });
  if (json?.errcode === 60002) {
    throw new Error(
      "get_token returned errcode 60002 (MAX LIMITATION EXCEEDED). The PBX has " +
        "rate-limited token requests; wait before retrying. No probes were run.",
    );
  }
  if (httpStatus !== 200 || !json || json.errcode !== 0 || !json.access_token) {
    throw new Error(
      `get_token failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} ` +
        `errmsg=${json?.errmsg ?? "n/a"} body=${text.slice(0, 200)}`,
    );
  }
  return json.access_token;
}

/**
 * Turn a response into a verdict.
 *
 * The distinction that matters is between "this PBX does not have this
 * interface" and "you called it wrong": both are non-zero errcodes, and reading
 * the second as the first is exactly the mistake this sprint is guarding
 * against. A parameter complaint proves the endpoint *exists* — something has to
 * be there to object to the arguments.
 */
function classify({ httpStatus, json }, expectParamError) {
  if (httpStatus === 0) return { result: "NETWORK ERROR", supported: "unknown" };
  if (httpStatus === 401 || json?.errcode === 40001)
    return { result: "AUTH FAILED", supported: "unknown" };
  if (httpStatus === 404) return { result: "HTTP 404", supported: "no" };
  if (json?.errcode === 0) return { result: "OK", supported: "yes" };

  const msg = String(json?.errmsg ?? "").toUpperCase();
  if (msg.includes("INTERFACE NOT EXISTED"))
    return { result: "INTERFACE NOT EXISTED", supported: "no" };
  if (expectParamError || /PARAM|MISSING|INVALID|REQUIRED/.test(msg)) {
    return { result: `EXISTS (param error: ${json?.errmsg})`, supported: "yes" };
  }
  return { result: `errcode ${json?.errcode}: ${json?.errmsg}`, supported: "unclear" };
}

async function main() {
  const baseUrl = env("YEASTAR_BASE_URL")?.replace(/\/+$/, "");
  const clientId = env("YEASTAR_CLIENT_ID");
  const clientSecret = env("YEASTAR_CLIENT_SECRET");

  if (!baseUrl || !clientId || !clientSecret) {
    console.error(
      "Missing credentials. Set YEASTAR_BASE_URL, YEASTAR_CLIENT_ID and " +
        "YEASTAR_CLIENT_SECRET, then re-run. Nothing was probed.",
    );
    process.exit(2);
  }

  console.error(`[probe] authenticating against ${baseUrl}`);
  const token = await getToken(baseUrl, clientId, clientSecret);
  console.error("[probe] token acquired; reusing it for every probe");

  const rows = [];
  for (const spec of ENDPOINTS) {
    for (const version of spec.versions) {
      const query = new URLSearchParams({ access_token: token, ...spec.params });
      const url = `${baseUrl}/openapi/${version}/${spec.path}?${query}`;
      const response = await request(url);
      const verdict = classify(response, spec.expectParamError);
      rows.push({
        group: spec.group,
        endpoint: spec.label ?? spec.path,
        version,
        method: "GET",
        documented: spec.documented,
        httpStatus: response.httpStatus,
        errcode: response.json?.errcode ?? null,
        errmsg: response.json?.errmsg ?? null,
        ...verdict,
      });
      console.error(
        `[probe] ${version.padEnd(5)} ${(spec.label ?? spec.path).padEnd(46)} ${verdict.result}`,
      );
      await sleep(DELAY_MS);
    }
  }

  // Identity, for the firmware/edition half of the report.
  const info = rows.find((r) => r.endpoint === "system/information" && r.result === "OK");

  const md = [
    "# Yeastar API probe — live results",
    "",
    `- Probed at: ${new Date().toISOString()}`,
    `- Base URL: ${baseUrl.replace(/\/\/.*@/, "//***@")}`,
    info
      ? "- `system/information` answered; see the JSON for firmware and edition."
      : "- `system/information` did not answer; firmware and edition unconfirmed.",
    "",
    "| Group | Endpoint | Ver | Documented | HTTP | errcode | Result | Supported |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.group} | \`${r.endpoint}\` | ${r.version} | ${r.documented} | ${r.httpStatus} | ${r.errcode ?? "—"} | ${r.result} | ${r.supported} |`,
    ),
    "",
  ].join("\n");

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "api-probe-results.md"), md, "utf8");
  await writeFile(
    resolve(OUT_DIR, "api-probe-results.json"),
    JSON.stringify({ probedAt: new Date().toISOString(), baseUrl, rows }, null, 2),
    "utf8",
  );

  console.log(md);
  console.error(`[probe] wrote ${OUT_DIR}/api-probe-results.{md,json}`);
}

main().catch((error) => {
  console.error(`[probe] ${error.message}`);
  process.exit(1);
});
