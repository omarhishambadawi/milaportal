/**
 * Metrics Engine tests.
 *
 * These pin the ENGINE'S CONTRACT rather than arithmetic — the arithmetic is
 * already covered against the live PBX in `yeastar-parity.test.ts`. What matters
 * here is the source policy:
 *
 *   - CDR owns every historical KPI and Call Report must never move one, with
 *     exactly one carved-out exception: the Missed/Abandoned split (O1).
 *   - Call Report owns per-agent missed calls, and only when it is applicable.
 *   - An unavailable metric reports itself unavailable; it never renders a zero
 *     that reads as "none".
 *   - The O1 divergence is still surfaced after being resolved, so a number that
 *     moved between sprints can explain itself.
 */
import { describe, expect, it } from "vitest";
import {
  buildCustomerCareMetrics,
  hourLabel,
  isCallReportApplicable,
  rankAgents,
  resolveQueueOutcomeSplit,
  type CustomerCareAgentRow,
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
      "unansweredSplit",
      "isEmpty",
      "sources",
      "callReport",
    ];
    expect(Object.keys(m).sort()).toEqual([...groups].sort());
    const valid = new Set(["cdr", "call_report", "unavailable"]);
    for (const [name, src] of Object.entries(m.sources)) {
      expect(valid.has(src), `sources.${name} = ${src}`).toBe(true);
    }
  });

  it("Call Report moves nothing except the missed/abandoned split", () => {
    // The snapshot deliberately disagrees with the CDR totals on the split and
    // on avgWaitAll. Only the split is allowed through.
    const withReport = build();
    const withoutReport = build({ callReport: null });
    expect(withReport.overview).toEqual(withoutReport.overview);
    expect(withReport.serviceLevel).toEqual(withoutReport.serviceLevel);
    expect(withReport.time).toEqual(withoutReport.time);
    expect(withReport.direction).toEqual(withoutReport.direction);
    expect(withReport.trends).toEqual(withoutReport.trends);
    // The queue group differs ONLY on missed/abandoned — the volumes, the
    // population total and the rate stay CDR's.
    expect({ ...withReport.queue, missed: 0, abandoned: 0 }).toEqual({
      ...withoutReport.queue,
      missed: 0,
      abandoned: 0,
    });
    expect(withReport.queue.queueCalls).toBe(withoutReport.queue.queueCalls);
    expect(withReport.queue.unansweredTotal).toBe(withoutReport.queue.unansweredTotal);
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

  it("publishes no Queue API source — the realtime group is gone", () => {
    // The realtime tiles were removed from the dashboard, so the engine must not
    // keep deriving them. This fails if the group is reintroduced without a
    // consumer, which is how the last dead metric survived three sprints.
    const m = build();
    expect(m).not.toHaveProperty("realtime");
    expect(Object.values(m.sources)).not.toContain("queue_api");
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

describe("O1 — missed vs abandoned (resolved, Sprint 3.5)", () => {
  it("reports Yeastar's split, not CDR's wait threshold", () => {
    // The whole point of the correction: the PBX knows who hung up, CDR only
    // knows how long they waited. The fixture has them inverted (CDR 8/2,
    // Yeastar 1/9) exactly as live data does.
    const m = build();
    expect(m.queue.missed).toBe(1);
    expect(m.queue.abandoned).toBe(9);
    expect(m.sources.queueOutcome).toBe("call_report");
  });

  it("keeps the population CDR's, so the queue arithmetic still ties out", () => {
    const m = build();
    expect(m.queue.unansweredTotal).toBe(10);
    expect(m.queue.answered + m.queue.unansweredTotal).toBe(m.queue.queueCalls);
  });

  it("counts queue answered as INBOUND answered, not every answered call", () => {
    // "Queue answered" and the overview's "Answered calls" are different
    // questions the moment an agent dials out. Wiring the card to
    // `totals.answered` would inflate it by the team's outbound work.
    const m = build({
      analytics: {
        totals: totals({ answered: 75, inboundAnswered: 70, outboundAnswered: 5 }),
        agents: [],
        byDay,
        byHour,
      },
    });
    expect(m.queue.answered).toBe(70);
    expect(m.overview.answeredCalls).toBe(75);
  });

  it("retains CDR's split beside it rather than erasing it", () => {
    const m = build();
    expect(m.unansweredSplit).toMatchObject({
      cdrMissed: 8,
      cdrAbandoned: 2,
      cdrUnansweredTotal: 10,
      reportMissed: 1,
      reportAbandoned: 9,
      reportUnansweredTotal: 10,
      populationsAgree: true,
      splitDiffers: true,
    });
  });

  it("does not flag a divergence when the two systems already agree", () => {
    const m = build({
      callReport: snapshot({ queue: { ...snapshot().queue!, missedCalls: 8, abandonedCalls: 2 } }),
    });
    expect(m.unansweredSplit.splitDiffers).toBe(false);
  });

  it("flags a genuine population disagreement", () => {
    const m = build({
      callReport: snapshot({ queue: { ...snapshot().queue!, missedCalls: 1, abandonedCalls: 20 } }),
    });
    expect(m.unansweredSplit.populationsAgree).toBe(false);
    // The rendered split still follows Yeastar; the banner explains the gap.
    expect(m.queue.abandoned).toBe(20);
  });

  it("falls back to CDR's split — labelled as such — when the report is absent", () => {
    const m = build({ callReport: null });
    expect(m.queue.missed).toBe(8);
    expect(m.queue.abandoned).toBe(2);
    expect(m.sources.queueOutcome).toBe("cdr");
    expect(m.unansweredSplit.splitDiffers).toBe(false);
  });

  it("falls back on an Outbound-filtered view, where the queue report cannot apply", () => {
    const m = build({
      filters: { direction: "Outbound", queue: "6400", agentId: "all", search: "" },
    });
    expect(m.queue.missed).toBe(8);
    expect(m.sources.queueOutcome).toBe("cdr");
  });

  it("reports unknown rather than false when Call Report is absent", () => {
    const m = build({ callReport: null });
    expect(m.unansweredSplit.populationsAgree).toBeNull();
    expect(m.unansweredSplit.reportUnansweredTotal).toBeNull();
    // Our own side is still fully populated.
    expect(m.unansweredSplit.cdrUnansweredTotal).toBe(10);
  });

  it("claims no source at all when nothing has loaded", () => {
    const m = build({ analytics: null, callReport: null });
    expect(m.sources.queueOutcome).toBe("unavailable");
  });
});

describe("resolveQueueOutcomeSplit", () => {
  const cdr = { missed: 95, abandoned: 2 };

  it("prefers the PBX whenever it has an opinion", () => {
    expect(resolveQueueOutcomeSplit(cdr, { missedCalls: 1, abandonedCalls: 96 }, "cdr")).toEqual({
      missed: 1,
      abandoned: 96,
      source: "call_report",
    });
  });

  it("passes CDR through, carrying CDR's own availability", () => {
    expect(resolveQueueOutcomeSplit(cdr, null, "cdr")).toEqual({
      missed: 95,
      abandoned: 2,
      source: "cdr",
    });
    expect(resolveQueueOutcomeSplit(cdr, null, "unavailable").source).toBe("unavailable");
  });

  it("takes an all-zero report at face value — a quiet queue is a real answer", () => {
    expect(resolveQueueOutcomeSplit(cdr, { missedCalls: 0, abandonedCalls: 0 }, "cdr")).toEqual({
      missed: 0,
      abandoned: 0,
      source: "call_report",
    });
  });
});

describe("agent ranking", () => {
  const row = (over: Partial<CustomerCareAgentRow>): CustomerCareAgentRow => ({
    agentId: "a",
    name: "A",
    ext: "4001",
    total: 10,
    inbound: 10,
    outbound: 0,
    answered: 5,
    missedCalls: 0,
    missedSource: "unavailable",
    noAnswerOutbound: 0,
    busy: 0,
    failed: 0,
    talkSeconds: 100,
    avgTalkSec: 20,
    avgRingSec: 5,
    longestSec: 40,
    answerRate: 50,
    ...over,
  });

  it("ranks the top three by calls answered", () => {
    const h = rankAgents([
      row({ agentId: "a", answered: 3 }),
      row({ agentId: "b", answered: 9 }),
      row({ agentId: "c", answered: 7 }),
      row({ agentId: "d", answered: 1 }),
    ]);
    expect(h.ranks).toEqual({ b: 1, c: 2, a: 3 });
    expect(h.topAnsweredId).toBe("b");
  });

  it("names a leader per column independently", () => {
    const h = rankAgents([
      row({ agentId: "a", answered: 9, answerRate: 40, talkSeconds: 100 }),
      row({ agentId: "b", answered: 2, answerRate: 95, talkSeconds: 100 }),
      row({ agentId: "c", answered: 5, answerRate: 50, talkSeconds: 900 }),
    ]);
    expect(h.topAnsweredId).toBe("a");
    expect(h.topAnswerRateId).toBe("b");
    expect(h.topTalkTimeId).toBe("c");
  });

  it("breaks ties deterministically, so badges do not shuffle between renders", () => {
    const tied = [
      row({ agentId: "b", answered: 5, answerRate: 50, talkSeconds: 100 }),
      row({ agentId: "a", answered: 5, answerRate: 50, talkSeconds: 100 }),
    ];
    expect(rankAgents(tied).ranks).toEqual(rankAgents([...tied].reverse()).ranks);
  });

  it("awards nothing on a single-agent table — a #1 of one is decoration", () => {
    expect(rankAgents([row({ agentId: "a", answered: 9 })])).toEqual({
      ranks: {},
      topAnsweredId: null,
      topAnswerRateId: null,
      topTalkTimeId: null,
    });
    expect(rankAgents([])).toMatchObject({ ranks: {} });
  });

  it("does not crown a zero", () => {
    const h = rankAgents([
      row({ agentId: "a", answered: 0, answerRate: 0, talkSeconds: 0 }),
      row({ agentId: "b", answered: 0, answerRate: 0, talkSeconds: 0 }),
    ]);
    expect(h.ranks).toEqual({});
    expect(h.topAnsweredId).toBeNull();
    expect(h.topAnswerRateId).toBeNull();
    expect(h.topTalkTimeId).toBeNull();
  });

  it("ranks over the full roster, so a search cannot rewrite the badges", () => {
    const m = build({
      filters: { direction: "all", queue: "6400", agentId: "all", search: "4003" },
    });
    expect(m.agents.visible).toHaveLength(1);
    expect(Object.keys(m.agents.highlights.ranks)).toHaveLength(2);
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

  it("picks the busiest hour, so the hourly chart never has to", () => {
    const m = build();
    expect(m.trends.peakHour).toEqual({ hour: 9, label: "9 AM", total: 12 });
  });

  it("breaks a peak-hour tie towards the earlier hour, so it stays put", () => {
    // Two equally busy hours must resolve the same way on every refresh —
    // otherwise the annotation flickers between them for no reason.
    const tied = byHour.map((h) => (h.hour === 9 || h.hour === 15 ? { ...h, total: 12 } : h));
    const m = build({ analytics: { totals: totals(), agents: [], byDay, byHour: tied } });
    expect(m.trends.peakHour?.hour).toBe(9);
  });

  it("counts the days in the window, so charts can pick their own density", () => {
    expect(build().trends.dayCount).toBe(byDay.length);
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
    const m = build({ analytics: null, callReport: null });
    expect(Object.values(m.sources).every((s) => s === "unavailable")).toBe(true);
  });

  it("reports no peak hour rather than a zero-call one", () => {
    const m = build({ analytics: null, callReport: null });
    expect(m.trends.peakHour).toBeNull();
    expect(m.trends.hasHourlyData).toBe(false);
  });
});

describe("zero-call window (a quiet day, not a broken one)", () => {
  /**
   * The distinction the dashboards used to lose.
   *
   * `analytics: null` means the fetch has not produced anything yet. A window
   * that RESOLVED and contains no calls is a different thing entirely: it is a
   * complete answer, every KPI is a real zero, and the page must render every
   * section around it. Both pages previously replaced everything below the KPI
   * grids with a single "no calls found" card, which made a quiet Friday look
   * like a failure.
   */
  const zeroTotals = totals({
    total: 0,
    inbound: 0,
    outbound: 0,
    answered: 0,
    missed: 0,
    abandoned: 0,
    talkSeconds: 0,
    avgTalkSec: 0,
    avgWaitSec: 0,
    avgWaitAnsweredSec: 0,
    maxWaitSec: 0,
    answerRate: 0,
    missedRate: 0,
    abandonRate: 0,
    inboundAnswered: 0,
    inboundAnswerRate: 0,
    queueCalls: 0,
    queueAnswerRate: 0,
    slaAnsweredWithin: 0,
    slaAttainment: 0,
    noAnswerOutbound: 0,
    busy: 0,
    failed: 0,
  });
  const zero = () =>
    build({
      analytics: { totals: zeroTotals, agents: [], byDay: [], byHour: [] },
      callReport: null,
    });

  it("reports the window as empty rather than as unloaded", () => {
    const m = zero();
    expect(m.isEmpty).toBe(true);
    // Still CDR-sourced: the data arrived, it just says nobody called.
    expect(m.sources.overview).toBe("cdr");
  });

  it("produces a finite zero for every numeric KPI — never NaN", () => {
    // Every rate on this object is a division, and each one has a zero
    // denominator here. One unguarded `a / b` renders as "NaN%" on a card.
    const m = zero();
    const groups = [m.overview, m.serviceLevel, m.queue, m.direction, m.time];
    // `slaSeconds` is the configured answer TARGET, not a measurement — it is
    // still 60 on a day nobody called, and zeroing it would be the bug.
    const CONFIGURATION_NOT_MEASUREMENT = new Set(["slaSeconds"]);
    for (const group of groups) {
      for (const [key, value] of Object.entries(group)) {
        if (typeof value !== "number") continue;
        expect(Number.isFinite(value), `${key} = ${value}`).toBe(true);
        if (CONFIGURATION_NOT_MEASUREMENT.has(key)) continue;
        expect(value, `${key} = ${value}`).toBe(0);
      }
    }
  });

  it("returns empty series and no peak, so charts show an empty state", () => {
    const m = zero();
    expect(m.trends.byDay).toEqual([]);
    expect(m.trends.hourly).toEqual([]);
    expect(m.trends.dailyAnswerRate).toEqual([]);
    expect(m.trends.peakHour).toBeNull();
    expect(m.trends.hasDailyData).toBe(false);
    expect(m.trends.hasHourlyData).toBe(false);
    expect(m.trends.dayCount).toBe(0);
  });

  it("returns an empty agent table without ranking anybody", () => {
    const m = zero();
    expect(m.agents.rows).toEqual([]);
    expect(m.agents.visible).toEqual([]);
    expect(m.agents.highlights.ranks).toEqual({});
    expect(m.agents.highlights.topAnsweredId).toBeNull();
  });

  it("raises no unanswered-split banner when there is nothing to split", () => {
    const m = zero();
    expect(m.unansweredSplit.cdrUnansweredTotal).toBe(0);
    expect(m.unansweredSplit.splitDiffers).toBe(false);
  });

  it("does not confuse a zero window with an unloaded one", () => {
    // `isEmpty` must stay false while the query is still in flight, or the page
    // announces "no calls" over a skeleton.
    expect(build({ analytics: null, callReport: null }).isEmpty).toBe(false);
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
