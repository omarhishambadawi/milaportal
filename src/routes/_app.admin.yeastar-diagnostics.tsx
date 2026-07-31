/**
 * Yeastar analytics validation & debugging — Owner/Administrator only.
 *
 * The single place to answer "why does this KPI not match the PBX report?"
 * without reading thousands of CDR rows by hand.
 *
 * Two halves, split along what is safe to expose from a deployed environment:
 *
 *   - Everything below runs ANYWHERE an administrator can reach it. It returns
 *     aggregates and per-call diagnostics only: call ids, extensions, outcomes
 *     and durations. Never credentials, tokens, phone numbers, DIDs, recording
 *     paths or raw response bodies.
 *   - Endpoint probes are DEVELOPMENT ONLY, because they return raw PBX
 *     response bodies. The server function behind them refuses to run outside a
 *     development build.
 *
 * The official Yeastar figures are TYPED IN, not fetched: this firmware answers
 * `10001 INTERFACE NOT EXISTED` for every `call_report/*` route, so there is no
 * API to read the report from (see docs/yeastar/live-audit-2026-07-30.md §1).
 *
 * Validation never touches the production analytics caches — it fetches its own
 * copy of the CDR window and only observes the cache state.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldAlert, TriangleAlert, CheckCircle2, Download, ChevronRight } from "lucide-react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { yeastarDevDiagnostics, yeastarKpiValidation } from "@/lib/yeastar.functions";
import { hhmmss } from "@/features/call-center/utils";
import {
  buildComparison,
  filterCallRows,
  inspectMismatch,
  expectedOfficialClassification,
  EMPTY_OFFICIAL,
  EMPTY_CALL_FILTERS,
  type CallRow,
  type KpiComparisonRow,
  type OfficialFigures,
} from "@/features/yeastar-diagnostics/compare";
import {
  exportValidationXlsx,
  exportComparisonCsv,
  exportCallsCsv,
  exportMismatchCsv,
} from "@/features/yeastar-diagnostics/export";

export const Route = createFileRoute("/_app/admin/yeastar-diagnostics")({
  component: YeastarDiagnostics,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics · MilaServ Portal" }] }),
});

function Json({ data, max = "max-h-80" }: { data: unknown; max?: string }) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return <pre className={`text-xs bg-muted rounded p-3 overflow-auto ${max}`}>{text ?? "—"}</pre>;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border/60 p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function fmtKpi(row: KpiComparisonRow, v: number | null): string {
  if (v == null) return "—";
  if (row.format === "duration") return hhmmss(v);
  if (row.format === "percent") return `${v.toFixed(2)}%`;
  return String(v);
}

function YeastarDiagnostics() {
  const { role } = useAuth();
  const isAdmin = isAdministrator(role);
  const isDev = import.meta.env.DEV;

  const [windowDays, setWindowDays] = useState(7);
  const runFn = useServerFn(yeastarDevDiagnostics);
  const run = useMutation({ mutationFn: () => runFn({ data: { windowDays } }) });

  // --- validation controls -------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [team, setTeam] = useState<"all" | "customer_care" | "telesales">("telesales");
  const [official, setOfficial] = useState<OfficialFigures>(EMPTY_OFFICIAL);
  const [filters, setFilters] = useState(EMPTY_CALL_FILTERS);
  const [openKpi, setOpenKpi] = useState<string | null>(null);

  const validateFn = useServerFn(yeastarKpiValidation);
  const validate = useMutation({
    mutationFn: () => validateFn({ data: { from, to, team } }),
  });
  const report = validate.data?.ok ? validate.data.report : null;

  const comparison = useMemo(
    () => (report ? buildComparison(report.totals, official) : []),
    [report, official],
  );
  const callRows: CallRow[] = report?.callRows ?? [];
  const visibleCalls = useMemo(() => filterCallRows(callRows, filters), [callRows, filters]);

  const classifications = useMemo(
    () => [...new Set(callRows.map((c) => c.classification))].sort(),
    [callRows],
  );
  const rootCauses = useMemo(
    () => [...new Set(callRows.map((c) => c.rootCause))].sort(),
    [callRows],
  );
  const mismatches = comparison.filter((c) => c.status === "mismatch");

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

  const officialField = (key: keyof OfficialFigures, label: string, placeholder: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        value={official[key]}
        placeholder={placeholder}
        onChange={(e) => setOfficial({ ...official, [key]: e.target.value })}
        className="h-8"
      />
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Analytics validation &amp; mismatch investigation · administrators only
        </p>
      </div>

      {/* ---- 1. Window + official figures ---------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Validation window</CardTitle>
          <div className="text-xs text-muted-foreground">
            {team === "customer_care" ? (
              <>
                Customer Care is queue-driven and is validated on queue analytics.{" "}
                <span className="font-medium">
                  Do not compare it against Extension Call Statistics
                </span>{" "}
                — that report only counts calls that reached an extension.
              </>
            ) : (
              <>
                Telesales is validated against Yeastar{" "}
                <span className="font-medium">Reports › Extension Call Statistics</span>. Enter that
                report's figures below — this firmware exposes no API for it.
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="from" className="text-xs">
                From
              </Label>
              <Input
                id="from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to" className="text-xs">
                To
              </Label>
              <Input
                id="to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-40"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Team</Label>
              <Select value={team} onValueChange={(v) => setTeam(v as typeof team)}>
                <SelectTrigger className="h-9 w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="telesales">Telesales</SelectItem>
                  <SelectItem value="customer_care">Customer Care</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => validate.mutate()} disabled={validate.isPending}>
              {validate.isPending ? "Validating…" : "Run validation"}
            </Button>
            {report && (
              <span className="text-xs text-muted-foreground">
                {report.cdr.rowsInWindow} rows → {report.stats.normalizedCalls} calls ·{" "}
                {report.processing.totalMs}ms
              </span>
            )}
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">
              Official Yeastar figures for this window
              <span className="block font-normal normal-case">
                typed in from the PBX report — leave blank to skip a KPI
              </span>
            </Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
              {officialField("total", "Total Calls", "158")}
              {officialField("answered", "Answered", "100")}
              {officialField("noAnswer", "No Answer", "29")}
              {officialField("busy", "Busy", "15")}
              {officialField("failed", "Failed", "0")}
              {officialField("inbound", "Inbound", "0")}
              {officialField("outbound", "Outbound", "158")}
              {officialField("talkTime", "Total Talk Time", "02:40:31")}
            </div>
          </div>

          {validate.isError && <Json data={String(validate.error)} />}
          {validate.data && !validate.data.ok && (
            <div className="text-sm text-destructive">
              {!validate.data.configured
                ? "Yeastar is not configured (missing YEASTAR_* environment variables)."
                : validate.data.error}
            </div>
          )}
        </CardContent>
      </Card>

      {report && (
        <>
          {/* ---- 2. KPI comparison ----------------------------------------- */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                {mismatches.length === 0 ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <TriangleAlert className="h-4 w-4 text-destructive" />
                )}
                KPI comparison
                <Badge
                  variant={mismatches.length === 0 ? "default" : "destructive"}
                  className="font-normal"
                >
                  {mismatches.length} mismatch{mismatches.length === 1 ? "" : "es"}
                </Badge>
              </CardTitle>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => exportComparisonCsv(comparison, from, to)}
                >
                  <Download className="h-4 w-4 mr-1" /> CSV
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    exportValidationXlsx({
                      comparison,
                      calls: visibleCalls,
                      exclusions: report.exclusions,
                      from,
                      to,
                    })
                  }
                >
                  <Download className="h-4 w-4 mr-1" /> Excel
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">KPI</th>
                    <th className="px-3 py-2 text-right">Dashboard</th>
                    <th className="px-3 py-2 text-right">Official Yeastar</th>
                    <th className="px-3 py-2 text-right">Difference</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {comparison.map((r) => {
                    const bad = r.status === "mismatch";
                    return (
                      <Fragment key={r.key}>
                        <tr className={`border-b last:border-0 ${bad ? "bg-destructive/5" : ""}`}>
                          <td className="px-3 py-2 font-medium">{r.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {fmtKpi(r, r.dashboard)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {fmtKpi(r, r.official)}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-semibold ${
                              bad ? "text-destructive" : "text-muted-foreground"
                            }`}
                          >
                            {r.difference == null
                              ? "—"
                              : `${r.difference > 0 ? "+" : ""}${fmtKpi(r, r.difference)}`}
                          </td>
                          <td className="px-3 py-2">
                            <Badge
                              variant={
                                r.status === "match"
                                  ? "secondary"
                                  : r.status === "mismatch"
                                    ? "destructive"
                                    : "outline"
                              }
                              className="font-normal"
                            >
                              {r.status === "not-entered" ? "not entered" : r.status}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-right">
                            {bad && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setOpenKpi(openKpi === r.key ? null : r.key)}
                              >
                                <ChevronRight
                                  className={`h-4 w-4 transition-transform ${
                                    openKpi === r.key ? "rotate-90" : ""
                                  }`}
                                />
                                Inspect
                              </Button>
                            )}
                          </td>
                        </tr>
                        {bad && openKpi === r.key && (
                          <tr className="border-b last:border-0">
                            <td colSpan={6} className="px-3 py-3 bg-muted/40">
                              <MismatchInspector kpi={r.key} row={r} calls={callRows} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* ---- 3. Exclusion ledger --------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Exclusion ledger</CardTitle>
              <div className="text-xs text-muted-foreground">
                {report.callsSeen - report.calls} of {report.callsSeen} calls are not operational.
                Excluded calls never move a KPI. A zero is information, not an omission.
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {report.exclusions.map((e) => (
                  <Stat key={e.reason} label={e.reason} value={e.count} />
                ))}
                <Stat label="agent_cancelled" value={report.totals.cancelledByAgent} />
              </div>
            </CardContent>
          </Card>

          {/* ---- 4. Analytics debug ---------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Analytics debug</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat label="Raw CDR rows" value={report.stats.rawRows} />
                <Stat label="Normalized calls" value={report.stats.normalizedCalls} />
                <Stat label="Duplicate legs removed" value={report.stats.duplicateLegsRemoved} />
                <Stat label="Direction corrections" value={report.stats.directionCorrections} />
                <Stat label="Calls excluded" value={report.stats.callsExcluded} />
                <Stat label="Queue calls" value={report.stats.queueCalls} />
                <Stat label="Extension calls" value={report.stats.extensionCalls} />
                <Stat label="Ring timeout" value={`${report.outbound.ringTimeoutSeconds}s`} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <Stat label="Fetch" value={`${report.processing.fetchMs}ms`} />
                <Stat label="Normalize" value={`${report.processing.normalizeMs}ms`} />
                <Stat label="Aggregate" value={`${report.processing.aggregateMs}ms`} />
                <Stat label="Total" value={`${report.processing.totalMs}ms`} />
                <Stat
                  label="Production CDR cache"
                  value={
                    report.processing.cdrCache.status === "warm"
                      ? `warm · ${Math.round((report.processing.cdrCache.ageMs ?? 0) / 1000)}s old`
                      : "cold"
                  }
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Validation fetches its own copy of the window, so running it neither warms nor
                evicts the cache the dashboards use.
              </p>
              <div className="grid gap-3 sm:grid-cols-3 text-xs">
                <div>
                  <Label className="text-xs text-muted-foreground">Outcomes</Label>
                  <Json data={report.outcomes} max="max-h-48" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Leg roles</Label>
                  <Json data={report.legRoles} max="max-h-48" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    Legs per call
                    <span className="block font-normal normal-case">
                      all-1 means grouping broke
                    </span>
                  </Label>
                  <Json data={report.legsPerCall} max="max-h-48" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">
                  Unanswered outbound ring durations
                  <span className="block font-normal normal-case">
                    the spike at the top is the true ring timeout — set
                    YEASTAR_OUTBOUND_RING_TIMEOUT_SEC to it
                  </span>
                </Label>
                <Json data={report.outbound.ringHistogram} max="max-h-40" />
              </div>
            </CardContent>
          </Card>

          {/* ---- 5. Call comparison ---------------------------------------- */}
          <Card>
            <CardHeader className="space-y-3">
              <div className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">
                  Call comparison ({visibleCalls.length}
                  {report.callRowsTruncated ? "+" : ""})
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportCallsCsv(visibleCalls, from, to)}
                  >
                    <Download className="h-4 w-4 mr-1" /> Calls
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportMismatchCsv(callRows, from, to)}
                  >
                    <Download className="h-4 w-4 mr-1" /> Mismatches
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                <Input
                  placeholder="Call ID…"
                  value={filters.callId}
                  onChange={(e) => setFilters({ ...filters, callId: e.target.value })}
                  className="h-8"
                />
                <Input
                  placeholder="Extension…"
                  value={filters.extension}
                  onChange={(e) => setFilters({ ...filters, extension: e.target.value })}
                  className="h-8"
                />
                <Select
                  value={filters.agentId}
                  onValueChange={(v) => setFilters({ ...filters, agentId: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any agent</SelectItem>
                    {report.agents.map((a) => (
                      <SelectItem key={a.ext} value={a.ext}>
                        {a.name} ({a.ext})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.direction}
                  onValueChange={(v) => setFilters({ ...filters, direction: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Direction" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any direction</SelectItem>
                    <SelectItem value="Inbound">Inbound</SelectItem>
                    <SelectItem value="Outbound">Outbound</SelectItem>
                    <SelectItem value="Internal">Internal</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={filters.classification}
                  onValueChange={(v) => setFilters({ ...filters, classification: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Classification" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any classification</SelectItem>
                    {classifications.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={filters.rootCause}
                  onValueChange={(v) => setFilters({ ...filters, rootCause: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Root cause" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any root cause</SelectItem>
                    {rootCauses.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <CallTable rows={visibleCalls.slice(0, 300)} />
              {visibleCalls.length > 300 && (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  Showing the first 300 of {visibleCalls.length}. Narrow the filters, or export.
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ---- 6. Endpoint probes — development builds only ------------------ */}
      {!isDev ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground flex items-start gap-2">
            <TriangleAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Endpoint probes are available in development builds only — they return raw PBX
              response bodies. Everything above runs in every environment.
            </span>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Endpoint probes (dev)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="windowDays" className="text-xs">
                  CDR window (days)
                </Label>
                <Input
                  id="windowDays"
                  type="number"
                  min={1}
                  max={30}
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value) || 7)}
                  className="h-9 w-28"
                />
              </div>
              <Button onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? "Probing…" : "Run probes"}
              </Button>
            </CardContent>
          </Card>
          {run.data?.ok &&
            run.data.report.probes.map((p) => (
              <Card key={p.label}>
                <CardHeader>
                  <CardTitle className="text-base flex flex-wrap items-center gap-2">
                    {p.parseErrors.length === 0 && p.endpointExists ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <TriangleAlert className="h-4 w-4 text-amber-600" />
                    )}
                    {p.label}
                    <span className="text-xs font-normal text-muted-foreground">
                      {p.elapsedMs}ms
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {p.parseErrors.length > 0 && (
                    <ul className="text-xs list-disc pl-5 space-y-1 text-destructive">
                      {p.parseErrors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                  {p.parsed != null && <Json data={p.parsed} />}
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </div>
  );
}

/** The calls that could explain one KPI's difference. */
function MismatchInspector({
  kpi,
  row,
  calls,
}: {
  kpi: string;
  row: KpiComparisonRow;
  calls: CallRow[];
}) {
  const { candidates, note } = inspectMismatch(kpi, calls);
  const shortfall = row.difference != null && row.difference < 0;

  return (
    <div className="space-y-2">
      <div className="text-xs">
        Dashboard <span className="font-semibold">{fmtKpi(row, row.dashboard)}</span> · Official{" "}
        <span className="font-semibold">{fmtKpi(row, row.official)}</span> · Difference{" "}
        <span className="font-semibold text-destructive">{fmtKpi(row, row.difference)}</span>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {shortfall && candidates.length === 0 && (
        <p className="text-xs text-destructive">
          No call in our dataset explains this. The dashboard is reporting FEWER than the PBX, so
          the responsible calls were never received — root cause: missing CDR row.
        </p>
      )}
      {candidates.length > 0 && <CallTable rows={candidates.slice(0, 100)} />}
    </div>
  );
}

function CallTable({ rows }: { rows: CallRow[] }) {
  if (rows.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-muted-foreground">No calls.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="px-2 py-2">Call ID</th>
          <th className="px-2 py-2">Date / Time</th>
          <th className="px-2 py-2">Agent</th>
          <th className="px-2 py-2">Ext</th>
          <th className="px-2 py-2">Direction</th>
          <th className="px-2 py-2">Dashboard class</th>
          <th className="px-2 py-2">Expected official</th>
          <th className="px-2 py-2">In / Excluded</th>
          <th className="px-2 py-2">Exclusion reason</th>
          <th className="px-2 py-2 text-right">Talk</th>
          <th className="px-2 py-2 text-right">Ring</th>
          <th className="px-2 py-2">Queue</th>
          <th className="px-2 py-2">Root cause</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.callId}
            className={`border-b last:border-0 ${r.included ? "" : "bg-muted/40"}`}
          >
            <td className="px-2 py-1.5 font-mono">{r.callId}</td>
            <td className="px-2 py-1.5 whitespace-nowrap">
              {r.startedAt ? new Date(r.startedAt * 1000).toLocaleString() : "—"}
            </td>
            <td className="px-2 py-1.5">{r.agentName}</td>
            <td className="px-2 py-1.5 font-mono">{r.extension}</td>
            <td className="px-2 py-1.5">
              {r.direction}
              {r.directionCorrected && (
                <Badge variant="destructive" className="ml-1 font-normal text-[10px]">
                  was {r.declaredDirection || "—"}
                </Badge>
              )}
            </td>
            <td className="px-2 py-1.5 font-mono">{r.classification}</td>
            <td className="px-2 py-1.5 font-mono text-muted-foreground">
              {expectedOfficialClassification(r)}
            </td>
            <td className="px-2 py-1.5">
              <Badge variant={r.included ? "secondary" : "outline"} className="font-normal">
                {r.included ? "included" : "excluded"}
              </Badge>
            </td>
            <td className="px-2 py-1.5 font-mono text-muted-foreground">
              {r.exclusionReason ?? "—"}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">{hhmmss(r.talkSeconds)}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">
              {r.ringSeconds == null ? "—" : hhmmss(r.ringSeconds)}
            </td>
            <td className="px-2 py-1.5 font-mono">{r.queueNumber ?? "—"}</td>
            <td className="px-2 py-1.5 font-mono">{r.rootCause}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
