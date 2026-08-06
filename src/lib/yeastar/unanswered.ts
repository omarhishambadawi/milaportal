/**
 * Abandoned / Missed drill-down — the call list behind two KPIs.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it must never become
 * ---------------------------------------------------------------------------
 * A supervisor reading "37 abandoned" on the Customer Care dashboard has exactly
 * one follow-up question: *which* 37, and did anybody ever call them back. This
 * module answers that and nothing else. It aggregates nothing, derives no KPI,
 * and every field on a row is read straight off a `NormalizedCall` that the
 * existing pipeline already produced.
 *
 * Which of those calls is "abandoned" is NOT decided here. It comes from
 * `./call-classification`, the one place in the module that turns the active
 * split into per-call labels — the same call the KPI cards make. This module
 * used to read `call.outcome` directly, which is why a card reading "Missed 0"
 * could open onto two rows: the card followed the PBX and the list followed
 * CDR.
 *
 * ---------------------------------------------------------------------------
 * "Handled later" is derived, not recorded
 * ---------------------------------------------------------------------------
 * Nothing in the CDR links an abandoned call to the callback that eventually
 * reached the same customer — they are separate calls, minutes or days apart,
 * often in the opposite direction. So the link is reconstructed here: a call is
 * "handled" when the SAME subscriber appears on a later ANSWERED call, and the
 * first such call is the follow-up we report.
 *
 * Two details make that reliable rather than approximate:
 *
 *   1. Subscribers are compared on `matchKey`, not on the string the PBX
 *      recorded. The same customer is filed as `0501234567`, `501234567` and
 *      `+966501234567` depending on the trunk, and a naive string compare would
 *      report "never called back" for a customer who was called back twice.
 *   2. The follow-up index is built ONCE over the window and binary-searched per
 *      row. Scanning every call for every abandoned call is the obvious
 *      implementation and it is quadratic — on a month (~8k calls, ~100
 *      abandoned) that is ~800k comparisons per open of the dialog, repeated on
 *      every filter toggle. Indexed, it is one pass plus a log₂ probe per row.
 *
 * Follow-ups are searched within the SELECTED WINDOW only. A callback that
 * happened after the window's last day is invisible here, which is why the
 * dialog says so rather than claiming the customer was never reached.
 */
import { matchKey } from "./lookup-match";
import { classifyUnansweredCalls } from "./call-classification";
import type { QueueOutcomeSplit, UnansweredKind } from "./call-classification";
import type { NormalizedCall } from "./normalize";

/** Re-exported so a caller listing calls needs one import, not two. */
export type { UnansweredKind };

export type CallTeam = "customer_care" | "telesales";

/** The successful later call that reached this customer. */
export interface UnansweredFollowUp {
  callId: string;
  /** Epoch seconds of the follow-up call. */
  at: number;
  /** How long after the unanswered call it happened, in seconds. */
  afterSeconds: number;
  /** Who took it, or null when the extension matches no roster entry. */
  agentName: string | null;
  agentExt: string | null;
  team: CallTeam | null;
  /** Inbound = the customer rang back. Outbound = we called them. */
  direction: "Inbound" | "Outbound";
  talkSeconds: number;
}

/** One abandoned or missed call, as the drill-down table renders it. */
export interface UnansweredCallRow {
  callId: string;
  /** Epoch seconds of the first leg, or null when the PBX omitted a timestamp. */
  startedAt: number | null;
  /** The customer's number, exactly as this call recorded it. */
  customerNumber: string;
  queueNumber: string | null;
  /** Queue-leg ring — how long the caller waited before giving up or being released. */
  waitSeconds: number | null;
  outcome: UnansweredKind;
  /** Null when no later answered call reached this customer inside the window. */
  handled: UnansweredFollowUp | null;
}

/** One answered call, reduced to what a follow-up row needs. */
interface FollowUpEntry {
  callId: string;
  at: number;
  ext: string | null;
  direction: "Inbound" | "Outbound";
  talkSeconds: number;
}

/** Answered calls by customer key, each bucket ascending by time. */
export type FollowUpIndex = ReadonlyMap<string, readonly FollowUpEntry[]>;

/**
 * The customer's end of a call — whichever end is not us.
 *
 * Inbound: the caller. Outbound: the number dialled. Anything internal has no
 * customer end at all and is excluded by the caller.
 */
function customerNumberOf(c: NormalizedCall): string {
  return c.direction === "Inbound" ? c.callerNumber : c.calleeNumber;
}

/**
 * Index every ANSWERED call in the window by the customer it reached.
 *
 * Internal calls are skipped: extension-to-extension traffic is not a customer
 * interaction, and letting one satisfy "handled later" would report a caller as
 * looked-after because two agents spoke to each other afterwards.
 */
export function buildFollowUpIndex(calls: Iterable<NormalizedCall>): FollowUpIndex {
  const index = new Map<string, FollowUpEntry[]>();
  for (const c of calls) {
    if (c.outcome !== "answered") continue;
    if (c.direction === "Internal") continue;
    if (c.startedAt == null) continue;
    const key = matchKey(customerNumberOf(c));
    if (!key) continue;
    const entry: FollowUpEntry = {
      callId: c.callId,
      at: c.startedAt,
      ext: c.answeringExtension ? String(c.answeringExtension).trim() || null : null,
      // Internal is filtered out above, so the remaining two are the only cases.
      direction: c.direction === "Inbound" ? "Inbound" : "Outbound",
      talkSeconds: c.talkSeconds,
    };
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  for (const bucket of index.values()) bucket.sort((a, b) => a.at - b.at);
  return index;
}

/**
 * The FIRST answered call to this customer strictly after `afterEpoch`.
 *
 * Binary search over the already-sorted bucket. Strictly after, so the call
 * cannot match itself if a future outcome rule ever lets an "answered" call
 * share a timestamp with an abandoned one.
 */
export function findFirstFollowUp(
  index: FollowUpIndex,
  customerNumber: string,
  afterEpoch: number,
): FollowUpEntry | null {
  const bucket = index.get(matchKey(customerNumber));
  if (!bucket || bucket.length === 0) return null;
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bucket[mid]!.at > afterEpoch) hi = mid;
    else lo = mid + 1;
  }
  return bucket[lo] ?? null;
}

export interface UnansweredSelection {
  rows: UnansweredCallRow[];
  /** Matching calls before the cap — what the dialog reports as the population. */
  total: number;
  /** How many of `total` were reached later. */
  handled: number;
  /** True when `limit` trimmed the rows. */
  truncated: boolean;
}

export interface SelectUnansweredArgs {
  /** Operational calls for the window — the population the KPIs count. */
  calls: readonly NormalizedCall[];
  /**
   * Every call in the window, operational or not, used ONLY to find follow-ups.
   * A callback that happened after hours still reached the customer, and hiding
   * it would report "never handled" for somebody who was.
   */
  followUpSource?: readonly NormalizedCall[];
  /**
   * A prebuilt index over that same source. The index depends only on the
   * window, not on the filters, so a caller that serves several drill-downs off
   * one classified window builds it once instead of per request.
   */
  followUps?: FollowUpIndex;
  kind: UnansweredKind;
  /**
   * The active Missed / Abandoned split — the SAME one the KPI card renders.
   * It decides which of the unanswered calls carry `kind`, so the list and the
   * card can only ever describe one population under one definition.
   */
  split: Pick<QueueOutcomeSplit, "abandoned" | "source">;
  /** Roster, for naming the agent who took the follow-up. */
  agentByExt: ReadonlyMap<string, { name: string; team: CallTeam }>;
  /** Hard cap on returned rows. `total` still reports the full count. */
  limit: number;
}

/**
 * Pick the abandoned or missed calls out of an already-filtered call list and
 * attach each one's follow-up.
 *
 * `calls` must ALREADY carry the dashboard's direction / queue / scope filters,
 * applied by the same predicates `aggregateClassified` uses — that is what keeps
 * this list and the KPI card describing the same population.
 *
 * The row count now matches the card by construction: both take their labels
 * from `classifyUnansweredCalls` under the same split. The one case where they
 * can still differ is when the PBX and CDR disagree on the SIZE of the
 * unanswered population, not on how to label it — the list can only show calls
 * that exist in the CDR window. The dialog states that rather than quietly
 * showing a different number.
 *
 * Rows come back newest first — the most recent failure is the one somebody is
 * about to act on.
 */
export function selectUnansweredCalls(args: SelectUnansweredArgs): UnansweredSelection {
  const { calls, kind, split, agentByExt, limit } = args;
  const index = args.followUps ?? buildFollowUpIndex(args.followUpSource ?? calls);
  const labels = classifyUnansweredCalls(calls, split);

  const rows: UnansweredCallRow[] = [];
  let handled = 0;

  for (const c of calls) {
    if (labels.get(c.callId) !== kind) continue;
    const customerNumber = c.callerNumber;
    const follow =
      c.startedAt == null ? null : findFirstFollowUp(index, customerNumber, c.startedAt);
    if (follow) handled++;
    const agent = follow?.ext ? agentByExt.get(follow.ext) : undefined;
    rows.push({
      callId: c.callId,
      startedAt: c.startedAt,
      customerNumber,
      queueNumber: c.queueNumber,
      waitSeconds: c.queueWaitSeconds,
      outcome: kind,
      handled:
        follow && c.startedAt != null
          ? {
              callId: follow.callId,
              at: follow.at,
              afterSeconds: follow.at - c.startedAt,
              agentName: agent?.name ?? null,
              agentExt: follow.ext,
              team: agent?.team ?? null,
              direction: follow.direction,
              talkSeconds: follow.talkSeconds,
            }
          : null,
    });
  }

  rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const truncated = rows.length > limit;
  return {
    rows: truncated ? rows.slice(0, limit) : rows,
    total: rows.length,
    handled,
    truncated,
  };
}
