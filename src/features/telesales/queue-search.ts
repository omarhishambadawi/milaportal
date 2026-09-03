import { LEAD_TYPES } from "@/lib/telesales/types";
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
  branch?: string;
  family?: string;
  followup?: string;
  lifecycle?: string;
  /** Free-text search over name, phone, patient id, prescription, invoice. */
  q?: string;
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
  branch: string;
  family: string;
  followup: string;
  lifecycle: string;
  term: string;
  mineOnly: boolean;
  unassignedOnly: boolean;
  page: number;
  pageSize: number;
}

const STATUS_VALUES = STATUS_FILTER_OPTIONS.map((o) => o.value as string);
const FOLLOWUP_VALUES = FOLLOWUP_FILTER_OPTIONS.map((o) => o.value as string);
const LIFECYCLE_VALUES = LIFECYCLE_FILTER_OPTIONS.map((o) => o.value as string);
const TYPE_VALUES: string[] = ["all", ...LEAD_TYPES];

/** Branch and product codes are free-form upstream, so they are bounded rather
 *  than enumerated — the option lists come from the data, not from a constant. */
const CODE = /^[A-Za-z0-9 ._/-]{1,64}$/;
/** The same cap the search input carries. */
const MAX_TERM = 80;
/** A page number no realistic queue reaches; bounds a hand-edited URL. */
const MAX_PAGE = 10_000;

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
export function validateQueueSearch(s: Record<string, unknown>): QueueSearch {
  const out: QueueSearch = {};

  const type = oneOf(s.type, TYPE_VALUES, DEFAULT_QUEUE_FILTERS.leadType);
  if (type !== DEFAULT_QUEUE_FILTERS.leadType) out.type = type;

  const status = oneOf(s.status, STATUS_VALUES, DEFAULT_QUEUE_FILTERS.status);
  if (status !== DEFAULT_QUEUE_FILTERS.status) out.status = status;

  const branch = code(s.branch);
  if (branch !== "all") out.branch = branch;

  const family = code(s.family);
  if (family !== "all") out.family = family;

  const followup = oneOf(s.followup, FOLLOWUP_VALUES, DEFAULT_QUEUE_FILTERS.followup);
  if (followup !== DEFAULT_QUEUE_FILTERS.followup) out.followup = followup;

  const lifecycle = oneOf(s.lifecycle, LIFECYCLE_VALUES, DEFAULT_QUEUE_FILTERS.lifecycle);
  if (lifecycle !== DEFAULT_QUEUE_FILTERS.lifecycle) out.lifecycle = lifecycle;

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
export function queueStateFromSearch(s: QueueSearch): QueueState {
  return {
    leadType: s.type ?? DEFAULT_QUEUE_FILTERS.leadType,
    status: s.status ?? DEFAULT_QUEUE_FILTERS.status,
    branch: s.branch ?? "all",
    family: s.family ?? "all",
    followup: s.followup ?? DEFAULT_QUEUE_FILTERS.followup,
    lifecycle: s.lifecycle ?? DEFAULT_QUEUE_FILTERS.lifecycle,
    term: s.q ?? "",
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
export function searchFromQueueState(state: QueueState): QueueSearch {
  return validateQueueSearch({
    type: state.leadType,
    status: state.status,
    branch: state.branch,
    family: state.family,
    followup: state.followup,
    lifecycle: state.lifecycle,
    q: state.term,
    mine: state.mineOnly,
    unassigned: state.unassignedOnly,
    page: state.page + 1,
    size: state.pageSize,
  });
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

/** How long a `from` value may be. Nine short filters and a search term. */
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

/** The lead route's `validateSearch`: one opaque parameter, bounded. */
export function validateLeadSearch(s: Record<string, unknown>): { from?: string } {
  const from = typeof s.from === "string" && s.from.length <= MAX_CONTEXT ? s.from : undefined;
  return from ? { from } : {};
}
