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
 *   Call Report  — authoritative for TWO things, and nothing else:
 *                    1. per-agent missed calls. This firmware writes an
 *                       agent-leg CDR row only when the agent answers, so an
 *                       unanswered ring leaves no CDR trace at all.
 *                    2. the Missed / Abandoned SPLIT of unanswered queue calls
 *                       (Sprint 3.5 — see `resolveQueueOutcomeSplit`). CDR can
 *                       count the population but cannot say who hung up.
 *                  Everything else Call Report publishes is already derived from
 *                  CDR at equal or better fidelity.
 *   Queue API    — nothing. It fed the realtime tiles, and those were removed
 *                  from the dashboard; the metric group went with them, because
 *                  a number nothing renders is a number nobody maintains. The
 *                  `yeastarRealtimeQueue` server function is untouched and still
 *                  serves /calls/diagnostics.
 *
 * Provenance is not implied — every metric's source is recorded on `sources`
 * and surfaced in the UI, so a viewer can tell where a number came from.
 *
 * See `docs/yeastar/sprint2-source-validation.md` for the evidence behind each
 * of those lines.
 */
import type { AgentCallStats, CallTotals, DayBucket, HourBucket } from "./stats.server";
import type { CallReportSnapshot } from "./call-report.server";
import { isQueueSplitApplicable, resolveQueueOutcomes } from "./call-classification";
import type { MetricSource } from "./call-classification";

/**
 * Where a rendered metric actually came from.
 *
 * Defined in `./call-classification` alongside the split it describes, and
 * re-exported here because `CustomerCareMetrics` is what components read.
 */
export type { MetricSource };

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

/**
 * The busiest hour of the day across the window.
 *
 * Derived here rather than in the chart for the usual reason: picking the
 * maximum of a series is a derivation, and a component that performs one is a
 * second place the number is defined. The hourly chart annotates this hour, so
 * the annotation and the bars are guaranteed to agree.
 */
export interface PeakHour {
  hour: number;
  label: string;
  total: number;
}

/**
 * The busiest bucket in an hourly series, or null when none carried a call.
 *
 * Ties go to the earlier hour, so the annotation does not jump between two
 * equal hours between refreshes.
 *
 * Exported because three surfaces annotate a peak — Customer Care's Calls by
 * Hour, Telesales' Outbound Calls by Hour and the Calls Overview — and a
 * maximum scanned separately in each chart is three places the same number is
 * defined. `pick` chooses which series the peak is of: Customer Care and the
 * overview read `total`, Telesales reads `outbound`, because a telesales peak
 * is about when the team dialled.
 */
export function resolvePeakHour<T extends { hour: number; label: string }>(
  hourly: readonly T[],
  pick: (bucket: T) => number = (b) => (b as unknown as { total: number }).total,
): PeakHour | null {
  let peak: PeakHour | null = null;
  for (const h of hourly) {
    const total = pick(h);
    if (total > 0 && (!peak || total > peak.total)) {
      peak = { hour: h.hour, label: h.label, total };
    }
  }
  return peak;
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
 * The O1 comparison — the CDR split against the PBX's, side by side.
 *
 * O1 (RESOLVED, Sprint 3.5): the two systems partition the SAME population of
 * unanswered queue calls by different rules. CDR splits on a 5-second wait
 * threshold; Yeastar splits on who ended the call. Over July 2026 both counted
 * 97, split 95/2 (CDR) against 1/96 (Yeastar).
 *
 * The business decision is that the dashboard reports Yeastar's split, because
 * supervisors reconcile this page against the PBX's own Queue panel and a
 * dashboard that disagrees with it on Abandoned is not usable for that. The
 * mapping lives in `resolveQueueOutcomeSplit`; CDR's own threshold split stays
 * on THIS object so the divergence remains inspectable rather than erased.
 *
 * `cdr*` fields are what the wait-threshold rule produced. `report*` fields are
 * what the PBX published — and, when available, what the dashboard renders.
 * See §9.4 of `docs/yeastar/sprint2-source-validation.md`.
 */
export interface UnansweredSplitComparison {
  /** CDR: queued, unanswered, waited >= the abandon threshold. */
  cdrMissed: number;
  /** CDR: queued, unanswered, hung up under the threshold. */
  cdrAbandoned: number;
  /** Both sides should agree on this even while the split differs. */
  cdrUnansweredTotal: number;
  /** Yeastar: the queue released the call. Null when Call Report is unavailable. */
  reportMissed: number | null;
  /** Yeastar: the caller hung up while waiting. Null when unavailable. */
  reportAbandoned: number | null;
  reportUnansweredTotal: number | null;
  /** True when both sides counted the same population, whatever the split. */
  populationsAgree: boolean | null;
  /**
   * True when the rendered Missed / Abandoned differ from CDR's own split —
   * i.e. Yeastar's definition is in force and the two systems disagree. Drives
   * the info banner, which is otherwise noise.
   */
  splitDiffers: boolean;
}

/** Which agents lead the table, so no component has to sort for a badge. */
export interface AgentHighlights {
  /** `agentId` → 1 | 2 | 3, ranked by queue answered. Empty when meaningless. */
  ranks: Record<string, number>;
  /** Most calls answered from the queue. */
  topAnsweredId: string | null;
  /** Highest answer rate. */
  topAnswerRateId: string | null;
  /** Most time on the phone. */
  topTalkTimeId: string | null;
}

export interface CustomerCareMetrics {
  overview: {
    totalCalls: number;
    answeredCalls: number;
    answerRate: number;
    avgTalkSec: number;
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
    /** Inbound calls that reached the queue — answered, missed and abandoned. */
    queueCalls: number;
    /**
     * Inbound calls the queue ANSWERED. Excludes missed and abandoned, which is
     * what makes it the number a supervisor reads as "handled". Yeastar labels
     * the same figure both "Queue Inbound Calls" and "Answered Calls"; it is one
     * population and therefore one field.
     */
    answered: number;
    /** Unanswered, released by the queue. Yeastar's definition — see O1. */
    missed: number;
    /** Unanswered, the caller hung up. Yeastar's definition — see O1. */
    abandoned: number;
    /**
     * The unanswered population, always CDR-derived, so that
     * `answered + unansweredTotal === queueCalls` holds against the other
     * CDR figures on this object. Only the SPLIT of it follows Yeastar.
     */
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
    /** Busiest hour in the window. Null when no hour carried a call. */
    peakHour: PeakHour | null;
    /** Days in the window that produced a bucket — drives chart density. */
    dayCount: number;
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
    /**
     * Who leads on what. Derived here rather than in the table because ranking
     * is a derivation, and the table is not allowed to perform one.
     */
    highlights: AgentHighlights;
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
    /**
     * The Missed / Abandoned split specifically — `call_report` once Yeastar's
     * definition is in force, `cdr` while it is falling back to the wait
     * threshold. Separate from `queue` because the rest of that group stays CDR.
     */
    queueOutcome: MetricSource;
    direction: MetricSource;
    time: MetricSource;
    trends: MetricSource;
    /** Per-agent counts other than `missedCalls`. */
    agents: MetricSource;
    /** The one metric CDR cannot produce on this firmware. */
    agentMissed: MetricSource;
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
 * A per-agent filter is fine HERE: the report carries per-agent detail and the
 * engine matches on extension, so the missed COLUMN stays meaningful. The
 * queue-level Missed/Abandoned split is stricter and has its own rule — see
 * `isQueueSplitApplicable`.
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
 * Rank the agent table once, here, so no component sorts for a badge.
 *
 * Ranking is by calls answered — the queue's own measure of who carried the
 * shift — with answer rate and then talk time breaking ties, and `agentId` last
 * so the order is stable across renders. A leader is only named when the metric
 * is non-zero and there is somebody to lead: a "#1" on a table of one, or on a
 * table where nobody answered anything, is decoration rather than information.
 */
export function rankAgents(rows: CustomerCareAgentRow[]): AgentHighlights {
  const empty: AgentHighlights = {
    ranks: {},
    topAnsweredId: null,
    topAnswerRateId: null,
    topTalkTimeId: null,
  };
  if (rows.length < 2) return empty;

  const best = (pick: (r: CustomerCareAgentRow) => number): string | null => {
    let winner: CustomerCareAgentRow | null = null;
    for (const r of rows) {
      if (pick(r) <= 0) continue;
      if (!winner || pick(r) > pick(winner)) winner = r;
    }
    return winner?.agentId ?? null;
  };

  const ordered = [...rows]
    .filter((r) => r.answered > 0)
    .sort(
      (a, b) =>
        b.answered - a.answered ||
        b.answerRate - a.answerRate ||
        b.talkSeconds - a.talkSeconds ||
        a.agentId.localeCompare(b.agentId),
    );

  const ranks: Record<string, number> = {};
  ordered.slice(0, 3).forEach((r, i) => {
    ranks[r.agentId] = i + 1;
  });

  return {
    ranks,
    topAnsweredId: best((r) => r.answered),
    topAnswerRateId: best((r) => r.answerRate),
    topTalkTimeId: best((r) => r.talkSeconds),
  };
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

  // --- O1: Yeastar's split rendered, CDR's kept alongside -------------------
  // Resolved through the shared classifier, which is the same call the
  // drill-down makes server-side — that is what keeps a card's number and the
  // rows behind it describing one population under one definition.
  const reportQueue = isQueueSplitApplicable(input.filters, snapshot?.available === true)
    ? (snapshot?.queue ?? null)
    : null;
  const reportUnanswered =
    reportQueue != null ? reportQueue.missedCalls + reportQueue.abandonedCalls : null;
  const split = resolveQueueOutcomes(totals, reportQueue, cdrSource);
  const cdrUnanswered = split.unansweredTotal;

  const unansweredSplit: UnansweredSplitComparison = {
    cdrMissed: totals.missed,
    cdrAbandoned: totals.abandoned,
    cdrUnansweredTotal: cdrUnanswered,
    reportMissed: reportQueue?.missedCalls ?? null,
    reportAbandoned: reportQueue?.abandonedCalls ?? null,
    reportUnansweredTotal: reportUnanswered,
    populationsAgree: reportUnanswered == null ? null : reportUnanswered === cdrUnanswered,
    splitDiffers: split.missed !== totals.missed || split.abandoned !== totals.abandoned,
  };

  // --- trends ---------------------------------------------------------------
  const hourly: LabelledHourBucket[] = byHour.map((h) => ({ ...h, label: hourLabel(h.hour) }));
  const peakHour = resolvePeakHour(hourly);

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
      // The numerator of the validated `queueAnswerRate`, exposed as its own
      // KPI. Kept as the SAME field the rate divides by, so a card and the rate
      // beside it can never tell different stories.
      answered: totals.inboundAnswered,
      missed: split.missed,
      abandoned: split.abandoned,
      unansweredTotal: split.unansweredTotal,
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
      peakHour,
      dayCount: byDay.length,
      hasHourlyData: peakHour != null,
      hasDailyData: byDay.length > 0,
    },
    agents: { rows, visible, missedAvailable, highlights: rankAgents(rows) },
    isEmpty: hasAnalytics && totals.total === 0,
    unansweredSplit,
    sources: {
      overview: cdrSource,
      serviceLevel: cdrSource,
      queue: cdrSource,
      queueOutcome: split.source,
      direction: cdrSource,
      time: cdrSource,
      trends: cdrSource,
      agents: cdrSource,
      agentMissed: agentMissedSource,
    },
    callReport: {
      attempted: snapshot != null,
      available: snapshot?.available === true,
      error: snapshot?.error ?? null,
      applicable,
    },
  };
}
