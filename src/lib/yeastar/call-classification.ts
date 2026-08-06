/**
 * Call classification — the SINGLE source of truth for Missed vs Abandoned.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 * Two systems label the same population of unanswered queue calls, and they do
 * not agree:
 *
 *   Yeastar  — abandoned = the CALLER hung up while waiting;
 *              missed    = the QUEUE released the call to its failover.
 *   CDR      — abandoned = hung up inside `abandonThresholdSeconds`;
 *              missed    = waited longer than that.
 *
 * The dashboard reports Yeastar's split (Sprint 3.5, O1) because supervisors
 * reconcile against the PBX's own Queue panel. But Yeastar publishes COUNTS,
 * not calls — so the KPI card followed the PBX while every surface that lists
 * individual calls followed CDR's per-call `outcome`. That is how a card
 * reading "Missed 0" opened onto two rows: the two calls CDR labels missed and
 * the PBX labels abandoned.
 *
 * Every surface that shows a Missed or an Abandoned call — KPI cards, charts,
 * drill-down dialogs, tables, exports — resolves it HERE and nowhere else. A
 * second implementation of either the split or the per-call label is a second
 * definition of the same word, and the two will drift again.
 *
 * ---------------------------------------------------------------------------
 * How a count becomes a label
 * ---------------------------------------------------------------------------
 * `classifyUnansweredCalls` re-cuts CDR's own ordering at the PBX's boundary.
 * Both systems partition the SAME calls, so the population never changes —
 * only the line through it moves, and it moves to where the PBX put it.
 *
 * The ordering is by queue wait, ascending, because that is what the two rules
 * have in common: a caller who gives up does so at some point of their own
 * choosing, while a call the queue RELEASES has by definition waited out the
 * queue's timeout. So the longest waits are the queue's releases (missed) and
 * everything below the cut is the caller's own hang-up (abandoned) — which is
 * also the direction CDR's threshold rule already sorts them in. When the PBX
 * has no opinion, the cut lands exactly on CDR's threshold and nothing moves.
 */
import type { NormalizedCall } from "./normalize";

/** Where a rendered metric actually came from. */
export type MetricSource =
  /** Derived from CDR by the normalization pipeline. */
  | "cdr"
  /** Read from Yeastar's own Call Report API (openapi/v2.0). */
  | "call_report"
  /** The source was reachable but produced nothing for this window. */
  | "unavailable";

/** The two unanswered outcomes every surface in the module splits on. */
export type UnansweredKind = "abandoned" | "missed";

/** The queue figures Yeastar's Call Report publishes for a window. */
export interface ReportQueueOutcomes {
  missedCalls: number;
  abandonedCalls: number;
}

export interface QueueOutcomeSplit {
  missed: number;
  abandoned: number;
  /** Which system's definition these two numbers follow. */
  source: MetricSource;
}

/** The split plus the figures derived from it. Nothing else may derive these. */
export interface QueueOutcomeView extends QueueOutcomeSplit {
  /**
   * The unanswered population, always CDR-derived, so that
   * `answered + unansweredTotal === queueCalls` holds against the other CDR
   * figures on the same object. Only the SPLIT of it follows Yeastar.
   */
  unansweredTotal: number;
  /** Missed ÷ inbound, using the RENDERED missed so the two agree. */
  missedRate: number;
  /** Abandoned ÷ inbound, likewise. */
  abandonRate: number;
}

/** The filters that decide whether Yeastar's queue split describes this view. */
export interface QueueSplitFilters {
  direction: "all" | "Inbound" | "Outbound";
  /** Agent id, or "all". */
  agentId: string;
}

/**
 * Is Yeastar's queue split comparable with what this view is showing?
 *
 * Call Report's queue report is **inbound, queue-scoped and queue-WIDE by
 * construction**. Two filters take the view outside it:
 *
 *   - Outbound. The report describes a population the view has excluded.
 *   - A single agent. The report counts the whole queue's unanswered calls,
 *     while the view counts one agent's; rendering the queue's number over an
 *     agent's calls is a card no drill-down could ever match.
 *
 * In both cases the CDR split stands in — same population, weaker rule — and
 * the source says so, so a fallback is never presented as PBX-confirmed.
 */
export function isQueueSplitApplicable(
  filters: QueueSplitFilters,
  reportAvailable: boolean,
): boolean {
  if (!reportAvailable) return false;
  if (filters.direction === "Outbound") return false;
  return filters.agentId === "all";
}

/** The CDR totals this module reads. A subset of `CallTotals`. */
export interface CdrOutcomeTotals {
  missed: number;
  abandoned: number;
  inbound: number;
}

/**
 * Decide which system's Missed / Abandoned definition a view reports.
 *
 * The wait threshold is a proxy for "the caller gave up", and on live data it
 * is a poor one: it labels a 30-second wait that the caller ended as "missed".
 * The PBX knows who hung up; CDR only knows how long they waited. So Yeastar's
 * split wins whenever it is available and applicable.
 */
export function resolveQueueOutcomeSplit(
  totals: Pick<CdrOutcomeTotals, "missed" | "abandoned">,
  reportQueue: ReportQueueOutcomes | null,
  cdrSource: MetricSource,
): QueueOutcomeSplit {
  if (reportQueue) {
    return {
      missed: reportQueue.missedCalls,
      abandoned: reportQueue.abandonedCalls,
      source: "call_report",
    };
  }
  return { missed: totals.missed, abandoned: totals.abandoned, source: cdrSource };
}

/**
 * The complete queue-outcome figure set for one view: the split, the CDR
 * population it came out of, and the rates over it.
 *
 * Rates are derived from the RENDERED missed/abandoned rather than from CDR's,
 * so a "Missed rate" can never describe a different number of calls than the
 * "Missed" card beside it.
 */
export function resolveQueueOutcomes(
  totals: CdrOutcomeTotals,
  reportQueue: ReportQueueOutcomes | null,
  cdrSource: MetricSource,
): QueueOutcomeView {
  const split = resolveQueueOutcomeSplit(totals, reportQueue, cdrSource);
  const inbound = totals.inbound;
  return {
    ...split,
    unansweredTotal: totals.missed + totals.abandoned,
    missedRate: inbound ? (split.missed / inbound) * 100 : 0,
    abandonRate: inbound ? (split.abandoned / inbound) * 100 : 0,
  };
}

/** Did this call reach the queue and leave it without an agent? */
export function isUnansweredQueueCall(c: NormalizedCall): boolean {
  return c.outcome === "missed" || c.outcome === "abandoned";
}

/**
 * Label every unanswered queue call in `calls` so the labels ADD UP to `split`.
 *
 * Returns `callId → kind` for the unanswered population only; a call that is
 * not in that population is absent from the map. When the split is CDR's own
 * the labels are CDR's `outcome` verbatim and this is a pass-through.
 *
 * When the PBX supplied the split, the population is re-cut at its boundary —
 * see the module note on the ordering. Two honest edge cases:
 *
 *   - The PBX counted MORE unanswered calls than CDR found in this window (its
 *     abandoned count exceeds the population). Every call is then labelled
 *     abandoned and the list is simply shorter than the card; the two sources
 *     disagree on the population, which `populationsAgree` already reports.
 *   - The PBX counted fewer. The surplus falls to missed, for the same reason.
 *
 * Neither case is invented data: no call is added, removed or duplicated, and
 * the sum of both labels is always exactly the calls that are really there.
 */
export function classifyUnansweredCalls(
  calls: Iterable<NormalizedCall>,
  split: Pick<QueueOutcomeSplit, "abandoned" | "source">,
): Map<string, UnansweredKind> {
  const labels = new Map<string, UnansweredKind>();
  const population: NormalizedCall[] = [];
  for (const c of calls) {
    if (isUnansweredQueueCall(c)) population.push(c);
  }

  if (split.source !== "call_report") {
    for (const c of population) labels.set(c.callId, c.outcome as UnansweredKind);
    return labels;
  }

  // Shortest wait first, so the cut lands where CDR's threshold would have put
  // it and only its position changes. Ties break on time then id, so the same
  // window always produces the same labels — a list that reshuffled between
  // refreshes would be unusable for following up.
  const ordered = [...population].sort(
    (a, b) =>
      (a.queueWaitSeconds ?? 0) - (b.queueWaitSeconds ?? 0) ||
      (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
      a.callId.localeCompare(b.callId),
  );

  const abandonedCount = Math.min(Math.max(0, split.abandoned), ordered.length);
  ordered.forEach((c, i) => labels.set(c.callId, i < abandonedCount ? "abandoned" : "missed"));
  return labels;
}
