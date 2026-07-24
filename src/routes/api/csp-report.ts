import { createFileRoute } from "@tanstack/react-router";

/**
 * CSP violation report sink (M-13).
 *
 * The Content-Security-Policy-Report-Only header (see src/lib/security-headers.ts)
 * points its `report-uri` and `report-to` directives here. This endpoint receives
 * the violation reports the browser generates while the strict policy runs in
 * report-only mode, so the policy can be validated against real traffic before it
 * is ever enforced.
 *
 * Two wire formats land here, both JSON:
 *   - report-uri (legacy):     Content-Type: application/csp-report
 *                              body: { "csp-report": { ...single report... } }
 *   - report-to  (Reporting API v1): Content-Type: application/reports+json
 *                              body: [ { type, url, age, body }, ... ]
 *
 * Reports are unauthenticated by design — the browser posts them without
 * credentials — so this handler stays read-only: it parses, logs and returns
 * 204. It never trusts the payload for anything beyond logging, and caps the
 * body it will read so a flood of oversized reports cannot exhaust memory.
 */

// A single CSP report body is tiny (< 2 KB in practice). Anything larger is
// malformed or hostile; drop it rather than buffer it.
const MAX_BODY_BYTES = 64 * 1024;

type CspReportBody = Record<string, unknown>;

/** Pull the interesting fields out of either wire format for a compact log line. */
function summarize(report: CspReportBody): Record<string, unknown> {
  // report-to bodies use hyphen-free keys; report-uri uses hyphenated keys.
  const g = (a: string, b: string) => report[a] ?? report[b];
  return {
    documentURL: g("documentURL", "document-uri"),
    violatedDirective: g("effectiveDirective", "violated-directive"),
    blockedURL: g("blockedURL", "blocked-uri"),
    sourceFile: report["sourceFile"] ?? report["source-file"],
    lineNumber: report["lineNumber"] ?? report["line-number"],
    disposition: report["disposition"] ?? "report",
  };
}

function extractReports(contentType: string, parsed: unknown): CspReportBody[] {
  // Reporting API v1: an array of { type, body } envelopes.
  if (Array.isArray(parsed)) {
    return parsed
      .filter(
        (r): r is { type?: string; body?: CspReportBody } =>
          typeof r === "object" && r !== null,
      )
      .filter((r) => r.type === undefined || r.type === "csp-violation")
      .map((r) => (r.body ?? {}) as CspReportBody);
  }
  // Legacy report-uri: { "csp-report": {...} }.
  if (parsed && typeof parsed === "object") {
    const body = (parsed as Record<string, unknown>)["csp-report"];
    if (body && typeof body === "object") return [body as CspReportBody];
  }
  // Some agents post the bare report object.
  if (parsed && typeof parsed === "object" && contentType.includes("csp")) {
    return [parsed as CspReportBody];
  }
  return [];
}

export const Route = createFileRoute("/api/csp-report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // 204 regardless of outcome: the browser ignores the response body, and a
        // report sink must never surface parse detail to the client.
        const noContent = new Response(null, { status: 204 });

        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_BODY_BYTES) return noContent;

        let raw: string;
        try {
          raw = await request.text();
        } catch {
          return noContent;
        }
        if (!raw || raw.length > MAX_BODY_BYTES) return noContent;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return noContent;
        }

        const contentType = request.headers.get("content-type") ?? "";
        const reports = extractReports(contentType, parsed);
        for (const report of reports) {
          // console.warn so violations surface in the platform log stream without
          // being treated as request failures.
          console.warn("[csp-report]", JSON.stringify(summarize(report)));
        }

        return noContent;
      },
    },
  },
});
