import { addDays, compareDates, daysBetween, formatBusinessDate, isBusinessDate } from "./dates";
import type { BusinessDate } from "./dates";

/**
 * Is this lead's refill opportunity still current?
 *
 * ===========================================================================
 * Why this is derived and not a status
 * ===========================================================================
 * The obvious move is a `stale` value on `telesales_leads.status`, and it is
 * wrong twice over.
 *
 * First, staleness is a function of *today*. A lead due on 1 August with a
 * 28-day cycle becomes stale on 30 August without anything happening to it, so
 * a stored verdict is correct only until midnight and then needs a job to keep
 * it true. A boolean that silently rots is worse than no boolean.
 *
 * Second, it is orthogonal to workflow status. A lead can be `follow_up` *and*
 * stale, or `new` and stale. Collapsing the two axes into one column would
 * destroy the answer to "has anybody actually worked this?" — which is the
 * question the status column exists for, and the one a supervisor looking at a
 * 479-lead backlog needs most.
 *
 * So the state is computed, here, from three values a lead already has: the due
 * date, the product's cycle, and the date. Nothing is written down.
 *
 * ===========================================================================
 * One implementation, two callers
 * ===========================================================================
 * This module is the single source of truth for the staleness boundary that
 * Phase 3 introduced. `recommendations.ts` calls it to decide whether a refill
 * still qualifies as an opportunity, and the queue calls it to decide how to
 * draw the row. The rule is not written twice.
 *
 * The database view `telesales_lead_lifecycle` computes the same boundary date
 * so the queue can filter and page on it server-side. That view stores nothing
 * either — it is evaluated on every read, so it cannot disagree with the clock.
 */

/**
 * `active`  — the refill is current, or is still within one cycle of its date
 * `stale`   — more than one full cycle past due; no longer a current refill
 * `none`    — there is no refill date to judge, so there is nothing to expire
 */
export type LifecycleState = "active" | "stale" | "none";

export interface LifecycleInput {
  /** The date the refill is judged against: the agreed callback where one
   *  exists, otherwise the projection from the last purchase. */
  dueOn: BusinessDate | null | undefined;
  /** `telesales_products.refill_days` for the lead's product. */
  cycleDays: number | null | undefined;
  today: BusinessDate;
  /** Bound for a product with no configured cycle. Only a fallback. */
  defaultCycleDays?: number;
}

export interface LeadLifecycle {
  state: LifecycleState;
  /** The last day the opportunity is still current. Null when nothing is due. */
  staleAfter: BusinessDate | null;
  /** Days past that boundary. Null unless `stale`. */
  daysStale: number | null;
  dueOn: BusinessDate | null;
  cycleDays: number | null;
  /** Short label for a badge. */
  label: string;
  /** One sentence an agent can act on. Null when the lead is active. */
  reason: string | null;
}

/**
 * The fallback cycle, used only when a product has none configured.
 *
 * Thirty days, matching the value Phase 3 already applied, and reachable only
 * by a lead whose due date came from an agreed callback — a projection cannot
 * exist without a cycle to project with.
 */
export const DEFAULT_CYCLE_DAYS = 30;

/**
 * The last day a refill opportunity is still worth calling about.
 *
 * `dueOn + cycleDays`. One full cycle of grace: by the day after this, the
 * customer has missed an entire fill, and whatever is happening — they bought
 * elsewhere, they stopped, somebody already called — it is not "you are due for
 * a refill" any more.
 *
 * Returned as a date rather than a verdict on purpose. A date is a durable fact
 * about the lead; a verdict is only true on the day it was computed. This is
 * what lets the same number be stored in a view, compared in SQL, and rendered
 * in the browser without any of the three disagreeing.
 */
export function staleAfterDate(
  dueOn: BusinessDate | null | undefined,
  cycleDays: number | null | undefined,
  defaultCycleDays: number = DEFAULT_CYCLE_DAYS,
): BusinessDate | null {
  if (!dueOn || !isBusinessDate(dueOn)) return null;
  const cycle = cycleDays != null && cycleDays > 0 ? cycleDays : defaultCycleDays;
  if (!(cycle > 0)) return null;
  return addDays(dueOn, cycle);
}

/**
 * Where this lead sits in its lifecycle.
 *
 * Boundary semantics, stated exactly because a day either way changes what an
 * agent is told: a lead is stale once today is **strictly after**
 * `dueOn + cycleDays`. Due 1 August on a 28-day cycle is still active through
 * 29 August and stale from 30 August. This is Phase 3's rule unchanged — the
 * recommendation engine and the queue must not disagree about a lead by one
 * day at the boundary.
 */
export function leadLifecycle(input: LifecycleInput): LeadLifecycle {
  const { today } = input;
  const dueOn = input.dueOn && isBusinessDate(input.dueOn) ? input.dueOn : null;
  const cycleDays = input.cycleDays != null && input.cycleDays > 0 ? input.cycleDays : null;
  const staleAfter = staleAfterDate(dueOn, input.cycleDays, input.defaultCycleDays);

  if (!dueOn || !staleAfter) {
    return {
      state: "none",
      staleAfter: null,
      daysStale: null,
      dueOn,
      cycleDays,
      label: "No refill scheduled",
      reason: null,
    };
  }

  if (compareDates(today, staleAfter) <= 0) {
    return {
      state: "active",
      staleAfter,
      daysStale: null,
      dueOn,
      cycleDays,
      label: "Active",
      reason: null,
    };
  }

  const effectiveCycle = cycleDays ?? input.defaultCycleDays ?? DEFAULT_CYCLE_DAYS;
  return {
    state: "stale",
    staleAfter,
    daysStale: daysBetween(staleAfter, today),
    dueOn,
    cycleDays,
    label: "STALE",
    /*
     * The reason, in the desk's terms and without the arithmetic. An agent
     * needs to know this is an old opportunity and roughly how old; the
     * boundary date and the subtraction behind it are not their problem.
     */
    reason:
      `Refill opportunity expired after one full cycle. ` +
      `Due ${formatBusinessDate(dueOn)} · ${effectiveCycle}-day refill cycle.`,
  };
}

/**
 * The predicate the recommendation engine asks for.
 *
 * Kept as its own export so the engine reads as the rule it is applying rather
 * than as date arithmetic, and so there is exactly one place where "more than
 * one cycle past due" is written down.
 */
export function isRefillStale(input: LifecycleInput): boolean {
  return leadLifecycle(input).state === "stale";
}
