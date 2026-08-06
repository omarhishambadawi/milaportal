/**
 * Calls Overview — both teams on one screen.
 *
 * ---------------------------------------------------------------------------
 * What this page is for
 * ---------------------------------------------------------------------------
 * Customer Care and Telesales are separate dashboards because their KPIs are
 * computed differently — one is queue-driven, the other extension-driven — and
 * a combined page that averaged them was what made the original single
 * dashboard misleading. This page does not average them. It reports the
 * platform-wide figures that are genuinely comparable (volume, direction,
 * answer rate, timing), shows the queue's own numbers as their own band, and
 * puts the two teams side by side rather than merged.
 *
 * It is a MONITORING surface: one window, no per-agent filter, and a single PDF
 * export of what is on screen. Every number here has a page that owns it in
 * more detail, and the section headers say which.
 *
 * Missed and Abandoned are resolved through `lib/yeastar/call-classification`,
 * exactly as Customer Care resolves them. They are the same two words about the
 * same queue, and a monitoring screen that labelled them by a different rule
 * than the page that owns them would be worse than not showing them.
 *
 * ---------------------------------------------------------------------------
 * Access
 * ---------------------------------------------------------------------------
 * Anyone holding the Calls view permission who is not confined to a single
 * team's dashboard — owner, admin, supervisor and auditor in practice. Team
 * agents are refused here and in the navigation alike, by the same
 * `canViewCallsPage` rule the rest of the module uses: the page aggregates a
 * team's performance next to theirs, which is not an agent's to read.
 *
 * ---------------------------------------------------------------------------
 * Cost
 * ---------------------------------------------------------------------------
 * ONE analytics query, unscoped (`team: "all"`), with the orders join off — no
 * KPI here is order-derived, and the join is the expensive half of the request.
 * It shares the CDR cache, the phase-1 normalization cache and the refresh
 * policy with the two team dashboards, so opening this page after either of
 * them costs nothing extra.
 */
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  Hourglass,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Printer,
  RefreshCw,
  ShieldAlert,
  Target,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/date-range-picker";
import { useAuth } from "@/lib/auth";
import { canViewCallsPage } from "@/lib/permissions";
import { pct, hhmmss } from "@/features/call-center/utils";
import { RefreshIndicator } from "@/features/call-center/components/fetch-progress";
import { DashboardSection } from "@/features/call-center/components/dashboard-section";
import { EmptyWindowNotice } from "@/features/call-center/components/empty-window-notice";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import { TeamComparison } from "@/features/call-center/components/team-comparison";
import { TopAgents } from "@/features/call-center/components/top-agents";
import { CallDistribution } from "@/features/call-center/components/call-distribution";
import {
  CallTrendCharts,
  HourlyDistributionChart,
} from "@/features/call-center/components/call-trend-charts";
import { OUTBOUND } from "@/features/call-center/components/chart-primitives";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";
import { useCallReportQuery } from "@/features/call-center/hooks/use-call-report";
import { isQueueSplitApplicable, resolveQueueOutcomes } from "@/lib/yeastar/call-classification";

// Cadence for a LIVE window. The overview watches both teams, one of which is a
// live queue, so it follows Customer Care's 20s rather than Telesales' 60s.
// Larger and closed windows back off automatically — see `resolveRefreshPolicy`.
const OVERVIEW_REFRESH_MS = 20_000;

/** How many agents the leaderboard shows before it stops being a leaderboard. */
const TOP_AGENT_COUNT = 8;

export const Route = createFileRoute("/_app/calls/overview")({
  head: () => ({ meta: [{ title: "Calls Overview — MilaServ Portal" }] }),
  component: CallsOverviewPage,
});

function CallsOverviewPage() {
  const { role, profile } = useAuth();
  // The module's own gate, with this page's key. Team agents fail it — see the
  // Access note above.
  const canViewOverview = canViewCallsPage(role, profile?.permissions as any, "overview");

  const f = useCallCenterFilters();
  const a = useCallCenterAnalytics({
    from: f.from,
    to: f.to,
    team: "all",
    agentId: "all",
    direction: "all",
    canAll: f.canAll,
    canView: canViewOverview,
    authLoading: f.authLoading,
    search: "",
    refreshMs: OVERVIEW_REFRESH_MS,
    // No KPI on this page is order-derived, and the join is the expensive half
    // of the request.
    includeOrders: false,
  });

  const {
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    isEmpty,
    refreshPolicy,
    refresh,
    totals,
    rows,
    byDay,
    teamCompare,
    hourly12,
    peakHour,
  } = a;

  // The queue report behind Missed / Abandoned. Same query, same cache entry
  // and same resolution as Customer Care — the overview is unfiltered by
  // direction and by agent, so Yeastar's split always applies here.
  const callReport = useCallReportQuery({
    from: f.from,
    to: f.to,
    queue: "all",
    enabled: !f.authLoading && canViewOverview,
    policy: refreshPolicy,
  });

  // Keyed on the two fields the split actually reads, not on the whole snapshot.
  // The envelope carries `elapsedMs`, which changes on every poll — depending on
  // it would rebuild the distribution series three times a minute for numbers
  // that had not moved, and Recharts replays its animation on a new array.
  const reportAvailable = callReport.data?.available === true;
  const reportQueue = callReport.data?.queue ?? null;

  const queueOutcome = useMemo(
    () =>
      resolveQueueOutcomes(
        {
          missed: totals?.missed ?? 0,
          abandoned: totals?.abandoned ?? 0,
          inbound: totals?.inbound ?? 0,
        },
        isQueueSplitApplicable({ direction: "all", agentId: "all" }, reportAvailable)
          ? reportQueue
          : null,
        totals ? "cdr" : "unavailable",
      ),
    [totals, reportAvailable, reportQueue],
  );

  // Ranking is a derivation, so it happens once here rather than inside the
  // leaderboard. Ties break on answer rate then talk time, with `agentId` last
  // so the order is stable across refreshes.
  const topAgents = useMemo(
    () =>
      [...rows]
        .filter((r) => r.answered > 0)
        .sort(
          (x, y) =>
            y.answered - x.answered ||
            y.answerRate - x.answerRate ||
            y.talkSeconds - x.talkSeconds ||
            x.agentId.localeCompare(y.agentId),
        )
        .slice(0, TOP_AGENT_COUNT),
    [rows],
  );

  // The answer-rate series the trend card draws. Same formula as the headline
  // card, applied per day, so the two cannot tell different stories.
  const dailyAnswerRate = useMemo(
    () => byDay.map((d) => ({ date: d.date, rate: d.total ? (d.answered / d.total) * 100 : 0 })),
    [byDay],
  );

  const distribution = useMemo(
    () => [
      {
        label: "Answered",
        value: totals?.answered ?? 0,
        color: "var(--color-success)",
        hint: "An agent picked up",
      },
      {
        label: "Missed",
        value: queueOutcome.missed,
        color: "var(--color-destructive)",
        hint: "Queue released the call",
      },
      {
        label: "Abandoned",
        value: queueOutcome.abandoned,
        color: "var(--color-warning)",
        hint: "Caller hung up waiting",
      },
      {
        label: "No answer (out)",
        value: totals?.noAnswerOutbound ?? 0,
        color: OUTBOUND,
        hint: "Rang out unanswered",
      },
      { label: "Busy", value: totals?.busy ?? 0, color: "var(--color-chart-5)" },
      { label: "Failed", value: totals?.failed ?? 0, color: "var(--color-muted-foreground)" },
    ],
    [totals, queueOutcome],
  );

  // Hooks first, then the permission guard — an early return above them would
  // change the hook count between renders.
  if (!f.authLoading && !canViewOverview) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to the Calls Overview.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Calls Overview</h1>
          <p className="truncate text-xs text-muted-foreground sm:text-sm">
            Customer Care and Telesales combined · {f.from} → {f.to}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <RefreshIndicator refreshing={isRefreshing} failed={refreshFailed} />
            <span className="text-[11px] text-muted-foreground/70 print:hidden">
              {refreshPolicy.label}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangePicker range={f.range} onChange={f.setRange} align="end" size="sm" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refresh();
              void callReport.refetch();
            }}
            disabled={isRefreshing}
            aria-label="Refresh analytics"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
          {/*
            The page's only export. Print is the export: the browser's own
            PDF writer renders exactly what is on screen, and the `print:`
            utilities throughout the page drop the controls from it.
          */}
          {f.canExport && (
            <Button
              variant="default"
              size="sm"
              onClick={() => window.print()}
              disabled={isLoading}
              className="ml-1"
            >
              <Printer className="mr-2 h-4 w-4" />
              Export PDF
            </Button>
          )}
        </div>
      </div>

      {errMsg && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {isEmpty && <EmptyWindowNotice from={f.from} to={f.to} />}

      {/* ---- PLATFORM TOTALS ----------------------------------------------- */}
      <DashboardSection
        title="Overview"
        description="Every call both teams handled in the window."
        icon={Activity}
        flush
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <HeroKpi
            label="Total calls"
            value={totals?.total ?? 0}
            loading={isLoading}
            icon={PhoneCall}
            tone="primary"
            accent="primary"
            hint="Inbound + outbound, both teams"
          />
          <HeroKpi
            label="Inbound calls"
            value={totals?.inbound ?? 0}
            loading={isLoading}
            icon={PhoneIncoming}
            tone="success"
            accent="primary"
            hint="Customers calling in"
          />
          <HeroKpi
            label="Outbound calls"
            value={totals?.outbound ?? 0}
            loading={isLoading}
            icon={PhoneOutgoing}
            tone="secondary"
            accent="primary"
            hint="Calls the teams placed"
          />
          <HeroKpi
            label="Answer rate"
            value={pct(totals?.answerRate)}
            loading={isLoading}
            icon={TrendingUp}
            tone="success"
            accent="success"
            hint="Answered ÷ total calls"
          />
        </div>
      </DashboardSection>

      {/* ---- UNANSWERED ---------------------------------------------------- */}
      <DashboardSection
        title="Unanswered"
        description="Everything that did not reach an agent. Customer Care owns the queue detail."
        icon={PhoneOff}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Queue missed"
            value={queueOutcome.missed}
            tone="destructive"
            accent="destructive"
            icon={PhoneMissed}
            loading={isLoading}
            hint="Queue released the call"
          />
          <Kpi
            label="Abandoned"
            value={queueOutcome.abandoned}
            tone="warning"
            accent="destructive"
            icon={PhoneOff}
            loading={isLoading}
            hint="Caller hung up waiting"
          />
          <Kpi
            label="No answer (outbound)"
            value={totals?.noAnswerOutbound ?? 0}
            accent="destructive"
            loading={isLoading}
            hint="Rang the full timeout"
          />
          <Kpi
            label="Missed rate"
            value={pct(queueOutcome.missedRate)}
            tone="destructive"
            accent="destructive"
            loading={isLoading}
            hint="Missed ÷ inbound calls"
          />
        </div>
      </DashboardSection>

      {/* ---- QUEUE + TIMING ------------------------------------------------ */}
      <DashboardSection
        title="Queue statistics"
        description="Customer Care's queue, in Yeastar's terms. Telesales joins no queue."
        icon={Users}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Queue calls"
            value={totals?.queueCalls ?? 0}
            accent="primary"
            loading={isLoading}
            hint="Reached the queue"
          />
          <Kpi
            label="Queue answer rate"
            value={pct(totals?.queueAnswerRate)}
            tone="success"
            accent="success"
            icon={TrendingUp}
            loading={isLoading}
            hint="Answered ÷ calls offered"
          />
          <Kpi
            label="SLA"
            value={pct(totals?.slaAttainment)}
            tone="success"
            accent="success"
            icon={Gauge}
            loading={isLoading}
            hint={`Answered within ${totals?.slaSeconds ?? 0}s`}
          />
          <Kpi
            label="Longest queue wait"
            value={hhmmss(totals?.maxWaitSec)}
            accent="secondary"
            icon={Hourglass}
            loading={isLoading}
            hint="Answered or not"
          />
        </div>
      </DashboardSection>

      <DashboardSection
        title="Time metrics"
        description="How long callers waited, and how long agents talked."
        icon={Clock}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Average waiting time"
            value={hhmmss(totals?.avgWaitAnsweredSec)}
            accent="secondary"
            icon={Hourglass}
            loading={isLoading}
            hint="Answered queue calls"
          />
          <Kpi
            label="Average talking time"
            value={hhmmss(totals?.avgTalkSec)}
            accent="secondary"
            icon={Clock}
            loading={isLoading}
            hint="Per answered call"
          />
          <Kpi
            label="Total talk duration"
            value={hhmmss(totals?.talkSeconds)}
            accent="secondary"
            icon={Clock}
            loading={isLoading}
            hint="Counted once per call"
          />
          <Kpi
            label="Answered calls"
            value={totals?.answered ?? 0}
            tone="success"
            accent="success"
            icon={UserCheck}
            loading={isLoading}
            hint="Both teams"
          />
        </div>
      </DashboardSection>

      {/* ---- TEAM COMPARISON ----------------------------------------------- */}
      <DashboardSection
        title="Team comparison"
        description="The two workflows side by side. Deliberately not averaged — they are measured differently."
        icon={Target}
      >
        <TeamComparison rows={teamCompare} loading={isLoading} />
      </DashboardSection>

      {/* ---- TRENDS -------------------------------------------------------- */}
      <DashboardSection
        title="Daily trends"
        description="Volume and answer rate across the window."
        icon={TrendingUp}
      >
        <CallTrendCharts
          byDay={byDay}
          answerRate={dailyAnswerRate}
          averageRate={totals?.answerRate ?? 0}
          totalInbound={totals?.inbound ?? 0}
          totalOutbound={totals?.outbound ?? 0}
          hasData={byDay.length > 0}
          loading={isLoading}
        />
      </DashboardSection>

      <DashboardSection
        title="Calls by hour"
        description="When the platform is busiest, across both teams."
        icon={Activity}
      >
        <HourlyDistributionChart
          hourly12={hourly12}
          peakHour={peakHour}
          loading={isLoading}
          hasData={peakHour != null}
        />
      </DashboardSection>

      {/* ---- DISTRIBUTION + LEADERBOARD ------------------------------------ */}
      <DashboardSection
        title="Distribution and top agents"
        description="Where the calls ended up, and who handled the most of them."
        icon={UserCheck}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <CallDistribution slices={distribution} loading={isLoading} />
          <TopAgents rows={topAgents} loading={isLoading} />
        </div>
      </DashboardSection>
    </div>
  );
}
