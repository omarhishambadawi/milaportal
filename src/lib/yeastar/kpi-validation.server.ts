/**
 * Production-safe live KPI validation.
 *
 * Deliberately separate from `diagnostics.server.ts`. That module returns raw
 * PBX response bodies — caller numbers, DIDs, recording paths — and is therefore
 * refused outside a development build. This one runs the same analytics pipeline
 * over the same live CDR but returns ONLY aggregates: call counts, KPI totals,
 * the pass/fail invariants, and field NAMES with their occurrence counts.
 *
 * It DOES return per-call diagnostic rows — a mismatch cannot be traced to
 * exact calls without them — but only fields that carry no external identity:
 *
 *   - `call_id`: an opaque PBX identifier, meaningless outside this PBX
 *   - extension + agent name: internal roster data the viewer already administers
 *   - outcome, durations, leg counts, exclusion reason
 *
 * Never returned, at any point: raw response bodies, credentials, tokens,
 * caller/callee phone numbers, DIDs, or recording file paths. That is what
 * makes this safe to expose to an administrator on a deployed environment,
 * which is the only place the Yeastar credentials exist.
 */
import { fetchCdrRange } from "./cdr.server";
import { aggregateClassified, classifyRecords, type CallTotals } from "./stats.server";
import { validateAnalytics, type KpiCheck } from "./validate";
import { RETIRED_ASSUMED_FIELDS } from "./diagnostics.server";
import {
  DEFAULT_OUTBOUND_RING_TIMEOUT_SEC,
  type NormalizationContext,
  type NormalizedCall,
} from "./normalize";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

/** Minutes from midnight → "HH:MM". */
function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * One call, reduced to what a mismatch investigation needs.
 *
 * Contains NO phone numbers, DIDs or recording paths — a `call_id` is an opaque
 * PBX identifier and the extension is an internal number, both of which are
 * required to line a row up against the Yeastar report.
 */
export interface CallDiagnosticRow {
  callId: string;
  startedAt: number | null;
  direction: string;
  /** Raw `call_type` before correction, so a reclassification is visible. */
  declaredDirection: string;
  directionCorrected: boolean;
  extension: string;
  /** Roster name for `extension`, or "Unknown" when no agent claims it. */
  agentName: string;
  classification: string;
  included: boolean;
  exclusionReason: string | null;
  talkSeconds: number;
  ringSeconds: number | null;
  queueWaitSeconds: number | null;
  queueNumber: string | null;
  legs: number;
  /** Why this call is where it is — see `deriveRootCause`. */
  rootCause: string;
}

/** How long each stage took, and whether production's cache was warm. */
export interface ProcessingStats {
  fetchMs: number;
  normalizeMs: number;
  aggregateMs: number;
  totalMs: number;
  /**
   * State of the PRODUCTION CDR cache, observed without touching it. Validation
   * always fetches its own copy, so running diagnostics can neither warm nor
   * evict the cache the dashboards rely on.
   */
  cdrCache: { status: "warm" | "cold"; ageMs: number | null };
}

export interface PipelineStats {
  rawRows: number;
  normalizedCalls: number;
  duplicateLegsRemoved: number;
  directionCorrections: number;
  callsExcluded: number;
  queueCalls: number;
  extensionCalls: number;
}

/**
 * Why a call ended up classified or excluded the way it did.
 *
 * Derived from the call's own facts — never guessed. "missing_cdr_row" is
 * deliberately absent: a call we never received cannot appear in this list, so
 * that root cause is inferred by the mismatch inspector from a count shortfall,
 * not from a row.
 */
export function deriveRootCause(c: NormalizedCall, duplicateLegs: boolean): string {
  if (c.directionCorrected) return "wrong_direction";
  if (c.exclusion === "after_hours") return "after_hours";
  if (c.exclusion === "queue_closed") return "queue_closed";
  if (c.exclusion === "system_event") return "system_event";
  if (c.exclusion === "ivr_only") return "ivr_only";
  if (c.exclusion === "internal") return "internal";
  if (duplicateLegs) return "duplicate_leg";
  if (c.outcome === "cancelled_by_agent") return "agent_cancelled";
  if (c.direction === "Inbound" && c.reachedQueue && !c.legs.some((l) => l.role === "agent"))
    return "queue_leg_ignored";
  if (c.outcome === "unknown") return "unknown";
  return "none";
}

export interface KpiValidationReport {
  at: string;
  window: { from: string; to: string; startEpoch: number; endEpoch: number };
  cdr: {
    path: string;
    totalReported: number | null;
    rowsInWindow: number;
    pagesFetched: number;
    truncated: boolean;
    elapsedMs: number;
  };
  /** Roster sizes only — never the numbers themselves, apart from queues. */
  roster: { extensionCount: number; queueNumbers: string[] };
  /** Configured operating window, or null when the after-hours rule is off. */
  businessHours: { days: number[]; start: string; end: string } | null;
  /** Calls that count toward KPIs. */
  calls: number;
  /** Every call the window produced, operational or not. */
  callsSeen: number;
  /**
   * Why calls were left out, one row per category. Every category is always
   * present — a zero is information, not an omission.
   */
  exclusions: { reason: string; count: number }[];
  /** Rows discarded as repeats of a `new_id` already seen. */
  duplicateRowsDropped: number;
  /** Calls whose direction contradicted the PBX label and was corrected. */
  directionCorrections: { declared: string; corrected: string; count: number }[];
  /** Operational calls per business-timezone hour — read real hours off this. */
  callsByHour: { hour: number; calls: number }[];
  /**
   * Outbound reconciliation against Yeastar Reports › Extension Call Statistics.
   *
   * `ringHistogram` buckets the ring duration of every UNANSWERED outbound call.
   * A genuine No Answer rings the full timeout, so the distribution has a spike
   * at the configured timeout; everything below it is an agent hanging up early.
   * That spike is the correct `YEASTAR_OUTBOUND_RING_TIMEOUT_SEC`.
   *
   * `calls` lists every outbound call with its id, bucket and durations so a
   * mismatch can be traced to exact call ids. Call ids are opaque PBX
   * identifiers — no phone numbers are included.
   */
  outbound: {
    ringTimeoutSeconds: number;
    buckets: { bucket: string; calls: number; talkSeconds: number }[];
    ringHistogram: { ringSeconds: string; calls: number }[];
    talkSecondsTotal: number;
    calls: {
      callId: string;
      startedAt: number | null;
      outcome: string;
      extension: string;
      ringSeconds: number | null;
      talkSeconds: number;
    }[];
    callsTruncated: boolean;
  };
  /** Agents in scope, for the agent filter. Names + extensions only. */
  agents: { ext: string; name: string }[];
  /** Every call in the window, for the comparison table and mismatch inspector. */
  callRows: CallDiagnosticRow[];
  callRowsTruncated: boolean;
  processing: ProcessingStats;
  stats: PipelineStats;
  totals: CallTotals;
  /** Aggregate counts by call outcome. */
  outcomes: { outcome: string; count: number }[];
  /** Aggregate counts by leg role — how the normalizer read the routing chain. */
  legRoles: { role: string; count: number }[];
  /** Distribution of legs per call. Should NOT be `{1: everything}` — that was the bug. */
  legsPerCall: { legs: number; calls: number }[];
  checks: KpiCheck[];
  passed: boolean;
  /** Field names + counts. No values, so nothing identifying leaves the server. */
  fieldPresence: { field: string; count: number; percent: number }[];
  /** Any of these reappearing means the firmware changed shape under us. */
  retiredFieldCheck: { field: string; occurrences: number }[];
}

/**
 * Fetch a CDR window, run the production aggregation over it, and re-derive
 * every KPI independently.
 *
 * `ctx` is supplied by the caller so the PBX roster is fetched exactly once, by
 * the same code path analytics uses — a second roster fetch here could disagree
 * with the one analytics saw and produce a validation that proves nothing.
 */
export async function runKpiValidation(
  from: string,
  to: string,
  ctx: NormalizationContext,
  opts: {
    /** Restrict to one team's extensions. Telesales and Customer Care are validated apart. */
    teamExtensions?: ReadonlySet<string> | null;
    /** extension -> agent name, so a row can name who a call belongs to. */
    agentsByExtension?: ReadonlyMap<string, string> | null;
    /** Observed state of the production CDR cache. Read-only — never mutated here. */
    cdrCache?: { status: "warm" | "cold"; ageMs: number | null };
    maxCallRows?: number;
  } = {},
): Promise<KpiValidationReport> {
  const t0 = Date.now();
  const cdr = await fetchCdrRange({ from, to });
  const tFetched = Date.now();
  const classified = classifyRecords(cdr.records, ctx);
  const tNormalized = Date.now();
  const result = aggregateClassified(classified, [], []);
  const tAggregated = Date.now();
  const checks = validateAnalytics(classified, result);

  const outcomes = new Map<string, number>();
  const legRoles = new Map<string, number>();
  const legsPerCall = new Map<number, number>();
  const byHour = new Map<number, number>();
  const tzOffset = ctx.businessHours?.utcOffsetMinutes ?? BUSINESS_UTC_OFFSET_MINUTES;
  for (const c of classified.calls) {
    outcomes.set(c.outcome, (outcomes.get(c.outcome) ?? 0) + 1);
    legsPerCall.set(c.legs.length, (legsPerCall.get(c.legs.length) ?? 0) + 1);
    for (const l of c.legs) legRoles.set(l.role, (legRoles.get(l.role) ?? 0) + 1);
    if (c.startedAt != null) {
      const h = new Date(c.startedAt * 1000 + tzOffset * 60_000).getUTCHours();
      byHour.set(h, (byHour.get(h) ?? 0) + 1);
    }
  }

  // Every category always reported, including the ones that are structurally
  // zero on this PBX — `queue_closed` cannot fire while the queue has
  // `enable_time_condition: 0`, and a zero says so.
  const EXCLUSION_CATEGORIES = [
    "after_hours",
    "queue_closed",
    "outbound_filtered",
    "ivr_only",
    "duplicate",
    "system_event",
    "internal",
    "other",
  ] as const;
  const exclusionMap = new Map<string, number>(
    classified.exclusionCounts.map((e) => [e.reason, e.count]),
  );
  // Duplicates are dropped at row level before a call exists, and the direction
  // filter is applied at query time, so both are folded in here rather than
  // being call-level exclusion reasons.
  exclusionMap.set("duplicate", classified.duplicateRowsDropped);
  exclusionMap.set(
    "outbound_filtered",
    classified.calls.filter((c) => c.direction === "Outbound").length,
  );
  const known = new Set<string>(EXCLUSION_CATEGORIES);
  let other = exclusionMap.get("other") ?? 0;
  for (const [reason, count] of exclusionMap) if (!known.has(reason)) other += count;
  exclusionMap.set("other", other);

  // --- outbound reconciliation ---------------------------------------------
  const OUTBOUND_CALL_LIMIT = 500;
  const outboundCalls = classified.calls.filter((c) => c.direction === "Outbound");
  const ringTimeoutSeconds = ctx.outboundRingTimeoutSeconds ?? DEFAULT_OUTBOUND_RING_TIMEOUT_SEC;

  const buckets = new Map<string, { calls: number; talkSeconds: number }>();
  const ringHistogram = new Map<number, number>();
  let outboundTalk = 0;
  for (const c of outboundCalls) {
    const b = buckets.get(c.outcome) ?? { calls: 0, talkSeconds: 0 };
    b.calls++;
    b.talkSeconds += c.talkSeconds;
    buckets.set(c.outcome, b);
    outboundTalk += c.talkSeconds;
    // Only unanswered calls carry the cancelled-vs-no-answer question.
    if (c.outcome !== "answered" && c.agentRingSeconds != null) {
      ringHistogram.set(c.agentRingSeconds, (ringHistogram.get(c.agentRingSeconds) ?? 0) + 1);
    }
  }

  // --- per-call diagnostic rows --------------------------------------------
  const MAX_CALL_ROWS = opts.maxCallRows ?? 2000;
  const teamExts = opts.teamExtensions ?? null;
  const inTeam = (c: NormalizedCall) =>
    teamExts == null ||
    (c.answeringExtension != null && teamExts.has(c.answeringExtension)) ||
    c.legs.some((l) => l.role === "agent" && teamExts.has(l.destinationNumber));

  const everyCall = [...classified.calls, ...classified.excluded]
    .filter(inTeam)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const callRows: CallDiagnosticRow[] = everyCall.slice(0, MAX_CALL_ROWS).map((c) => {
    // A repeated `new_id` is dropped before the call exists, so the surviving
    // signal is a call carrying two legs that resolve to the same destination.
    const destinations = c.legs.map((l) => l.destinationNumber).filter(Boolean);
    const duplicateLegs = new Set(destinations).size < destinations.length;
    return {
      callId: c.callId,
      startedAt: c.startedAt,
      direction: c.direction,
      declaredDirection: c.declaredDirection,
      directionCorrected: c.directionCorrected,
      extension: c.answeringExtension ?? "unknown",
      agentName:
        (c.answeringExtension && opts.agentsByExtension?.get(c.answeringExtension)) || "Unknown",
      classification: c.outcome,
      included: c.operational,
      exclusionReason: c.exclusion,
      talkSeconds: c.talkSeconds,
      ringSeconds: c.agentRingSeconds,
      queueWaitSeconds: c.queueWaitSeconds,
      queueNumber: c.queueNumber,
      legs: c.legs.length,
      rootCause: deriveRootCause(c, duplicateLegs),
    };
  });

  const counts = new Map<string, number>();
  for (const row of cdr.records)
    for (const key of Object.keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);

  return {
    at: new Date().toISOString(),
    window: { from, to, startEpoch: cdr.startEpoch, endEpoch: cdr.endEpoch },
    cdr: {
      path: cdr.path,
      totalReported: cdr.totalReported,
      rowsInWindow: cdr.records.length,
      pagesFetched: cdr.pagesFetched,
      truncated: cdr.truncated,
      elapsedMs: cdr.elapsedMs,
    },
    roster: { extensionCount: ctx.extensionNumbers.size, queueNumbers: [...ctx.queueNumbers] },
    businessHours: ctx.businessHours
      ? {
          days: [...ctx.businessHours.days],
          start: minuteLabel(ctx.businessHours.startMinute),
          end: minuteLabel(ctx.businessHours.endMinute),
        }
      : null,
    calls: classified.calls.length,
    callsSeen: classified.calls.length + classified.excluded.length,
    exclusions: EXCLUSION_CATEGORIES.map((reason) => ({
      reason,
      count: exclusionMap.get(reason) ?? 0,
    })),
    duplicateRowsDropped: classified.duplicateRowsDropped,
    directionCorrections: classified.directionCorrections,
    callsByHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      calls: byHour.get(hour) ?? 0,
    })),
    outbound: {
      ringTimeoutSeconds,
      buckets: [...buckets.entries()]
        .map(([bucket, v]) => ({ bucket, calls: v.calls, talkSeconds: v.talkSeconds }))
        .sort((a, b) => b.calls - a.calls),
      ringHistogram: [...ringHistogram.entries()]
        .map(([ringSeconds, calls]) => ({ ringSeconds: String(ringSeconds), calls }))
        .sort((a, b) => Number(a.ringSeconds) - Number(b.ringSeconds)),
      talkSecondsTotal: outboundTalk,
      calls: outboundCalls.slice(0, OUTBOUND_CALL_LIMIT).map((c) => ({
        callId: c.callId,
        startedAt: c.startedAt,
        outcome: c.outcome,
        extension: c.answeringExtension ?? "unknown",
        ringSeconds: c.agentRingSeconds,
        talkSeconds: c.talkSeconds,
      })),
      callsTruncated: outboundCalls.length > OUTBOUND_CALL_LIMIT,
    },
    agents: [...(opts.agentsByExtension ?? new Map())]
      .map(([ext, name]) => ({ ext, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    callRows,
    callRowsTruncated: everyCall.length > MAX_CALL_ROWS,
    processing: {
      fetchMs: tFetched - t0,
      normalizeMs: tNormalized - tFetched,
      aggregateMs: tAggregated - tNormalized,
      totalMs: Date.now() - t0,
      cdrCache: opts.cdrCache ?? { status: "cold", ageMs: null },
    },
    stats: {
      rawRows: classified.rowsInspected,
      normalizedCalls: classified.calls.length + classified.excluded.length,
      duplicateLegsRemoved: classified.duplicateRowsDropped,
      directionCorrections: classified.directionCorrections.reduce((n, d) => n + d.count, 0),
      callsExcluded: classified.excluded.length,
      queueCalls: classified.calls.filter((c) => c.reachedQueue).length,
      extensionCalls: classified.calls.filter(
        (c) => !c.reachedQueue && c.answeringExtension != null,
      ).length,
    },
    totals: result.totals,
    outcomes: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    legRoles: [...legRoles.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count),
    legsPerCall: [...legsPerCall.entries()]
      .map(([legs, calls]) => ({ legs, calls }))
      .sort((a, b) => a.legs - b.legs),
    checks,
    passed: checks.every((c) => c.passed),
    fieldPresence: [...counts.entries()]
      .map(([field, count]) => ({
        field,
        count,
        percent: cdr.records.length ? Math.round((count / cdr.records.length) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)),
    retiredFieldCheck: RETIRED_ASSUMED_FIELDS.map((field) => ({
      field,
      occurrences: counts.get(field) ?? 0,
    })),
  };
}
