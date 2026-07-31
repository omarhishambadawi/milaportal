/**
 * Call Diagnostics — Owner/Administrator only.
 *
 * Every developer tool for the PBX integration, and nothing operational. This
 * page is deliberately NOT for daily use: it exists to answer "is the
 * integration behaving?" when something looks wrong, and the operational
 * dashboards deliberately carry none of it.
 *
 * The status cards at the top state what is known before anything is pressed —
 * the page used to open as a row of identical "Probe" buttons that told an
 * operator nothing until clicked. The probes are still here, as secondary
 * actions beneath the state they refine.
 *
 * Configuration moved to /calls/configuration; KPI validation to
 * /calls/analytics. Each page has one responsibility.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert, KeyRound, Radio, Headphones, Database, Network } from "lucide-react";
import { StatusCard } from "@/features/calls/status-card";
import { useAuth, isAdministrator } from "@/lib/auth";
import { queryKeys } from "@/lib/query-keys";
import {
  yeastarConfigDiagnostic,
  yeastarAuthDiagnostic,
  yeastarCdrProbe,
  yeastarAgentMappingDiagnostic,
  yeastarEndpointProbe,
  yeastarQueueRoster,
  yeastarRealtimeQueue,
  yeastarAnalyticsDebug,
} from "@/lib/yeastar.functions";

export const Route = createFileRoute("/_app/calls/diagnostics")({
  component: CallDiagnostics,
  head: () => ({ meta: [{ title: "Call Diagnostics — MilaServ Portal" }] }),
});

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} className="font-normal">
      {label}: {ok ? "yes" : "no"}
    </Badge>
  );
}
function Json({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[420px]">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function CallDiagnostics() {
  const { role } = useAuth();
  // This page gates on administrator status, not on a view permission.
  // It previously checked `view_all_agents`, which auditor and supervisor both
  // hold by default -- so the sidebar hid the link while the route stayed
  // reachable by URL, rendering the admin tooling to non-administrators. The
  // underlying server functions all enforce assertAdmin, so no data leaked, but
  // the page must not present admin surfaces it cannot back.
  const isAdmin = isAdministrator(role);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(today);

  const configFn = useServerFn(yeastarConfigDiagnostic);
  const authFn = useServerFn(yeastarAuthDiagnostic);
  const probeFn = useServerFn(yeastarCdrProbe);
  const mapFn = useServerFn(yeastarAgentMappingDiagnostic);
  const capsFn = useServerFn(yeastarEndpointProbe);
  const rosterFn = useServerFn(yeastarQueueRoster);
  const realtimeFn = useServerFn(yeastarRealtimeQueue);
  const debugFn = useServerFn(yeastarAnalyticsDebug);

  const [debugCallId, setDebugCallId] = useState("");

  const config = useQuery({
    queryKey: queryKeys.yeastar.config(),
    queryFn: () => configFn(),
    enabled: isAdmin,
  });
  const auth = useMutation({ mutationFn: () => authFn() });
  const probe = useMutation({ mutationFn: () => probeFn({ data: { from, to } }) });
  const map = useMutation({ mutationFn: () => mapFn({ data: { from, to } }) });
  const caps = useMutation({ mutationFn: () => capsFn({ data: { from, to } }) });
  const roster = useMutation({ mutationFn: () => rosterFn() });
  const realtime = useMutation({ mutationFn: () => realtimeFn() });
  const debug = useMutation({
    mutationFn: () => debugFn({ data: { from, to, callId: debugCallId.trim() } }),
  });

  if (!isAdmin) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Call Diagnostics.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Call Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Developer tools for the call integration · administrators only
        </p>
      </div>

      {/* State first. The probes below refine what these cards already say. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatusCard
          label="Credentials"
          value={
            config.data?.baseUrlLoaded &&
            config.data?.clientIdLoaded &&
            config.data?.clientSecretLoaded
              ? "Loaded"
              : "Incomplete"
          }
          tone={
            config.data?.baseUrlLoaded &&
            config.data?.clientIdLoaded &&
            config.data?.clientSecretLoaded
              ? "ok"
              : "bad"
          }
          icon={KeyRound}
          loading={config.isPending}
          detail={config.data ? `TZ offset ${config.data.utcOffsetMinutes}m` : undefined}
        />
        <StatusCard
          label="Authentication"
          value={auth.data?.ok ? "Connected" : auth.data ? "Failed" : "Not checked"}
          tone={auth.data?.ok ? "ok" : auth.data ? "bad" : "idle"}
          icon={Network}
          loading={auth.isPending}
          detail={
            auth.data?.ok ? `token via ${auth.data.source} · ${auth.data.elapsedMs}ms` : undefined
          }
          actionLabel={auth.data ? "Re-check" : "Check now"}
          onAction={() => auth.mutate()}
          actionPending={auth.isPending}
        />
        <StatusCard
          label="Queue roster"
          value={roster.data?.ok ? `${roster.data.totalQueues} queues` : "Not loaded"}
          tone={roster.data?.ok ? "ok" : "idle"}
          icon={Headphones}
          loading={roster.isPending}
          detail={roster.data?.ok ? `${roster.data.uniqueAgents.length} unique agents` : undefined}
          actionLabel="Inspect"
          onAction={() => roster.mutate()}
          actionPending={roster.isPending}
        />
        <StatusCard
          label="CDR"
          value={probe.data?.ok ? `${probe.data.fetched.toLocaleString()} rows` : "Not fetched"}
          tone={probe.data?.ok ? "ok" : probe.data ? "bad" : "idle"}
          icon={Database}
          loading={probe.isPending}
          detail={probe.data?.ok ? `${from} → ${to} · ${probe.data.elapsedMs}ms` : undefined}
          actionLabel="Inspect"
          onAction={() => probe.mutate()}
          actionPending={probe.isPending}
        />
        <StatusCard
          label="Realtime queue"
          value={realtime.data?.ok ? `${realtime.data.calls.total} live calls` : "Not sampled"}
          tone={realtime.data?.ok ? "ok" : "idle"}
          icon={Radio}
          loading={realtime.isPending}
          detail={
            realtime.data?.ok
              ? `${realtime.data.agents.total} agents · ${realtime.data.calls.waiting} waiting`
              : undefined
          }
          actionLabel="Sample"
          onAction={() => realtime.mutate()}
          actionPending={realtime.isPending}
        />
        <StatusCard
          label="Endpoint support"
          value={
            caps.data?.ok
              ? `${caps.data.results.filter((r) => r.supported).length} supported`
              : "Not probed"
          }
          tone={caps.data?.ok ? "ok" : "idle"}
          icon={Network}
          loading={caps.isPending}
          detail={caps.data?.ok ? `${caps.data.results.length} endpoints probed` : undefined}
          actionLabel="Probe"
          onAction={() => caps.mutate()}
          actionPending={caps.isPending}
        />
        <StatusCard
          label="Agent mapping"
          value={map.data ? `${map.data.agentCount} agents` : "Not checked"}
          tone={map.data && map.data.missingExt.length > 0 ? "warn" : map.data ? "ok" : "idle"}
          icon={Headphones}
          loading={map.isPending}
          detail={map.data ? `${map.data.missingExt.length} without an extension` : undefined}
          actionLabel="Check"
          onAction={() => map.mutate()}
          actionPending={map.isPending}
        />
        <StatusCard
          label="Window"
          value={`${from} → ${to}`}
          tone="idle"
          icon={Database}
          detail="Used by CDR probe, agent mapping and call tracing"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill ok={!!config.data?.baseUrlLoaded} label="YEASTAR_BASE_URL" />
            <Pill ok={!!config.data?.clientIdLoaded} label="YEASTAR_CLIENT_ID" />
            <Pill ok={!!config.data?.clientSecretLoaded} label="YEASTAR_CLIENT_SECRET" />
            {config.data ? (
              <>
                <Badge variant="outline" className="font-normal">
                  TZ offset: {config.data.utcOffsetMinutes}m
                </Badge>
                <Badge variant="outline" className="font-normal">
                  Date format: {config.data.datetimeFormat}
                </Badge>
              </>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => config.refetch()}
            disabled={config.isFetching}
          >
            {config.isFetching ? "Checking…" : "Re-check"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => auth.mutate()} disabled={auth.isPending}>
            {auth.isPending ? "Authenticating…" : "Run auth check"}
          </Button>
          {auth.data ? <Json data={auth.data} /> : null}
          {auth.error ? (
            <div className="text-sm text-destructive">{(auth.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Date window (used by probe + mapping diagnostic)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. CDR probe</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? "Fetching…" : "Fetch CDRs for range"}
          </Button>
          {probe.data ? <Json data={probe.data} /> : null}
          {probe.error ? (
            <div className="text-sm text-destructive">{(probe.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Agent mapping</CardTitle>
          <div className="text-xs text-muted-foreground">
            Set each agent's PBX extension in{" "}
            <span className="font-mono">Users → edit → Yeastar extension</span>. Missing extensions
            and top unmatched PBX extensions are listed here.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => map.mutate()} disabled={map.isPending}>
            {map.isPending ? "Checking…" : "Run mapping diagnostic"}
          </Button>
          {map.data ? <Json data={map.data} /> : null}
          {map.error ? (
            <div className="text-sm text-destructive">{(map.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Endpoint capability probe</CardTitle>
          <div className="text-xs text-muted-foreground">
            Verifies which Yeastar OpenAPI endpoints the connected PBX actually exposes on this
            firmware. Read-only. Results feed the decision of whether to wire an endpoint in —
            nothing else changes based on this.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => caps.mutate()} disabled={caps.isPending}>
            {caps.isPending ? "Probing…" : "Probe endpoints"}
          </Button>
          {caps.data ? (
            <div className="space-y-3">
              {(() => {
                const results = caps.data.results ?? [];
                const supported = results.filter((r) => r.supported);
                const unsupported = results.filter((r) => !r.supported);
                return (
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="outline">Total: {results.length}</Badge>
                    <Badge variant="default">Supported: {supported.length}</Badge>
                    <Badge variant="destructive">Unsupported: {unsupported.length}</Badge>
                    {caps.data.probeContext?.sampleQueueId ? (
                      <Badge variant="outline" className="font-mono">
                        queue_id={caps.data.probeContext.sampleQueueId}
                        {caps.data.probeContext.sampleQueueNumber
                          ? ` (#${caps.data.probeContext.sampleQueueNumber})`
                          : ""}
                      </Badge>
                    ) : null}
                  </div>
                );
              })()}
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="px-2 py-1.5 font-medium">Status</th>
                      <th className="px-2 py-1.5 font-medium">Endpoint</th>
                      <th className="px-2 py-1.5 font-medium">HTTP</th>
                      <th className="px-2 py-1.5 font-medium">errcode</th>
                      <th className="px-2 py-1.5 font-medium">errmsg</th>
                      <th className="px-2 py-1.5 font-medium">Sample keys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caps.data.results?.map((r) => (
                      <tr key={r.endpoint} className="border-t align-top">
                        <td className="px-2 py-1.5">
                          <Badge
                            variant={r.supported ? "default" : "destructive"}
                            className="text-[10px]"
                          >
                            {r.supported ? "✓ supported" : "✗ unsupported"}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 font-mono">{r.endpoint}</td>
                        <td className="px-2 py-1.5 font-mono">{r.httpStatus || "—"}</td>
                        <td className="px-2 py-1.5 font-mono">{r.errcode ?? "—"}</td>
                        <td
                          className="px-2 py-1.5 text-muted-foreground max-w-[280px] truncate"
                          title={r.errmsg ?? ""}
                        >
                          {r.errmsg ?? "—"}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground max-w-[300px]">
                          {r.sampleKeys && r.sampleKeys.length
                            ? r.sampleKeys.slice(0, 8).join(", ") +
                              (r.sampleKeys.length > 8 ? "…" : "")
                            : "—"}
                          {r.dataCount !== null ? (
                            <span className="ml-1 text-foreground/70">({r.dataCount} items)</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Raw JSON</summary>
                <Json data={caps.data} />
              </details>
            </div>
          ) : null}

          {caps.error ? (
            <div className="text-sm text-destructive">{(caps.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">6. Queue roster (PBX-authoritative)</CardTitle>
          <div className="text-xs text-muted-foreground">
            Confirmed supported: <span className="font-mono">/openapi/v1.0/queue/list</span>.
            Returns the queues configured on the PBX and their agent members (extension ↔ display
            name). This is the authoritative source for "who is a Call Center agent". Not yet wired
            into analytics — review the roster below, then we can replace the manual per-user
            extension mapping.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => roster.mutate()} disabled={roster.isPending}>
            {roster.isPending ? "Fetching…" : "Fetch queue roster"}
          </Button>
          {roster.data ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">Queues: {roster.data.totalQueues}</Badge>
                <Badge variant="outline">
                  Unique agents: {roster.data.uniqueAgents?.length ?? 0}
                </Badge>
                {roster.data.error ? (
                  <Badge variant="destructive">{roster.data.error}</Badge>
                ) : null}
              </div>
              {roster.data.queues?.map((q) => (
                <div key={q.id} className="rounded border p-3 space-y-2">
                  <div className="text-sm font-medium">
                    {q.name}{" "}
                    <span className="text-muted-foreground font-normal">
                      · #{q.number} · {q.ring_strategy}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {q.static_members.map((m) => (
                      <Badge
                        key={m.extension_id}
                        variant="secondary"
                        className="font-mono text-[11px]"
                      >
                        {m.extension_number} · {m.display_name}
                      </Badge>
                    ))}
                    {q.static_members.length === 0 ? (
                      <span className="text-xs text-muted-foreground">No static members</span>
                    ) : null}
                  </div>
                </div>
              ))}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Raw JSON</summary>
                <Json data={roster.data} />
              </details>
            </div>
          ) : null}
          {roster.error ? (
            <div className="text-sm text-destructive">{(roster.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">7. Realtime queue (widget data source)</CardTitle>
          <div className="text-xs text-muted-foreground">
            Powers the realtime widgets on the Call Center page:
            <span className="font-mono"> /queue/call_status</span> +
            <span className="font-mono"> /queue/agent_status</span>. Never used for historical
            analytics.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => realtime.mutate()} disabled={realtime.isPending}>
            {realtime.isPending ? "Loading…" : "Snapshot realtime queue"}
          </Button>
          {realtime.data ? <Json data={realtime.data} /> : null}
          {realtime.error ? (
            <div className="text-sm text-destructive">{(realtime.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">8. Analytics debug — trace a Call ID</CardTitle>
          <div className="text-xs text-muted-foreground">
            Enter a <span className="font-mono">call_id</span> /{" "}
            <span className="font-mono">linkedid</span> to walk the raw CDR → resolved agent → KPI
            contribution pipeline. Uses the same date window above.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="space-y-1 flex-1 max-w-md">
              <Label className="text-xs">Call ID / linkedid / uid</Label>
              <Input
                value={debugCallId}
                onChange={(e) => setDebugCallId(e.target.value)}
                placeholder="e.g. 1721839200.123"
              />
            </div>
            <Button
              size="sm"
              onClick={() => debug.mutate()}
              disabled={debug.isPending || !debugCallId.trim()}
            >
              {debug.isPending ? "Tracing…" : "Trace"}
            </Button>
          </div>
          {debug.data ? <Json data={debug.data} /> : null}
          {debug.error ? (
            <div className="text-sm text-destructive">{(debug.error as Error).message}</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
