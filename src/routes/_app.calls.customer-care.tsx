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
 * (openapi/v2.0) for per-agent missed calls only, Queue API for the realtime
 * tiles only. Evidence: `docs/yeastar/sprint2-source-validation.md`.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  Download,
  ShieldAlert,
  RefreshCw,
  PhoneOff,
  AlertTriangle,
  Printer,
  PhoneIncoming,
  PhoneOutgoing,
  Clock,
  Users,
  TrendingUp,
  Info,
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
import { exportCustomerCare } from "@/features/call-center/export";
import { RefreshIndicator } from "@/features/call-center/components/fetch-progress";
import { SectionHeader } from "@/features/call-center/components/section-header";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import {
  CallTrendCharts,
  HourlyDistributionChart,
} from "@/features/call-center/components/call-trend-charts";
import { AgentPerformanceTable } from "@/features/call-center/components/agent-performance-table";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCustomerCareMetrics } from "@/features/call-center/hooks/use-customer-care-metrics";

// Customer Care watches a live queue, so it refreshes every 20 seconds —
// inside the 15-30s operational band, and slow enough not to feel busy.
const CUSTOMER_CARE_REFRESH_MS = 20_000;

export const Route = createFileRoute("/_app/calls/customer-care")({
  head: () => ({ meta: [{ title: "Customer Care Calls — MilaServ Portal" }] }),
  component: CustomerCarePage,
});

function CustomerCarePage() {
  const f = useCallCenterFilters({ team: "customer_care", withQueue: true });
  const { metrics, isLoading, isRefreshing, refreshFailed, errMsg, ok, realtimeLoading, refresh } =
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

  const { overview, realtime, serviceLevel, queue, direction, time, trends, agents } = metrics;

  // Hooks first, then the permission guard — an early return above them would
  // change the hook count between renders.
  if (!f.authLoading && !f.canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to Call Analytics.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Customer Care</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            Queue analytics · {f.from} → {f.to}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <RefreshIndicator refreshing={isRefreshing} failed={refreshFailed} />
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
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCustomerCare(metrics, f.from, f.to)}
                disabled={!ok}
              >
                <Download className="h-4 w-4 mr-2" />
                Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!ok}>
                <Printer className="h-4 w-4 mr-2" />
                PDF
              </Button>
            </>
          )}
        </div>
      </div>

      {errMsg && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {/* OVERVIEW */}
      <SectionHeader>Overview</SectionHeader>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HeroKpi
          label="Total calls"
          value={overview.totalCalls}
          loading={isLoading}
          icon={Users}
          tone="primary"
        />
        <HeroKpi
          label="Answered calls"
          value={overview.answeredCalls}
          loading={isLoading}
          icon={PhoneIncoming}
          tone="success"
        />
        <HeroKpi
          label="Answer rate"
          value={pct(overview.answerRate)}
          loading={isLoading}
          icon={TrendingUp}
          tone="success"
        />
        <HeroKpi
          label="Avg talk time"
          value={hhmmss(overview.avgTalkSec)}
          loading={isLoading}
          icon={Clock}
          tone="secondary"
        />
      </div>

      {/* REALTIME QUEUE */}
      <SectionHeader>Realtime queue</SectionHeader>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          label="Waiting"
          value={realtime.waiting}
          tone="warning"
          loading={realtimeLoading}
          hint="In queue now"
        />
        <Kpi
          label="Active"
          value={realtime.active}
          tone="success"
          loading={realtimeLoading}
          hint="On call"
        />
        <Kpi label="Ringing" value={realtime.ringing} loading={realtimeLoading} />
        <Kpi
          label="Agents ready"
          value={realtime.agentsReady}
          tone="success"
          loading={realtimeLoading}
        />
        <Kpi
          label="Agents busy"
          value={realtime.agentsBusy}
          tone="secondary"
          loading={realtimeLoading}
        />
        <Kpi label="Paused" value={realtime.agentsPaused} loading={realtimeLoading} />
      </div>

      {/* SLA */}
      <SectionHeader>Service level</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label={`SLA (answered <= ${serviceLevel.slaSeconds}s)`}
          value={pct(serviceLevel.slaAttainment)}
          tone="success"
          loading={isLoading}
          hint="Answered within target, over calls offered to agents"
        />
        <Kpi
          label="Within SLA"
          value={serviceLevel.slaAnsweredWithin}
          loading={isLoading}
          hint="Queue calls answered inside the target"
        />
        <Kpi
          label="Avg wait (answered)"
          value={hhmmss(serviceLevel.avgQueueWaitAnsweredSec)}
          loading={isLoading}
          icon={Clock}
          hint="Matches Yeastar's headline Average Waiting Time"
        />
        <Kpi
          label="Longest wait"
          value={hhmmss(serviceLevel.maxQueueWaitSec)}
          loading={isLoading}
          icon={Clock}
          hint="Longest wait in the window, answered or not"
        />
      </div>

      {/* QUEUE STATISTICS */}
      <SectionHeader>Queue statistics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Kpi
          label="Queue calls"
          value={queue.queueCalls}
          loading={isLoading}
          hint="Reached a queue"
        />
        <Kpi
          label="Missed queue calls"
          value={queue.missed}
          tone="destructive"
          loading={isLoading}
          hint="Inbound not answered within ring window"
        />
        <Kpi
          label="Abandoned calls"
          value={queue.abandoned}
          tone="warning"
          loading={isLoading}
          hint="Inbound hung up before ring threshold"
        />
        <Kpi
          label="Queue answer rate"
          value={pct(queue.queueAnswerRate)}
          tone="success"
          loading={isLoading}
          hint="Answered ÷ calls offered to agents"
        />
      </div>

      {/*
        O1 — Missed vs Abandoned is defined differently here and on the PBX.
        The dashboard's definition is unchanged on purpose (Sprint 3 objective
        8); this notice makes the divergence visible instead of letting someone
        discover it by comparing two screens. Resolution is blocked on §9.4 of
        docs/yeastar/sprint2-source-validation.md.
      */}
      {metrics.unansweredSplit.reportUnansweredTotal != null && (
        <Card className="print:hidden">
          <CardContent className="p-4 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Both this dashboard and Yeastar counted{" "}
              <strong className="text-foreground">
                {metrics.unansweredSplit.dashboardUnansweredTotal}
              </strong>{" "}
              unanswered queue call
              {metrics.unansweredSplit.dashboardUnansweredTotal === 1 ? "" : "s"}
              {metrics.unansweredSplit.populationsAgree === false && (
                <> (Yeastar: {metrics.unansweredSplit.reportUnansweredTotal})</>
              )}
              , but split them differently — here{" "}
              <strong className="text-foreground">
                {metrics.unansweredSplit.dashboardMissed} missed /{" "}
                {metrics.unansweredSplit.dashboardAbandoned} abandoned
              </strong>
              , on the PBX{" "}
              <strong className="text-foreground">
                {metrics.unansweredSplit.reportMissed} missed /{" "}
                {metrics.unansweredSplit.reportAbandoned} abandoned
              </strong>
              . We split on how long the caller waited; Yeastar splits on who ended the call.
              Neither is wrong. Open issue O1.
            </span>
          </CardContent>
        </Card>
      )}

      {/* DIRECTION */}
      <SectionHeader>Call direction</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi
          label="Inbound calls"
          value={direction.inbound}
          tone="success"
          loading={isLoading}
          icon={PhoneIncoming}
        />
        <Kpi
          label="Outbound calls"
          value={direction.outbound}
          tone="secondary"
          loading={isLoading}
          icon={PhoneOutgoing}
        />
      </div>

      {/* TIME METRICS */}
      <SectionHeader>Time metrics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi
          label="Average talking time"
          value={hhmmss(time.avgTalkSec)}
          loading={isLoading}
          icon={Clock}
        />
        <Kpi
          label="Average queue wait"
          value={hhmmss(time.avgQueueWaitSec)}
          loading={isLoading}
          icon={Clock}
          hint="Averaged over calls that reached a queue"
        />
        <Kpi
          label="Total talk duration"
          value={hhmmss(time.totalTalkSec)}
          loading={isLoading}
          icon={Clock}
        />
      </div>

      {metrics.isEmpty ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-8 w-8" />
            No calls found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionHeader>Call trends</SectionHeader>
          <CallTrendCharts
            byDay={trends.byDay}
            answerRate={trends.dailyAnswerRate}
            hasData={trends.hasDailyData}
            loading={isLoading}
          />

          <SectionHeader>Hourly distribution</SectionHeader>
          <HourlyDistributionChart
            hourly12={trends.hourly}
            loading={isLoading}
            hasData={trends.hasHourlyData}
          />

          <SectionHeader>Queue members</SectionHeader>
          <Card>
            <CardContent className="p-4">
              {f.queues.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Queue membership is unavailable — the PBX roster could not be read.
                </p>
              ) : (
                <div className="space-y-3">
                  {f.queues
                    .filter((qq) => f.queue === "all" || qq.number === f.queue)
                    .map((qq) => (
                      <div key={qq.number}>
                        <div className="text-sm font-medium">
                          {qq.name}{" "}
                          <span className="font-mono text-xs text-muted-foreground">
                            #{qq.number}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {qq.members.length} member{qq.members.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {qq.members.map((m) => (
                            <span
                              key={m.ext}
                              className="rounded border border-border/60 px-2 py-0.5 text-xs"
                            >
                              <span className="font-mono text-muted-foreground">{m.ext}</span>{" "}
                              {m.name}
                            </span>
                          ))}
                          {qq.members.length === 0 && (
                            <span className="text-xs text-muted-foreground">No members.</span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          <SectionHeader>Agent performance</SectionHeader>
          <AgentPerformanceTable
            rows={agents.visible}
            loading={isLoading}
            search={f.search}
            onSearch={f.setSearch}
            mode="customer_care"
          />
        </>
      )}
    </div>
  );
}
