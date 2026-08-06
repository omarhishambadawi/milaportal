/**
 * Telesales call analytics — EXTENSION-driven.
 *
 * Telesales agents belong to no queue: they dial out from their extension. So
 * there is no queue wait, no queue status and no abandoned-queue metric here —
 * those numbers do not exist for this workflow, and showing them would be
 * inventing data. What matters instead is call outcomes (busy / failed / no
 * answer) and what the calls produced: orders, revenue and conversion.
 *
 * The Yeastar integration, CDR retrieval, normalization and analytics engine
 * are shared with Customer Care; only this presentation layer and the KPI
 * selection are separate.
 *
 * ---------------------------------------------------------------------------
 * Layout and performance
 * ---------------------------------------------------------------------------
 * Both follow Customer Care, deliberately. The page is banded into
 * `DashboardSection`s at a fixed rhythm rather than run together under bare
 * headers, the charts are drawn in the module's shared vocabulary, and the
 * refresh cadence is derived from the selected window by the same
 * `resolveRefreshPolicy` — a fixed poll is right for today and ruinous for a
 * month. A supervisor moving between the two dashboards should be reading one
 * interface, not two that happen to share a data source.
 */
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  Printer,
  RefreshCw,
  ShieldAlert,
  ShieldX,
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
import { fmtSAR } from "@/lib/branches";
import type { Direction } from "@/features/call-center/types";
import { pct, hhmmss } from "@/features/call-center/utils";
import { RefreshIndicator } from "@/features/call-center/components/fetch-progress";
import { DashboardSection } from "@/features/call-center/components/dashboard-section";
import { EmptyWindowNotice } from "@/features/call-center/components/empty-window-notice";
import { HeroKpi } from "@/features/call-center/components/hero-kpi";
import { Kpi } from "@/features/call-center/components/kpi";
import { ConversionByAgentTable } from "@/features/call-center/components/conversion-by-agent-table";
import {
  TelesalesTrendCharts,
  OutboundHourlyChart,
} from "@/features/call-center/components/telesales-trend-charts";
import { AgentPerformanceTable } from "@/features/call-center/components/agent-performance-table";
import { useCallCenterFilters } from "@/features/call-center/hooks/use-call-center-filters";
import { useCallCenterAnalytics } from "@/features/call-center/hooks/use-call-center-analytics";

// Cadence for a LIVE window. Telesales reviews a day's outbound work rather
// than a live queue, so 60s keeps it current without extra load. Larger and
// closed windows back off automatically — see `resolveRefreshPolicy`.
const TELESALES_REFRESH_MS = 60_000;

export const Route = createFileRoute("/_app/calls/telesales")({
  head: () => ({ meta: [{ title: "Telesales Calls — MilaServ Portal" }] }),
  component: TelesalesPage,
});

function TelesalesPage() {
  const f = useCallCenterFilters({ team: "telesales" });
  const a = useCallCenterAnalytics({
    from: f.from,
    to: f.to,
    team: "telesales",
    agentId: f.agentId,
    direction: f.direction,
    canAll: f.canAll,
    canView: f.canView,
    authLoading: f.authLoading,
    search: f.search,
    refreshMs: TELESALES_REFRESH_MS,
  });

  const {
    ok,
    isLoading,
    isRefreshing,
    refreshFailed,
    errMsg,
    isEmpty,
    refreshPolicy,
    refresh,
    totals,
    byDay,
    conv,
    hourly12,
    peakOutboundHour,
    searchedAgents,
  } = a;

  // Memoised because it is a prop of a memoised table: rebuilt per render it
  // would defeat that memo on every refresh tick.
  const perAgent = useMemo(() => conv?.perAgent ?? [], [conv]);
  const perDay = useMemo(() => conv?.perDay ?? [], [conv]);

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
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Telesales</h1>
          <p className="truncate text-xs text-muted-foreground sm:text-sm">
            Extension analytics · {f.from} → {f.to}
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
            <Button variant="default" size="sm" onClick={() => window.print()} disabled={!ok}>
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

      {/*
        A zero-call window is a complete, valid answer, not an error and not a
        reason to stop rendering. It is announced once here and every section
        below stays on screen showing its own zeros — see the note on
        `EmptyWindowNotice`.
      */}
      {isEmpty && <EmptyWindowNotice from={f.from} to={f.to} />}

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
            value={totals?.total ?? 0}
            loading={isLoading}
            icon={Users}
            tone="primary"
            accent="primary"
            hint="Every call the extensions handled"
          />
          <HeroKpi
            label="Answered calls"
            value={totals?.answered ?? 0}
            loading={isLoading}
            icon={PhoneIncoming}
            tone="success"
            accent="primary"
            hint="The far end picked up"
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
          <HeroKpi
            label="Conversion rate"
            value={pct(conv?.overall.conversionRate)}
            loading={isLoading}
            icon={PhoneOutgoing}
            tone="secondary"
            accent="secondary"
            hint="Total orders ÷ answered calls"
          />
        </div>
      </DashboardSection>

      {/* ---- OUTBOUND ACTIVITY — the operation ------------------------------
          Inbound is informational only: the only legitimate inbound telesales
          call is a transfer from Customer Care, so it is never a primary KPI. */}
      <DashboardSection
        title="Outbound activity"
        description="What the team dialled, and how much of it reached a customer."
        icon={PhoneOutgoing}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            label="Outbound calls"
            value={totals?.outbound ?? 0}
            tone="secondary"
            accent="primary"
            loading={isLoading}
            icon={PhoneOutgoing}
            hint="Dialled out"
          />
          <Kpi
            label="Contacted"
            value={totals?.outboundAnswered ?? 0}
            tone="success"
            accent="primary"
            loading={isLoading}
            icon={UserCheck}
            hint="Customer picked up"
          />
          <Kpi
            label="Lead contact rate"
            value={pct(totals?.leadContactRate)}
            tone="success"
            accent="success"
            loading={isLoading}
            icon={Gauge}
            hint="Answered ÷ total outbound"
          />
          <Kpi
            label="Transferred in"
            value={totals?.inbound ?? 0}
            accent="muted"
            loading={isLoading}
            icon={PhoneIncoming}
            hint="Informational — transfers from Customer Care"
          />
        </div>
      </DashboardSection>

      {/* ---- OUTCOMES — what happened when the far end was dialled --------- */}
      <DashboardSection
        title="Call outcomes"
        description="Why the calls that did not connect did not connect."
        icon={PhoneOff}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            label="No answer"
            value={totals?.noAnswerOutbound ?? 0}
            accent="destructive"
            loading={isLoading}
            hint="Rang the full timeout without an answer"
          />
          <Kpi
            label="Agent cancelled"
            value={totals?.cancelledByAgent ?? 0}
            tone="destructive"
            accent="destructive"
            loading={isLoading}
            icon={ShieldX}
            hint="Agent hung up before the ring timeout expired"
          />
          <Kpi
            label="Busy"
            value={totals?.busy ?? 0}
            tone="warning"
            accent="destructive"
            loading={isLoading}
          />
          <Kpi
            label="Failed"
            value={totals?.failed ?? 0}
            tone="destructive"
            accent="destructive"
            loading={isLoading}
          />
        </div>
      </DashboardSection>

      {/* ---- AGENT DISCIPLINE — lead-abuse signal -------------------------- */}
      <DashboardSection
        title="Agent discipline"
        description="Whether calls are being cut short before the customer had a chance to answer."
        icon={ShieldX}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Kpi
            label="Agent cancel rate"
            value={pct(totals?.agentCancelRate)}
            tone="destructive"
            accent="destructive"
            loading={isLoading}
            hint="Cancelled ÷ total outbound"
          />
          <Kpi
            label="Avg ring before cancel"
            value={hhmmss(totals?.avgRingBeforeCancelSec)}
            accent="secondary"
            loading={isLoading}
            icon={Clock}
            hint="How long the agent waited before hanging up"
          />
        </div>
      </DashboardSection>

      {/* ---- TIME METRICS — no queue wait: telesales joins no queue -------- */}
      <DashboardSection
        title="Time metrics"
        description="Where the shift's minutes went."
        icon={Clock}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Kpi
            label="Average talking time"
            value={hhmmss(totals?.avgTalkSec)}
            accent="secondary"
            loading={isLoading}
            icon={Clock}
            hint="Per answered call"
          />
          <Kpi
            label="Total talk duration"
            value={hhmmss(totals?.talkSeconds)}
            accent="secondary"
            loading={isLoading}
            icon={Clock}
            hint="Agent talk time, counted once per call"
          />
        </div>
      </DashboardSection>

      {/* ---- TRENDS -------------------------------------------------------- */}
      <DashboardSection
        title="Sales trends"
        description="Reach, discipline and what the calls produced, across the window."
        icon={TrendingUp}
      >
        <TelesalesTrendCharts byDay={byDay} perDay={perDay} loading={isLoading} />
      </DashboardSection>

      <DashboardSection
        title="Hourly distribution"
        description="When the team actually dials, and when customers pick up."
        icon={Activity}
      >
        <OutboundHourlyChart
          hourly12={hourly12}
          peakHour={peakOutboundHour}
          loading={isLoading}
          hasData={!isEmpty && peakOutboundHour != null}
        />
      </DashboardSection>

      <DashboardSection
        title="Agent performance"
        description="Per-agent detail for the selected window."
        icon={UserCheck}
      >
        <AgentPerformanceTable
          rows={searchedAgents}
          loading={isLoading}
          search={f.search}
          onSearch={f.setSearch}
          mode="telesales"
        />
      </DashboardSection>

      {/* ---- CONVERSION — Orders is the source of truth for order metrics -- */}
      <DashboardSection
        title="Conversion"
        description="What the answered calls turned into. Order figures come from Orders, not the PBX."
        icon={PhoneOutgoing}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Kpi
              label="Answered calls"
              value={totals?.answered ?? 0}
              accent="primary"
              loading={isLoading}
            />
            <Kpi
              label="Total orders"
              value={conv?.overall.orders ?? 0}
              tone="primary"
              accent="primary"
              loading={isLoading}
            />
            <Kpi
              label="Completed"
              value={conv?.overall.completed ?? 0}
              tone="success"
              accent="success"
              loading={isLoading}
            />
            <Kpi
              label="Conversion rate"
              value={pct(conv?.overall.conversionRate)}
              tone="secondary"
              accent="success"
              loading={isLoading}
              hint="Orders ÷ answered calls"
            />
            <Kpi
              label="Revenue"
              value={conv ? fmtSAR(conv.overall.revenue) : fmtSAR(0)}
              accent="secondary"
              loading={isLoading}
            />
            <Kpi
              label="Revenue per call"
              value={conv ? fmtSAR(conv.overall.revenuePerCall) : fmtSAR(0)}
              accent="secondary"
              loading={isLoading}
            />
          </div>

          <ConversionByAgentTable rows={perAgent} loading={isLoading} />
        </div>
      </DashboardSection>
    </div>
  );
}
