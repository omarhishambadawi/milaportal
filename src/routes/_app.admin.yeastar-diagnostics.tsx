import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { ShieldAlert, TriangleAlert, CheckCircle2 } from "lucide-react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { yeastarDevDiagnostics, yeastarKpiValidation } from "@/lib/yeastar.functions";

/**
 * Yeastar diagnostics.
 *
 * Two halves, split along what is safe to expose from a deployed environment:
 *
 *   - Live KPI validation runs ANYWHERE an administrator can reach it. It
 *     returns aggregates only — call counts, KPI totals, pass/fail invariants —
 *     so the analytics can be validated against the real PBX, which is the only
 *     place the Yeastar credentials exist.
 *   - Endpoint probes are DEVELOPMENT ONLY. They return raw PBX response bodies
 *     (caller numbers, DIDs, recording paths), so the server function behind
 *     them refuses to run outside a development build.
 */
export const Route = createFileRoute("/_app/admin/yeastar-diagnostics")({
  component: YeastarDiagnostics,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics · MilaServ Portal" }] }),
});

function Json({ data, max = "max-h-80" }: { data: unknown; max?: string }) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return <pre className={`text-xs bg-muted rounded p-3 overflow-auto ${max}`}>{text ?? "—"}</pre>;
}

function YeastarDiagnostics() {
  const { role } = useAuth();
  const isAdmin = isAdministrator(role);
  const isDev = import.meta.env.DEV;

  const [windowDays, setWindowDays] = useState(7);
  const runFn = useServerFn(yeastarDevDiagnostics);
  const run = useMutation({ mutationFn: () => runFn({ data: { windowDays } }) });

  const [validationDays, setValidationDays] = useState(7);
  const validateFn = useServerFn(yeastarKpiValidation);
  const validate = useMutation({
    mutationFn: () => validateFn({ data: { windowDays: validationDays } }),
  });

  if (!isAdmin) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Yeastar diagnostics.
        </p>
      </div>
    );
  }

  const result = run.data;
  const report = result?.ok ? result.report : null;
  const validation = validate.data?.ok ? validate.data.report : null;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Live KPI validation against the real PBX · endpoint probes (development builds only)
        </p>
      </div>

      {/* ---- Live KPI validation — runs in every environment ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live KPI validation</CardTitle>
          <div className="text-xs text-muted-foreground">
            Runs the production analytics pipeline over live CDR and re-derives every KPI
            independently. Returns aggregates only — no raw response bodies and no per-call data —
            so it is safe to run from a deployed environment.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="validationDays">CDR window (days)</Label>
              <input
                id="validationDays"
                type="number"
                min={1}
                max={30}
                value={validationDays}
                onChange={(e) => setValidationDays(Number(e.target.value) || 7)}
                className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <Button onClick={() => validate.mutate()} disabled={validate.isPending}>
              {validate.isPending ? "Validating…" : "Run live KPI validation"}
            </Button>
            {validation && (
              <span className="text-xs text-muted-foreground">
                {validation.window.from} → {validation.window.to} · {validation.cdr.rowsInWindow}{" "}
                rows → {validation.calls} calls · {validation.at}
              </span>
            )}
          </div>

          {validate.isError && <Json data={String(validate.error)} />}
          {validate.data && !validate.data.ok && (
            <div className="text-sm text-destructive">
              {!validate.data.configured
                ? "Yeastar is not configured (missing YEASTAR_* environment variables)."
                : validate.data.error}
            </div>
          )}

          {validation && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {validation.passed ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-destructive" />
                )}
                <Badge
                  variant={validation.passed ? "default" : "destructive"}
                  className="font-normal"
                >
                  {validation.checks.filter((c) => c.passed).length}/{validation.checks.length}{" "}
                  checks passed
                </Badge>
                {validation.cdr.truncated && (
                  <Badge variant="destructive" className="font-normal">
                    CDR truncated — window too large
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {validation.roster.extensionCount} extensions · queues{" "}
                  {validation.roster.queueNumbers.join(", ") || "none"}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {(
                  [
                    ["Total calls", validation.totals.total],
                    ["Inbound", validation.totals.inbound],
                    ["Outbound", validation.totals.outbound],
                    ["Answered", validation.totals.answered],
                    ["Missed", validation.totals.missed],
                    ["Abandoned", validation.totals.abandoned],
                    ["IVR-only", validation.totals.ivrOnly],
                    ["Queue calls", validation.totals.queueCalls],
                    ["Answer rate %", validation.totals.answerRate.toFixed(1)],
                    ["Inbound answer %", validation.totals.inboundAnswerRate.toFixed(1)],
                    ["Avg wait (s)", validation.totals.avgWaitSec.toFixed(1)],
                    ["Avg talk (s)", validation.totals.avgTalkSec.toFixed(1)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded border border-border/60 p-2">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="text-sm font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                {validation.checks.map((c) => (
                  <div
                    key={c.name}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/50 py-1 text-xs"
                  >
                    <Badge
                      variant={c.passed ? "secondary" : "destructive"}
                      className="font-mono font-normal"
                    >
                      {c.name}
                    </Badge>
                    <span className="text-muted-foreground">{c.description}</span>
                    {!c.passed && (
                      <span className="font-mono text-destructive">
                        expected {c.expected}, got {c.actual}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-3 text-xs">
                <div>
                  <Label className="text-xs text-muted-foreground">Outcomes</Label>
                  <Json data={validation.outcomes} max="max-h-52" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Leg roles</Label>
                  <Json data={validation.legRoles} max="max-h-52" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Legs per call
                    <span className="block font-normal normal-case">
                      all-1 means grouping is broken
                    </span>
                  </Label>
                  <Json data={validation.legsPerCall} max="max-h-52" />
                </div>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground">Retired field check</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {validation.retiredFieldCheck.map((f) => (
                    <Badge
                      key={f.field}
                      variant={f.occurrences === 0 ? "secondary" : "destructive"}
                      className="font-mono font-normal"
                    >
                      {f.field}: {f.occurrences}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- Endpoint probes — development builds only ---------------------- */}
      {!isDev ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Endpoint probes are available in development builds only — they return raw PBX
              response bodies. The live KPI validation above runs in every environment.
            </span>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run probes (dev)</CardTitle>
              <div className="text-xs text-muted-foreground">
                Endpoint · Request · Response status · Response body · Parsed output · Parsing
                errors
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="windowDays">CDR window (days)</Label>
                <input
                  id="windowDays"
                  type="number"
                  min={1}
                  max={30}
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value) || 7)}
                  className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm"
                />
              </div>
              <Button onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? "Probing…" : "Run diagnostics"}
              </Button>
              {report && (
                <span className="text-xs text-muted-foreground">
                  {report.cdrRowsInspected} CDR rows inspected · {report.at}
                </span>
              )}
            </CardContent>
          </Card>

          {run.isError && (
            <Card>
              <CardContent className="pt-6">
                <Json data={String(run.error)} />
              </CardContent>
            </Card>
          )}

          {result && !result.ok && (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                {"devOnly" in result
                  ? "Endpoint probes are disabled outside development."
                  : !result.configured
                    ? "Yeastar is not configured (missing YEASTAR_* environment variables)."
                    : result.error}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {report?.retiredFieldCheck && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Retired field assumptions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Fields the previous parser read. Any non-zero count means the firmware started
              emitting a field this integration deliberately stopped trusting.
            </p>
            <div className="flex flex-wrap gap-2">
              {report.retiredFieldCheck.map((f) => (
                <Badge
                  key={f.field}
                  variant={f.occurrences === 0 ? "secondary" : "destructive"}
                  className="font-mono font-normal"
                >
                  {f.field}: {f.occurrences}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {report?.fieldPresence && report.fieldPresence.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">CDR field presence</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
              {report.fieldPresence.map((f) => (
                <div key={f.field} className="flex justify-between border-b border-border/50 py-1">
                  <span>{f.field}</span>
                  <span className="text-muted-foreground">
                    {f.count} ({f.percent}%)
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {report?.probes.map((p) => (
        <Card key={p.label}>
          <CardHeader>
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              {p.parseErrors.length === 0 && p.endpointExists ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-amber-600" />
              )}
              {p.label}
              <Badge variant={p.endpointExists ? "default" : "destructive"} className="font-normal">
                {p.endpointExists ? "supported" : "not on this firmware"}
              </Badge>
              <span className="text-xs font-normal text-muted-foreground">{p.elapsedMs}ms</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-xs font-mono break-all">
              <span className="text-muted-foreground">{p.method}</span> {p.endpoint}
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">Request</Label>
              <Json data={p.request} max="max-h-40" />
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">HTTP {p.httpStatus}</Badge>
              <Badge variant="outline">errcode {p.errcode ?? "—"}</Badge>
              <Badge variant="outline">{p.errmsg ?? "—"}</Badge>
            </div>

            {p.parseErrors.length > 0 && (
              <div>
                <Label className="text-xs text-destructive">Parsing errors</Label>
                <ul className="text-xs list-disc pl-5 space-y-1 mt-1">
                  {p.parseErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {p.parsed != null && (
              <div>
                <Label className="text-xs text-muted-foreground">Parsed output</Label>
                <Json data={p.parsed} />
              </div>
            )}

            <div>
              <Label className="text-xs text-muted-foreground">
                Response body{p.responseTruncated ? " (truncated)" : ""}
              </Label>
              <Json data={p.responseBody} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
