/**
 * YEASTAR PARITY REGRESSION SUITE
 *
 * ---------------------------------------------------------------------------
 * What this proves
 * ---------------------------------------------------------------------------
 * That the CDR pipeline and the Metrics Engine still reproduce the numbers
 * Yeastar's OWN Queue Performance report published for the same window. Both
 * sides of every assertion below are real:
 *
 *   left  — this repo's `classifyRecords` → `aggregateClassified` →
 *           `buildCustomerCareMetrics`, run over live CDR rows
 *   right — `call_report/list` on `openapi/v2.0`, captured from the PBX at the
 *           same time, stored verbatim in the fixture
 *
 * Fixture: `docs/yeastar/samples/parity-2026-07-29.json` — Yeastar P570,
 * firmware 37.23.0.123, queue 6400 CC_Team, 446 CDR rows for 2026-07-29.
 * External numbers are masked with stable pseudonyms; leg structure,
 * dispositions and durations are verbatim. The masking cannot affect any
 * assertion here: legs are classified by roster membership, and every masked
 * value is a number that is on neither roster.
 *
 * If one of these fails, a KPI has drifted away from the PBX. That is the whole
 * point — do not "fix" it by editing the expectation. The expectations are not
 * ours to choose; they came off the PBX.
 *
 * ---------------------------------------------------------------------------
 * Rounding
 * ---------------------------------------------------------------------------
 * Yeastar publishes whole seconds and TRUNCATES rather than rounds — verified
 * on three independent windows (26.6→26, 17.9→17, 105.1→105). Duration
 * assertions therefore compare `Math.floor` of our value, and any change to
 * that convention should be treated as a finding, not a tolerance to widen.
 *
 * See `docs/yeastar/sprint2-source-validation.md`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRecords, aggregateClassified, type AgentRef } from "../stats.server";
import { buildContext, type RawCdrRow } from "../normalize";
import { failedChecks, validateAnalytics } from "../validate";
import { buildCustomerCareMetrics } from "../metrics-engine";
import type { CallReportSnapshot } from "../call-report.server";

interface ParityFixture {
  window: { from: string; to: string; tzOffsetMinutes: number };
  roster: {
    extensions: Array<{ id: number; number: string }>;
    queues: Array<{ id: number; number: string; name: string; members: string[] }>;
  };
  yeastarReport: {
    queuePerformance: {
      queue_num: string;
      total_calls: number;
      answered_calls: number;
      missed_calls: number;
      abandoned_calls: number;
      average_waiting_time: number;
      all_call_average_waiting_time: number;
      average_talking_time: number;
      max_waiting_time: number;
      answered_rate: number;
      missed_rate: number;
      abandoned_rate: number;
      sla: number;
    };
    queueAgentPerformance: Array<{
      agent_number: string;
      total_calls: number;
      answered_calls: number;
      missed_calls: number;
      total_talking_time: number;
      average_talking_time: number;
      average_waiting_time: number;
    }>;
  };
  cdr: RawCdrRow[];
}

const fixture: ParityFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../docs/yeastar/samples/parity-2026-07-29.json", import.meta.url),
    ),
    "utf8",
  ),
);

const QUEUE_NUMBER = "6400";
const report = fixture.yeastarReport.queuePerformance;
const agentReport = fixture.yeastarReport.queueAgentPerformance;

const ctx = buildContext(
  fixture.roster.extensions.map((e) => ({ number: e.number })),
  fixture.roster.queues.map((q) => ({
    number: q.number,
    static_agent_list: q.members.map((ext) => ({ text2: ext })),
    dynamic_agent_list: [],
  })),
);

/** The Customer Care roster, exactly as queue 6400 defines it. */
const agents: AgentRef[] = (
  fixture.roster.queues.find((q) => q.number === QUEUE_NUMBER)?.members ?? []
).map((ext) => ({
  id: `cc-${ext}`,
  name: `Agent ${ext}`,
  ext,
  team: "customer_care" as const,
}));

const classified = classifyRecords(fixture.cdr, ctx);
/** Queue-scoped: the only slice comparable to a Queue Performance report. */
const queueResult = aggregateClassified(classified, agents, [], { queueNumber: QUEUE_NUMBER });

/** The fixture's Yeastar report, shaped as the Call Report client would return it. */
const snapshot: CallReportSnapshot = {
  available: true,
  error: null,
  window: { start: "29/07/2026 12:00:00 AM", end: "29/07/2026 11:59:59 PM" },
  queue: {
    queueNumber: report.queue_num,
    totalCalls: report.total_calls,
    answeredCalls: report.answered_calls,
    missedCalls: report.missed_calls,
    abandonedCalls: report.abandoned_calls,
    avgWaitAnsweredSec: report.average_waiting_time,
    avgWaitAllSec: report.all_call_average_waiting_time,
    avgTalkSec: report.average_talking_time,
    maxWaitSec: report.max_waiting_time,
    answeredRate: report.answered_rate,
    slaAttainment: report.sla,
  },
  agents: agentReport.map((a) => ({
    ext: a.agent_number,
    name: `Agent ${a.agent_number}`,
    totalCalls: a.total_calls,
    answeredCalls: a.answered_calls,
    missedCalls: a.missed_calls,
    totalTalkSeconds: a.total_talking_time,
  })),
  elapsedMs: 0,
};

const metrics = buildCustomerCareMetrics({
  analytics: {
    totals: queueResult.totals,
    agents: queueResult.agents,
    byDay: queueResult.byDay,
    byHour: queueResult.byHour,
  },
  callReport: snapshot,
  realtime: null,
  filters: { direction: "all", queue: QUEUE_NUMBER, agentId: "all", search: "" },
});

/** Yeastar truncates seconds; compare like for like. */
const trunc = (n: number) => Math.floor(n);

describe("Yeastar parity — queue 6400, 2026-07-29 (live fixture)", () => {
  it("the fixture is the window it claims to be", () => {
    expect(fixture.cdr.length).toBe(446);
    expect(report.queue_num).toBe(QUEUE_NUMBER);
    // A fixture that lost its report would make every assertion below vacuous.
    expect(report.total_calls).toBeGreaterThan(0);
    expect(agentReport.length).toBeGreaterThan(0);
  });

  // ---- headline counts ----------------------------------------------------

  it("total queue calls match Yeastar exactly", () => {
    expect(queueResult.totals.total).toBe(report.total_calls);
    expect(queueResult.totals.queueCalls).toBe(report.total_calls);
    expect(metrics.queue.queueCalls).toBe(report.total_calls);
  });

  it("answered calls match Yeastar exactly", () => {
    expect(queueResult.totals.answered).toBe(report.answered_calls);
    expect(metrics.overview.answeredCalls).toBe(report.answered_calls);
  });

  it("queue answer rate matches Yeastar to 2dp", () => {
    expect(Number(metrics.queue.queueAnswerRate.toFixed(2))).toBe(report.answered_rate);
  });

  it("SLA attainment matches Yeastar to 2dp", () => {
    expect(Number(metrics.serviceLevel.slaAttainment.toFixed(2))).toBe(report.sla);
    // The target itself is the queue's own `sla_time`, not a local invention.
    expect(metrics.serviceLevel.slaSeconds).toBe(60);
  });

  // ---- durations ----------------------------------------------------------

  it("average waiting time (answered only) matches Yeastar", () => {
    expect(trunc(metrics.serviceLevel.avgQueueWaitAnsweredSec)).toBe(report.average_waiting_time);
  });

  it("average waiting time (all calls) matches Yeastar", () => {
    expect(trunc(metrics.serviceLevel.avgQueueWaitSec)).toBe(report.all_call_average_waiting_time);
  });

  it("the two waiting-time series are genuinely different", () => {
    // Guards against a refactor quietly wiring both KPIs to the same number —
    // which would still pass one of the two assertions above.
    expect(report.average_waiting_time).not.toBe(report.all_call_average_waiting_time);
    expect(metrics.serviceLevel.avgQueueWaitAnsweredSec).not.toBe(
      metrics.serviceLevel.avgQueueWaitSec,
    );
  });

  it("longest queue wait matches Yeastar", () => {
    expect(metrics.serviceLevel.maxQueueWaitSec).toBe(report.max_waiting_time);
  });

  it("average talking time matches Yeastar", () => {
    expect(trunc(metrics.overview.avgTalkSec)).toBe(report.average_talking_time);
  });

  // ---- O1: same population, different split -------------------------------

  it("counts the same unanswered population as Yeastar", () => {
    const reported = report.missed_calls + report.abandoned_calls;
    expect(metrics.queue.unansweredTotal).toBe(reported);
    expect(metrics.unansweredSplit.populationsAgree).toBe(true);
  });

  it("TODO(O1): the missed/abandoned SPLIT is deliberately still ours", () => {
    // Sprint 3 objective 8 — do not reconcile this until O1 is resolved. The
    // dashboard splits on how long the caller waited; Yeastar splits on who
    // ended the call. This test pins the CURRENT behaviour so a change to it
    // has to be deliberate. See docs/yeastar/sprint2-source-validation.md §9.4.
    expect(metrics.queue.missed).toBe(8);
    expect(metrics.queue.abandoned).toBe(0);
    // And the PBX's opposite split is carried alongside, not thrown away.
    expect(metrics.unansweredSplit.reportMissed).toBe(0);
    expect(metrics.unansweredSplit.reportAbandoned).toBe(8);
  });

  it("total = answered + missed + abandoned, on both sides", () => {
    expect(report.answered_calls + report.missed_calls + report.abandoned_calls).toBe(
      report.total_calls,
    );
    expect(metrics.overview.answeredCalls + metrics.queue.unansweredTotal).toBe(
      metrics.queue.queueCalls,
    );
  });

  // ---- per-agent ----------------------------------------------------------

  it("per-agent answered counts match Yeastar exactly", () => {
    const byExt = new Map(metrics.agents.rows.map((r) => [r.ext, r]));
    for (const a of agentReport) {
      expect(byExt.get(a.agent_number)?.answered, `ext ${a.agent_number}`).toBe(a.answered_calls);
    }
  });

  it("per-agent talk seconds match Yeastar exactly", () => {
    const byExt = new Map(metrics.agents.rows.map((r) => [r.ext, r]));
    for (const a of agentReport) {
      expect(byExt.get(a.agent_number)?.talkSeconds, `ext ${a.agent_number}`).toBe(
        a.total_talking_time,
      );
    }
  });

  it("per-agent answered sums to the queue's answered total", () => {
    const sum = metrics.agents.rows.reduce((n, r) => n + r.answered, 0);
    expect(sum).toBe(report.answered_calls);
  });

  it("per-agent MISSED comes from Call Report, because CDR cannot supply it", () => {
    // The structural finding: this firmware writes an agent-leg CDR row only
    // when the agent answers, so a ring that went unanswered leaves no trace.
    const inboundAgentLegs = fixture.cdr.filter(
      (r) =>
        r.call_type === "Inbound" &&
        typeof r.call_to_number === "string" &&
        ctx.extensionNumbers.has(r.call_to_number),
    );
    expect(inboundAgentLegs.length).toBeGreaterThan(0);
    expect(inboundAgentLegs.every((r) => r.disposition === "ANSWERED")).toBe(true);

    // CDR's own per-agent missed is therefore structurally zero …
    expect(queueResult.agents.every((a) => a.missed === 0)).toBe(true);
    // … and the engine sources the real figure from Call Report instead.
    expect(metrics.agents.missedAvailable).toBe(true);
    const byExt = new Map(metrics.agents.rows.map((r) => [r.ext, r]));
    for (const a of agentReport) {
      expect(byExt.get(a.agent_number)?.missedCalls, `ext ${a.agent_number}`).toBe(a.missed_calls);
      expect(byExt.get(a.agent_number)?.missedSource).toBe("call_report");
    }
    // Non-zero somewhere, or the assertion above proves nothing.
    expect(agentReport.some((a) => a.missed_calls > 0)).toBe(true);
  });

  // ---- the pipeline's own invariants still hold ---------------------------

  it("passes every KPI invariant on the live fixture", () => {
    const unscoped = aggregateClassified(classified, agents, []);
    const failures = failedChecks(validateAnalytics(classified, unscoped));
    expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
  });

  it("groups legs into calls rather than counting rows", () => {
    // 446 rows collapsing to 35 queue calls is the whole normalization thesis.
    expect(fixture.cdr.length).toBeGreaterThan(queueResult.totals.total * 5);
    const legHistogram = new Set(classified.calls.map((c) => c.legs.length));
    expect(legHistogram.size).toBeGreaterThan(1);
  });
});

describe("Yeastar parity — Call Report degradation is safe", () => {
  const withoutReport = buildCustomerCareMetrics({
    analytics: {
      totals: queueResult.totals,
      agents: queueResult.agents,
      byDay: queueResult.byDay,
      byHour: queueResult.byHour,
    },
    callReport: null,
    realtime: null,
    filters: { direction: "all", queue: QUEUE_NUMBER, agentId: "all", search: "" },
  });

  it("every CDR-derived KPI is identical with Call Report absent", () => {
    expect(withoutReport.overview).toEqual(metrics.overview);
    expect(withoutReport.queue).toEqual(metrics.queue);
    expect(withoutReport.serviceLevel).toEqual(metrics.serviceLevel);
    expect(withoutReport.time).toEqual(metrics.time);
    expect(withoutReport.direction).toEqual(metrics.direction);
  });

  it("the missed column reports itself unavailable rather than showing zero", () => {
    expect(withoutReport.agents.missedAvailable).toBe(false);
    expect(withoutReport.agents.rows.every((r) => r.missedSource === "unavailable")).toBe(true);
    expect(withoutReport.sources.agentMissed).toBe("unavailable");
  });
});
