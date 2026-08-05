/**
 * Customer Care call analytics — QUEUE-driven, Metrics Engine only.
 *
 * Customer Care traffic arrives on a queue, so every KPI here is about the
 * queue: how long callers waited, how many the queue never got answered, how
 * many hung up. Orders, revenue and conversion are deliberately absent — those
 * belong to Telesales, and mixing them into a queue dashboard is what made the
 * combined page misleading.
 *
 * ---------------------------------------------------------------------------
 * This file computes nothing.
 * ---------------------------------------------------------------------------
 * Every number rendered below comes from `useCustomerCareMetrics`, which is the
 * single entry point onto the Metrics Engine. This component may format a value
 * and may decide not to show one; it may not derive one. No `.filter()`, no
 * `.reduce()`, no ratios, no `?? 0` standing in for a metric. If a widget needs
 * a number that is not on `metrics`, it belongs on `metrics` — see the contract
 * on `buildCustomerCareMetrics`.
 *
 * Sources, per Sprint 3: CDR for every historical KPI, Yeastar Call Report
 * (openapi/v2.0) for per-agent missed calls and for the Missed/Abandoned split.
 * Evidence: `docs/yeastar/sprint2-source-validation.md`.
 *
 * ---------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------------
 * The page reads top-down as an operations screen: what happened overall, then
 * the queue's own numbers — which are the primary section, because this is a
 * queue dashboard and everything below them is supporting detail. Terminology
 * follows Yeastar's Queue panel throughout, so a supervisor with both screens
 * open is reading the same words for the same figures.
 *
 * The realtime queue tiles were removed: they were the only widget on the page
 * describing the present moment rather than the selected window, and they cost a
 * 15-second poll that re-rendered every chart beneath them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/date-range-picker";
import type { Direction } from "@/features/call-center/types";
import { pct, hhmmss } from "@/features/call-center/utils";
import { RefreshIndicator } from "@/features/call-center/components/fetch-progress";
import { DashboardSection } from "@/features/call-center/components/dashboard-section";
import { InfoBanner } from "@/features/call-center/components/info-banner";
import { QueueMembers } from "@/features/call-center/components/queue-members";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import {
  CallTrendCharts,
  HourlyDistributionChart,
} from "@/features/call-center/components/call-trend-charts";
import {
  AgentPerformanceTable,
  agentRowId,
} from "@/features/call-center/components/agent-performance-table";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCustomerCareMetrics } from "@/features/call-center/hooks/use-customer-care-metrics";

// Cadence for a LIVE window (today, or today plus yesterday) — inside the
// 15-30s operational band, and slow enough not to feel busy. Larger and closed
// windows back off automatically; see `resolveRefreshPolicy`.
const CUSTOMER_CARE_REFRESH_MS = 20_000;

/** Where the queue-member chips jump to. */
const AGENTS_ANCHOR = "agent-performance";

/** How long a jumped-to agent row stays flagged. Long enough to find, short
 *  enough that it never looks like a persistent selection. */
const AGENT_HIGHLIGHT_MS = 3_000;

export const Route = createFileRoute("/_app/calls/customer-care")({
  head: () => ({ meta: [{ title: "Customer Care Calls — MilaServ Portal" }] }),
  component: CustomerCarePage,
});

function CustomerCarePage() {
  const f = useCallCenterFilters({ team: "customer_care", withQueue: true });
  const { metrics, isLoading, isRefreshing, refreshFailed, errMsg, ok, refreshPolicy, refresh } =
    useCustomerCareMetrics({
      from: f.from,
      to: f.to,
      agentId: f.agentId,
      direction: f.direction,
      queue: f.queue,
      canAll: f.canAll,
      canView: f.canView,
      authLoading: f.authLoading,
      search: f.search,
      refreshMs: CUSTOMER_CARE_REFRESH_MS,
    });

  const { overview, serviceLevel, queue, direction, time, trends, agents, sources } = metrics;
  const split = metrics.unansweredSplit;
  const yeastarSplit = sources.queueOutcome === "call_report";

  // Memoised because it is a prop of a memoised component: rebuilt per render it
  // would defeat `QueueMembers`'s own memo on every refresh tick.
  const visibleQueues = useMemo(
    () => f.queues.filter((qq) => f.queue === "all" || qq.number === f.queue),
    [f.queues, f.queue],
  );

  // Queue-member chips scroll to an agent and flag their row. Deliberately NOT
  // a filter: the search box, the agent dropdown and every query stay untouched,
  // so the analytics on screen are the same before and after the jump.
  const [highlightExt, setHighlightExt] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const showAgent = useCallback((ext: string) => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightExt(ext);
    highlightTimer.current = setTimeout(() => setHighlightExt(null), AGENT_HIGHLIGHT_MS);

    // Next frame, so the row is already flagged when it arrives rather than
    // lighting up after it has settled. An agent with no calls in the window
    // has no row at all — fall back to the section so the click still goes
    // somewhere sensible.
    requestAnimationFrame(() => {
      const row = document.getElementById(agentRowId(ext));
      (row ?? document.getElementById(AGENTS_ANCHOR))?.scrollIntoView({
        behavior: "smooth",
        block: row ? "center" : "start",
      });
    });
  }, []);

  // Hooks first, then the permission guard — an early return above them would
  // change the hook count between renders.
  if (!f.authLoading && !f.canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Call Analytics.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Customer Care</h1>
          <p className="truncate text-xs text-muted-foreground sm:text-sm">
            Queue analytics · {f.from} → {f.to}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <RefreshIndicator refreshing={isRefreshing} failed={refreshFailed} />
            {/*
              The cadence is derived from the window, so it has to be stated —
              a page that silently stops polling on a month-wide range looks
              stale rather than deliberate.
            */}
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
            onClick={() => refresh()}
            disabled={isRefreshing}
            aria-label="Refresh analytics"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
          {f.queues.length > 0 && (
            <Select value={f.queue} onValueChange={f.setQueue}>
              <SelectTrigger className="h-9 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All queues</SelectItem>
                {f.queues.map((qq) => (
                  <SelectItem key={qq.number} value={qq.number}>
                    {qq.name} ({qq.number})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {f.canAll && (
            <Select value={f.agentId} onValueChange={f.setAgentId}>
              <SelectTrigger className="h-9 w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {f.filteredAgents.map((agent: any) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={f.direction} onValueChange={(v) => f.setDirection(v as Direction)}>
            <SelectTrigger className="h-9 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both</SelectItem>
              <SelectItem value="Inbound">Inbound</SelectItem>
              <SelectItem value="Outbound">Outbound</SelectItem>
            </SelectContent>
          </Select>
          {f.canExport && (
            <Button
              variant="default"
              size="sm"
              onClick={() => window.print()}
              disabled={!ok}
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

      {/* ---- OVERVIEW ------------------------------------------------------ */}
      <DashboardSection
        title="Overview"
        description="The window at a glance. Everything below breaks these down."
        icon={Activity}
        flush
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <HeroKpi
            label="Total calls"
            value={overview.totalCalls}
            loading={isLoading}
            icon={PhoneCall}
            tone="primary"
            accent="primary"
            hint="Inbound + outbound"
          />
          <HeroKpi
            label="Queue inbound calls"
            value={queue.answered}
            loading={isLoading}
            icon={PhoneIncoming}
            tone="success"
            accent="primary"
            hint="Answered by the queue — excludes missed and abandoned"
          />
          <HeroKpi
            label="Abandoned calls"
            value={queue.abandoned}
            loading={isLoading}
            icon={PhoneOff}
            tone="warning"
            accent="primary"
            hint={yeastarSplit ? "Caller hung up while waiting" : "Yeastar's split unavailable"}
          />
          {/*
            Queue Missed, not Average Talk Time. Talk time is still on the page
            twice — Time metrics reports it, and the agent table breaks it down
            per agent — whereas the number a supervisor opens this page to see
            is how many callers the queue failed. The same field the Queue
            statistics card renders, so the two can never disagree.
          */}
          <HeroKpi
            label="Queue missed"
            value={queue.missed}
            loading={isLoading}
            icon={PhoneMissed}
            tone="destructive"
            accent="destructive"
            hint={yeastarSplit ? "Queue released the call" : "Yeastar's split unavailable"}
          />
        </div>
      </DashboardSection>

      {/* ---- QUEUE STATISTICS — the primary operational section ------------- */}
      <DashboardSection
        title="Queue statistics"
        description="The queue's own numbers, in Yeastar's terms."
        icon={Users}
      >
        {/*
          Two grids rather than one seven-cell grid: how the queue performed on
          top, how it failed underneath. Splitting them keeps every row evenly
          filled at every breakpoint AND carries the grouping §10 asks for
          without adding another colour.

          `Queue inbound calls` and `Queue answered` are the same population —
          inbound calls the queue answered — and both are shown on purpose.
          Yeastar uses each label in a different place, and a supervisor
          reconciling against the PBX should find whichever word they arrived
          with rather than having to work out that the other one means it too.
        */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label="Queue calls"
              value={queue.queueCalls}
              accent="primary"
              loading={isLoading}
              hint="Reached the queue"
            />
            <Kpi
              label="Queue inbound calls"
              value={queue.answered}
              tone="success"
              accent="primary"
              icon={PhoneIncoming}
              loading={isLoading}
              hint="Inbound calls the queue answered"
            />
            <Kpi
              label="Queue answered"
              value={queue.answered}
              tone="success"
              accent="primary"
              icon={UserCheck}
              loading={isLoading}
              hint="An agent picked up"
            />
            <Kpi
              label="Queue answer rate"
              value={pct(queue.queueAnswerRate)}
              tone="success"
              accent="success"
              icon={TrendingUp}
              loading={isLoading}
              hint="Answered ÷ calls offered"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Kpi
              label="Queue missed"
              value={queue.missed}
              tone="destructive"
              accent="destructive"
              icon={PhoneMissed}
              loading={isLoading}
              hint="Queue released the call"
              footnote={yeastarSplit ? "Yeastar definition" : "CDR fallback"}
            />
            <Kpi
              label="Queue abandoned"
              value={queue.abandoned}
              tone="warning"
              accent="destructive"
              icon={PhoneOff}
              loading={isLoading}
              hint="Caller hung up waiting"
              footnote={yeastarSplit ? "Yeastar definition" : "CDR fallback"}
            />
            <Kpi
              label="Unanswered total"
              value={queue.unansweredTotal}
              accent="destructive"
              loading={isLoading}
              hint="Missed + abandoned"
            />
          </div>
        </div>

        {/*
          O1 — the Missed/Abandoned split. Resolved in Sprint 3.5 in favour of
          Yeastar's definition, but the divergence is still worth stating: a
          supervisor who remembers the old numbers, or who is looking at a CDR
          export, needs to know why they differ. Compact by design — it is
          reference material, not a KPI.
        */}
        {split.reportUnansweredTotal != null && split.splitDiffers && (
          <InfoBanner
            className="mt-3"
            summary={
              <>
                Missed and abandoned follow Yeastar's definition. Our call records split the same{" "}
                {split.cdrUnansweredTotal} call{split.cdrUnansweredTotal === 1 ? "" : "s"}{" "}
                differently.
              </>
            }
          >
            Yeastar splits unanswered queue calls by <strong>who ended the call</strong> — abandoned
            means the caller hung up while waiting, missed means the queue released them. Our call
            records can only split by <strong>how long the caller waited</strong> (a 5-second
            threshold), which mislabels a long wait the caller ended. The dashboard therefore
            reports Yeastar's split:{" "}
            <strong className="text-foreground">
              {split.reportMissed} missed / {split.reportAbandoned} abandoned
            </strong>
            . The same calls split by wait time would read{" "}
            <strong className="text-foreground">
              {split.cdrMissed} missed / {split.cdrAbandoned} abandoned
            </strong>
            .
            {split.populationsAgree === false && (
              <>
                {" "}
                The two sources also disagree on the total ({split.cdrUnansweredTotal} here against{" "}
                {split.reportUnansweredTotal} on the PBX), which usually means the window or queue
                filter does not line up.
              </>
            )}
          </InfoBanner>
        )}

        {!yeastarSplit && !isLoading && metrics.callReport.attempted && (
          <InfoBanner
            className="mt-3"
            summary="Yeastar's missed/abandoned split is unavailable for this filter — showing our own."
          >
            Yeastar's queue report is inbound and queue-scoped, so it cannot describe an
            outbound-filtered view, and it is skipped when the PBX report could not be read. Missed
            and abandoned above are split by how long the caller waited (a 5-second threshold)
            rather than by who hung up, so they will not tie out against the PBX's Queue panel until
            this view is unfiltered again.
            {metrics.callReport.error && (
              <>
                {" "}
                Reported reason:{" "}
                <span className="font-mono text-[11px]">{metrics.callReport.error}</span>.
              </>
            )}
          </InfoBanner>
        )}
      </DashboardSection>

      {/* ---- SERVICE LEVEL ------------------------------------------------- */}
      <DashboardSection
        title="Service level"
        description="How quickly the queue got to its callers."
        icon={Target}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="SLA"
            value={pct(serviceLevel.slaAttainment)}
            tone="success"
            accent="success"
            icon={Gauge}
            loading={isLoading}
            hint={`Answered within ${serviceLevel.slaSeconds}s, over calls offered`}
          />
          <Kpi
            label="Within SLA"
            value={serviceLevel.slaAnsweredWithin}
            accent="success"
            loading={isLoading}
            hint="Queue calls answered inside the target"
          />
          <Kpi
            label="Average queue wait"
            value={hhmmss(serviceLevel.avgQueueWaitAnsweredSec)}
            accent="secondary"
            loading={isLoading}
            icon={Hourglass}
            hint="Answered calls — Yeastar's Average Waiting Time"
          />
          <Kpi
            label="Longest queue wait"
            value={hhmmss(serviceLevel.maxQueueWaitSec)}
            accent="secondary"
            loading={isLoading}
            icon={Hourglass}
            hint="Longest wait in the window, answered or not"
          />
        </div>
      </DashboardSection>

      {/* ---- DIRECTION & TIME ---------------------------------------------- */}
      <DashboardSection
        title="Call direction"
        description="Everything the Customer Care extensions handled, both ways."
        icon={PhoneCall}
      >
        <div className="grid grid-cols-2 gap-3">
          <Kpi
            label="Inbound calls"
            value={direction.inbound}
            tone="success"
            accent="primary"
            loading={isLoading}
            icon={PhoneIncoming}
          />
          <Kpi
            label="Outbound calls"
            value={direction.outbound}
            tone="secondary"
            accent="primary"
            loading={isLoading}
            icon={PhoneOutgoing}
          />
        </div>
      </DashboardSection>

      <DashboardSection
        title="Time metrics"
        description="Where the shift's minutes went."
        icon={Clock}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Kpi
            label="Average talking time"
            value={hhmmss(time.avgTalkSec)}
            accent="secondary"
            loading={isLoading}
            icon={Clock}
            hint="Per answered call"
          />
          <Kpi
            label="Average queue wait (all calls)"
            value={hhmmss(time.avgQueueWaitSec)}
            accent="secondary"
            loading={isLoading}
            icon={Hourglass}
            hint="Includes callers who never got through"
          />
          <Kpi
            label="Total talk duration"
            value={hhmmss(time.totalTalkSec)}
            accent="secondary"
            loading={isLoading}
            icon={Clock}
            hint="Agent talk time, counted once per call"
          />
        </div>
      </DashboardSection>

      {metrics.isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <PhoneOff className="h-8 w-8" />
            No calls found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <>
          <DashboardSection
            title="Call trends"
            description="Volume and answer rate across the window."
            icon={TrendingUp}
          >
            <CallTrendCharts
              byDay={trends.byDay}
              answerRate={trends.dailyAnswerRate}
              averageRate={overview.answerRate}
              totalInbound={direction.inbound}
              totalOutbound={direction.outbound}
              hasData={trends.hasDailyData}
              loading={isLoading}
            />
          </DashboardSection>

          <DashboardSection
            title="Hourly distribution"
            description="When the queue is busiest."
            icon={Activity}
          >
            <HourlyDistributionChart
              hourly12={trends.hourly}
              peakHour={trends.peakHour}
              loading={isLoading}
              hasData={trends.hasHourlyData}
            />
          </DashboardSection>

          <DashboardSection
            title="Queue members"
            description="Who is assigned to the queue. Select a member to jump to their row below — filters stay as they are."
            icon={Users}
          >
            <QueueMembers queues={visibleQueues} onSelectMember={showAgent} />
          </DashboardSection>

          <DashboardSection
            id={AGENTS_ANCHOR}
            title="Agent performance"
            description="Per-agent detail for the selected window."
            icon={UserCheck}
          >
            <AgentPerformanceTable
              rows={agents.visible}
              loading={isLoading}
              search={f.search}
              onSearch={f.setSearch}
              mode="customer_care"
              highlights={agents.highlights}
              highlightExt={highlightExt}
            />
          </DashboardSection>
        </>
      )}
    </div>
  );
}
