/**
 * Calls — overview.
 *
 * The landing page for the Calls module: high-level health only, no analytics.
 * Anything an operator needs to act on daily lives in Customer Care or
 * Telesales; anything a developer needs lives in Diagnostics. This page answers
 * one question — is call data healthy right now — and points at the page that
 * owns each answer.
 *
 * Nothing here names the PBX vendor. "Calls" is the product feature; the
 * integration behind it is an implementation detail.
 */
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  PhoneOutgoing,
  ChartNoAxesCombined,
  Headphones,
  Database,
  PhoneCall,
  ServerCog,
  ShieldAlert,
  Stethoscope,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, isAdministrator } from "@/lib/auth";
import { canViewCallCenter } from "@/lib/permissions";
import { callsTeamForRole } from "@/lib/calls-access";
import { StatusCard } from "@/features/calls/status-card";
import { yeastarQueueOptions, getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { hhmmss, toISO } from "@/features/call-center/utils";

export const Route = createFileRoute("/_app/calls/")({
  head: () => ({ meta: [{ title: "Calls — MilaServ Portal" }] }),
  component: CallsOverview,
});

function CallsOverview() {
  const { role, profile, loading: authLoading } = useAuth();
  const canView = canViewCallCenter(role, profile?.permissions as any);
  const isAdmin = isAdministrator(role);

  const today = toISO(new Date());
  const queueFn = useServerFn(yeastarQueueOptions);
  const analyticsFn = useServerFn(getCallCenterAnalytics);

  const queues = useQuery({
    queryKey: queryKeys.callCenter.queues(),
    queryFn: () => queueFn(),
    enabled: !authLoading && canView,
    staleTime: 5 * 60_000,
  });

  // Today, unscoped — the overview is a health check, not a report.
  const todayCalls = useQuery({
    queryKey: queryKeys.callCenter.analytics({
      from: today,
      to: today,
      team: "all",
      agentId: "all",
      direction: "all",
    }),
    queryFn: () =>
      analyticsFn({
        data: {
          from: today,
          to: today,
          team: "all",
          agentId: null,
          direction: "all",
          status: "all",
          includeOrders: false,
        },
      }),
    enabled: !authLoading && canView,
    staleTime: 5 * 60_000,
  });

  // Team agents have no module landing page: the overview aggregates both
  // teams, so they are sent to the one dashboard they own instead.
  const callsTeam = callsTeamForRole(role);
  if (!authLoading && callsTeam) {
    return (
      <Navigate
        to={callsTeam === "telesales" ? "/calls/telesales" : "/calls/customer-care"}
        replace
      />
    );
  }

  if (!authLoading && !canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Calls.</p>
      </div>
    );
  }

  const analytics = todayCalls.data?.ok ? todayCalls.data : null;
  const configured = todayCalls.data ? (todayCalls.data as any).configured !== false : true;
  const loading = authLoading || todayCalls.isPending;

  const pbxTone = !configured ? "bad" : analytics ? "ok" : todayCalls.isError ? "bad" : "idle";
  const pbxValue = !configured ? "Not configured" : analytics ? "Connected" : "Unknown";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Calls</h1>
        <p className="text-sm text-muted-foreground">Health overview · {today}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatusCard
          label="PBX connection"
          value={pbxValue}
          tone={pbxTone}
          icon={ServerCog}
          loading={loading}
          detail={
            configured ? "Call data is being retrieved" : "Integration credentials are not set"
          }
        />
        <StatusCard
          label="Analytics"
          value={analytics ? "Healthy" : configured ? "Unknown" : "Unavailable"}
          tone={analytics ? "ok" : "idle"}
          icon={Activity}
          loading={loading}
          detail={
            isAdmin ? (
              <Link to="/calls/analytics" className="underline underline-offset-2">
                Validate against the PBX report
              </Link>
            ) : (
              "Validated by administrators"
            )
          }
        />
        <StatusCard
          label="Today's calls"
          value={analytics ? analytics.totals.total : "—"}
          tone="idle"
          icon={PhoneCall}
          loading={loading}
          detail={
            analytics
              ? `${analytics.totals.inbound} in · ${analytics.totals.outbound} out · ${hhmmss(
                  analytics.totals.talkSeconds,
                )} talk`
              : undefined
          }
        />
        <StatusCard
          label="Last sync"
          value={
            analytics ? `${Math.max(0, Math.round(analytics.cdr.elapsedMs / 1000))}s fetch` : "—"
          }
          tone="idle"
          icon={Database}
          loading={loading}
          detail={
            analytics ? `${analytics.cdr.fetched.toLocaleString()} CDR rows for today` : undefined
          }
        />
        <StatusCard
          label="Queues"
          value={queues.data?.ok ? queues.data.queues.length : "—"}
          tone="idle"
          icon={Headphones}
          loading={queues.isPending}
          detail={
            queues.data?.ok && queues.data.queues.length > 0
              ? queues.data.queues.map((q) => q.name).join(", ")
              : undefined
          }
        />
        <StatusCard
          label="Agents with calls today"
          value={analytics ? analytics.agents.length : "—"}
          tone="idle"
          icon={Users}
          loading={loading}
        />
        <StatusCard
          label="Answer rate today"
          value={analytics ? `${analytics.totals.answerRate.toFixed(1)}%` : "—"}
          tone="idle"
          icon={ChartNoAxesCombined}
          loading={loading}
        />
        <StatusCard
          label="Unmatched extensions"
          value={analytics ? analytics.unmatched.extensions.length : "—"}
          tone={analytics && analytics.unmatched.extensions.length > 0 ? "warn" : "idle"}
          icon={Stethoscope}
          loading={loading}
          detail={
            analytics && analytics.unmatched.extensions.length > 0
              ? "Extensions the PBX reported that no agent claims"
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where to go</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          <Destination
            to="/calls/customer-care"
            icon={Headphones}
            title="Customer Care"
            body="Queue performance, SLA, waiting time and live queue status."
          />
          <Destination
            to="/calls/telesales"
            icon={PhoneOutgoing}
            title="Telesales"
            body="Outbound sales activity, lead contact rate, conversion and revenue."
          />
          {isAdmin && (
            <>
              <Destination
                to="/calls/analytics"
                icon={ChartNoAxesCombined}
                title="Analytics Center"
                body="Validate every KPI against the official PBX report and inspect mismatches."
              />
              <Destination
                to="/calls/diagnostics"
                icon={Stethoscope}
                title="Diagnostics"
                body="Developer tools: authentication, endpoint probes, CDR and call tracing."
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Destination({
  to,
  icon: Icon,
  title,
  body,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded-lg border border-border/60 p-3 transition-colors hover:bg-accent/60"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </Link>
  );
}
