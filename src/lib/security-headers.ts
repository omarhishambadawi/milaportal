/**
 * Security response headers.
 *
 * Applied in src/server.ts so they cover every server response -- SSR
 * documents, /api routes, server functions and the MCP endpoints -- rather than
 * only the static assets a host-level `_headers` file would reach.
 *
 * CSP is deliberately split in two:
 *
 *   - An ENFORCED policy limited to directives that cannot break a working app:
 *     frame-ancestors, base-uri, object-src, form-action. These block
 *     clickjacking, base-tag injection, plugin injection and form exfiltration
 *     outright, and none of them affect how scripts, styles or images load.
 *
 *   - A REPORT-ONLY policy carrying the full default-src/script-src/connect-src
 *     lockdown. TanStack Start injects inline hydration scripts and Radix sets
 *     inline style attributes, so a strict script-src/style-src needs nonce
 *     plumbing through the SSR renderer. Shipping that enforced, untested,
 *     would white-screen the app. Report-only lets the policy be validated
 *     against real traffic first; promote it to enforced once the violation
 *     reports are clean.
 *
 * The report-only policy carries `report-uri` and `report-to` directives that
 * point at the /api/csp-report sink (src/routes/api/csp-report.ts). Both are
 * emitted for coverage: `report-uri` is the legacy directive still honoured by
 * most browsers, `report-to` is the current Reporting API mechanism, whose
 * endpoint group is declared via the companion `Report-To` (v0) and
 * `Reporting-Endpoints` (v1) response headers. The enforced policy deliberately
 * carries no reporting directives — only the untested lockdown needs validating.
 *
 * Nothing here weakens an existing header: values are only set when absent.
 */

/** Endpoint group name shared by the report-to directive and the Report-To headers. */
const CSP_REPORT_GROUP = "csp-endpoint";

/** Same-origin path of the violation report sink. */
const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Resolve the origin the browser should post reports back to. Prefers the
 * proxy-forwarded host/proto (the app is served behind Cloudflare Workers, so
 * request.url is the internal origin) and falls back to the request URL.
 */
function reportOrigin(request: Request): string | null {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/**
 * Google Maps Platform origins.
 *
 * The Maps JavaScript SDK is not a single script: the bootstrap on
 * maps.googleapis.com loads further modules from maps.gstatic.com, fetches tiles
 * and icons as images from both plus googleusercontent, and issues XHRs back to
 * maps.googleapis.com for viewport data. Omitting any one of them produces a
 * grey rectangle rather than an obvious failure, which is why they are listed
 * together here rather than discovered one console error at a time.
 */
const GOOGLE_MAPS_SCRIPT = "https://maps.googleapis.com https://maps.gstatic.com";
const GOOGLE_MAPS_CONNECT = "https://maps.googleapis.com https://maps.gstatic.com";
const GOOGLE_MAPS_IMG =
  "https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.ggpht.com https://*.googleusercontent.com";

/** Origins the app legitimately talks to (Supabase REST, Auth, Storage, Realtime). */
function connectSources(): string {
  const urls = new Set<string>(["'self'"]);
  for (const raw of [process.env.SUPABASE_URL, process.env.VITE_SUPABASE_URL]) {
    if (!raw) continue;
    try {
      const { origin, host } = new URL(raw);
      urls.add(origin);
      urls.add(`wss://${host}`); // realtime websockets
    } catch {
      /* malformed env value - skip rather than emit a broken directive */
    }
  }
  for (const origin of GOOGLE_MAPS_CONNECT.split(" ")) urls.add(origin);
  return [...urls].join(" ");
}

const ENFORCED_CSP = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

function reportOnlyCsp(): string {
  const connect = connectSources();
  return [
    "default-src 'self'",
    // 'unsafe-inline' is required by SSR hydration today; the value of this
    // directive is that it still blocks loading script from any foreign origin.
    `script-src 'self' 'unsafe-inline' ${GOOGLE_MAPS_SCRIPT}`,
    // The Maps SDK writes inline style attributes on every tile and control, so
    // 'unsafe-inline' is already required here and no maps origin need be added.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${GOOGLE_MAPS_IMG}`,
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    // Reporting: legacy directive first, Reporting API group second. A path is a
    // valid report-uri value; report-to resolves its endpoint from the
    // Report-To / Reporting-Endpoints headers set alongside this policy.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}

export function applySecurityHeaders(request: Request, response: Response): Response {
  // Response headers are immutable on some runtimes; clone through a mutable set.
  const headers = new Headers(response.headers);
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };

  set("X-Content-Type-Options", "nosniff");
  set("X-Frame-Options", "DENY");
  set("Referrer-Policy", "strict-origin-when-cross-origin");
  set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
  );
  set("Content-Security-Policy", ENFORCED_CSP);
  set("Content-Security-Policy-Report-Only", reportOnlyCsp());

  // Declare the report-to endpoint group for both Reporting API generations.
  // Report-To (v0) is still what Chromium consults for CSP; Reporting-Endpoints
  // (v1) is the modern header. Both name the same same-origin sink.
  const origin = reportOrigin(request);
  if (origin) {
    const reportUrl = `${origin}${CSP_REPORT_PATH}`;
    set("Reporting-Endpoints", `${CSP_REPORT_GROUP}="${reportUrl}"`);
    set(
      "Report-To",
      JSON.stringify({
        group: CSP_REPORT_GROUP,
        max_age: 10886400,
        endpoints: [{ url: reportUrl }],
      }),
    );
  }

  // HSTS only over TLS. Emitting it on plain http is ignored by browsers, and
  // sending it from a local http dev origin would needlessly pin localhost.
  let isHttps = false;
  try {
    isHttps = new URL(request.url).protocol === "https:";
  } catch {
    /* non-absolute URL - treat as not-https */
  }
  if (isHttps) {
    // No `preload`: that is a one-way commitment for the apex domain and is the
    // domain owner's call, not something to switch on from application code.
    set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
