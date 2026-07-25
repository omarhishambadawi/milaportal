/**
 * Yeastar CDR aggregation — queue-aware, Internal excluded.
 *
 * A queue call can hit multiple agents in sequence. Each attempt is its
 * own CDR row. We group rows by (call_id || linkedid || linked_id) and
 * treat the group as ONE call. If the PBX omits a correlation id we
 * fall back to a *sliding* fingerprint: a leg joins the previous group
 * with the same from/to whose last leg was within QUEUE_LEG_WINDOW_SEC
 * (so boundary-straddling legs don't split and unrelated calls in the
 * same window don't merge). — H1 fix.
 *
 * Direction is taken from the first leg; all legs in a queue call share
 * the same direction, so this is not a majority calculation.
 *
 *   Global (platform) counters (Internal excluded):
 *     - Answered = ANY row in the group has disposition = ANSWERED
 *     - Missed   = Inbound group, no row answered, max WAIT >= 5s
 *                  (queue auto-forward flows end with an ANSWERED row and
 *                  are therefore NOT counted as Missed at platform level)
 *     - Abandoned= Inbound group, no row answered, max WAIT <  5s
 *                  (wait, not ring — H5 fix)
 *     - Outbound "No Answer" = Outbound group with no ANSWERED row
 *                  (kept for per-agent stats — NEVER rolled into Missed)
 *
 *   Per-agent counters use RAW rows so per-agent missed reflects the
 *   agent's own unanswered ring even when the queue later forwarded
 *   the call to someone else. Per-agent `missed` is inbound-only (M1).
 *
 *   Talk seconds sum across ALL answered legs in a group (M2), not just
 *   the first, so transferred calls report full talk time.
 *
 *   Waiting Time separates queue WAIT from agent RING (H5):
 *     - `waitSeconds` / `avgWaitSec` — inbound, answered + abandoned
 *     - `ringSeconds` / `avgRingAnsweredSec` — answered only
 */
import type { CdrRecord } from "./cdr.server";
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
  missed: number;               // per-agent NO ANSWER — INBOUND ONLY (M1)
  noAnswerOutbound: number;     // per-agent outbound calls customer did not pick up
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
  total: number;                 // inbound + outbound only (Internal excluded)
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;                // platform (queue) missed only
  abandoned: number;
  noAnswerOutbound: number;      // outbound calls customer didn't pick up
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;           // SUM of answered-leg talk across all groups (M2)
  ringSeconds: number;           // ring on answered groups (agent ring only)
  waitSeconds: number;           // queue wait, answered + abandoned inbound (H5)
  handlingSeconds: number;
  longestSec: number;
  avgTalkSec: number;            // avg talk on answered groups
  avgWaitSec: number;            // avg wait across inbound answered + abandoned (H5)
  avgRingAnsweredSec: number;    // avg agent-ring on answered groups
  answerRate: number;
  missedRate: number;
  abandonRate: number;
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
  talkSeconds: number;
  ringSeconds: number;
  waitSeconds: number;
  handlingSeconds: number;
}

export interface TeamCompareRow {
  team: "customer_care" | "telesales";
  calls: number; answered: number; missed: number; inbound: number; outbound: number;
  talkSeconds: number; handlingSeconds: number;
  answerRate: number; missedRate: number;
}

export interface ConversionRow {
  agentId: string; name: string; ext: string;
  answered: number;
  ordersTotal: number; ordersCompleted: number; ordersCancelled: number; ordersPending: number;
  ordersCash: number; ordersWasfaty: number;
  revenue: number;
  conversionRate: number;      // total orders / answered * 100 (canonical)
  completionRate: number;      // completed orders / total orders * 100
  revenuePerCall: number;
  revenuePerOrder: number;
}

export interface AnalyticsResult {
  totals: CallTotals;
  agents: AgentCallStats[];
  byDay: DayBucket[];
  byHour: HourBucket[];              // 0..23
  teamCompare: TeamCompareRow[];
  conversion: {
    overall: {
      answered: number; orders: number; completed: number; cancelled: number; pending: number;
      cash: number; wasfaty: number; revenue: number;
      conversionRate: number;        // total orders / answered * 100 (canonical)
      completionRate: number;        // completed orders / total orders * 100
      revenuePerCall: number; revenuePerOrder: number;
    };
    perAgent: ConversionRow[];
    perDay: { date: string; answered: number; orders: number; rate: number }[];
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
  /** Filter grouped calls by direction (applied AFTER classification — C2). */
  direction?: "all" | "Inbound" | "Outbound";
  /** Filter grouped calls by group disposition (applied AFTER classification — C2). */
  status?: "all" | "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED" | "VOICEMAIL";
  /**
   * Known PBX queue numbers (e.g. "6400"). agentExtFor() will NEVER return
   * one of these — a queue is not an agent. Prevents Inbound queue calls
   * from being attributed to the queue and then zero-matched, which used to
   * zero-out platform Inbound totals via the reconciliation block.
   */
  queueNumbers?: Set<string>;
  /**
   * Active team/agent scope. When set, platform totals, day/hour buckets and
   * per-agent stats include only call groups attributed to `exts` (a leg
   * resolved to an in-scope agent extension) plus, for a team selection,
   * unanswered inbound calls routed through `ownedQueueNumbers` (the team's
   * owning queue — Customer Care owns 6400). When undefined (team = all,
   * no agent), every classified call is included (prior behaviour).
   */
  scope?: { exts: Set<string>; ownedQueueNumbers?: Set<string> };
}

const ABANDON_THRESHOLD_SEC = 5;
const QUEUE_LEG_WINDOW_SEC = 120; // sliding window for fingerprint fallback

const isAnswered = (d?: string) => d === "ANSWERED";
const isNoAnswer = (d?: string) => d === "NO ANSWER";
const num = (v: any) => Number(v ?? 0);

/**
 * Deterministic PBX correlation id, if the payload provides one (H1).
 * `pin_code` is intentionally NOT used — it is an account/queue PIN, not a
 * call id, and would merge unrelated calls.
 */
function correlationId(r: CdrRecord): string | null {
  const anyR = r as any;
  const id = anyR.call_id ?? anyR.linkedid ?? anyR.linked_id;
  return id ? String(id) : null;
}

function ringOf(r: CdrRecord): number {
  const anyR = r as any;
  // Agent ring only. NOT max()ed with queue wait_time (H5).
  return Math.max(num(r.ring_duration), num(anyR.agent_ring_time));
}

function waitOf(r: CdrRecord): number {
  const anyR = r as any;
  // Queue wait. Some payloads only expose ring_duration for the answered
  // agent leg — fall back to ring_duration when wait_time is absent so
  // abandon/wait metrics don't collapse to zero on non-queue PBX flows.
  const w = num(anyR.wait_time);
  return w > 0 ? w : num(r.ring_duration);
}

/**
 * True if a row is ext-to-ext / Internal.
 * Tighter than before (M6): trust `call_type === "Internal"` and skip the
 * broad "both endpoints ≤4 digits" heuristic that could drop short-code
 * inbound / short-DID traffic.
 */
function looksInternal(r: CdrRecord): boolean {
  return r.call_type === "Internal";
}

/**
 * Which extension identifies the answering AGENT for this row?
 *
 * CRITICAL: a queue number (e.g. 6400) is NEVER an agent. On this Yeastar
 * firmware, a queue-inbound CDR row often has `dst = <queue number>` — the
 * pre-refactor code returned that as the agent extension, no roster entry
 * matched, every queue call fell into "unmatched", and the downstream
 * reconciliation block then zero-ed platform Inbound/Answered. Fix: skip
 * any candidate that is a known queue number, walk a priority list of
 * confirmed answering-agent fields, and return null (→ "Unknown") rather
 * than a queue number when no real agent can be resolved.
 */
function agentExtFor(r: CdrRecord, queueNumbers?: Set<string>): string | null {
  const anyR = r as any;
  const isQueue = (v: unknown): boolean => {
    if (v == null || !queueNumbers) return false;
    const s = String(v).trim();
    return s.length > 0 && queueNumbers.has(s);
  };
  const pick = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || isQueue(s)) return null;
    return s;
  };

  if (r.call_type === "Outbound") {
    return pick(r.call_from_number);
  }
  if (r.call_type === "Inbound") {
    // Priority: confirmed answering-agent fields → connected/dst → to-number.
    // For queue calls the PBX's `last_participant_number` is the agent that
    // actually took the call; test it FIRST before any dst/to fallback.
    const candidates: unknown[] = [
      anyR.last_participant_number,
      anyR.last_participant,
      anyR.final_participant,
      anyR.answer_by,
      anyR.answered_by,
      anyR.agent_number,
      anyR.dst,
      anyR.dst_num,
      anyR.dst_number,
      r.call_to_number,
    ];
    for (const c of candidates) {
      const ext = pick(c);
      if (ext) return ext;
    }
    return null; // Unknown — never fall through to a queue number.
  }
  return null; // Internal ignored
}

/**
 * True if any leg's destination/DID matches one of the given queue numbers.
 * Used to attribute unanswered inbound queue calls to the owning team even
 * when no agent answered (team-scope rule).
 */
function routedThroughQueue(rows: CdrRecord[], queueNumbers: Set<string>): boolean {
  for (const r of rows) {
    const anyR = r as any;
    for (const f of [anyR.dst, anyR.dst_num, anyR.dst_number, r.call_to_number, anyR.did_number]) {
      if (f != null && queueNumbers.has(String(f).trim())) return true;
    }
  }
  return false;
}

function dayKey(ts: number | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function hourOf(ts: number | undefined, tzOffsetMin: number): number {
  if (typeof ts !== "number") return 0;
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return d.getUTCHours();
}

// Note: the legacy `aggregateAgentStats` adaptor was removed (Prompt 1, item 1).
// All callers now use `aggregateAnalytics` directly.


export interface Classified {
  rows: CdrRecord[];
  direction: "Inbound" | "Outbound";
  anyAnswered: boolean;
  talk: number;                  // sum across answered legs (M2)
  ring: number;                  // max agent ring
  wait: number;                  // max queue wait
  handling: number;
  primary: CdrRecord;
  kind: "answered" | "missed" | "abandoned" | "noAnswerOutbound" | "busy" | "failed" | "voicemail" | "other";
  ts: number | undefined;
}

function classify(rows: CdrRecord[]): Classified | null {
  const direction = rows[0].call_type as "Inbound" | "Outbound" | undefined;
  if (direction !== "Inbound" && direction !== "Outbound") return null;

  const answeredLegs = rows.filter((r) => isAnswered(r.disposition));
  const anyAnswered = answeredLegs.length > 0;
  const primary = answeredLegs[answeredLegs.length - 1] ?? rows[rows.length - 1];

  // M2: sum talk across all answered legs (dedupe identical leg fingerprint
  // to avoid transfer double-counting when the PBX re-emits a leg).
  const seenLeg = new Set<string>();
  let talk = 0;
  for (const r of answeredLegs) {
    const fp = `${r.timestamp ?? ""}|${r.call_from_number ?? ""}|${r.call_to_number ?? ""}|${r.talk_duration ?? ""}`;
    if (seenLeg.has(fp)) continue;
    seenLeg.add(fp);
    talk += num(r.talk_duration);
  }
  const ring = Math.max(0, ...rows.map(ringOf));
  const wait = Math.max(0, ...rows.map(waitOf));
  const handling = talk + ring;

  let kind: Classified["kind"] = "other";
  if (anyAnswered) kind = "answered";
  else {
    const dispSet = new Set(rows.map((r) => r.disposition));
    if (dispSet.has("BUSY")) kind = "busy";
    else if (dispSet.has("FAILED")) kind = "failed";
    else if (dispSet.has("VOICEMAIL")) kind = "voicemail";
    else if (direction === "Inbound") {
      // H5: threshold on WAIT, not ring
      kind = wait < ABANDON_THRESHOLD_SEC ? "abandoned" : "missed";
    } else {
      kind = "noAnswerOutbound";
    }
  }

  return { rows, direction, anyAnswered, talk, ring, wait, handling, primary, kind, ts: primary.timestamp };
}

/** Does this classified group pass a status-filter selection? */
function matchesStatus(c: Classified, status: AggregateOptions["status"]): boolean {
  if (!status || status === "all") return true;
  if (status === "ANSWERED") return c.anyAnswered;
  if (status === "NO ANSWER") return !c.anyAnswered && (c.kind === "missed" || c.kind === "abandoned" || c.kind === "noAnswerOutbound");
  const dispSet = new Set(c.rows.map((r) => r.disposition));
  return dispSet.has(status);
}

/** Output of the scope-independent phase 1 (see `classifyRecords`). */
export interface ClassifiedRecords {
  /** Grouped + classified calls. */
  groups: Classified[];
  /** Deduped, non-internal rows — the input to per-agent aggregation. */
  filteredRecords: CdrRecord[];
}

/**
 * Phase 1 — normalize, group and classify raw CDR rows.
 *
 * Everything here is a pure function of `records` alone: it does NOT depend on
 * the agent roster, orders, queue numbers, or the direction/status/scope
 * filters. That independence is what makes the result safe to cache per CDR
 * window and reuse across every team/agent/direction/status permutation the UI
 * requests (M-4). The expensive work — the row dedup, the correlation grouping
 * and the sliding-fingerprint sort — then runs once per window instead of once
 * per filter toggle.
 */
export function classifyRecords(records: CdrRecord[]): ClassifiedRecords {
  // Drop Internal / ext-to-ext rows entirely, up front.
  const nonInternal = records.filter(
    (r) => (r.call_type === "Inbound" || r.call_type === "Outbound") && !looksInternal(r),
  );

  // Row-level dedup: prefer a PBX row id; only fall back to a content
  // fingerprint when none is present. Content dedup includes disposition
  // so distinct NO ANSWER legs of a queue call aren't collapsed. (M7)
  const seen = new Set<string>();
  const filteredRecords: CdrRecord[] = [];
  for (const r of nonInternal) {
    const anyR = r as any;
    const rowId = anyR.uid ?? anyR.new_id ?? anyR.id;
    const fp = rowId != null
      ? `id:${rowId}`
      : `${r.timestamp ?? ""}|${r.call_from_number ?? ""}|${r.call_to_number ?? ""}|${r.disposition ?? ""}|${r.talk_duration ?? ""}|${r.ring_duration ?? ""}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    filteredRecords.push(r);
  }

  // ---- Group by call (H1) --------------------------------------------------
  // 1) By correlation id when the payload has one.
  // 2) Otherwise: sliding fingerprint over sorted-by-timestamp rows.
  const groupsById = new Map<string, CdrRecord[]>();
  const withoutId: CdrRecord[] = [];
  for (const r of filteredRecords) {
    const cid = correlationId(r);
    if (cid) {
      const arr = groupsById.get(cid);
      if (arr) arr.push(r); else groupsById.set(cid, [r]);
    } else {
      withoutId.push(r);
    }
  }
  withoutId.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const groupsByFp: Record<string, CdrRecord[]> = {};
  const lastTsByFp = new Map<string, number>();
  const activeGroupKeyByFp = new Map<string, string>();
  let fpCounter = 0;
  for (const r of withoutId) {
    const fp = `${String(r.call_from_number ?? "").trim()}|${String(r.call_to_number ?? "").trim()}`;
    const ts = typeof r.timestamp === "number" ? r.timestamp : 0;
    const lastTs = lastTsByFp.get(fp);
    const activeKey = activeGroupKeyByFp.get(fp);
    if (activeKey && lastTs !== undefined && ts - lastTs <= QUEUE_LEG_WINDOW_SEC) {
      groupsByFp[activeKey].push(r);
    } else {
      const key = `fp:${fp}:${++fpCounter}`;
      groupsByFp[key] = [r];
      activeGroupKeyByFp.set(fp, key);
    }
    lastTsByFp.set(fp, ts);
  }

  const allGroups: CdrRecord[][] = [
    ...groupsById.values(),
    ...Object.values(groupsByFp),
  ];

  // Classify every group.
  const groups: Classified[] = [];
  for (const rows of allGroups) {
    const c = classify(rows);
    if (c) groups.push(c);
  }

  return { groups, filteredRecords };
}

/**
 * Phase 2 — filter classified groups by the active scope and accumulate every
 * KPI. Cheap relative to phase 1, and dependent on the roster/orders/filters,
 * so it is re-run per request rather than cached.
 */
export function aggregateClassified(
  input: ClassifiedRecords,
  agents: AgentRef[],
  orders: OrderRef[],
  opts: AggregateOptions = {},
): AnalyticsResult {
  const tz = opts.tzOffsetMin ?? Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES);
  const direction = opts.direction ?? "all";
  const status = opts.status ?? "all";

  const byExt = new Map<string, AgentRef>();
  for (const a of agents) if (a.ext) byExt.set(String(a.ext).trim(), a);

  const { groups: classified, filteredRecords } = input;

  // C2: apply direction/status filters at the CALL level, post-classification.
  const filteredGroups = classified.filter((c) => {
    if (direction !== "all" && c.direction !== direction) return false;
    if (!matchesStatus(c, status)) return false;
    return true;
  });

  // Scope filter: when a team/agent selection is active, keep only groups
  // attributed to the in-scope roster (a leg resolved to an in-scope agent
  // extension) plus, for a team selection, unanswered inbound calls routed
  // through the team's owning queue. Undefined scope = include everything.
  const scope = opts.scope;
  const groupInScope = (c: Classified): boolean => {
    if (!scope) return true;
    for (const r of c.rows) {
      const ext = agentExtFor(r, opts.queueNumbers);
      if (ext && scope.exts.has(ext)) return true;
    }
    if (
      scope.ownedQueueNumbers && scope.ownedQueueNumbers.size > 0 &&
      !c.anyAnswered && c.direction === "Inbound" &&
      routedThroughQueue(c.rows, scope.ownedQueueNumbers)
    ) {
      return true;
    }
    return false;
  };
  const scopedGroups = scope ? filteredGroups.filter(groupInScope) : filteredGroups;

  const totals: CallTotals = {
    total: 0, inbound: 0, outbound: 0,
    answered: 0, missed: 0, abandoned: 0, noAnswerOutbound: 0,
    busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, waitSeconds: 0, handlingSeconds: 0,
    longestSec: 0,
    avgTalkSec: 0, avgWaitSec: 0, avgRingAnsweredSec: 0,
    answerRate: 0, missedRate: 0, abandonRate: 0,
  };

  const dayMap = new Map<string, DayBucket>();
  const hourMap = new Map<number, HourBucket>();
  // H5: wait counted over inbound answered + abandoned
  let inboundWaitCount = 0;

  for (const c of scopedGroups) {
    totals.total++;
    if (c.direction === "Inbound") totals.inbound++;
    else totals.outbound++;

    if (c.kind === "answered") {
      totals.answered++;
      totals.talkSeconds += c.talk;
      totals.ringSeconds += c.ring;
      totals.handlingSeconds += c.handling;
      if (c.handling > totals.longestSec) totals.longestSec = c.handling;
      if (c.direction === "Inbound") {
        totals.waitSeconds += c.wait;
        inboundWaitCount++;
      }
    } else if (c.kind === "missed") {
      totals.missed++;
      totals.waitSeconds += c.wait;
      inboundWaitCount++;
    } else if (c.kind === "abandoned") {
      totals.abandoned++;
      totals.waitSeconds += c.wait;
      inboundWaitCount++;
    } else if (c.kind === "noAnswerOutbound") totals.noAnswerOutbound++;
    else if (c.kind === "busy") totals.busy++;
    else if (c.kind === "failed") totals.failed++;
    else if (c.kind === "voicemail") totals.voicemail++;

    // Buckets — inbound + outbound only
    const dk = dayKey(c.ts, tz);
    const hr = hourOf(c.ts, tz);
    const day = dayMap.get(dk) ?? { date: dk, total: 0, answered: 0, missed: 0, abandoned: 0, inbound: 0, outbound: 0, talkSeconds: 0, ringSeconds: 0, waitSeconds: 0, handlingSeconds: 0 };
    day.total++;
    if (c.direction === "Inbound") day.inbound++; else day.outbound++;
    if (c.kind === "answered") {
      day.answered++; day.talkSeconds += c.talk; day.ringSeconds += c.ring; day.handlingSeconds += c.handling;
      if (c.direction === "Inbound") day.waitSeconds += c.wait;
    } else if (c.kind === "abandoned") { day.abandoned++; day.waitSeconds += c.wait; }
    else if (c.kind === "missed") { day.missed++; day.waitSeconds += c.wait; }
    dayMap.set(dk, day);

    const hb = hourMap.get(hr) ?? { hour: hr, total: 0, answered: 0, inbound: 0, outbound: 0 };
    hb.total++;
    if (c.kind === "answered") hb.answered++;
    if (c.direction === "Inbound") hb.inbound++; else hb.outbound++;
    hourMap.set(hr, hb);
  }

  totals.avgTalkSec = totals.answered ? totals.talkSeconds / totals.answered : 0;
  totals.avgRingAnsweredSec = totals.answered ? totals.ringSeconds / totals.answered : 0;
  totals.avgWaitSec = inboundWaitCount ? totals.waitSeconds / inboundWaitCount : 0;
  totals.answerRate = totals.total ? (totals.answered / totals.total) * 100 : 0;
  totals.missedRate = totals.inbound ? (totals.missed / totals.inbound) * 100 : 0;
  totals.abandonRate = totals.inbound ? (totals.abandoned / totals.inbound) * 100 : 0;

  // ---- Per-agent (raw rows, but only from groups that passed filters) ------
  const keepRowSet = new WeakSet<CdrRecord>();
  for (const c of scopedGroups) for (const r of c.rows) keepRowSet.add(r);

  const blank = (a: AgentRef): AgentCallStats => ({
    agentId: a.id, name: a.name, ext: a.ext, team: a.team,
    total: 0, inbound: 0, outbound: 0,
    answered: 0, missed: 0, noAnswerOutbound: 0, busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0,
    longestSec: 0,
    avgTalkSec: 0, avgRingSec: 0, avgHandlingSec: 0, answerRate: 0,
  });
  const perAgent = new Map<string, AgentCallStats>();
  const unmatchedExt = new Map<string, number>();
  let unmatchedRecords = 0;

  for (const r of filteredRecords) {
    if (!keepRowSet.has(r)) continue;
    const ext = agentExtFor(r, opts.queueNumbers);
    const agent = ext ? byExt.get(String(ext).trim()) : undefined;
    if (!agent) {
      unmatchedRecords++;
      if (ext) unmatchedExt.set(ext, (unmatchedExt.get(ext) ?? 0) + 1);
      continue;
    }
    let s = perAgent.get(agent.id);
    if (!s) { s = blank(agent); perAgent.set(agent.id, s); }
    s.total++;
    if (r.call_type === "Inbound") s.inbound++;
    else if (r.call_type === "Outbound") s.outbound++;

    const talk = num(r.talk_duration);
    const ring = num(r.ring_duration);
    if (isAnswered(r.disposition)) {
      s.answered++;
      s.talkSeconds += talk;
      s.ringSeconds += ring;
      const handling = talk + ring;
      s.handlingSeconds += handling;
      if (handling > s.longestSec) s.longestSec = handling;
    } else if (isNoAnswer(r.disposition)) {
      // M1: only inbound NO ANSWER counts as `missed` per-agent.
      // Outbound NO ANSWER is exposed exclusively via `noAnswerOutbound`.
      if (r.call_type === "Inbound") s.missed++;
      else if (r.call_type === "Outbound") s.noAnswerOutbound++;
    } else if (r.disposition === "BUSY") s.busy++;
    else if (r.disposition === "FAILED") s.failed++;
    else if (r.disposition === "VOICEMAIL") s.voicemail++;
  }

  const agentRows = [...perAgent.values()].map((s) => ({
    ...s,
    avgTalkSec: s.answered ? s.talkSeconds / s.answered : 0,
    avgRingSec: s.answered ? s.ringSeconds / s.answered : 0,
    avgHandlingSec: s.answered ? s.handlingSeconds / s.answered : 0,
    answerRate: s.total ? (s.answered / s.total) * 100 : 0,
  })).sort((a, b) => b.total - a.total);

  // ---- Reconciliation intentionally REMOVED ------------------------------
  // Previous code overwrote platform totals from per-agent row aggregates.
  // That destroyed the correct classified totals whenever an agent could
  // not be resolved (queue-inbound rows with dst=<queue number> → no
  // roster match → unmatched → agent totals = 0 → platform Inbound
  // zeroed out even though CDR clearly showed inbound calls).
  //
  // Rule: platform KPIs come from classified CDR groups above and stay
  // authoritative. Per-agent stats are supplemental and never mutate them.



  // ---- Team compare -------------------------------------------------------
  // Per M1, team `missed` is inbound-missed only (per-agent already scoped).
  const teams: Record<"customer_care" | "telesales", TeamCompareRow> = {
    customer_care: { team: "customer_care", calls: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkSeconds: 0, handlingSeconds: 0, answerRate: 0, missedRate: 0 },
    telesales:    { team: "telesales",    calls: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkSeconds: 0, handlingSeconds: 0, answerRate: 0, missedRate: 0 },
  };
  for (const a of agentRows) {
    const t = teams[a.team];
    t.calls += a.total; t.answered += a.answered; t.missed += a.missed;
    t.inbound += a.inbound; t.outbound += a.outbound;
    t.talkSeconds += a.talkSeconds; t.handlingSeconds += a.handlingSeconds;
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
  // by the caller's query, answered by the group-scope filter above). Yeastar
  // owns call metrics, Orders owns order metrics — divided here, never merged.
  const S_COMPLETED = STATUSES[1]; // "Completed"
  const S_CANCELLED = STATUSES[2]; // "Cancelled"
  const S_PENDING   = STATUSES[0]; // "Pending"
  const T_CASH      = ORDER_TYPES[0];
  const T_WASFATY   = ORDER_TYPES[1];

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
  const perAgentConv: ConversionRow[] = agentRows.map((a) => {
    const os = orders.filter((o) => o.agent_id === a.agentId);
    const oc = os.filter((o) => o.status === S_COMPLETED).length;
    const rev = os.reduce((s, o) => s + num(o.invoice_value), 0);
    return {
      agentId: a.agentId, name: a.name, ext: a.ext,
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
  }).sort((a, b) => b.conversionRate - a.conversionRate);

  // Per-day conversion = total orders / answered calls (both scoped).
  const ordersByDay = new Map<string, number>();
  for (const o of orders) ordersByDay.set(o.order_date, (ordersByDay.get(o.order_date) ?? 0) + 1);
  const perDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const answered = d.answered;
    const ord = ordersByDay.get(d.date) ?? 0;
    return { date: d.date, answered, orders: ord, rate: answered ? (ord / answered) * 100 : 0 };
  });

  // Ensure hour 0..23
  const byHour: HourBucket[] = [];
  for (let h = 0; h < 24; h++) byHour.push(hourMap.get(h) ?? { hour: h, total: 0, answered: 0, inbound: 0, outbound: 0 });

  return {
    totals,
    agents: agentRows,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byHour,
    teamCompare: Object.values(teams),
    conversion: { overall, perAgent: perAgentConv, perDay },
    unmatched: {
      records: unmatchedRecords,
      extensions: [...unmatchedExt.entries()].map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count).slice(0, 25),
    },
  };
}

/**
 * One-shot analytics over raw CDR rows — the original public entry point.
 *
 * Behaviourally identical to before the M-4 split: it simply runs phase 1 then
 * phase 2. Callers that repeatedly analyse the SAME CDR window under different
 * filters (the Call Center page) should instead cache `classifyRecords` and
 * call `aggregateClassified` directly, as `getCallCenterAnalytics` now does.
 * Diagnostics and one-off traces keep using this wrapper.
 */
export function aggregateAnalytics(
  records: CdrRecord[],
  agents: AgentRef[],
  orders: OrderRef[],
  opts: AggregateOptions = {},
): AnalyticsResult {
  return aggregateClassified(classifyRecords(records), agents, orders, opts);
}
