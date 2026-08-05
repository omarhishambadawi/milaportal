/**
 * Yeastar analytics aggregation.
 *
 * Every KPI in this module is computed from NORMALIZED CALLS produced by
 * `./normalize` — never from raw CDR rows. That distinction is the whole point:
 * on this firmware one inbound call emits one CDR row per routing stage (IVR →
 * IVR → queue → agent), all sharing `call_id`, and each of those rows carries a
 * `disposition` and a repeated `talk_duration`. Counting rows counts stages.
 *
 * See `docs/yeastar/live-audit-2026-07-30.md` for the measurements behind this;
 * the short version of what changed and why:
 *
 *   - Rows are grouped by `call_id` (verified present on 100% of rows) and
 *     de-duplicated on `new_id`. The previous parser de-duplicated on `uid`,
 *     which is a CALL id on this firmware — that kept exactly one leg per call
 *     (always the IVR leg) and made every multi-leg code path below it dead.
 *   - "Answered" now means a real agent extension answered. An `ANSWERED` IVR
 *     leg means the auto-attendant picked up; 1,741 calls in 30 days were
 *     counted as answered on that basis alone.
 *   - Missed / Abandoned are reachable again. They were structurally pinned to
 *     zero, because the surviving IVR leg always made `anyAnswered` true.
 *   - Talk seconds come from the agent leg only, counted once.
 *   - Queue wait is the QUEUE leg's `ring_duration`; agent ring is the AGENT
 *     leg's. They are different numbers and are kept apart.
 *   - `ivr_only` (caller hung up inside the IVR, never offered to an agent) is
 *     tracked separately and is deliberately NOT counted as Missed.
 *
 * Outbound behaviour is unchanged — outbound calls are single-leg here, so none
 * of the above moves them. The audit confirmed outbound call, answered,
 * no-answer and talk-second totals are byte-identical before and after.
 *
 * Internal (extension-to-extension) calls are excluded from every KPI, as
 * before.
 *
 * Per-agent stats are supplemental and NEVER mutate the platform totals.
 */
import type { CdrRecord } from "./cdr.server";
import type { NormalizationContext, NormalizedCall, NormalizedLeg } from "./normalize";
import { DEFAULT_SLA_SECONDS, normalizeCdr } from "./normalize";
import { STATUSES, ORDER_TYPES } from "@/lib/branches";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

export interface AgentRef {
  id: string;
  name: string;
  ext: string;
  team: "customer_care" | "telesales";
}

export interface AgentCallStats {
  agentId: string;
  name: string;
  ext: string;
  team: "customer_care" | "telesales";
  total: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number; // this agent's own ring went unanswered — INBOUND ONLY (M1)
  noAnswerOutbound: number; // per-agent outbound calls customer did not pick up
  /** Outbound calls this agent hung up before the ring timeout expired. */
  cancelledByAgent: number;
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;
  ringSeconds: number;
  handlingSeconds: number;
  longestSec: number;
  avgTalkSec: number;
  avgRingSec: number;
  avgHandlingSec: number;
  answerRate: number;
}

export interface CallTotals {
  total: number; // inbound + outbound only (Internal excluded)
  inbound: number;
  outbound: number;
  answered: number; // a human agent answered (IVR pickup does NOT count)
  missed: number; // inbound, reached the queue, no agent answered, waited >= 5s
  abandoned: number; // inbound, reached the queue, caller hung up < 5s
  /**
   * Inbound callers who hung up inside the IVR. REPORTING ONLY — these are
   * excluded from `total` and from every rate, because the parity target
   * (Yeastar Reports › Extension Call Statistics) counts only calls that
   * reached an extension.
   */
  ivrOnly: number;
  noAnswerOutbound: number; // outbound calls that rang out unanswered
  /**
   * Outbound calls the AGENT hung up before the ring timeout expired. Counted
   * in `total`, never in `noAnswerOutbound`. Telesales lead-abuse signal.
   */
  cancelledByAgent: number;
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number; // agent-leg talk, counted once per call
  ringSeconds: number; // agent-leg ring on answered calls
  waitSeconds: number; // queue-leg ring across every call that reached a queue
  /**
   * Queue-leg ring summed over ANSWERED queue calls only.
   *
   * Distinct from `waitSeconds`, which spans every queued call. Yeastar's Queue
   * Performance publishes both — `answered_waiting_time` and
   * `total_waiting_time` — and its headline "Average Waiting Time" is derived
   * from this one, not from the all-call figure. Verified equal to Yeastar's
   * `answered_waiting_time` (17,322s over July 2026); see
   * `docs/yeastar/sprint2-source-validation.md` §6.
   */
  waitSecondsAnswered: number;
  handlingSeconds: number;
  longestSec: number;
  avgTalkSec: number; // avg talk on answered calls
  avgWaitSec: number; // avg queue wait across calls that reached a queue
  /** Avg queue wait over ANSWERED queue calls — Yeastar `average_waiting_time`. */
  avgWaitAnsweredSec: number;
  /** Longest queue wait in the window, answered or not — Yeastar `max_waiting_time`. */
  maxWaitSec: number;
  avgRingAnsweredSec: number; // avg agent-ring on answered calls
  answerRate: number;
  missedRate: number;
  abandonRate: number;
  // --- inbound / queue detail ---------------------------------------------
  inboundAnswered: number;
  /** Answered inbound ÷ all inbound (IVR hang-ups included in the denominator). */
  inboundAnswerRate: number;
  /** Inbound calls that actually reached a queue. */
  queueCalls: number;
  /** Answered ÷ (answered + missed + abandoned) — of the calls agents were offered. */
  queueAnswerRate: number;
  /** Queue calls answered within the SLA target. */
  slaAnsweredWithin: number;
  /** The SLA target itself, in seconds, so the UI can label the KPI honestly. */
  slaSeconds: number;
  /**
   * Answered-within-SLA ÷ calls offered to agents. Calls that never reached a
   * queue are not in either side of this ratio.
   */
  slaAttainment: number;
  // --- outbound / telesales detail ----------------------------------------
  outboundAnswered: number;
  /**
   * Answered ÷ total outbound. How often agents actually reach a customer.
   * Distinct from conversion rate, which is orders ÷ answered.
   */
  leadContactRate: number;
  /** Cancelled ÷ total outbound. */
  agentCancelRate: number;
  /** Mean ring seconds before the agent hung up, over cancelled calls only. */
  avgRingBeforeCancelSec: number;
}

export interface HourBucket {
  hour: number;
  total: number;
  answered: number;
  inbound: number;
  outbound: number;
}

export interface DayBucket {
  date: string;
  total: number;
  answered: number;
  missed: number;
  abandoned: number;
  inbound: number;
  outbound: number;
  /** Outbound calls answered by the customer — drives the lead-contact trend. */
  outboundAnswered: number;
  /** Outbound calls the agent cancelled early — drives the cancel trend. */
  cancelledByAgent: number;
  talkSeconds: number;
  ringSeconds: number;
  waitSeconds: number;
  handlingSeconds: number;
}

export interface TeamCompareRow {
  team: "customer_care" | "telesales";
  calls: number;
  answered: number;
  missed: number;
  inbound: number;
  outbound: number;
  talkSeconds: number;
  handlingSeconds: number;
  answerRate: number;
  missedRate: number;
}

export interface ConversionRow {
  agentId: string;
  name: string;
  ext: string;
  answered: number;
  ordersTotal: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersPending: number;
  ordersCash: number;
  ordersWasfaty: number;
  revenue: number;
  conversionRate: number; // total orders / answered * 100 (canonical)
  completionRate: number; // completed orders / total orders * 100
  revenuePerCall: number;
  revenuePerOrder: number;
}

export interface AnalyticsResult {
  totals: CallTotals;
  agents: AgentCallStats[];
  byDay: DayBucket[];
  byHour: HourBucket[]; // 0..23
  teamCompare: TeamCompareRow[];
  conversion: {
    overall: {
      answered: number;
      orders: number;
      completed: number;
      cancelled: number;
      pending: number;
      cash: number;
      wasfaty: number;
      revenue: number;
      conversionRate: number; // total orders / answered * 100 (canonical)
      completionRate: number; // completed orders / total orders * 100
      revenuePerCall: number;
      revenuePerOrder: number;
    };
    perAgent: ConversionRow[];
    perDay: {
      date: string;
      answered: number;
      orders: number;
      rate: number;
      revenue: number;
    }[];
  };
  unmatched: { records: number; extensions: { ext: string; count: number }[] };
}

export interface OrderRef {
  id: string;
  agent_id: string;
  order_date: string;
  status: string;
  order_type: string | null;
  invoice_value: number | null;
}

export interface AggregateOptions {
  tzOffsetMin?: number;
  /** Filter normalized calls by direction (applied AFTER normalization). */
  direction?: "all" | "Inbound" | "Outbound";
  /** Filter normalized calls by outcome (applied AFTER normalization). */
  status?: "all" | "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED" | "VOICEMAIL";
  /**
   * Keep only calls that passed through this queue number. Used by the
   * Customer Care dashboard, which is queue-driven. Telesales never sets it —
   * telesales agents belong to no queue.
   */
  queueNumber?: string | null;
  /** Queue answer target in seconds. Defaults to DEFAULT_SLA_SECONDS. */
  slaSeconds?: number;
  /**
   * Active team/agent scope. When set, platform totals, day/hour buckets and
   * per-agent stats include only calls an in-scope extension took part in
   * (answered it, or had their phone ring for it) plus, for a team selection,
   * unanswered inbound calls that queued on `ownedQueueNumbers` (the team's
   * owning queue — Customer Care owns 6400). When undefined (team = all, no
   * agent), every call is included.
   */
  scope?: CallScope;
}

const num = (v: unknown) => Number(v ?? 0);

function dayKey(ts: number | null | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function hourOf(ts: number | null | undefined, tzOffsetMin: number): number {
  if (typeof ts !== "number") return 0;
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return d.getUTCHours();
}

/** Talk + agent ring for one call. Zero unless an agent actually took it. */
function handlingOf(c: NormalizedCall): number {
  return c.talkSeconds + (c.agentRingSeconds ?? 0);
}

/**
 * Every extension that took part in a call, with the leg that represents that
 * agent's involvement.
 *
 * Inbound: one entry per agent leg — an agent whose phone rang took part even if
 * the queue moved on to someone else, which is what makes the per-agent `missed`
 * column meaningful. When one extension appears on several legs, the answered
 * leg wins.
 *
 * Outbound: the placing extension (`call_from_number`, roster-checked by the
 * normalizer), with no leg — outbound calls are single-leg on this firmware and
 * their durations live at call level.
 */
function participantsOf(c: NormalizedCall): Map<string, NormalizedLeg | null> {
  const out = new Map<string, NormalizedLeg | null>();
  if (c.direction === "Outbound") {
    if (c.answeringExtension) out.set(c.answeringExtension, null);
    return out;
  }
  for (const leg of c.legs) {
    if (leg.role !== "agent" || !leg.destinationNumber) continue;
    const prev = out.get(leg.destinationNumber);
    // Keep the answered leg if there is one; otherwise the latest attempt.
    if (prev && prev.answered) continue;
    out.set(leg.destinationNumber, leg);
  }
  return out;
}

/** Does this call pass a status-filter selection? */
function matchesStatus(c: NormalizedCall, status: AggregateOptions["status"]): boolean {
  if (!status || status === "all") return true;
  switch (status) {
    case "ANSWERED":
      return c.outcome === "answered";
    case "NO ANSWER":
      // `cancelled_by_agent` is included: the PBX disposition on those rows IS
      // "NO ANSWER". The split exists for KPI reporting, not to hide them from
      // a disposition filter.
      return (
        c.outcome === "missed" ||
        c.outcome === "abandoned" ||
        c.outcome === "no_answer_outbound" ||
        c.outcome === "cancelled_by_agent"
      );
    case "BUSY":
      return c.outcome === "busy";
    case "FAILED":
      return c.outcome === "failed";
    case "VOICEMAIL":
      return c.outcome === "voicemail";
    default:
      return true;
  }
}

/** Output of the scope-independent phase 1 (see `classifyRecords`). */
export interface ClassifiedRecords {
  /**
   * OPERATIONAL calls only — the sole input to every KPI. Internal calls,
   * after-hours calls, queue-closed calls, IVR-only informational calls and
   * PBX system events are not here.
   */
  calls: NormalizedCall[];
  /** Non-operational calls, kept for reporting. These never move a KPI. */
  excluded: NormalizedCall[];
  /** How many calls were dropped, per reason. */
  exclusionCounts: { reason: string; count: number }[];
  /** How many raw rows produced these calls. Diagnostics only. */
  rowsInspected: number;
  /** Rows discarded as repeats of a `new_id` already seen. */
  duplicateRowsDropped: number;
  /** Calls whose direction contradicted the PBX label and had to be corrected. */
  directionCorrections: { declared: string; corrected: string; count: number }[];
}

/**
 * Phase 1 — normalize raw CDR rows into calls, then split operational calls
 * from the ones business rules exclude.
 *
 * Pure over `records` + `ctx`: it does NOT depend on the agent roster, orders,
 * or the direction/status/scope filters, which is what makes the result safe to
 * cache per CDR window and reuse across every filter permutation the UI
 * requests. The expensive work — row de-dup, `call_id` grouping and business-
 * rule classification — runs once per window instead of once per filter toggle.
 *
 * `ctx` carries the PBX extension and queue rosters. They are what distinguish
 * an agent leg from a queue or IVR leg, so an empty extension roster would make
 * every inbound call look like it never reached an agent. Callers must not pass
 * an empty one — see `buildNormalizationContext` in `yeastar.functions.ts`.
 */
export function classifyRecords(
  records: CdrRecord[],
  ctx: NormalizationContext,
): ClassifiedRecords {
  const all = normalizeCdr(records, ctx);

  const calls: NormalizedCall[] = [];
  const excluded: NormalizedCall[] = [];
  const reasons = new Map<string, number>();
  const corrections = new Map<string, number>();
  let legTotal = 0;

  for (const c of all) {
    legTotal += c.legs.length;
    if (c.directionCorrected) {
      const key = `${c.declaredDirection || "(none)"}→${c.direction}`;
      corrections.set(key, (corrections.get(key) ?? 0) + 1);
    }
    if (c.operational) {
      calls.push(c);
    } else {
      excluded.push(c);
      const reason = c.exclusion ?? "other";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  return {
    calls,
    excluded,
    exclusionCounts: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    rowsInspected: records.length,
    // `groupByCall` drops repeats of a `new_id` it has already seen, so any
    // shortfall between rows in and legs out is exactly the duplicates.
    duplicateRowsDropped: Math.max(0, records.length - legTotal),
    directionCorrections: [...corrections.entries()]
      .map(([key, count]) => {
        const [declared, corrected] = key.split("→");
        return { declared, corrected, count };
      })
      .sort((a, b) => b.count - a.count),
  };
}

/** The team/agent scope a request is confined to. See `AggregateOptions.scope`. */
export type CallScope = {
  exts: ReadonlySet<string>;
  ownedQueueNumbers?: ReadonlySet<string>;
};

/**
 * Is this call inside the active team/agent scope?
 *
 * An in-scope extension took part in it (answered it, or had their phone ring
 * for it) — or, for a team selection, it is an unanswered inbound call that
 * queued on the team's own queue. No scope means every call qualifies.
 *
 * Exported because the Abandoned / Missed drill-down has to select exactly the
 * calls the KPI counted. A second implementation of this predicate is a second
 * definition of "this team's calls", and the two would drift.
 */
export function callInScope(c: NormalizedCall, scope?: CallScope): boolean {
  if (!scope) return true;
  for (const ext of participantsOf(c).keys()) if (scope.exts.has(ext)) return true;
  return (
    scope.ownedQueueNumbers != null &&
    scope.ownedQueueNumbers.size > 0 &&
    c.direction === "Inbound" &&
    !c.answeredByAgent &&
    c.queueNumber != null &&
    scope.ownedQueueNumbers.has(c.queueNumber)
  );
}

/**
 * The operational calls one dashboard request is about: direction, status and
 * queue applied at CALL level, then the team/agent scope.
 *
 * The single definition of "the calls behind this view", shared by the KPI
 * aggregation below and by the drill-down that lists them.
 */
export function selectDashboardCalls(
  input: Pick<ClassifiedRecords, "calls">,
  opts: Pick<AggregateOptions, "direction" | "status" | "queueNumber" | "scope"> = {},
): NormalizedCall[] {
  const direction = opts.direction ?? "all";
  const status = opts.status ?? "all";
  const queueNumber = opts.queueNumber ? String(opts.queueNumber).trim() : "";
  return input.calls.filter(
    (c) =>
      (direction === "all" || c.direction === direction) &&
      matchesStatus(c, status) &&
      (queueNumber === "" || c.queueNumber === queueNumber) &&
      callInScope(c, opts.scope),
  );
}

/**
 * Phase 2 — filter normalized calls by the active scope and accumulate every
 * KPI. Cheap relative to phase 1, and dependent on the roster/orders/filters, so
 * it is re-run per request rather than cached.
 */
export function aggregateClassified(
  input: ClassifiedRecords,
  agents: AgentRef[],
  orders: OrderRef[],
  opts: AggregateOptions = {},
): AnalyticsResult {
  const tz =
    opts.tzOffsetMin ??
    Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES);
  const direction = opts.direction ?? "all";
  const status = opts.status ?? "all";

  const byExt = new Map<string, AgentRef>();
  for (const a of agents) if (a.ext) byExt.set(String(a.ext).trim(), a);

  // Direction / status / queue at CALL level, then the team/agent scope. Shared
  // with the drill-down through `selectDashboardCalls` so a listed call and a
  // counted call are the same call.
  const calls = selectDashboardCalls(input, {
    direction,
    status,
    queueNumber: opts.queueNumber,
    scope: opts.scope,
  });

  const totals: CallTotals = {
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

  // Reporting-only: excluded by business rule, so it is read off the exclusion
  // ledger rather than accumulated from the operational calls below.
  totals.ivrOnly = input.exclusionCounts.find((e) => e.reason === "ivr_only")?.count ?? 0;

  const dayMap = new Map<string, DayBucket>();
  const hourMap = new Map<number, HourBucket>();
  // Queue wait is averaged over the calls that actually reached a queue — the
  // only calls for which a wait exists. Verified: `ring_duration` is present on
  // 100% of queue legs.
  let queueWaitCount = 0;
  // Answered queue calls carrying a wait — the denominator behind Yeastar's
  // headline "Average Waiting Time".
  let queueWaitAnsweredCount = 0;
  // Ring-before-cancel is averaged only over cancelled calls that reported a
  // ring duration, so a missing field cannot drag the mean toward zero.
  let cancelRingSeconds = 0;
  let cancelRingCount = 0;
  const slaSeconds = opts.slaSeconds ?? DEFAULT_SLA_SECONDS;

  for (const c of calls) {
    totals.total++;
    if (c.direction === "Inbound") totals.inbound++;
    else totals.outbound++;

    const answered = c.outcome === "answered";
    const handling = handlingOf(c);

    if (answered) {
      totals.answered++;
      if (c.direction === "Inbound") totals.inboundAnswered++;
      else totals.outboundAnswered++;
      totals.talkSeconds += c.talkSeconds;
      totals.ringSeconds += c.agentRingSeconds ?? 0;
      totals.handlingSeconds += handling;
      if (handling > totals.longestSec) totals.longestSec = handling;
    } else if (c.outcome === "missed") totals.missed++;
    else if (c.outcome === "abandoned") totals.abandoned++;
    else if (c.outcome === "no_answer_outbound") totals.noAnswerOutbound++;
    else if (c.outcome === "cancelled_by_agent") {
      totals.cancelledByAgent++;
      if (c.agentRingSeconds != null) {
        cancelRingSeconds += c.agentRingSeconds;
        cancelRingCount++;
      }
    } else if (c.outcome === "busy") totals.busy++;
    else if (c.outcome === "failed") totals.failed++;
    else if (c.outcome === "voicemail") totals.voicemail++;

    if (c.reachedQueue) totals.queueCalls++;
    if (answered && c.queueWaitSeconds != null && c.queueWaitSeconds <= slaSeconds) {
      totals.slaAnsweredWithin++;
    }
    if (c.queueWaitSeconds != null) {
      totals.waitSeconds += c.queueWaitSeconds;
      queueWaitCount++;
      if (c.queueWaitSeconds > totals.maxWaitSec) totals.maxWaitSec = c.queueWaitSeconds;
      // The answered-only wait is a SEPARATE series, not a subset filter applied
      // later: Yeastar publishes `average_waiting_time` (answered) alongside
      // `all_call_average_waiting_time`, and the two differ materially whenever
      // callers abandon after a long wait.
      if (answered) {
        totals.waitSecondsAnswered += c.queueWaitSeconds;
        queueWaitAnsweredCount++;
      }
    }

    // Buckets — inbound + outbound only
    const dk = dayKey(c.startedAt, tz);
    const hr = hourOf(c.startedAt, tz);
    const day = dayMap.get(dk) ?? {
      date: dk,
      total: 0,
      answered: 0,
      missed: 0,
      abandoned: 0,
      inbound: 0,
      outbound: 0,
      outboundAnswered: 0,
      cancelledByAgent: 0,
      talkSeconds: 0,
      ringSeconds: 0,
      waitSeconds: 0,
      handlingSeconds: 0,
    };
    day.total++;
    if (c.direction === "Inbound") day.inbound++;
    else day.outbound++;
    if (c.outcome === "cancelled_by_agent") day.cancelledByAgent++;
    if (answered) {
      day.answered++;
      if (c.direction === "Outbound") day.outboundAnswered++;
      day.talkSeconds += c.talkSeconds;
      day.ringSeconds += c.agentRingSeconds ?? 0;
      day.handlingSeconds += handling;
    } else if (c.outcome === "abandoned") day.abandoned++;
    else if (c.outcome === "missed") day.missed++;
    day.waitSeconds += c.queueWaitSeconds ?? 0;
    dayMap.set(dk, day);

    const hb = hourMap.get(hr) ?? { hour: hr, total: 0, answered: 0, inbound: 0, outbound: 0 };
    hb.total++;
    if (answered) hb.answered++;
    if (c.direction === "Inbound") hb.inbound++;
    else hb.outbound++;
    hourMap.set(hr, hb);
  }

  totals.avgTalkSec = totals.answered ? totals.talkSeconds / totals.answered : 0;
  totals.avgRingAnsweredSec = totals.answered ? totals.ringSeconds / totals.answered : 0;
  totals.avgWaitSec = queueWaitCount ? totals.waitSeconds / queueWaitCount : 0;
  totals.avgWaitAnsweredSec = queueWaitAnsweredCount
    ? totals.waitSecondsAnswered / queueWaitAnsweredCount
    : 0;
  totals.answerRate = totals.total ? (totals.answered / totals.total) * 100 : 0;
  totals.missedRate = totals.inbound ? (totals.missed / totals.inbound) * 100 : 0;
  totals.abandonRate = totals.inbound ? (totals.abandoned / totals.inbound) * 100 : 0;
  totals.inboundAnswerRate = totals.inbound ? (totals.inboundAnswered / totals.inbound) * 100 : 0;
  const offered = totals.inboundAnswered + totals.missed + totals.abandoned;
  totals.queueAnswerRate = offered ? (totals.inboundAnswered / offered) * 100 : 0;
  totals.slaSeconds = slaSeconds;
  totals.slaAttainment = offered ? (totals.slaAnsweredWithin / offered) * 100 : 0;
  totals.leadContactRate = totals.outbound ? (totals.outboundAnswered / totals.outbound) * 100 : 0;
  totals.agentCancelRate = totals.outbound ? (totals.cancelledByAgent / totals.outbound) * 100 : 0;
  totals.avgRingBeforeCancelSec = cancelRingCount ? cancelRingSeconds / cancelRingCount : 0;

  // ---- Per-agent ----------------------------------------------------------
  // Also derived from normalized calls: one contribution per (call, agent),
  // never one per CDR row. Durations come from that agent's own leg, so a
  // transferred call credits each agent with the part they actually handled and
  // the call is still counted once at platform level.
  const blank = (a: AgentRef): AgentCallStats => ({
    agentId: a.id,
    name: a.name,
    ext: a.ext,
    team: a.team,
    total: 0,
    inbound: 0,
    outbound: 0,
    answered: 0,
    missed: 0,
    noAnswerOutbound: 0,
    cancelledByAgent: 0,
    busy: 0,
    failed: 0,
    voicemail: 0,
    talkSeconds: 0,
    ringSeconds: 0,
    handlingSeconds: 0,
    longestSec: 0,
    avgTalkSec: 0,
    avgRingSec: 0,
    avgHandlingSec: 0,
    answerRate: 0,
  });
  const perAgent = new Map<string, AgentCallStats>();
  const unmatchedExt = new Map<string, number>();
  let unmatchedRecords = 0;

  for (const c of calls) {
    for (const [ext, leg] of participantsOf(c)) {
      const agent = byExt.get(ext);
      if (!agent) {
        // An extension the PBX reported that no roster entry claims. Calls that
        // legitimately reached nobody (IVR hang-ups) have no participants at
        // all and are correctly absent here.
        unmatchedRecords++;
        unmatchedExt.set(ext, (unmatchedExt.get(ext) ?? 0) + 1);
        continue;
      }
      let s = perAgent.get(agent.id);
      if (!s) {
        s = blank(agent);
        perAgent.set(agent.id, s);
      }
      s.total++;
      if (c.direction === "Inbound") s.inbound++;
      else s.outbound++;

      const answeredHere = c.direction === "Outbound" ? c.outcome === "answered" : !!leg?.answered;
      if (answeredHere) {
        const talk = c.direction === "Outbound" ? c.talkSeconds : (leg?.talkSeconds ?? 0);
        const ring =
          c.direction === "Outbound" ? (c.agentRingSeconds ?? 0) : (leg?.ringSeconds ?? 0);
        s.answered++;
        s.talkSeconds += talk;
        s.ringSeconds += ring;
        const handling = talk + ring;
        s.handlingSeconds += handling;
        if (handling > s.longestSec) s.longestSec = handling;
      } else if (c.direction === "Inbound") {
        // The agent's own phone rang and this agent did not take the call.
        // M1: only inbound counts as per-agent `missed`.
        const disp = leg?.disposition ?? "";
        if (disp === "BUSY") s.busy++;
        else if (disp === "FAILED") s.failed++;
        else if (disp === "VOICEMAIL") s.voicemail++;
        else s.missed++;
      } else if (c.outcome === "busy") s.busy++;
      else if (c.outcome === "failed") s.failed++;
      else if (c.outcome === "voicemail") s.voicemail++;
      else if (c.outcome === "cancelled_by_agent") s.cancelledByAgent++;
      // Outbound NO ANSWER is exposed exclusively via `noAnswerOutbound`.
      else s.noAnswerOutbound++;
    }
  }

  const agentRows = [...perAgent.values()]
    .map((s) => ({
      ...s,
      avgTalkSec: s.answered ? s.talkSeconds / s.answered : 0,
      avgRingSec: s.answered ? s.ringSeconds / s.answered : 0,
      avgHandlingSec: s.answered ? s.handlingSeconds / s.answered : 0,
      answerRate: s.total ? (s.answered / s.total) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // ---- Reconciliation intentionally REMOVED ------------------------------
  // Platform KPIs come from the normalized calls above and stay authoritative.
  // Per-agent stats are supplemental and never mutate them.

  // ---- Team compare -------------------------------------------------------
  // Per M1, team `missed` is inbound-missed only (per-agent already scoped).
  const teams: Record<"customer_care" | "telesales", TeamCompareRow> = {
    customer_care: {
      team: "customer_care",
      calls: 0,
      answered: 0,
      missed: 0,
      inbound: 0,
      outbound: 0,
      talkSeconds: 0,
      handlingSeconds: 0,
      answerRate: 0,
      missedRate: 0,
    },
    telesales: {
      team: "telesales",
      calls: 0,
      answered: 0,
      missed: 0,
      inbound: 0,
      outbound: 0,
      talkSeconds: 0,
      handlingSeconds: 0,
      answerRate: 0,
      missedRate: 0,
    },
  };
  for (const a of agentRows) {
    const t = teams[a.team];
    t.calls += a.total;
    t.answered += a.answered;
    t.missed += a.missed;
    t.inbound += a.inbound;
    t.outbound += a.outbound;
    t.talkSeconds += a.talkSeconds;
    t.handlingSeconds += a.handlingSeconds;
  }
  for (const t of Object.values(teams)) {
    t.answerRate = t.calls ? (t.answered / t.calls) * 100 : 0;
    // missedRate = inbound-missed / inbound (M1)
    t.missedRate = t.inbound ? (t.missed / t.inbound) * 100 : 0;
  }

  // ---- Conversion & completion (canonical, scoped to the active filter) ----
  // Conversion Rate = Total Orders / Answered Calls (orders of ANY status).
  // Completion Rate = Completed Orders / Total Orders.
  // `orders` and `answered` are already scoped to the active team/agent (orders
  // by the caller's query, answered by the scope filter above). Yeastar owns
  // call metrics, Orders owns order metrics — divided here, never merged.
  const S_COMPLETED = STATUSES[1]; // "Completed"
  const S_CANCELLED = STATUSES[2]; // "Cancelled"
  const S_PENDING = STATUSES[0]; // "Pending"
  const T_CASH = ORDER_TYPES[0];
  const T_WASFATY = ORDER_TYPES[1];

  const ordersTotal = orders.length;
  const ordersCompleted = orders.filter((o) => o.status === S_COMPLETED).length;
  const revenueTotal = orders.reduce((s, o) => s + num(o.invoice_value), 0);
  const answeredScoped = totals.answered;

  const overall = {
    answered: answeredScoped,
    orders: ordersTotal,
    completed: ordersCompleted,
    cancelled: orders.filter((o) => o.status === S_CANCELLED).length,
    pending: orders.filter((o) => o.status === S_PENDING).length,
    cash: orders.filter((o) => o.order_type === T_CASH).length,
    wasfaty: orders.filter((o) => o.order_type === T_WASFATY).length,
    revenue: revenueTotal,
    conversionRate: answeredScoped ? (ordersTotal / answeredScoped) * 100 : 0,
    completionRate: ordersTotal ? (ordersCompleted / ordersTotal) * 100 : 0,
    revenuePerCall: answeredScoped ? revenueTotal / answeredScoped : 0,
    revenuePerOrder: ordersTotal ? revenueTotal / ordersTotal : 0,
  };

  // Per-agent conversion for every in-scope agent (answered from that agent's
  // call stats; orders joined by agent_id). Same canonical formula.
  const perAgentConv: ConversionRow[] = agentRows
    .map((a) => {
      const os = orders.filter((o) => o.agent_id === a.agentId);
      const oc = os.filter((o) => o.status === S_COMPLETED).length;
      const rev = os.reduce((s, o) => s + num(o.invoice_value), 0);
      return {
        agentId: a.agentId,
        name: a.name,
        ext: a.ext,
        answered: a.answered,
        ordersTotal: os.length,
        ordersCompleted: oc,
        ordersCancelled: os.filter((o) => o.status === S_CANCELLED).length,
        ordersPending: os.filter((o) => o.status === S_PENDING).length,
        ordersCash: os.filter((o) => o.order_type === T_CASH).length,
        ordersWasfaty: os.filter((o) => o.order_type === T_WASFATY).length,
        revenue: rev,
        conversionRate: a.answered ? (os.length / a.answered) * 100 : 0,
        completionRate: os.length ? (oc / os.length) * 100 : 0,
        revenuePerCall: a.answered ? rev / a.answered : 0,
        revenuePerOrder: os.length ? rev / os.length : 0,
      };
    })
    .sort((a, b) => b.conversionRate - a.conversionRate);

  // Per-day conversion = total orders / answered calls (both scoped).
  const ordersByDay = new Map<string, number>();
  const revenueByDay = new Map<string, number>();
  for (const o of orders) {
    ordersByDay.set(o.order_date, (ordersByDay.get(o.order_date) ?? 0) + 1);
    revenueByDay.set(o.order_date, (revenueByDay.get(o.order_date) ?? 0) + num(o.invoice_value));
  }
  const perDay = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const answered = d.answered;
      const ord = ordersByDay.get(d.date) ?? 0;
      return {
        date: d.date,
        answered,
        orders: ord,
        rate: answered ? (ord / answered) * 100 : 0,
        revenue: revenueByDay.get(d.date) ?? 0,
      };
    });

  // Ensure hour 0..23
  const byHour: HourBucket[] = [];
  for (let h = 0; h < 24; h++)
    byHour.push(hourMap.get(h) ?? { hour: h, total: 0, answered: 0, inbound: 0, outbound: 0 });

  return {
    totals,
    agents: agentRows,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byHour,
    teamCompare: Object.values(teams),
    conversion: { overall, perAgent: perAgentConv, perDay },
    unmatched: {
      records: unmatchedRecords,
      extensions: [...unmatchedExt.entries()]
        .map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 25),
    },
  };
}

/**
 * One-shot analytics over raw CDR rows — the public entry point for callers
 * that analyse a window once (diagnostics, single-call traces).
 *
 * Callers that repeatedly analyse the SAME window under different filters (the
 * Call Center page) should cache `classifyRecords` and call
 * `aggregateClassified` directly, as `getCallCenterAnalytics` does.
 */
export function aggregateAnalytics(
  records: CdrRecord[],
  ctx: NormalizationContext,
  agents: AgentRef[],
  orders: OrderRef[],
  opts: AggregateOptions = {},
): AnalyticsResult {
  return aggregateClassified(classifyRecords(records, ctx), agents, orders, opts);
}
