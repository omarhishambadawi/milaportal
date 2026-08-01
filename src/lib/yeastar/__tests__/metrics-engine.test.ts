/**
 * Metrics Engine tests.
 *
 * These pin the ENGINE'S CONTRACT rather than arithmetic — the arithmetic is
 * already covered against the live PBX in `yeastar-parity.test.ts`. What matters
 * here is the source policy:
 *
 *   - CDR owns every historical KPI and Call Report must never move one.
 *   - Call Report owns per-agent missed calls, and only when it is applicable.
 *   - An unavailable metric reports itself unavailable; it never renders a zero
 *     that reads as "none".
 *   - The O1 divergence is surfaced, never reconciled.
 */
import { describe, expect, it } from "vitest";
import {
  buildCustomerCareMetrics,
  hourLabel,
  isCallReportApplicable,
  type MetricsEngineInput,
} from "../metrics-engine";
import type { AgentCallStats, CallTotals, DayBucket, HourBucket } from "../stats.server";
import type { CallReportSnapshot } from "../call-report.server";

function totals(over: Partial<CallTotals> = {}): CallTotals {
  return {
    total: 100,
    inbound: 80,
    outbound: 20,
    answered: 70,
    missed: 8,
    abandoned: 2,
    ivrOnly: 5,
    noAnswerOutbound: 3,
    cancelledByAgent: 1,
    busy: 0,
    failed: 0,
    voicemail: 0,
    talkSeconds: 7000,
    ringSeconds: 700,
    waitSeconds: 1000,
    waitSecondsAnswered: 700,
    handlingSeconds: 7700,
    longestSec: 500,
    avgTalkSec: 100,
    avgWaitSec: 12.5,
    avgWaitAnsweredSec: 10,
    maxWaitSec: 160,
    avgRingAnsweredSec: 10,
    answerRate: 70,
    missedRate: 10,
    abandonRate: 2.5,
    inboundAnswered: 70,
    inboundAnswerRate: 87.5,
    queueCalls: 80,
    queueAnswerRate: 87.5,
    slaAnsweredWithin: 60,
    slaSeconds: 60,
    slaAttainment: 75,
    outboundAnswered: 0,
    leadContactRate: 0,
    agentCancelRate: 0,
    avgRingBeforeCancelSec: 0,
    ...over,
  };
}

function agent(ext: string, over: Partial<AgentCallStats> = {}): AgentCallStats {
  return {
    agentId: `cc-${ext}`,
    name: `Agent ${ext}`,
    ext,
    team: "customer_care",
    total: 10,
    inbound: 10,
    outbound: 0,
    answered: 9,
    missed: 0,
    noAnswerOutbound: 0,
    cancelledByAgent: 0,
    busy: 0,
    failed: 0,
    voicemail: 0,
    talkSeconds: 900,
    ringSeconds: 90,
    handlingSeconds: 990,
    longestSec: 200,
    avgTalkSec: 100,
    avgRingSec: 10,
    avgHandlingSec: 110,
    answerRate: 90,
    ...over,
  };
}

const byHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  total: hour === 9 ? 12 : 0,
  answered: hour === 9 ? 10 : 0,
  inbound: hour === 9 ? 12 : 0,
  outbound: 0,
}));

const byDay: DayBucket[] = [
  {
    date: "2026-07-29",
    total: 100,
    answered: 70,
    missed: 8,
    abandoned: 2,
    inbound: 80,
    outbound: 20,
    outboundAnswered: 0,
    cancelledByAgent: 1,
    talkSeconds: 7000,
    ringSeconds: 700,
    waitSeconds: 1000,
    handlingSeconds: 7700,
  },
];

function snapshot(over: Partial<CallReportSnapshot> = {}): CallReportSnapshot {
  return {
    available: true,
    error: null,
    window: { start: "29/07/2026 12:00:00 AM", end: "29/07/2026 11:59:59 PM" },
    queue: {
      queueNumber: "6400",
      totalCalls: 80,
      answeredCalls: 70,
      missedCalls: 1,
      abandonedCalls: 9,
      avgWaitAnsweredSec: 10,
      avgWaitAllSec: 12,
      avgTalkSec: 100,
      maxWaitSec: 160,
      answeredRate: 87.5,
      slaAttainment: 75,
    },
    agents: [
      {
        ext: "4002",
        name: "Agent 4002",
        totalCalls: 13,
        answeredCalls: 9,
        missedCalls: 4,
        totalTalkSeconds: 900,
      },
      {
        ext: "4003",
        name: "Agent 4003",
        totalCalls: 9,
        answeredCalls: 9,
        missedCalls: 0,
        totalTalkSeconds: 900,
      },
    ],
    elapsedMs: 12,
    ...over,
  };
}

function build(over: Partial<MetricsEngineInput> = {}) {
  return buildCustomerCareMetrics({
    analytics: { totals: totals(), agents: [agent("4002"), agent("4003")], byDay, byHour },
    callReport: snapshot(),
    realtime: null,
    filters: { direction: "all", queue: "6400", agentId: "all", search: "" },
    ...over,
  });
}

describe("source policy", () => {
  it("marks every historical KPI as CDR-derived", () => {
    const m = build();
    expect(m.sources.overview).toBe("cdr");
    expect(m.sources.serviceLevel).toBe("cdr");
    expect(m.sources.queue).toBe("cdr");
    expect(m.sources.direction).toBe("cdr");
    expect(m.sources.time).toBe("cdr");
    expect(m.sources.trends).toBe("cdr");
    expect(m.sources.agents).toBe("cdr");
  });

  it("declares a source for every metric group — no group is unattributed", () => {
    // Acceptance item 4: every metric documents its origin. This fails loudly
    // if a new group is added to the engine without a `sources` entry.
    const m = build();
    const groups = [
      "overview",
      "serviceLevel",
      "queue",
      "direction",
      "time",
      "trends",
      "agents",
      "realtime",
      "unansweredSplit",
      "isEmpty",
      "sources",
      "callReport",
    ];
    expect(Object.keys(m).sort()).toEqual([...groups].sort());
    const valid = new Set(["cdr", "call_report", "queue_api", "unavailable"]);
    for (const [name, src] of Object.entries(m.sources)) {
      expect(valid.has(src), `sources.${name} = ${src}`).toBe(true);
    }
  });

  it("Call Report never moves a CDR-derived KPI", () => {
    // The snapshot deliberately disagrees with the CDR totals on the split and
    // on avgWaitAll. None of it may leak into the rendered KPIs.
    const withReport = build();
    const withoutReport = build({ callReport: null });
    expect(withReport.overview).toEqual(withoutReport.overview);
    expect(withReport.queue).toEqual(withoutReport.queue);
    expect(withReport.serviceLevel).toEqual(withoutReport.serviceLevel);
    expect(withReport.time).toEqual(withoutReport.time);
    // Specifically: the engine reports OUR avg wait, not the PBX's.
    expect(withReport.serviceLevel.avgQueueWaitSec).toBe(12.5);
    expect(withReport.serviceLevel.avgQueueWaitSec).not.toBe(snapshot().queue!.avgWaitAllSec);
  });

  it("sources per-agent missed from Call Report", () => {
    const m = build();
    expect(m.agents.missedAvailable).toBe(true);
    expect(m.sources.agentMissed).toBe("call_report");
    expect(m.agents.rows.find((r) => r.ext === "4002")?.missedCalls).toBe(4);
    expect(m.agents.rows.find((r) => r.ext === "4002")?.missedSource).toBe("call_report");
  });

  it("never falls back to CDR's structurally-zero per-agent missed", () => {
    const m = build({ callReport: null });
    expect(m.agents.missedAvailable).toBe(false);
    expect(m.agents.rows.every((r) => r.missedSource === "unavailable")).toBe(true);
    expect(m.sources.agentMissed).toBe("unavailable");
  });

  it("routes realtime tiles through the Queue API only", () => {
    const m = build({
      realtime: {
        ok: true,
        calls: { waiting: 3, active: 2, ringing: 1 },
        agents: { ready: 4, busy: 2, paused: 1 },
      },
    });
    expect(m.sources.realtime).toBe("queue_api");
    expect(m.realtime).toEqual({
      available: true,
      waiting: 3,
      active: 2,
      ringing: 1,
      agentsReady: 4,
      agentsBusy: 2,
      agentsPaused: 1,
    });
  });

  it("zeroes realtime tiles when the snapshot is not ok", () => {
    const m = build({ realtime: { ok: false } });
    expect(m.realtime.available).toBe(false);
    expect(m.realtime.waiting).toBe(0);
    expect(m.sources.realtime).toBe("unavailable");
  });
});

describe("Call Report applicability", () => {
  it("does not apply to an Outbound-filtered view", () => {
    // Queue reports are inbound and queue-scoped by construction; merging them
    // into an outbound view would be a category error.
    const filters = { direction: "Outbound" as const, queue: "6400", agentId: "all", search: "" };
    expect(isCallReportApplicable(filters, snapshot())).toBe(false);
    const m = build({ filters });
    expect(m.agents.missedAvailable).toBe(false);
    expect(m.unansweredSplit.reportMissed).toBeNull();
    expect(m.callReport.applicable).toBe(false);
  });

  it("applies to Inbound and to the unfiltered view", () => {
    for (const direction of ["all", "Inbound"] as const) {
      const filters = { direction, queue: "6400", agentId: "all", search: "" };
      expect(isCallReportApplicable(filters, snapshot())).toBe(true);
    }
  });

  it("does not apply when the snapshot is unavailable", () => {
    const filters = { direction: "all" as const, queue: "6400", agentId: "all", search: "" };
    expect(isCallReportApplicable(filters, snapshot({ available: false }))).toBe(false);
    expect(isCallReportApplicable(filters, null)).toBe(false);
  });

  it("does not claim the missed column when no in-scope agent matched", () => {
    // A report for a different queue returns agents we do not have. Showing a
    // confident zero for every row would be worse than showing nothing.
    const m = build({
      callReport: snapshot({
        agents: [
          {
            ext: "9999",
            name: "Other",
            totalCalls: 1,
            answeredCalls: 1,
            missedCalls: 1,
            totalTalkSeconds: 1,
          },
        ],
      }),
    });
    expect(m.agents.missedAvailable).toBe(false);
    expect(m.agents.rows.every((r) => r.missedCalls === 0)).toBe(true);
    expect(m.agents.rows.every((r) => r.missedSource === "unavailable")).toBe(true);
  });

  it("reports a Call Report failure without disturbing the KPIs", () => {
    const m = build({
      callReport: snapshot({ available: false, error: "errcode 40002", queue: null, agents: [] }),
    });
    expect(m.callReport.attempted).toBe(true);
    expect(m.callReport.available).toBe(false);
    expect(m.callReport.error).toBe("errcode 40002");
    expect(m.overview.totalCalls).toBe(100);
  });
});

describe("O1 — missed vs abandoned", () => {
  it("keeps the dashboard's split unchanged", () => {
    const m = build();
    expect(m.queue.missed).toBe(8);
    expect(m.queue.abandoned).toBe(2);
  });

  it("surfaces the PBX's opposite split alongside, without reconciling", () => {
    const m = build();
    expect(m.unansweredSplit).toMatchObject({
      dashboardMissed: 8,
      dashboardAbandoned: 2,
      dashboardUnansweredTotal: 10,
      reportMissed: 1,
      reportAbandoned: 9,
      reportUnansweredTotal: 10,
      populationsAgree: true,
    });
  });

  it("flags a genuine population disagreement", () => {
    const m = build({
      callReport: snapshot({ queue: { ...snapshot().queue!, missedCalls: 1, abandonedCalls: 20 } }),
    });
    expect(m.unansweredSplit.populationsAgree).toBe(false);
  });

  it("reports unknown rather than false when Call Report is absent", () => {
    const m = build({ callReport: null });
    expect(m.unansweredSplit.populationsAgree).toBeNull();
    expect(m.unansweredSplit.reportUnansweredTotal).toBeNull();
    // Our own side is still fully populated.
    expect(m.unansweredSplit.dashboardUnansweredTotal).toBe(10);
  });
});

describe("derivations the components must not repeat", () => {
  it("labels hour buckets", () => {
    const m = build();
    expect(m.trends.hourly).toHaveLength(24);
    expect(m.trends.hourly[0].label).toBe("12 AM");
    expect(m.trends.hourly[9].label).toBe("9 AM");
    expect(m.trends.hourly[12].label).toBe("12 PM");
    expect(m.trends.hourly[17].label).toBe("5 PM");
  });

  it("derives the daily answer-rate series, so no chart has to", () => {
    const m = build();
    expect(m.trends.dailyAnswerRate).toEqual([{ date: "2026-07-29", rate: 70 }]);
  });

  it("uses the same answer-rate formula as the headline card", () => {
    // A single-day window makes the two necessarily identical. If they ever
    // diverge, the card and the trend line are telling different stories.
    const m = build();
    expect(m.trends.dailyAnswerRate[0].rate).toBe(m.overview.answerRate);
  });

  it("does not divide by zero on an empty day", () => {
    const emptyDay = [{ ...byDay[0], total: 0, answered: 0 }];
    const m = build({ analytics: { totals: totals(), agents: [], byDay: emptyDay, byHour } });
    expect(m.trends.dailyAnswerRate[0].rate).toBe(0);
  });

  it("decides whether the daily charts have anything to draw", () => {
    expect(build().trends.hasDailyData).toBe(true);
    expect(
      build({ analytics: { totals: totals(), agents: [], byDay: [], byHour } }).trends.hasDailyData,
    ).toBe(false);
  });

  it("decides whether the hourly chart has anything to draw", () => {
    expect(build().trends.hasHourlyData).toBe(true);
    const flat = byHour.map((h) => ({ ...h, total: 0 }));
    expect(
      build({ analytics: { totals: totals(), agents: [], byDay, byHour: flat } }).trends
        .hasHourlyData,
    ).toBe(false);
  });

  it("narrows agent rows by the search term, by name and by extension", () => {
    expect(
      build({ filters: { direction: "all", queue: "6400", agentId: "all", search: "4002" } }).agents
        .visible,
    ).toHaveLength(1);
    expect(
      build({ filters: { direction: "all", queue: "6400", agentId: "all", search: "agent" } })
        .agents.visible,
    ).toHaveLength(2);
    expect(
      build({ filters: { direction: "all", queue: "6400", agentId: "all", search: "nobody" } })
        .agents.visible,
    ).toHaveLength(0);
    // `rows` always stays complete — only `visible` is filtered.
    expect(
      build({ filters: { direction: "all", queue: "6400", agentId: "all", search: "nobody" } })
        .agents.rows,
    ).toHaveLength(2);
  });

  it("treats a whitespace-only search as no search", () => {
    expect(
      build({ filters: { direction: "all", queue: "6400", agentId: "all", search: "   " } }).agents
        .visible,
    ).toHaveLength(2);
  });

  it("decides the empty state", () => {
    expect(build().isEmpty).toBe(false);
    expect(
      build({ analytics: { totals: totals({ total: 0 }), agents: [], byDay: [], byHour } }).isEmpty,
    ).toBe(true);
    // Nothing loaded yet is NOT the same as a window with no calls.
    expect(build({ analytics: null }).isEmpty).toBe(false);
  });
});

describe("no-analytics state (CDR delayed or still loading)", () => {
  it("returns a fully-zeroed, non-throwing metric set", () => {
    const m = build({ analytics: null, callReport: null });
    expect(m.overview.totalCalls).toBe(0);
    expect(m.queue.queueCalls).toBe(0);
    expect(m.agents.rows).toEqual([]);
    expect(m.trends.hourly).toEqual([]);
    expect(m.trends.dailyAnswerRate).toEqual([]);
    expect(m.sources.overview).toBe("unavailable");
  });

  it("reports every source unavailable rather than claiming CDR", () => {
    const m = build({ analytics: null, callReport: null, realtime: null });
    expect(Object.values(m.sources).every((s) => s === "unavailable")).toBe(true);
  });

  it("still renders realtime tiles while CDR is delayed", () => {
    // The two sources are independent — a slow CDR sweep must not blank the
    // live queue tiles, which are the operationally urgent half of the page.
    const m = build({
      analytics: null,
      callReport: null,
      realtime: {
        ok: true,
        calls: { waiting: 5, active: 1, ringing: 0 },
        agents: { ready: 2, busy: 1, paused: 0 },
      },
    });
    expect(m.realtime.waiting).toBe(5);
    expect(m.sources.realtime).toBe("queue_api");
    expect(m.sources.overview).toBe("unavailable");
  });
});

describe("export-facing metrics", () => {
  it("carries no-answer outbound, which the XLSX reports but no card shows", () => {
    expect(build().direction.noAnswerOutbound).toBe(3);
  });

  it("keeps the full agent list separate from the searched one", () => {
    // The export ships `rows`; the table ships `visible`. Conflating them would
    // silently make the export obey an on-screen search box.
    const m = build({
      filters: { direction: "all", queue: "6400", agentId: "all", search: "4002" },
    });
    expect(m.agents.rows).toHaveLength(2);
    expect(m.agents.visible).toHaveLength(1);
  });
});

describe("hourLabel", () => {
  it("renders 12-hour clock labels", () => {
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(11)).toBe("11 AM");
    expect(hourLabel(12)).toBe("12 PM");
    expect(hourLabel(23)).toBe("11 PM");
  });
});
