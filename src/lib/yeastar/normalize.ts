/**
 * Yeastar CDR normalization layer — built ONLY from fields verified against the
 * live PBX.
 *
 * Verified 2026-07-30 against Yeastar P570, firmware 37.23.0.83
 * (`hogdfpbxy.ras.yeastar.com`), over 13,997 CDR rows spanning 30 days.
 * Sample payloads live in `docs/yeastar/samples/`; the audit that produced this
 * file is `docs/yeastar/live-audit-2026-07-30.md`.
 *
 * ---------------------------------------------------------------------------
 * The one thing that matters: an inbound call is NOT one CDR row.
 * ---------------------------------------------------------------------------
 * A single inbound call produces several rows that all share `call_id`, one per
 * routing stage the call passed through:
 *
 *   call_id 1782844637.854
 *     row 1  call_to "IVR Welcome_AR_EN<6200>"   disposition ANSWERED  talk 13
 *     row 2  call_to "IVR Main_AR<6201>"         disposition ANSWERED  talk 5
 *     row 3  call_to "Queue CC_Team<6400>"       disposition ANSWERED  ring 11  talk 74
 *     row 4  call_to "Shams Rafiq<4005>"         disposition ANSWERED  ring 11  talk 74
 *
 * Two consequences drive this whole module:
 *
 *   1. `disposition: "ANSWERED"` on an IVR row means *the IVR picked up*, not
 *      that a human did. Treating any ANSWERED row as an answered call counts
 *      auto-attendant pickups as handled calls.
 *   2. `talk_duration` repeats down the chain (the queue row and the agent row
 *      both report the same 74s). Summing talk across rows multiplies it.
 *
 * So the unit of analysis is the CALL (grouped by `call_id`), and within a call
 * exactly one leg — the agent leg — carries the truth about who answered and
 * for how long.
 *
 * ---------------------------------------------------------------------------
 * Fields confirmed ABSENT on this firmware (present in the older parser)
 * ---------------------------------------------------------------------------
 * Zero occurrences across all 13,997 rows:
 *   wait_time, agent_ring_time, last_participant_number, last_participant,
 *   final_participant, answer_by, answered_by, agent_number, dst, dst_num,
 *   dst_number, linkedid, linked_id, id
 *
 * None of them are referenced here. Where the old parser fell through that list
 * and landed on `call_to_number`, it picked up the IVR or queue number instead
 * of an agent — which is why answering-extension attribution has to be derived
 * from the leg structure rather than from any single field.
 */

/** A raw CDR row. Every field here was observed on the live PBX. */
export interface RawCdrRow {
  /**
   * CALL-level id — shared by every leg of one call, NOT unique per row.
   * 7,769 distinct values across 13,997 rows, exactly matching the call count.
   * Using this to de-duplicate rows collapses a call to a single leg.
   */
  uid?: string;
  /** ROW-level unique id — 13,997 distinct across 13,997 rows. Used for dedup. */
  new_id?: string;
  /** Call correlation id — shared by every leg of one call. 100% of rows. */
  call_id?: string;
  /** Epoch seconds, UTC. Authoritative for time filtering. 100% of rows. */
  timestamp?: number;
  /** PBX-local display time, "DD/MM/YYYY hh:mm:ss AM/PM". Display only. */
  time?: string;
  call_type?: string;
  disposition?: string;
  /** Display form of the destination, e.g. "Queue CC_Team<6400>". 100%. */
  call_to?: string;
  call_to_number?: string;
  call_to_name?: string;
  call_from?: string;
  call_from_number?: string;
  call_from_name?: string;
  did?: string;
  did_number?: string;
  /** Total leg seconds. 98.5% of rows. */
  duration?: number;
  /** Seconds connected. 85.5% of rows — absent on legs that never connected. */
  talk_duration?: number;
  /** Seconds ringing. 52.0% of rows — absent on IVR legs, present on all queue legs. */
  ring_duration?: number;
  src_trunk?: string;
  dst_trunk?: string;
  dod_number?: string;
  record_file?: string;
  [k: string]: unknown;
}

/** What a single CDR row represents within its call. */
export type LegRole = "agent" | "queue" | "ivr" | "survey" | "prompt" | "external" | "unknown";

export type CallDirection = "Inbound" | "Outbound" | "Internal";

export type CallOutcome =
  /** A human agent answered. */
  | "answered"
  /** Reached the queue, no agent answered, caller waited >= abandonThresholdSeconds. */
  | "missed"
  /** Reached the queue, no agent answered, caller hung up almost immediately. */
  | "abandoned"
  /** Never reached the queue — caller hung up inside the IVR. Not a missed call. */
  | "ivr_only"
  /** Outbound call the far end rang out without picking up. */
  | "no_answer_outbound"
  /**
   * Outbound call the AGENT hung up before the ring timeout expired — the
   * customer was never given the full chance to answer. Counted in Total but
   * NEVER in No Answer: Yeastar's Extension Call Statistics separates the two,
   * and folding them together is what inflated our No Answer figure.
   */
  | "cancelled_by_agent"
  | "busy"
  | "failed"
  | "voicemail"
  | "internal"
  | "unknown";

export interface NormalizedLeg {
  /** `new_id` — the row-unique id on this firmware. */
  rowId: string;
  role: LegRole;
  destinationNumber: string;
  /** Human label the PBX rendered, e.g. "Queue CC_Team". */
  destinationLabel: string;
  disposition: string;
  answered: boolean;
  /** null when the PBX omitted `ring_duration` for this leg. */
  ringSeconds: number | null;
  /** null when the PBX omitted `talk_duration` for this leg. */
  talkSeconds: number | null;
  durationSeconds: number | null;
  timestamp: number | null;
}

/**
 * Why a call does not count toward operational KPIs.
 *
 * `null` means it does. Anything else is reported separately and MUST NOT move
 * Total / Answered / Missed / Abandoned / Answer Rate / queue / agent /
 * conversion numbers.
 */
export type CallExclusionReason =
  /** Arrived outside configured business hours. */
  | "after_hours"
  /** Reached the queue while it was closed and was never offered to an agent. */
  | "queue_closed"
  /** Caller hung up inside the IVR — informational, never offered to an agent. */
  | "ivr_only"
  /** PBX-generated: no external party and no agent/queue/IVR stage. */
  | "system_event"
  /** Extension-to-extension. */
  | "internal";

/**
 * Operating window of the call centre, in the business timezone.
 *
 * Not readable from this PBX: queue 6400 reports `enable_time_condition: 0`, so
 * the queue never closes and any time condition lives upstream on the inbound
 * route, which the firmware exposes no API for. It is therefore configuration,
 * and when it is absent no call is excluded for being after-hours.
 */
export interface BusinessHours {
  /** Days open. 0 = Sunday … 6 = Saturday. */
  days: readonly number[];
  /** Opening time as minutes from midnight. */
  startMinute: number;
  /** Closing time as minutes from midnight. Less than `startMinute` wraps past midnight. */
  endMinute: number;
  /** Business timezone offset, minutes east of UTC. */
  utcOffsetMinutes: number;
}

export interface NormalizedCall {
  /** `call_id` — the verified linked-call identifier. */
  callId: string;
  direction: CallDirection;
  /** Raw `call_type` before any correction. Kept so disagreements are auditable. */
  declaredDirection: string;
  /** True when `direction` had to be corrected against the PBX's own label. */
  directionCorrected: boolean;
  /** Epoch seconds of the first leg. */
  startedAt: number | null;
  callerNumber: string;
  /** Final destination number the caller reached. */
  calleeNumber: string;
  /** DID the call arrived on (inbound only). */
  didNumber: string | null;
  /** Queue the call passed through, or null if it never reached one. */
  queueNumber: string | null;
  /**
   * The extension that actually answered, or null when it cannot be determined
   * from the live payload. null MUST be surfaced as "Unknown" — never guessed,
   * and never substituted with a queue or IVR number.
   */
  answeringExtension: string | null;
  /** True only when a real agent extension answered. IVR pickup does not count. */
  answeredByAgent: boolean;
  reachedQueue: boolean;
  outcome: CallOutcome;
  /** Queue-leg `ring_duration` — how long the caller waited for an agent. */
  queueWaitSeconds: number | null;
  /** Agent-leg `ring_duration` — how long that agent's phone rang. */
  agentRingSeconds: number | null;
  /** Talk seconds counted once, from the agent leg only. */
  talkSeconds: number;
  /** `null` when the call counts toward operational KPIs. */
  exclusion: CallExclusionReason | null;
  /** Convenience mirror of `exclusion === null`. */
  operational: boolean;
  legs: NormalizedLeg[];
}

export interface NormalizationContext {
  /** Extension numbers from `/openapi/v1.0/extension/list`. Authoritative. */
  extensionNumbers: ReadonlySet<string>;
  /** Queue numbers from `/openapi/v1.0/queue/list`. Never treated as agents. */
  queueNumbers: ReadonlySet<string>;
  /** Below this many seconds of queue wait, an unanswered call is "abandoned". */
  abandonThresholdSeconds?: number;
  /**
   * The PBX's outbound ring timeout, in seconds.
   *
   * This is what separates a genuine No Answer from an agent cancelling: a
   * customer who simply does not pick up rings for the FULL timeout, while an
   * agent who gives up hangs up early. Both carry `disposition: "NO ANSWER"`,
   * so the ring duration is the only available discriminator.
   *
   * Nothing in the CDR states this value, so it is configuration. Set it to the
   * PBX's actual ring timeout — the diagnostics page prints a ring-duration
   * histogram of unanswered outbound calls, and the correct value is the spike
   * at the top of that distribution.
   */
  outboundRingTimeoutSeconds?: number;
  /**
   * Operating window. When absent (the default), NO call is excluded for
   * arriving after hours — an unverified schedule would silently move every
   * KPI, which is worse than not applying the rule at all.
   */
  businessHours?: BusinessHours | null;
}

export const DEFAULT_ABANDON_THRESHOLD_SEC = 5;

/**
 * Yeastar's stock outbound ring timeout. Override per-deployment via
 * `YEASTAR_OUTBOUND_RING_TIMEOUT_SEC` once the live ring histogram confirms it.
 */
export const DEFAULT_OUTBOUND_RING_TIMEOUT_SEC = 60;

/**
 * Service-level target: a queue call answered within this many seconds counts
 * as within SLA. Matches the queue's own `sla_time` on this PBX (60s).
 */
export const DEFAULT_SLA_SECONDS = 60;

const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Strip the "<1234>" suffix off a `call_to` display value. */
function labelOf(callTo: string): string {
  const i = callTo.indexOf("<");
  return (i === -1 ? callTo : callTo.slice(0, i)).trim();
}

/**
 * Classify one leg.
 *
 * Roster membership decides first, because `/extension/list` and `/queue/list`
 * are authoritative and language-independent. The `call_to` label prefix is only
 * consulted for IVR / survey / prompt legs, which have no roster to check
 * against — those labels ("IVR ", "Satisfaction Survey", "Play Prompt") are
 * emitted by the firmware itself and were confirmed across the sample.
 */
export function classifyLeg(row: RawCdrRow, ctx: NormalizationContext): LegRole {
  const dest = str(row.call_to_number);
  if (dest && ctx.queueNumbers.has(dest)) return "queue";
  if (dest && ctx.extensionNumbers.has(dest)) return "agent";

  const label = str(row.call_to);
  if (/^IVR\b/i.test(label)) return "ivr";
  if (/satisfaction survey/i.test(label)) return "survey";
  if (/^play prompt/i.test(label)) return "prompt";
  if (/^voicemail/i.test(label)) return "ivr";

  // A long/E.164-looking destination is the far end of an outbound call.
  // Separators are stripped first: the PBX renders some destinations with
  // spaces or dashes, and a formatting difference must not change a leg's role.
  if (/^\+?\d{6,}$/.test(dest.replace(/[\s-]/g, ""))) return "external";
  return "unknown";
}

function normalizeLeg(row: RawCdrRow, ctx: NormalizationContext): NormalizedLeg {
  const disposition = str(row.disposition);
  return {
    rowId: str(row.new_id) || str(row.uid) || str(row.call_id),
    role: classifyLeg(row, ctx),
    destinationNumber: str(row.call_to_number),
    destinationLabel: labelOf(str(row.call_to)),
    disposition,
    answered: disposition === "ANSWERED",
    ringSeconds: numOrNull(row.ring_duration),
    talkSeconds: numOrNull(row.talk_duration),
    durationSeconds: numOrNull(row.duration),
    timestamp: numOrNull(row.timestamp),
  };
}

/**
 * Group raw rows into calls by `call_id`.
 *
 * `call_id` is present on 100% of live rows, so — unlike the previous parser —
 * there is no timestamp-window fingerprint fallback here. A row without a
 * `call_id` becomes its own single-leg call rather than being merged into an
 * unrelated one on a from/to heuristic.
 *
 * Rows are de-duplicated on `new_id`, which is the row-unique id here. `uid`
 * must NOT be used for this: it is shared by every leg of a call, so
 * deduplicating on it would discard all but the first leg.
 *
 * `uid` is, however, a valid correlation key, so it backs up `call_id` when a
 * row somehow lacks one.
 */
export function groupByCall(rows: readonly RawCdrRow[]): Map<string, RawCdrRow[]> {
  const seen = new Set<string>();
  const groups = new Map<string, RawCdrRow[]>();
  for (const row of rows) {
    const rowId = str(row.new_id);
    if (rowId) {
      if (seen.has(rowId)) continue;
      seen.add(rowId);
    }
    const key = str(row.call_id) || str(row.uid) || `row:${rowId}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }
  return groups;
}

/** Is this instant inside the configured operating window? */
export function isWithinBusinessHours(epochSeconds: number, bh: BusinessHours): boolean {
  const local = new Date(epochSeconds * 1000 + bh.utcOffsetMinutes * 60_000);
  if (!bh.days.includes(local.getUTCDay())) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return bh.endMinute > bh.startMinute
    ? minute >= bh.startMinute && minute < bh.endMinute
    : // Window wraps past midnight (e.g. 22:00 → 06:00).
      minute >= bh.startMinute || minute < bh.endMinute;
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Parse a schedule such as `"sun-thu 08:00-17:00"` or `"sat,sun 09:00-22:00"`.
 * Returns null for empty or unparseable input — the caller then applies no
 * after-hours rule at all rather than guessing a window.
 */
export function parseBusinessHours(
  spec: string | undefined | null,
  utcOffsetMinutes: number,
): BusinessHours | null {
  const text = str(spec).toLowerCase();
  if (!text) return null;
  const m = /^([a-z,-]+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;

  const days = new Set<number>();
  for (const part of m[1].split(",")) {
    const range = part.split("-");
    if (range.length === 2) {
      const from = DAY_NAMES.indexOf(range[0] as (typeof DAY_NAMES)[number]);
      const to = DAY_NAMES.indexOf(range[1] as (typeof DAY_NAMES)[number]);
      if (from === -1 || to === -1) return null;
      // Ranges wrap: "fri-mon" is Fri, Sat, Sun, Mon.
      for (let i = from; ; i = (i + 1) % 7) {
        days.add(i);
        if (i === to) break;
      }
    } else {
      const d = DAY_NAMES.indexOf(part as (typeof DAY_NAMES)[number]);
      if (d === -1) return null;
      days.add(d);
    }
  }
  if (days.size === 0) return null;

  const startMinute = Number(m[2]) * 60 + Number(m[3]);
  const endMinute = Number(m[4]) * 60 + Number(m[5]);
  if (startMinute > 1439 || endMinute > 1440 || startMinute === endMinute) return null;

  return { days: [...days].sort(), startMinute, endMinute, utcOffsetMinutes };
}

/**
 * Decide a call's direction, correcting the PBX's own label when the call's
 * endpoints contradict it.
 *
 * An inbound call's caller is an external party — that is what "inbound" means.
 * When a row is labelled `Inbound` but `call_from_number` is one of our own
 * extensions, the call originated inside the PBX and is not inbound, whatever
 * the label says. `call_from_number` is the trustworthy signal here: the live
 * audit matched it to the extension roster on 4,744 of 4,745 outbound rows.
 *
 * The correction is deliberately one-way. It can only move a call OUT of
 * Inbound, never into it, so outbound totals — verified correct against the
 * live PBX — cannot regress.
 */
function deriveDirection(
  first: RawCdrRow,
  legs: readonly NormalizedLeg[],
  ctx: NormalizationContext,
): { direction: CallDirection; declared: string; corrected: boolean } {
  const declared = str(first.call_type);
  const caller = str(first.call_from_number);
  const callerIsExtension = caller !== "" && ctx.extensionNumbers.has(caller);
  const hasExternalDestination = legs.some((l) => l.role === "external");

  if (declared === "Inbound" && callerIsExtension) {
    return {
      direction: hasExternalDestination ? "Outbound" : "Internal",
      declared,
      corrected: true,
    };
  }
  if (declared === "Inbound" || declared === "Outbound" || declared === "Internal") {
    return { direction: declared, declared, corrected: false };
  }
  // Unlabelled. `call_type` is present on 100% of live rows, so this is a
  // defensive branch; it stays Internal so an unknown label can never inflate
  // inbound.
  return { direction: "Internal", declared, corrected: false };
}

/**
 * Why this call does not count as an operational call, or null if it does.
 *
 * Precedence runs most-specific first, so a call that is both after-hours and
 * queue-terminated reports the queue reason.
 */
function classifyExclusion(
  args: {
    direction: CallDirection;
    outcome: CallOutcome;
    startedAt: number | null;
    callerNumber: string;
    reachedQueue: boolean;
    hasAgentLeg: boolean;
    legs: readonly NormalizedLeg[];
  },
  ctx: NormalizationContext,
): CallExclusionReason | null {
  const { direction, outcome, startedAt, callerNumber, reachedQueue, hasAgentLeg, legs } = args;

  if (direction === "Internal") return "internal";

  // PBX-generated: no counterparty at either end, so there is no call to speak
  // of. Deliberately based on the NUMBERS rather than on leg roles — a role is
  // a best-effort classification, and an unrecognised destination (an oddly
  // formatted external number, say) must never cause a real call to vanish from
  // the KPIs. Excluding a call is far more damaging than mis-labelling a leg.
  const hasCounterparty = callerNumber !== "" || legs.some((l) => l.destinationNumber !== "");
  if (!hasCounterparty) return "system_event";
  if (direction === "Inbound" && callerNumber === "") return "system_event";

  const bh = ctx.businessHours;
  const outsideHours = bh != null && startedAt != null && !isWithinBusinessHours(startedAt, bh);
  if (outsideHours) {
    // Reached the queue while closed and was never offered to an agent — the
    // queue terminated it, so it is not a missed call by anybody.
    if (reachedQueue && !hasAgentLeg) return "queue_closed";
    return "after_hours";
  }

  // Informational: the caller never reached a queue or an agent. The parity
  // target (Yeastar Reports › Extension Call Statistics) counts only calls that
  // reached an extension, so these must not appear in operational KPIs.
  if (outcome === "ivr_only") return "ivr_only";

  return null;
}

function inboundOutcome(
  legs: NormalizedLeg[],
  agentAnswered: boolean,
  queueLeg: NormalizedLeg | undefined,
  abandonThreshold: number,
): CallOutcome {
  if (agentAnswered) return "answered";

  const dispositions = new Set(legs.map((l) => l.disposition));
  if (dispositions.has("VOICEMAIL")) return "voicemail";
  if (dispositions.has("BUSY")) return "busy";
  if (dispositions.has("FAILED")) return "failed";

  if (queueLeg) {
    const waited = queueLeg.ringSeconds ?? 0;
    return waited < abandonThreshold ? "abandoned" : "missed";
  }

  // Never reached a queue or an agent: the caller hung up inside the IVR. This
  // is deliberately NOT "missed" — no agent was ever given the opportunity to
  // answer, so charging it against answer rate would be wrong.
  return "ivr_only";
}

/** Normalize one call's legs. `rows` must all share a `call_id`. */
export function normalizeCall(
  rows: readonly RawCdrRow[],
  ctx: NormalizationContext,
): NormalizedCall | null {
  if (rows.length === 0) return null;

  const abandonThreshold = ctx.abandonThresholdSeconds ?? DEFAULT_ABANDON_THRESHOLD_SEC;
  const ordered = [...rows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const first = ordered[0];
  const legs = ordered.map((r) => normalizeLeg(r, ctx));

  const {
    direction,
    declared: declaredDirection,
    corrected: directionCorrected,
  } = deriveDirection(first, legs, ctx);

  const queueLeg = legs.find((l) => l.role === "queue");
  const answeredAgentLegs = legs.filter((l) => l.role === "agent" && l.answered);
  const lastAnsweredAgentLeg = answeredAgentLegs[answeredAgentLegs.length - 1];

  let answeringExtension: string | null = null;
  let talkSeconds = 0;
  let agentRingSeconds: number | null = null;

  if (direction === "Outbound") {
    // Verified: on outbound rows `call_from_number` is the placing extension
    // (4,744 of 4,745 rows matched the extension roster). This preserves the
    // existing, already-correct outbound attribution.
    const from = str(first.call_from_number);
    if (from && ctx.extensionNumbers.has(from)) answeringExtension = from;
    for (const leg of legs) {
      if (leg.answered) talkSeconds += leg.talkSeconds ?? 0;
    }
    agentRingSeconds = legs.find((l) => l.ringSeconds != null)?.ringSeconds ?? null;
  } else if (lastAnsweredAgentLeg) {
    answeringExtension = lastAnsweredAgentLeg.destinationNumber || null;
    // Counted from agent legs only — the queue and IVR legs repeat the same
    // talk_duration and would multiply the total.
    for (const leg of answeredAgentLegs) talkSeconds += leg.talkSeconds ?? 0;
    agentRingSeconds = lastAnsweredAgentLeg.ringSeconds;
  }

  const agentAnswered = direction === "Inbound" && answeredAgentLegs.length > 0;

  let outcome: CallOutcome;
  if (direction === "Internal") {
    outcome = "internal";
  } else if (direction === "Outbound") {
    const dispositions = new Set(legs.map((l) => l.disposition));
    if (legs.some((l) => l.answered)) outcome = "answered";
    else if (dispositions.has("BUSY")) outcome = "busy";
    else if (dispositions.has("FAILED")) outcome = "failed";
    else if (dispositions.has("VOICEMAIL")) outcome = "voicemail";
    else if (dispositions.has("NO ANSWER")) {
      // A customer who does not pick up rings for the FULL timeout; an agent
      // who gives up hangs up before it. Same disposition, different event —
      // and Yeastar's Extension Call Statistics counts them in different
      // buckets, so we must too.
      //
      // When the PBX omitted `ring_duration` there is no evidence of an early
      // hang-up, and the call stays a plain No Answer. Inventing cancellations
      // from missing data would defame the agent it is attributed to.
      const ringTimeout = ctx.outboundRingTimeoutSeconds ?? DEFAULT_OUTBOUND_RING_TIMEOUT_SEC;
      outcome =
        agentRingSeconds != null && agentRingSeconds < ringTimeout
          ? "cancelled_by_agent"
          : "no_answer_outbound";
    } else outcome = "unknown";
  } else {
    outcome = inboundOutcome(legs, agentAnswered, queueLeg, abandonThreshold);
  }

  const lastLeg = legs[legs.length - 1];
  const startedAt = numOrNull(first.timestamp);
  const callerNumber = str(first.call_from_number);

  const exclusion = classifyExclusion(
    {
      direction,
      outcome,
      startedAt,
      callerNumber,
      reachedQueue: queueLeg != null,
      hasAgentLeg: legs.some((l) => l.role === "agent"),
      legs,
    },
    ctx,
  );

  return {
    callId: str(first.call_id) || legs[0].rowId,
    direction,
    declaredDirection,
    directionCorrected,
    startedAt,
    callerNumber,
    calleeNumber: (lastAnsweredAgentLeg ?? lastLeg).destinationNumber,
    didNumber: str(first.did_number) || str(first.did) || null,
    queueNumber: queueLeg ? queueLeg.destinationNumber : null,
    answeringExtension,
    answeredByAgent: agentAnswered,
    reachedQueue: queueLeg != null,
    outcome,
    // Queue wait and agent ring are distinct on this firmware and are kept
    // apart: on 101 of 1,192 answered queue calls the queue leg rang longer
    // than the agent leg, because the queue had already tried another agent.
    queueWaitSeconds: queueLeg ? queueLeg.ringSeconds : null,
    agentRingSeconds,
    talkSeconds,
    exclusion,
    operational: exclusion === null,
    legs,
  };
}

/** Normalize a full CDR page/window into one entry per call, oldest first. */
export function normalizeCdr(
  rows: readonly RawCdrRow[],
  ctx: NormalizationContext,
): NormalizedCall[] {
  const calls: NormalizedCall[] = [];
  for (const group of groupByCall(rows).values()) {
    const call = normalizeCall(group, ctx);
    if (call) calls.push(call);
  }
  calls.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return calls;
}

/** A queue member as `/queue/list` renders it: `text2` is the extension NUMBER. */
interface QueueMemberEntry {
  text2?: unknown;
}

/** A `/queue/list` entry, with its agent rosters. */
interface QueueListEntry {
  number?: unknown;
  static_agent_list?: ReadonlyArray<QueueMemberEntry> | null;
  dynamic_agent_list?: ReadonlyArray<QueueMemberEntry> | null;
}

/**
 * Build a normalization context from live roster responses.
 *
 * Queue MEMBERS are folded into the extension set as well as `/extension/list`
 * itself. `/extension/list` is paginated, and an agent who falls on a page the
 * caller did not fetch would otherwise go unrecognised — their leg would be
 * classified as `unknown`, the call would look like it never reached a human,
 * and it would land in Missed. A queue member is an extension by definition, so
 * this closes that gap without weakening the check: both lists come from the
 * PBX, and any number configured as a queue is still removed at the end.
 */
export function buildContext(
  extensionListData: ReadonlyArray<{ number?: unknown }> | null | undefined,
  queueListData: ReadonlyArray<QueueListEntry> | null | undefined,
  abandonThresholdSeconds = DEFAULT_ABANDON_THRESHOLD_SEC,
  businessHours: BusinessHours | null = null,
  outboundRingTimeoutSeconds = DEFAULT_OUTBOUND_RING_TIMEOUT_SEC,
): NormalizationContext {
  const extensionNumbers = new Set<string>();
  for (const e of extensionListData ?? []) {
    const n = str(e?.number);
    if (n) extensionNumbers.add(n);
  }
  const queueNumbers = new Set<string>();
  for (const q of queueListData ?? []) {
    const n = str(q?.number);
    if (n) queueNumbers.add(n);
    for (const m of [...(q?.static_agent_list ?? []), ...(q?.dynamic_agent_list ?? [])]) {
      const ext = str(m?.text2);
      if (ext) extensionNumbers.add(ext);
    }
  }
  // A number configured as a queue is never an agent, whatever else it appears in.
  for (const q of queueNumbers) extensionNumbers.delete(q);
  return {
    extensionNumbers,
    queueNumbers,
    abandonThresholdSeconds,
    businessHours,
    outboundRingTimeoutSeconds,
  };
}
