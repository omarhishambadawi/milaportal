import { LEAD_TYPES, OUTCOMES } from "@/lib/telesales/types";
import {
  DEFAULT_PAGE_SIZE,
  FOLLOWUP_FILTER_OPTIONS,
  LIFECYCLE_FILTER_OPTIONS,
  PAGE_SIZE_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "./constants";
import { DEFAULT_QUEUE_FILTERS } from "./types";

/**
 * The queue's filters, in the address bar.
 *
 * ===========================================================================
 * Why they moved out of `useState`
 * ===========================================================================
 * An agent filters the queue to Follow-up · Retention · overdue, finds the lead
 * they want on page three, opens it, works the call — and comes back to an
 * unfiltered first page. Every one of those choices was component state, and
 * component state does not survive a route change. The same loss happened on a
 * refresh and on browser Back.
 *
 * In the URL it survives all three, and it becomes shareable: a supervisor can
 * send "the stale Wasfaty backlog" as a link rather than as instructions.
 *
 * This is the pattern `/shams` already uses — `validateSearch` on the route,
 * `Route.useSearch()` to read, `navigate({ search })` to write — and it is
 * copied deliberately rather than invented, so there is one way this
 * application keeps view state.
 *
 * ===========================================================================
 * Validated, never trusted
 * ===========================================================================
 * Anything unexpected collapses to the default, so a hand-edited or truncated
 * URL cannot put the queue into a state it has no rendering for. That matters
 * more here than on `/shams`: several of these values are sent to PostgREST as
 * filters, and the queue should be answering a question it recognises.
 *
 * ===========================================================================
 * Defaults are omitted
 * ===========================================================================
 * `/telesales` with no search is the default queue, and staying on the default
 * writes nothing. Without that, opening the page would immediately rewrite the
 * URL with nine parameters that say "everything as it was", and every Back
 * would land on a duplicate entry.
 */

/* ------------------------------------------------------------------------- */
/* The shape                                                                 */
/* ------------------------------------------------------------------------- */

export interface QueueSearch {
  /** Lead type, which is the row of chips above the list. */
  type?: string;
  status?: string;
  /** The recorded action. Wasfaty's status vocabulary; see `OUTCOMES`. */
  outcome?: string;
  /** The assigned telesales agent, by user id. */
  agent?: string;
  /**
   * The import cycle, as its business month (`2026-10`), or `all`.
   *
   * Absent means "the current cycle", which is a *datum* rather than a
   * constant — it is whichever month was imported last — so it cannot be a
   * default in this file. The page resolves absence against the cycle list and
   * the queue filters on the batches in it.
   */
  cycle?: string;
  branch?: string;
  family?: string;
  followup?: string;
  lifecycle?: string;
  /** Free-text search over name, phone, patient id, prescription, invoice. */
  q?: string;
  /** Inclusive business-date range over the lead's source date, `YYYY-MM-DD`. */
  dateFrom?: string;
  dateTo?: string;
  mine?: boolean;
  unassigned?: boolean;
  /** Zero-based, as the queue holds it; written to the URL one-based. */
  page?: number;
  size?: number;
}

/** The concrete state the page renders from, with every default applied. */
export interface QueueState {
  leadType: string;
  status: string;
  outcome: string;
  agent: string;
  /** `""` means the current cycle, `"all"` every cycle, else a `YYYY-MM`. */
  cycle: string;
  branch: string;
  family: string;
  followup: string;
  lifecycle: string;
  term: string;
  dateFrom: string;
  dateTo: string;
  mineOnly: boolean;
  unassignedOnly: boolean;
  page: number;
  pageSize: number;
}

const STATUS_VALUES = STATUS_FILTER_OPTIONS.map((o) => o.value as string);
const FOLLOWUP_VALUES = FOLLOWUP_FILTER_OPTIONS.map((o) => o.value as string);
const LIFECYCLE_VALUES = LIFECYCLE_FILTER_OPTIONS.map((o) => o.value as string);
const TYPE_VALUES: string[] = ["all", ...LEAD_TYPES];
const OUTCOME_VALUES: string[] = ["all", ...OUTCOMES.map((o) => o.key)];

/** An agent is a profile id. Bounded rather than enumerated: the roster comes
 *  from the data, and a value that is not a uuid is not one of them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A cycle is a business month, or every one of them. */
const PERIOD = /^\d{4}-\d{2}$/;

/** Branch and product codes are free-form upstream, so they are bounded rather
 *  than enumerated — the option lists come from the data, not from a constant. */
const CODE = /^[A-Za-z0-9 ._/-]{1,64}$/;
/** The same cap the search input carries. */
const MAX_TERM = 80;
/** A page number no realistic queue reaches; bounds a hand-edited URL. */
const MAX_PAGE = 10_000;

/**
 * A business date, or nothing.
 *
 * Shape-checked rather than parsed: `2026-02-31` is refused by Postgres and
 * would come back as an error, but `?dateFrom=yesterday` should collapse to "no
 * filter" here rather than reach the database at all. The queue sends this
 * straight into a `gte`, so an unrecognised value must become absence and not a
 * guess.
 */
function businessDate(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : "";
}

/**
 * "Deliberately no dates", for a view whose default range is not empty.
 *
 * Everywhere else an empty end is simply omitted from the URL and reads back as
 * empty, because the default is empty. On Generated Leads the default is a real
 * range, so omission would mean "put the default back" and the agent could
 * never widen past it. This is that view's way of writing "cleared".
 */
export const ANY_DATE = "any";

/**
 * The two filters whose resting position differs between views.
 *
 * Generated Leads is "open work, still current" — the same defaults the Cash
 * queue has always had. All Leads and Worked Leads are retrospective, so their
 * resting position is "everything", and a URL that omits `status` on those
 * pages must mean *their* default rather than the queue's.
 *
 * Passing them through rather than hard-coding is what keeps the round trip
 * honest: `searchFromQueueState` omits whatever equals the default, so if the
 * writer and the reader disagreed about what the default is, choosing "Open" on
 * All Leads would write nothing to the URL and read back as "All".
 */
export interface QueueDefaults {
  status: string;
  lifecycle: string;
  /**
   * Where the date range rests when the URL says nothing.
   *
   * `""` on every view but one. Generated Leads rests on the daily window the
   * generator itself uses — today and tomorrow — so the page opens with the
   * dates already chosen rather than asking the agent to reproduce the business
   * rule by hand every morning.
   */
  dateFrom: string;
  dateTo: string;
}

const GLOBAL_DEFAULTS: QueueDefaults = {
  status: DEFAULT_QUEUE_FILTERS.status,
  lifecycle: DEFAULT_QUEUE_FILTERS.lifecycle,
  dateFrom: "",
  dateTo: "",
};

/**
 * A view's resting position, with the global one filling every gap.
 *
 * Exported because the queue component needs the *same* answer the URL reader
 * uses. It did not have it: `LeadQueue` compared the live status against the
 * global default and reset to the global default, so on All Leads and Worked
 * Leads — whose resting status is `"all"` — the Clear button was offered on an
 * untouched page and, pressed, applied `status = "open"` and hid every closed
 * and converted lead. One function, one answer, and the disagreement is gone
 * structurally rather than by two constants being kept equal by hand.
 */
export function queueDefaults(d?: Partial<QueueDefaults>): QueueDefaults {
  return { ...GLOBAL_DEFAULTS, ...d };
}

/**
 * What the Clear button writes: this view's resting position, and nothing else.
 *
 * Pure, and here rather than inside `LeadQueue`, because "clear" and "is
 * anything filtered" are two readings of one rule and the bug was them
 * disagreeing — the button reset `status` to the queue's global `"open"` while
 * the page it was on rested at `"all"`. Kept as one function beside
 * {@link queueFiltersActive}, which compares against the same values, so the
 * button can only be shown when pressing it would change something.
 *
 * Every field the queue filters on appears here, deliberately. A filter added
 * to `QueueState` and forgotten here would survive a Clear, which is the quiet
 * half of the same fault.
 */
export function clearedQueueFilters(defaults: QueueDefaults): Partial<QueueState> {
  return {
    leadType: DEFAULT_QUEUE_FILTERS.leadType,
    status: defaults.status,
    lifecycle: defaults.lifecycle,
    outcome: "all",
    agent: "all",
    branch: "all",
    family: "all",
    followup: "all",
    // Back to the view's resting range, not to "no dates": Generated Leads
    // rests on the daily window, and clearing filters there should return the
    // agent to today's work rather than to every prescription ever imported.
    dateFrom: defaults.dateFrom,
    dateTo: defaults.dateTo,
    term: "",
    mineOnly: false,
    unassignedOnly: false,
    page: 0,
  };
}

/**
 * Has the reader narrowed this view at all?
 *
 * The Clear button's visibility, and the difference between the two empty
 * states ("loosen a filter" versus "nothing has been imported"). Measured
 * against `clearedQueueFilters`, so the answer is exactly "would Clear change
 * anything" — which is what makes the button's disappearance the confirmation
 * that it worked.
 *
 * `page` and `pageSize` are not filters and are excluded: being on page three
 * is not something an agent needs offering a Clear for.
 */
export function queueFiltersActive(state: QueueState, defaults: QueueDefaults): boolean {
  const cleared = clearedQueueFilters(defaults);
  for (const [key, value] of Object.entries(cleared)) {
    if (key === "page") continue;
    const current = state[key as keyof QueueState];
    // The search box is the one field where trailing space is not a filter.
    if (key === "term") {
      if (String(current).trim() !== value) return true;
      continue;
    }
    if (current !== value) return true;
  }
  return false;
}

function oneOf(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function code(value: unknown): string {
  return typeof value === "string" && CODE.test(value.trim()) ? value.trim() : "all";
}

function flag(value: unknown): boolean {
  // `?mine=true` from a link, `mine: true` from a navigate call.
  return value === true || value === "true";
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The route's `validateSearch`.
 *
 * Returns only what differs from the default, so the URL stays short and the
 * router does not consider two equivalent states different.
 */
export function validateQueueSearch(
  s: Record<string, unknown>,
  viewDefaults?: Partial<QueueDefaults>,
): QueueSearch {
  const d = queueDefaults(viewDefaults);
  const out: QueueSearch = {};

  const type = oneOf(s.type, TYPE_VALUES, DEFAULT_QUEUE_FILTERS.leadType);
  if (type !== DEFAULT_QUEUE_FILTERS.leadType) out.type = type;

  const status = oneOf(s.status, STATUS_VALUES, d.status);
  if (status !== d.status) out.status = status;

  const outcome = oneOf(s.outcome, OUTCOME_VALUES, "all");
  if (outcome !== "all") out.outcome = outcome;

  if (typeof s.agent === "string" && UUID.test(s.agent)) out.agent = s.agent.toLowerCase();

  /*
   * The cycle has no default here, so absence is preserved rather than
   * collapsed. "The current cycle" is whichever month was imported last, which
   * only the data knows.
   */
  if (s.cycle === "all") out.cycle = "all";
  else if (typeof s.cycle === "string" && PERIOD.test(s.cycle)) out.cycle = s.cycle;

  const branch = code(s.branch);
  if (branch !== "all") out.branch = branch;

  const family = code(s.family);
  if (family !== "all") out.family = family;

  const followup = oneOf(s.followup, FOLLOWUP_VALUES, DEFAULT_QUEUE_FILTERS.followup);
  if (followup !== DEFAULT_QUEUE_FILTERS.followup) out.followup = followup;

  const lifecycle = oneOf(s.lifecycle, LIFECYCLE_VALUES, d.lifecycle);
  if (lifecycle !== d.lifecycle) out.lifecycle = lifecycle;

  /*
   * Stored whenever the raw value is non-empty, not only when it has non-space
   * content.
   *
   * Dropping a whitespace-only term would make the URL disagree with the input
   * that produced it, and the effect that adopts the URL back into the box
   * would then erase the space the agent had just typed. The database query
   * trims it anyway, so carrying it costs nothing.
   */
  const q = typeof s.q === "string" ? s.q.slice(0, MAX_TERM) : "";
  if (q !== "") out.q = q;

  const dateFrom = businessDate(s.dateFrom);
  const dateTo = businessDate(s.dateTo);
  /*
   * A backwards range is corrected rather than refused.
   *
   * Two date inputs make it trivially reachable — pick the "to" first, then a
   * "from" after it — and an empty queue with two dates on screen looks like a
   * bug in the data rather than a range nobody meant. Swapping shows the rows
   * between the two dates the user actually chose.
   */
  const hasDefaultRange = d.dateFrom !== "" || d.dateTo !== "";
  if (dateFrom && dateTo && dateFrom > dateTo) {
    out.dateFrom = dateTo;
    out.dateTo = dateFrom;
  } else {
    if (dateFrom) out.dateFrom = dateFrom;
    else if (hasDefaultRange && s.dateFrom !== undefined) out.dateFrom = ANY_DATE;
    if (dateTo) out.dateTo = dateTo;
    else if (hasDefaultRange && s.dateTo !== undefined) out.dateTo = ANY_DATE;
  }
  // A range already at the view's resting position writes nothing.
  if (out.dateFrom === d.dateFrom) delete out.dateFrom;
  if (out.dateTo === d.dateTo) delete out.dateTo;

  if (flag(s.mine)) out.mine = true;
  if (flag(s.unassigned)) out.unassigned = true;

  /*
   * One-based in the URL, zero-based in the page.
   *
   * `?page=1` is the first page to anybody who reads it, and the queue's
   * internal index is an implementation detail that should not leak into
   * something a supervisor pastes into a message.
   */
  const page = Number(s.page);
  if (Number.isFinite(page) && page >= 2 && page <= MAX_PAGE) out.page = Math.floor(page);

  const size = Number(s.size);
  if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(size) && size !== DEFAULT_PAGE_SIZE) {
    out.size = size;
  }

  return out;
}

/* ------------------------------------------------------------------------- */
/* Reading and writing                                                       */
/* ------------------------------------------------------------------------- */

/** The search params, expanded into the state the page renders from. */
export function queueStateFromSearch(
  s: QueueSearch,
  viewDefaults?: Partial<QueueDefaults>,
): QueueState {
  const d = queueDefaults(viewDefaults);
  return {
    leadType: s.type ?? DEFAULT_QUEUE_FILTERS.leadType,
    status: s.status ?? d.status,
    outcome: s.outcome ?? "all",
    agent: s.agent ?? "all",
    cycle: s.cycle ?? "",
    branch: s.branch ?? "all",
    family: s.family ?? "all",
    followup: s.followup ?? DEFAULT_QUEUE_FILTERS.followup,
    lifecycle: s.lifecycle ?? d.lifecycle,
    term: s.q ?? "",
    dateFrom: s.dateFrom === ANY_DATE ? "" : (s.dateFrom ?? d.dateFrom),
    dateTo: s.dateTo === ANY_DATE ? "" : (s.dateTo ?? d.dateTo),
    mineOnly: s.mine === true,
    unassignedOnly: s.unassigned === true,
    page: s.page ? s.page - 1 : 0,
    pageSize: s.size ?? DEFAULT_PAGE_SIZE,
  };
}

/**
 * The state, reduced to the search params that differ from the default.
 *
 * The inverse of `queueStateFromSearch`, and a test asserts the round trip:
 * a state that survives one and then the other must come back identical, or
 * returning from a lead would silently drop a filter.
 */
export function searchFromQueueState(
  state: QueueState,
  viewDefaults?: Partial<QueueDefaults>,
): QueueSearch {
  return validateQueueSearch(
    {
      type: state.leadType,
      status: state.status,
      outcome: state.outcome,
      agent: state.agent,
      cycle: state.cycle,
      branch: state.branch,
      family: state.family,
      followup: state.followup,
      lifecycle: state.lifecycle,
      q: state.term,
      // An empty end on a view that has a default range is a deliberate
      // clearing, not an omission; `ANY_DATE` is how that survives the URL.
      dateFrom: state.dateFrom === "" ? ANY_DATE : state.dateFrom,
      dateTo: state.dateTo === "" ? ANY_DATE : state.dateTo,
      mine: state.mineOnly,
      unassigned: state.unassignedOnly,
      page: state.page + 1,
      size: state.pageSize,
    },
    viewDefaults,
  );
}

/** Is this the untouched queue? Used to decide whether a Back link needs to
 *  carry anything at all. */
export function isDefaultQueueSearch(s: QueueSearch): boolean {
  return Object.keys(s).length === 0;
}

/* ------------------------------------------------------------------------- */
/* Carrying the context onto a lead                                          */
/* ------------------------------------------------------------------------- */

/**
 * The queue's state, as one opaque string a lead can hold and hand back.
 *
 * Browser Back already restores the queue, because the filters are in the URL
 * it came from. This is for the lead page's own "Queue" button, which is a
 * `Link` and therefore navigates forward to whatever it is told.
 *
 * It travels as a single `from` parameter so the lead route does not enumerate
 * the queue's filters. The lead page never reads inside it: it takes the string
 * off its own search, passes it to `decodeQueueContext`, and puts the result on
 * a Link. Adding a queue filter tomorrow changes this file and nothing else.
 *
 * JSON rather than a bespoke encoding, and bounded — `decodeQueueContext` runs
 * the result back through `validateQueueSearch`, so a truncated or hand-edited
 * value degrades to the default queue instead of a broken one.
 */
export function encodeQueueContext(s: QueueSearch): string | undefined {
  if (isDefaultQueueSearch(s)) return undefined;
  const json = JSON.stringify(s);
  return json.length <= MAX_CONTEXT ? json : undefined;
}

/** How long a `from` value may be. A dozen short filters and a search term. */
const MAX_CONTEXT = 400;

export function decodeQueueContext(value: unknown): QueueSearch {
  if (typeof value !== "string" || value === "" || value.length > MAX_CONTEXT) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return validateQueueSearch(parsed as Record<string, unknown>);
  } catch {
    // A mangled value is not an error worth showing anybody; it is the default
    // queue, which is where the button would have gone before this existed.
    return {};
  }
}

/**
 * The lead route's `validateSearch`: one opaque parameter, and which desk.
 *
 * `dom` is not part of the context blob, and deliberately so. The blob is the
 * queue's *filters*, which the lead page never reads; the desk is something the
 * lead page has to act on — a Wasfaty lead's Queue button must return to
 * `/crm/wasfaty` — and it has to work in the one case where the lead itself
 * cannot answer the question, which is when the lead has been deleted and there
 * is nothing left to read a `lead_type` from.
 */
export function validateLeadSearch(s: Record<string, unknown>): {
  from?: string;
  dom?: "wasfaty";
} {
  const from = typeof s.from === "string" && s.from.length <= MAX_CONTEXT ? s.from : undefined;
  const dom = s.dom === "wasfaty" ? ("wasfaty" as const) : undefined;
  return { ...(from ? { from } : {}), ...(dom ? { dom } : {}) };
}
