/**
 * Unified Customer Care Metrics Engine.
 *
 * ---------------------------------------------------------------------------
 * The contract
 * ---------------------------------------------------------------------------
 * Every number the Customer Care dashboard renders is produced HERE, once. A
 * React component may format a value (`hhmmss`, `pct`) and it may choose not to
 * show one — it may never derive one. No `.filter()`, no `.reduce()`, no
 * `a / b * 100`, no `?? 0` fallback standing in for a real metric in a
 * component. If a widget needs a number that is not on `CustomerCareMetrics`,
 * the number belongs on `CustomerCareMetrics`.
 *
 * That rule exists because the same KPI was previously computed in three
 * places — the aggregator, the hook and the route — and they drifted. A single
 * derivation point is also what makes the parity regression tests meaningful:
 * they assert against this engine's output, which is exactly what the user sees.
 *
 * ---------------------------------------------------------------------------
 * Source policy (Sprint 3 objectives 1–3)
 * ---------------------------------------------------------------------------
 *   CDR          — every historical KPI. The normalization pipeline is unchanged
 *                  and remains the primary source.
 *   Call Report  — authoritative for ONE metric: per-agent missed calls. This
 *                  firmware writes an agent-leg CDR row only when the agent
 *                  answers, so an unanswered ring leaves no CDR trace at all.
 *                  Everything else Call Report publishes is already derived from
 *                  CDR at equal or better fidelity.
 *   Queue API    — realtime tiles only. It reports the present moment and can
 *                  never answer a historical question.
 *
 * Provenance is not implied — every metric's source is recorded on `sources`
 * and surfaced in the UI, so a viewer can tell where a number came from.
 *
 * See `docs/yeastar/sprint2-source-validation.md` for the evidence behind each
 * of those three lines.
 */
import type { AgentCallStats, CallTotals, DayBucket, HourBucket } from "./stats.server";
import type { CallReportSnapshot } from "./call-report.server";

/** Where a rendered metric actually came from. */
export type MetricSource =
  /** Derived from CDR by the normalization pipeline. */
  | "cdr"
  /** Read from Yeastar's own Call Report API (openapi/v2.0). */
  | "call_report"
  /** Live PBX queue state. */
  | "queue_api"
  /** The source was reachable but produced nothing for this window. */
  | "unavailable";

/** `12 AM`, `9 AM`, `12 PM`, `5 PM` — the x-axis label for an hour bucket. */
export function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

/** An hour bucket carrying its own axis label, so charts never build one. */
export interface LabelledHourBucket extends HourBucket {
  label: string;
}

/** One point on the answer-rate-over-time line. */
export interface DailyRatePoint {
  date: string;
  /** Answered ÷ total for that day, as a percentage. */
  rate: number;
}

/** Live queue state, exactly as `yeastarRealtimeQueue` returns it. */
export interface RealtimeQueueSnapshot {
  ok?: boolean;
  calls?: { waiting?: number; active?: number; ringing?: number };
  agents?: { ready?: number; busy?: number; paused?: number };
}

/**
 * One agent row, with CDR and Call Report reconciled.
 *
 * `missedCalls` is the only field whose source can vary, and `missedSource`
 * always says which it was — a `0` from CDR means "unknowable", not "none", and
 * the two must never look alike in the UI.
 */
export interface CustomerCareAgentRow {
  agentId: string;
  name: string;
  ext: string;
  total: number;
  inbound: number;
  outbound: number;
  answered: number;
  /** The agent's phone rang and they did not pick up. */
  missedCalls: number;
  missedSource: MetricSource;
  noAnswerOutbound: number;
  busy: number;
  failed: number;
  talkSeconds: number;
  avgTalkSec: number;
  avgRingSec: number;
  longestSec: number;
  answerRate: number;
}

/**
 * The O1 comparison — the dashboard's split against the PBX's, side by side.
 *
 * TODO(O1): the two systems partition the SAME population of unanswered queue
 * calls by different rules. The dashboard splits on a 5-second wait threshold;
 * Yeastar splits on who ended the call. Over July 2026 both counted 97, split
 * 95/2 (dashboard) against 1/96 (Yeastar).
 *
 * Per Sprint 3 objective 8 the dashboard's definition is LEFT UNCHANGED until
 * O1 is resolved, which is blocked on confirming Yeastar's own definitions from
 * the Web UI. This block exists so the divergence is visible rather than
 * silently reconciled. See Open Issue **O1** and §9.4 of
 * `docs/yeastar/sprint2-source-validation.md`.
 */
export interface UnansweredSplitComparison {
  /** Dashboard: queued, unanswered, waited >= the abandon threshold. */
  dashboardMissed: number;
  /** Dashboard: queued, unanswered, hung up under the threshold. */
  dashboardAbandoned: number;
  /** Both sides should agree on this even while the split differs. */
  dashboardUnansweredTotal: number;
  /** Yeastar: the queue released the call. Null when Call Report is unavailable. */
  reportMissed: number | null;
  /** Yeastar: the caller hung up while waiting. Null when unavailable. */
  reportAbandoned: number | null;
  reportUnansweredTotal: number | null;
  /** True when both sides counted the same population, whatever the split. */
  populationsAgree: boolean | null;
}

export interface CustomerCareMetrics {
  overview: {
    totalCalls: number;
    answeredCalls: number;
    answerRate: number;
    avgTalkSec: number;
  };
  realtime: {
    available: boolean;
    waiting: number;
    active: number;
    ringing: number;
    agentsReady: number;
    agentsBusy: number;
    agentsPaused: number;
  };
  serviceLevel: {
    slaSeconds: number;
    slaAttainment: number;
    slaAnsweredWithin: number;
    /** Mean wait over every queued call. */
    avgQueueWaitSec: number;
    /** Mean wait over ANSWERED queued calls — Yeastar's headline figure. */
    avgQueueWaitAnsweredSec: number;
    /** Longest wait in the window, answered or not. */
    maxQueueWaitSec: number;
  };
  queue: {
    queueCalls: number;
    missed: number;
    abandoned: number;
    unansweredTotal: number;
    queueAnswerRate: number;
  };
  direction: {
    inbound: number;
    outbound: number;
    /** Outbound calls that rang out unanswered. Exported, not shown on a card. */
    noAnswerOutbound: number;
  };
  time: { avgTalkSec: number; avgQueueWaitSec: number; totalTalkSec: number };
  trends: {
    byDay: DayBucket[];
    hourly: LabelledHourBucket[];
    /**
     * Answer rate per day, for the trend line.
     *
     * Derived HERE rather than in the chart: it is a KPI, and the chart is not
     * allowed to compute one. It also has to agree with the headline Answer
     * Rate card, which is only guaranteed while both come off this engine.
     */
    dailyAnswerRate: DailyRatePoint[];
    /** False when every hour bucket is empty — charts render an empty state. */
    hasHourlyData: boolean;
    /** False when the window produced no daily buckets at all. */
    hasDailyData: boolean;
  };
  agents: {
    /** Every in-scope agent, reconciled. */
    rows: CustomerCareAgentRow[];
    /** `rows` narrowed by the active search term. What the table renders. */
    visible: CustomerCareAgentRow[];
    /** True when Call Report supplied the missed column. */
    missedAvailable: boolean;
  };
  /** True when the window produced no calls at all — drives the empty state. */
  isEmpty: boolean;
  unansweredSplit: UnansweredSplitComparison;
  /**
   * Origin of every metric group on this object. Exhaustive on purpose — a
   * group without an entry here is a metric whose provenance nobody can state,
   * which is the situation this whole sprint exists to end.
   */
  sources: {
    overview: MetricSource;
    serviceLevel: MetricSource;
    queue: MetricSource;
    direction: MetricSource;
    time: MetricSource;
    trends: MetricSource;
    /** Per-agent counts other than `missedCalls`. */
    agents: MetricSource;
    /** The one metric CDR cannot produce on this firmware. */
    agentMissed: MetricSource;
    realtime: MetricSource;
  };
  /** How Call Report behaved, so the UI can be honest about a degraded column. */
  callReport: {
    attempted: boolean;
    available: boolean;
    error: string | null;
    /** Non-null only when the report's own scope matched the active filters. */
    applicable: boolean;
  };
}

/** The CDR-derived analytics this engine consumes. */
export interface AnalyticsSlice {
  totals: CallTotals;
  agents: AgentCallStats[];
  byDay: DayBucket[];
  byHour: HourBucket[];
}

export interface MetricsEngineInput {
  /** Null while the analytics query has produced nothing yet. */
  analytics: AnalyticsSlice | null;
  callReport: CallReportSnapshot | null;
  realtime: RealtimeQueueSnapshot | null;
  /** Active dashboard filters — they decide whether Call Report even applies. */
  filters: {
    direction: "all" | "Inbound" | "Outbound";
    /** Queue number, or "all". */
    queue: string;
    /** Agent id, or "all". */
    agentId: string;
    /** Free-text agent search. */
    search: string;
  };
}

const EMPTY_TOTALS: CallTotals = {
  total: 0,
  inbound: 0,
  outbound: 0,
  answered: 0,
  missed: 0,
  abandoned: 0,
  ivrOnly: 0,
  noAnswerOutbound: 0,
  cancelledByAgent: 0,
  busy: 0,
  failed: 0,
  voicemail: 0,
  talkSeconds: 0,
  ringSeconds: 0,
  waitSeconds: 0,
  waitSecondsAnswered: 0,
  handlingSeconds: 0,
  longestSec: 0,
  avgTalkSec: 0,
  avgWaitSec: 0,
  avgWaitAnsweredSec: 0,
  maxWaitSec: 0,
  avgRingAnsweredSec: 0,
  answerRate: 0,
  missedRate: 0,
  abandonRate: 0,
  inboundAnswered: 0,
  inboundAnswerRate: 0,
  queueCalls: 0,
  queueAnswerRate: 0,
  slaAnsweredWithin: 0,
  slaSeconds: 0,
  slaAttainment: 0,
  outboundAnswered: 0,
  leadContactRate: 0,
  agentCancelRate: 0,
  avgRingBeforeCancelSec: 0,
};

/**
 * Is the Call Report snapshot comparable to what the dashboard is showing?
 *
 * Call Report's queue reports are **inbound and queue-scoped by construction**.
 * If the user has filtered to Outbound, the report describes a different
 * population and merging it would be a category error — better to show no
 * missed column than a wrong one.
 *
 * A per-agent filter is fine: the report carries per-agent detail, and the
 * engine matches on extension.
 */
export function isCallReportApplicable(
  filters: MetricsEngineInput["filters"],
  snapshot: CallReportSnapshot | null,
): boolean {
  if (!snapshot?.available) return false;
  if (filters.direction === "Outbound") return false;
  return true;
}

/**
 * Build the complete metric set for one render of the Customer Care dashboard.
 *
 * Pure and synchronous: same inputs, same output. Every branch is reachable from
 * a test, which is the point — this is the function the parity suite asserts
 * against.
 */
export function buildCustomerCareMetrics(input: MetricsEngineInput): CustomerCareMetrics {
  const totals = input.analytics?.totals ?? EMPTY_TOTALS;
  const cdrAgents = input.analytics?.agents ?? [];
  const byDay = input.analytics?.byDay ?? [];
  const byHour = input.analytics?.byHour ?? [];
  const hasAnalytics = input.analytics != null;
  /** Every historical KPI on this object comes from CDR, or from nowhere yet. */
  const cdrSource: MetricSource = hasAnalytics ? "cdr" : "unavailable";

  const snapshot = input.callReport;
  const applicable = isCallReportApplicable(input.filters, snapshot);

  // --- per-agent missed, the one metric Call Report owns --------------------
  const reportByExt = new Map<string, number>();
  if (applicable && snapshot) {
    for (const a of snapshot.agents) reportByExt.set(a.ext, a.missedCalls);
  }
  // Only claim the column when at least one in-scope agent was actually
  // matched. A report that came back empty, or for a different queue, must not
  // leave the table showing an authoritative-looking zero.
  const missedAvailable =
    applicable && cdrAgents.some((a) => reportByExt.has(String(a.ext).trim()));
  const agentMissedSource: MetricSource = missedAvailable ? "call_report" : "unavailable";

  const rows: CustomerCareAgentRow[] = cdrAgents.map((a) => {
    const ext = String(a.ext).trim();
    const reported = reportByExt.get(ext);
    return {
      agentId: a.agentId,
      name: a.name,
      ext: a.ext,
      total: a.total,
      inbound: a.inbound,
      outbound: a.outbound,
      answered: a.answered,
      // CDR's own per-agent `missed` is structurally 0 for inbound on this
      // firmware and is deliberately NOT used as a fallback — a fabricated zero
      // is worse than an honest gap.
      missedCalls: missedAvailable ? (reported ?? 0) : 0,
      missedSource: missedAvailable && reported != null ? "call_report" : "unavailable",
      noAnswerOutbound: a.noAnswerOutbound,
      busy: a.busy,
      failed: a.failed,
      talkSeconds: a.talkSeconds,
      avgTalkSec: a.avgTalkSec,
      avgRingSec: a.avgRingSec,
      longestSec: a.longestSec,
      answerRate: a.answerRate,
    };
  });

  const term = input.filters.search.trim().toLowerCase();
  const visible = term
    ? rows.filter((r) => r.name.toLowerCase().includes(term) || r.ext.toLowerCase().includes(term))
    : rows;

  // --- O1 comparison, surfaced not reconciled -------------------------------
  const reportQueue = applicable ? (snapshot?.queue ?? null) : null;
  const dashboardUnanswered = totals.missed + totals.abandoned;
  const reportUnanswered =
    reportQueue != null ? reportQueue.missedCalls + reportQueue.abandonedCalls : null;

  const unansweredSplit: UnansweredSplitComparison = {
    dashboardMissed: totals.missed,
    dashboardAbandoned: totals.abandoned,
    dashboardUnansweredTotal: dashboardUnanswered,
    reportMissed: reportQueue?.missedCalls ?? null,
    reportAbandoned: reportQueue?.abandonedCalls ?? null,
    reportUnansweredTotal: reportUnanswered,
    populationsAgree: reportUnanswered == null ? null : reportUnanswered === dashboardUnanswered,
  };

  // --- realtime -------------------------------------------------------------
  const rt = input.realtime;
  const rtOk = rt?.ok === true;

  const hourly: LabelledHourBucket[] = byHour.map((h) => ({ ...h, label: hourLabel(h.hour) }));
  // Same formula as the headline answer rate, applied per day. Kept beside it so
  // the card and the trend line cannot drift apart.
  const dailyAnswerRate: DailyRatePoint[] = byDay.map((d) => ({
    date: d.date,
    rate: d.total ? (d.answered / d.total) * 100 : 0,
  }));

  return {
    overview: {
      totalCalls: totals.total,
      answeredCalls: totals.answered,
      answerRate: totals.answerRate,
      avgTalkSec: totals.avgTalkSec,
    },
    realtime: {
      available: rtOk,
      waiting: rtOk ? (rt?.calls?.waiting ?? 0) : 0,
      active: rtOk ? (rt?.calls?.active ?? 0) : 0,
      ringing: rtOk ? (rt?.calls?.ringing ?? 0) : 0,
      agentsReady: rtOk ? (rt?.agents?.ready ?? 0) : 0,
      agentsBusy: rtOk ? (rt?.agents?.busy ?? 0) : 0,
      agentsPaused: rtOk ? (rt?.agents?.paused ?? 0) : 0,
    },
    serviceLevel: {
      slaSeconds: totals.slaSeconds,
      slaAttainment: totals.slaAttainment,
      slaAnsweredWithin: totals.slaAnsweredWithin,
      avgQueueWaitSec: totals.avgWaitSec,
      avgQueueWaitAnsweredSec: totals.avgWaitAnsweredSec,
      maxQueueWaitSec: totals.maxWaitSec,
    },
    queue: {
      queueCalls: totals.queueCalls,
      // TODO(O1) — unchanged on purpose; see `UnansweredSplitComparison`.
      missed: totals.missed,
      abandoned: totals.abandoned,
      unansweredTotal: dashboardUnanswered,
      queueAnswerRate: totals.queueAnswerRate,
    },
    direction: {
      inbound: totals.inbound,
      outbound: totals.outbound,
      noAnswerOutbound: totals.noAnswerOutbound,
    },
    time: {
      avgTalkSec: totals.avgTalkSec,
      avgQueueWaitSec: totals.avgWaitSec,
      totalTalkSec: totals.talkSeconds,
    },
    trends: {
      byDay,
      hourly,
      dailyAnswerRate,
      hasHourlyData: byHour.some((h) => h.total > 0),
      hasDailyData: byDay.length > 0,
    },
    agents: { rows, visible, missedAvailable },
    isEmpty: hasAnalytics && totals.total === 0,
    unansweredSplit,
    sources: {
      overview: cdrSource,
      serviceLevel: cdrSource,
      queue: cdrSource,
      direction: cdrSource,
      time: cdrSource,
      trends: cdrSource,
      agents: cdrSource,
      agentMissed: agentMissedSource,
      realtime: rtOk ? "queue_api" : "unavailable",
    },
    callReport: {
      attempted: snapshot != null,
      available: snapshot?.available === true,
      error: snapshot?.error ?? null,
      applicable,
    },
  };
}
