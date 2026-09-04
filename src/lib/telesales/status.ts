import type { BusinessDate } from "./dates";
import { addDays, compareDates } from "./dates";
import {
  CLOSED_LEAD_STATUSES,
  OUTCOME_BY_KEY,
  type LeadStatus,
  type LeadType,
  type OutcomeDef,
} from "./types";

/**
 * The lead state machine.
 *
 * Pure, so that "what does recording *No answer* actually do" has one answer
 * that a test can ask without a database. The server function applies the
 * result; it does not decide it.
 *
 * ===========================================================================
 * Why outcome and status are separate
 * ===========================================================================
 * The workbooks had one column, `Action`, and it carried both. That is why the
 * Retention sheet cannot answer "how many leads are still open" — 270 rows say
 * `Reschedule call`, 221 say `No Answer or Busy`, and nothing distinguishes a
 * lead rescheduled this morning from one rescheduled in May and forgotten.
 *
 * Here, an outcome is an *event* (it goes in the timeline, forever, and is
 * counted for contact rate) and a status is a *state* (there is one, it is
 * current, and the queue filters on it).
 */

/** What applying an outcome does to a lead. */
export interface OutcomeEffect {
  status: LeadStatus;
  /** Whether the lead is finished. */
  terminal: boolean;
  /** Whether a follow-up date must accompany this outcome. */
  requiresFollowup: boolean;
  /** Whether this counts as having reached the customer. */
  connected: boolean;
  /** Whether recording this should bump `contact_attempts`. */
  countsAsAttempt: boolean;
  /** Set on the lead when the outcome closes it. */
  closedReason: string | null;
}

/**
 * Apply an outcome to a lead in a given status.
 *
 * Throws on an unknown outcome key rather than defaulting: a typo in a server
 * function must not quietly file a conversion as a no-answer.
 */
export function applyOutcome(current: LeadStatus, outcomeKey: string): OutcomeEffect {
  const def: OutcomeDef | undefined = OUTCOME_BY_KEY.get(outcomeKey);
  if (!def) throw new Error(`Unknown telesales outcome: ${outcomeKey}`);

  return {
    status: def.status,
    terminal: def.terminal,
    requiresFollowup: def.requiresFollowup,
    connected: def.connected,
    /*
     * Every recorded outcome is a contact attempt, including the ones that
     * closed the lead — an agent who dialled and got "wrong number" made an
     * attempt, and the contact *rate* is meaningless if its denominator only
     * counts the calls that went somewhere.
     */
    countsAsAttempt: true,
    closedReason: def.terminal ? def.label : null,
  };
}

/**
 * May this transition be made at all?
 *
 * The one rule the machine enforces: a closed lead does not accept an outcome.
 * Reopening is a separate, deliberate action with its own activity type, so that
 * "this lead was closed and then worked again" is legible in the timeline rather
 * than being an unexplained second outcome after a terminal one.
 */
export function canRecordOutcome(current: LeadStatus): boolean {
  return !(CLOSED_LEAD_STATUSES as string[]).includes(current);
}

/* ------------------------------------------------------------------------- */
/* Ownership                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Who may act on this lead?
 *
 * This is the rule that replaces the spreadsheet's "Agent Name" column, and it
 * is the one that prevents the failure the brief names: two agents unknowingly
 * working the same lead.
 *
 *   - A manager (`manage_telesales`) may act on anything, and may reassign.
 *   - An agent may act on a lead assigned to them.
 *   - An agent may *claim* an unassigned lead, which assigns it to them.
 *   - An agent may not act on, or claim, a lead assigned to somebody else.
 *
 * The last line is the whole point. In the workbook an agent typed their name
 * into a row a colleague had already typed into, and the second name overwrote
 * the first.
 */
export interface ActorContext {
  userId: string;
  canWork: boolean;
  canManage: boolean;
}

export type OwnershipDecision =
  | { allowed: true; claims: boolean }
  | { allowed: false; reason: string };

export function canActOnLead(
  actor: ActorContext,
  lead: { assigned_to: string | null; status: string },
): OwnershipDecision {
  if (actor.canManage) return { allowed: true, claims: lead.assigned_to == null };
  if (!actor.canWork)
    return { allowed: false, reason: "You do not have permission to work leads." };
  if (lead.assigned_to == null) return { allowed: true, claims: true };
  if (lead.assigned_to === actor.userId) return { allowed: true, claims: false };
  return {
    allowed: false,
    reason: "This lead is assigned to another agent. A team lead can reassign it.",
  };
}

/** Reassigning somebody else's lead is a manager action, always. */
export function canAssignLead(actor: ActorContext, lead: { assigned_to: string | null }): boolean {
  if (actor.canManage) return true;
  // An agent may assign an unassigned lead — to themselves, which the server
  // function enforces separately by ignoring the requested assignee.
  return actor.canWork && lead.assigned_to == null;
}

/* ------------------------------------------------------------------------- */
/* Follow-ups                                                                */
/* ------------------------------------------------------------------------- */

export interface FollowupProposal {
  dueOn: BusinessDate;
  reason: string;
}

/**
 * What date to put in the follow-up box before the agent touches it.
 *
 * Three cases, in order:
 *
 *   1. The product has a nominal refill interval and the outcome was a
 *      conversion — the next cycle is one interval away. A 30-tablet Rybelsus
 *      pack is 30 days; a FreeStyle Libre sensor is a 14-day wear cycle.
 *   2. The outcome was a reschedule — tomorrow, because that is what a
 *      reschedule almost always means and it is one keystroke to change.
 *   3. Anything else — three days, matching the branch reservation period the
 *      Cash rule is built on.
 *
 * A proposal, never a decision: the agent's choice always wins, and an outcome
 * marked `requiresFollowup` will not be accepted without one.
 */
export function proposeFollowup(
  today: BusinessDate,
  input: { outcomeKey: string; refillDays: number | null; leadType: LeadType },
): FollowupProposal {
  const def = OUTCOME_BY_KEY.get(input.outcomeKey);

  if (def?.status === "converted" && input.refillDays && input.refillDays > 0) {
    return {
      dueOn: addDays(today, input.refillDays),
      reason: `Next refill due after ${input.refillDays} days`,
    };
  }
  if (input.outcomeKey === "reschedule") {
    return { dueOn: addDays(today, 1), reason: "Customer asked to be called back" };
  }
  /*
   * "Too soon" means the customer still has medication, so the honest proposal
   * is the product's own cycle when the catalogue knows it. Two weeks otherwise,
   * which is the shortest interval any product in the catalogue carries and
   * therefore the one least likely to propose a call after the customer has run
   * out.
   */
  if (input.outcomeKey === "refill_too_soon") {
    return input.refillDays && input.refillDays > 0
      ? {
          dueOn: addDays(today, input.refillDays),
          reason: `Still supplied — next cycle is ${input.refillDays} days`,
        }
      : { dueOn: addDays(today, 14), reason: "Still supplied — call back" };
  }
  // Stock, not the customer. Three days is the branch reservation period the
  // Cash rule is built on, which is roughly how long a restock takes.
  if (input.outcomeKey === "out_of_stock") {
    return { dueOn: addDays(today, 3), reason: "Waiting on stock" };
  }
  if (input.outcomeKey === "interested") {
    return { dueOn: addDays(today, 2), reason: "Interested — follow up" };
  }
  return { dueOn: addDays(today, 3), reason: "Follow up" };
}

/** Is a scheduled follow-up workable today? */
export function isFollowupDue(dueOn: BusinessDate, today: BusinessDate): boolean {
  return compareDates(dueOn, today) <= 0;
}

/* ------------------------------------------------------------------------- */
/* Priority                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The queue's sort weight.
 *
 * The workbooks had no notion of priority — the sheet was in whatever order the
 * filter produced — so this is new, and it is kept deliberately crude. Three
 * inputs, each with an operational justification:
 *
 *   - **An overdue follow-up outranks everything.** Somebody was promised a
 *     call on a day that has passed.
 *   - **A Wasfaty lead in its window outranks a Cash lead**, because the Wasfaty
 *     window is two days wide and the Cash one is three: it expires sooner.
 *   - **A lead with a phone number outranks one without**, because the one
 *     without needs a Wasfaty portal lookup first and is not, right now, a call.
 *
 * Anything more elaborate would be guessing at a desk that has never had
 * prioritisation and cannot yet say what it wants from it.
 */
export function computePriority(input: {
  leadType: LeadType;
  hasPhone: boolean;
  followupOverdue: boolean;
}): number {
  let score = 0;
  if (input.followupOverdue) score += 100;
  if (input.leadType === "wasfaty") score += 10;
  else if (input.leadType === "retention") score += 5;
  if (input.hasPhone) score += 1;
  return score;
}

/* ------------------------------------------------------------------------- */
/* Legacy outcome mapping                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A spreadsheet `Action` value → an outcome key.
 *
 * Used only by the retention backlog import, which has to carry 745 rows of
 * existing history across. Matching is case-insensitive and whitespace-
 * insensitive because the workbooks are not: `"N/A"` and `"N.A"`, `"duplicate "`
 * and `"DUPLICATE"`, `"                   "` and `null` all appear in the same
 * column.
 *
 * Returns `null` for an unrecognised value, and the importer records it against
 * a row number rather than guessing — an `Action` nobody has seen before is more
 * likely a new outcome the desk invented than a typo worth resolving silently.
 */
const LEGACY_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const outcome of OUTCOME_BY_KEY.values()) {
    for (const legacy of outcome.legacyLabels) {
      map.set(legacyKey(legacy), outcome.key);
    }
    map.set(legacyKey(outcome.label), outcome.key);
  }
  return map;
})();

function legacyKey(value: string): string {
  return value
    .replace(/[.\s]+/g, " ")
    .replace(/\s*[-–]\s*/g, " - ")
    .trim()
    .toLowerCase();
}

export function outcomeFromLegacyAction(action: string | null | undefined): string | null {
  if (!action) return null;
  const key = legacyKey(action);
  if (!key) return null;
  return LEGACY_LOOKUP.get(key) ?? null;
}
