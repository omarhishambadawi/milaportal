/**
 * KPI validation for the normalized analytics pipeline.
 *
 * Every check here is an INDEPENDENT recount over the normalized calls, compared
 * against what `aggregateClassified` reported. The point is not to restate the
 * aggregator's arithmetic — it is to pin the specific failure modes the live
 * audit found, so they cannot come back silently:
 *
 *   - a call counted more than once (leg counted as a call)
 *   - an IVR pickup counted as an answered call
 *   - talk seconds multiplied by summing the repeated `talk_duration` down the
 *     leg chain
 *   - queue wait collapsing to zero, or being confused with agent ring
 *   - a queue or IVR number reported as the answering agent
 *
 * The same function runs in two places: over transcribed fixtures in the test
 * suite, and over live CDR on `/admin/yeastar-diagnostics`, so the KPIs can be
 * validated against the real PBX rather than against assumptions.
 *
 * Validation is only meaningful over an UNFILTERED, UNSCOPED result — pass the
 * exact calls the result was computed from.
 */
import type { AnalyticsResult, ClassifiedRecords } from "./stats.server";
import type { NormalizedCall } from "./normalize";

export interface KpiCheck {
  /** Stable id, safe to reference from a report. */
  name: string;
  /** What this check protects against. */
  description: string;
  passed: boolean;
  expected: string;
  actual: string;
}

const eq = (
  name: string,
  description: string,
  expected: number,
  actual: number,
  tolerance = 0,
): KpiCheck => ({
  name,
  description,
  passed: Math.abs(expected - actual) <= tolerance,
  expected: String(expected),
  actual: String(actual),
});

/**
 * `input` must be the exact ClassifiedRecords the result was computed from.
 * Passing a bare call array still works and is treated as the operational set
 * with an empty exclusion ledger.
 */
export function validateAnalytics(
  input: ClassifiedRecords | readonly NormalizedCall[],
  result: AnalyticsResult,
): KpiCheck[] {
  const classified: ClassifiedRecords = Array.isArray(input)
    ? {
        calls: input as NormalizedCall[],
        excluded: [],
        exclusionCounts: [],
        rowsInspected: 0,
        duplicateRowsDropped: 0,
        directionCorrections: [],
      }
    : (input as ClassifiedRecords);
  const calls = classified.calls;
  const t = result.totals;

  // ---- independent recount ------------------------------------------------
  let total = 0;
  let inbound = 0;
  let outbound = 0;
  let answered = 0;
  let inboundAnswered = 0;
  let missed = 0;
  let abandoned = 0;
  // Must stay zero: an IVR-only call is excluded before it can reach a KPI.
  const ivrOnly = calls.filter((c) => c.outcome === "ivr_only").length;
  let noAnswerOutbound = 0;
  let nonOperationalLeak = 0;
  let talk = 0;
  let ring = 0;
  let wait = 0;
  let queueWaitCount = 0;
  let queueCalls = 0;

  const callIds = new Set<string>();
  let duplicateCallIds = 0;
  let answeredWithoutExtension = 0;
  let extensionIsQueue = 0;
  let ivrPickupCountedAsAnswered = 0;
  let talkExceedsLegMax = 0;
  let waitWithoutQueue = 0;
  let internalLeaked = 0;

  const queueNumbers = new Set<string>();
  for (const c of calls) if (c.queueNumber) queueNumbers.add(c.queueNumber);

  for (const c of calls) {
    if (callIds.has(c.callId)) duplicateCallIds++;
    callIds.add(c.callId);

    if (c.direction === "Internal") internalLeaked++;
    if (!c.operational) nonOperationalLeak++;

    total++;
    if (c.direction === "Inbound") inbound++;
    else if (c.direction === "Outbound") outbound++;

    if (c.outcome === "answered") {
      answered++;
      if (c.direction === "Inbound") inboundAnswered++;
      talk += c.talkSeconds;
      ring += c.agentRingSeconds ?? 0;

      if (!c.answeringExtension) answeredWithoutExtension++;
      if (c.answeringExtension && queueNumbers.has(c.answeringExtension)) extensionIsQueue++;

      // An inbound call whose only ANSWERED legs are IVR/survey stages is an
      // auto-attendant pickup, not a handled call.
      if (c.direction === "Inbound" && !c.legs.some((l) => l.role === "agent" && l.answered)) {
        ivrPickupCountedAsAnswered++;
      }

      // Talk must be counted ONCE. `talk_duration` repeats from the queue leg
      // down to the agent leg, so a call's talk can never exceed the largest
      // single leg times the number of legs that actually answered as an agent.
      const answeredAgentLegs = c.legs.filter((l) => l.role === "agent" && l.answered);
      const legMax = Math.max(0, ...c.legs.map((l) => l.talkSeconds ?? 0));
      if (c.talkSeconds > legMax * Math.max(1, answeredAgentLegs.length)) talkExceedsLegMax++;
    } else if (c.outcome === "missed") missed++;
    else if (c.outcome === "abandoned") abandoned++;
    else if (c.outcome === "no_answer_outbound") noAnswerOutbound++;

    if (c.reachedQueue) queueCalls++;
    if (c.queueWaitSeconds != null) {
      wait += c.queueWaitSeconds;
      queueWaitCount++;
      if (!c.reachedQueue) waitWithoutQueue++;
    }
  }

  const dayTotal = result.byDay.reduce((n, d) => n + d.total, 0);
  const dayAnswered = result.byDay.reduce((n, d) => n + d.answered, 0);
  const hourTotal = result.byHour.reduce((n, h) => n + h.total, 0);

  const checks: KpiCheck[] = [
    eq("total-calls", "Total calls = one entry per call_id, not per CDR row.", total, t.total),
    eq("direction-split", "Inbound + Outbound accounts for every call.", total, inbound + outbound),
    eq("inbound", "Inbound call count.", inbound, t.inbound),
    eq(
      "outbound",
      "Outbound call count (must be unchanged by this pipeline).",
      outbound,
      t.outbound,
    ),
    eq("answered", "Answered = a human agent picked up.", answered, t.answered),
    eq("inbound-answered", "Inbound answered by an agent.", inboundAnswered, t.inboundAnswered),
    eq("missed", "Missed = queued, never answered, waited >= threshold.", missed, t.missed),
    eq(
      "abandoned",
      "Abandoned = queued, caller hung up under the threshold.",
      abandoned,
      t.abandoned,
    ),
    eq(
      "ivr-only-excluded",
      "IVR-only calls are reported but excluded from operational KPIs.",
      classified.exclusionCounts.find((e) => e.reason === "ivr_only")?.count ?? 0,
      t.ivrOnly,
    ),
    eq("ivr-only-not-in-total", "No IVR-only call survives into the operational set.", 0, ivrOnly),
    eq(
      "no-answer-outbound",
      "Outbound the far end did not pick up.",
      noAnswerOutbound,
      t.noAnswerOutbound,
    ),
    eq("talk-seconds", "Talk seconds taken from the agent leg, counted once.", talk, t.talkSeconds),
    eq("agent-ring-seconds", "Ring seconds are the AGENT leg's ring.", ring, t.ringSeconds),
    eq("queue-wait-seconds", "Wait seconds are the QUEUE leg's ring.", wait, t.waitSeconds),
    eq("queue-calls", "Calls that actually reached a queue.", queueCalls, t.queueCalls),
    eq(
      "avg-queue-wait",
      "Average wait is over queued calls only, not over all inbound.",
      queueWaitCount ? wait / queueWaitCount : 0,
      t.avgWaitSec,
      0.001,
    ),
    eq(
      "avg-talk",
      "Average talk is over answered calls.",
      answered ? talk / answered : 0,
      t.avgTalkSec,
      0.001,
    ),
    eq(
      "answer-rate",
      "Answer rate = answered / total.",
      total ? (answered / total) * 100 : 0,
      t.answerRate,
      0.001,
    ),
    eq("day-buckets-total", "Day buckets sum to the platform total.", total, dayTotal),
    eq("day-buckets-answered", "Day buckets sum to platform answered.", answered, dayAnswered),
    eq("hour-buckets-total", "Hour buckets sum to the platform total.", total, hourTotal),
    // --- structural guards (must all be zero) -------------------------------
    eq("no-duplicate-calls", "No call_id appears twice — legs are not calls.", 0, duplicateCallIds),
    eq("no-internal-leak", "Internal calls are excluded from analytics.", 0, internalLeaked),
    eq(
      "no-non-operational-leak",
      "No business-rule-excluded call reaches a KPI.",
      0,
      nonOperationalLeak,
    ),
    eq(
      "no-outbound-in-inbound",
      "No call the PBX labelled Outbound is counted as inbound.",
      0,
      calls.filter((c) => c.direction === "Inbound" && c.declaredDirection === "Outbound").length,
    ),
    eq(
      "inbound-callers-are-external",
      "Every inbound call has an external caller, never one of our extensions.",
      0,
      calls.filter((c) => c.direction === "Inbound" && c.directionCorrected).length,
    ),
    eq(
      "no-ivr-pickup-as-answered",
      "No answered inbound call lacking an answered agent leg (IVR pickup).",
      0,
      ivrPickupCountedAsAnswered,
    ),
    eq(
      "no-multiplied-talk",
      "No call's talk exceeds what its legs can support (repeated talk_duration).",
      0,
      talkExceedsLegMax,
    ),
    eq(
      "no-unknown-answering-extension",
      "Every answered call resolves to an answering extension.",
      0,
      answeredWithoutExtension,
    ),
    eq(
      "queue-is-never-an-agent",
      "No queue number is reported as the answering extension.",
      0,
      extensionIsQueue,
    ),
    eq(
      "wait-implies-queue",
      "A recorded queue wait always belongs to a call that reached a queue.",
      0,
      waitWithoutQueue,
    ),
  ];

  return checks;
}

/** Convenience: the failing subset, for a report or a thrown error. */
export function failedChecks(checks: readonly KpiCheck[]): KpiCheck[] {
  return checks.filter((c) => !c.passed);
}
