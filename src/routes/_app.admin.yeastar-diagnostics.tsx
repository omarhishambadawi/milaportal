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
import { yeastarDevDiagnostics } from "@/lib/yeastar.functions";

/**
 * Development-only Yeastar diagnostics.
 *
 * Shows, per endpoint: the request, the HTTP status, the raw response body, the
 * parsed result from the normalization layer, and any parsing errors. The server
 * function behind it refuses to run outside development, so in production this
 * page renders its unavailable state and nothing else.
 */
export const Route = createFileRoute("/_app/admin/yeastar-diagnostics")({
  component: YeastarDiagnostics,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics (dev) · MilaServ Portal" }] }),
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

  if (!isDev) {
    return (
      <div className="text-center py-16">
        <TriangleAlert className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          This page is available in development builds only.
        </p>
      </div>
    );
  }

  const result = run.data;
  const report = result?.ok ? result.report : null;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Diagnostics (dev)</h1>
        <p className="text-sm text-muted-foreground">
          Endpoint · Request · Response status · Response body · Parsed output · Parsing errors
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run probes</CardTitle>
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
              ? "Diagnostics are disabled outside development."
              : !result.configured
                ? "Yeastar is not configured (missing YEASTAR_* environment variables)."
                : result.error}
          </CardContent>
        </Card>
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
