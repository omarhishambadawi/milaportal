/**
 * AlShrouq dispatch history, derived from the row that records it.
 *
 * Pure: no React, no network, no clock of its own beyond what a caller passes.
 * It takes the persisted `alshrouq_dispatches` columns and returns the events an
 * agent should see, in the order they happened.
 *
 * ## Why derivation rather than a second event log
 *
 * Every event here is a *timestamp that exists in the database*. `scheduled_at`
 * is written when an agent approves; `last_attempt_at` when a worker claims the
 * row; `dispatched_at` when the send completed; `cancelled_at` when it was
 * called off. Reading them back is reporting, not invention.
 *
 * Writing a parallel `order_activity` row at each step was the alternative, and
 * it was rejected for one reason: the worker's guarantee is that the only table
 * it touches is `alshrouq_dispatches` — asserted by a test, and the reason a
 * Portal edit cannot reach a courier. Giving the worker a second table to write
 * would trade that guarantee for events it can already be asked for.
 *
 * So there is no second timeline system. `OrderActivityTimeline` remains the one
 * timeline; this module hands it entries built from facts it did not have.
 *
 * ## What is never derived
 *
 * A tracking URL. It is shown when the reconciliation read persisted one and is
 * otherwise absent — no format is assumed, nothing is assembled from a
 * reference, and a missing one produces no button. The same applies to the
 * external reference: `external_order_id` comes from the GET or it is not shown.
 *
 * ## Failure text
 *
 * `last_error` is written only by this codebase, from a fixed set of sentences.
 * It is still passed through `safeFailureReason` before display, because a
 * column that reaches an operations screen should not be one upstream text could
 * later flow into unchecked.
 */

import { formatScheduledFor } from "./scheduling";
import { blocksNewDispatch } from "@/lib/shams-crm/alshrouq-dispatch-state";
import { canResolveDispatch } from "@/lib/shams-crm/alshrouq-resolution";

/**
 * The persisted columns this module reads. Exactly the shape the client query
 * selects — nothing here is computed by a caller and handed in as though it
 * were stored.
 */
export interface AlShrouqDispatchRow {
  /** `scheduled | processing | accepted | failed | indeterminate | cancelled`. */
  dispatch_status: string | null;
  /** When the courier is due to be called. Set only while a dispatch is parked. */
  scheduled_for: string | null;
  /** When the agent approved it. The scheduled event's own timestamp. */
  scheduled_at: string | null;
  /** When a worker claimed the row. The only evidence that processing began. */
  last_attempt_at: string | null;
  dispatched_at: string | null;
  cancelled_at: string | null;
  external_order_id: string | null;
  tracking_url: string | null;
  /**
   * When the reconciliation read ran — and so when a tracking URL, if there is
   * one, became known. The tracking event's own timestamp; there is no separate
   * "tracking became available" column, and this is the honest stand-in because
   * it is the moment the record carrying the URL was read.
   */
  refreshed_at: string | null;
  last_error: string | null;
  /**
   * What an operator established about a stuck dispatch — `delivered`,
   * `not_delivered` or `undetermined`, or null while it is still unsettled.
   *
   * Never a lifecycle value. `dispatch_status` keeps recording what the machine
   * observed and `status` keeps the courier's own word; this is the third,
   * separate thing, and the card must never present it as either of the others.
   */
  resolution_outcome: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  /** The courier's own status word, stored verbatim and never translated. */
  status: string | null;
}

export type AlShrouqTimelineKind =
  | "scheduled"
  | "started"
  | "accepted"
  | "tracking"
  | "failed"
  | "indeterminate"
  | "cancelled";

export interface AlShrouqTimelineEvent {
  kind: AlShrouqTimelineKind;
  /** Corporate wording. No "POST", "worker", "payload" or "cron". */
  title: string;
  detail: string | null;
  /** ISO instant this event happened. Never null — an event with no persisted
   *  time is not emitted at all. */
  at: string;
  /** Only ever the persisted reference. */
  externalOrderId: string | null;
  /** Only ever the persisted URL, and only when it is a safe absolute one. */
  trackingUrl: string | null;
  tone: "info" | "success" | "warning" | "danger";
}

/** The lifecycle value that means "still waiting for its time". */
const WAITING = "scheduled";

/**
 * A tracking URL fit to put behind a link.
 *
 * The column is populated from the CRM's reconciliation record, which is
 * upstream text. `http`/`https` only, so no `javascript:` or `data:` value can
 * reach an anchor, and absolute only, so nothing can be read as a Portal route.
 * A URL that fails this is treated as no URL rather than rewritten.
 */
export function safeTrackingUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A failure reason an agent may read.
 *
 * Drops anything that looks like a credential, a URL, a header or a stack trace
 * rather than trying to redact it in place, and caps the length. The fallback is
 * deliberately unhelpful about internals and honest about the outcome.
 */
export function safeFailureReason(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A stack trace, a URL, a header line or a token-shaped string is not
  // operations copy, whatever else it might be.
  if (
    /https?:\/\/|\bat\s+\/|\.[jt]sx?:\d|authorization|bearer\s|x-[a-z-]*(token|secret|key)|session[_-]?token/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

/** The external reference, when one was actually persisted. */
function reference(row: AlShrouqDispatchRow): string | null {
  const value = row.external_order_id;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function iso(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * The dispatch history for one order.
 *
 * Ascending by time, so a caller can merge it with the order's own activity and
 * sort the combined list however it renders. Returns `[]` for an order with no
 * dispatch row — a new order has no AlShrouq history, and inventing a "not
 * scheduled" event would be history it does not have.
 */
export function buildAlShrouqTimeline(
  row: AlShrouqDispatchRow | null | undefined,
): AlShrouqTimelineEvent[] {
  if (!row) return [];

  const events: AlShrouqTimelineEvent[] = [];
  const status = row.dispatch_status ?? null;
  const ref = reference(row);
  const tracking = safeTrackingUrl(row.tracking_url);

  /* 1. Approved and parked. -------------------------------------------------
     `scheduled_at` is written by the same insert that writes the snapshot, so
     its presence *is* the fact that someone approved a scheduled delivery. A
     row without it was never scheduled — an immediate dispatch, or one of the
     four that predate scheduling entirely. */
  const scheduledAt = iso(row.scheduled_at);
  if (scheduledAt) {
    const due = formatScheduledFor(row.scheduled_for);
    events.push({
      kind: "scheduled",
      title: "AlShrouq delivery scheduled",
      // The countdown is added by the renderer, which owns the clock. This line
      // is the fixed part: the instant that was approved.
      detail: due ? `Delivery due ${due}` : null,
      at: scheduledAt,
      externalOrderId: null,
      trackingUrl: null,
      tone: "info",
    });
  }

  /* 2. A worker took the row. -----------------------------------------------
     `last_attempt_at` is set by the claim and by nothing else, so it is the one
     honest answer to "did processing start". An immediate dispatch never has
     one, and correctly shows no such event. */
  const startedAt = iso(row.last_attempt_at);
  if (startedAt) {
    events.push({
      kind: "started",
      title: "AlShrouq dispatch initiated",
      detail: "Submitted to AlShrouq",
      at: startedAt,
      externalOrderId: null,
      trackingUrl: null,
      tone: "info",
    });
  }

  /* 3. The terminal outcome. ------------------------------------------------ */
  const cancelledAt = iso(row.cancelled_at);
  if (cancelledAt) {
    events.push({
      kind: "cancelled",
      title: "AlShrouq delivery cancelled",
      detail: "Cancelled before dispatch",
      at: cancelledAt,
      externalOrderId: ref,
      trackingUrl: null,
      tone: "warning",
    });
    return events.sort(byTime);
  }

  if (status === "accepted") {
    const at = iso(row.dispatched_at);
    if (at) {
      const parts: string[] = [];
      // The reference AlShrouq knows this delivery by — a user-facing number an
      // agent can quote on the phone, not an internal id.
      if (ref) parts.push(`Reference: ${ref}`);
      // The courier's own word for where the delivery is, when it reported one.
      if (row.status && row.status.trim() !== "") parts.push(row.status.trim());
      events.push({
        kind: "accepted",
        title: "Accepted by AlShrouq",
        detail: parts.length > 0 ? parts.join(" · ") : null,
        at,
        externalOrderId: ref,
        // The link lives on the tracking event below, so one destination is
        // offered once rather than twice in a row.
        trackingUrl: null,
        tone: "success",
      });

      /* Tracking became available. -----------------------------------------
         Its own step because it is its own fact: a delivery can be accepted
         with no tracking page at all, and pretending otherwise would put a
         dead link on the timeline. `refreshed_at` is when the reconciliation
         record carrying the URL was read, which is the moment it became
         known; a row that somehow has the URL without that timestamp is
         anchored to the send instead of being dropped. */
      if (tracking) {
        events.push({
          kind: "tracking",
          title: "Tracking available",
          detail: null,
          at: iso(row.refreshed_at) ?? at,
          externalOrderId: ref,
          trackingUrl: tracking,
          tone: "success",
        });
      }
    }
  } else if (status === "failed") {
    const at = iso(row.last_attempt_at) ?? iso(row.dispatched_at);
    if (at) {
      events.push({
        kind: "failed",
        title: "AlShrouq dispatch failed",
        detail:
          safeFailureReason(row.last_error) ??
          "The delivery request was rejected. Nothing was sent.",
        at,
        externalOrderId: null,
        trackingUrl: null,
        tone: "danger",
      });
    }
  } else if (status === "indeterminate") {
    const at = iso(row.last_attempt_at) ?? iso(row.dispatched_at);
    if (at) {
      const reason = safeFailureReason(row.last_error);
      events.push({
        kind: "indeterminate",
        title: "Delivery status unavailable",
        /* Never collapsed into "failed". A failure is AlShrouq saying no; this
           is nobody knowing, which is a different instruction to the person
           reading it — and the sentence they must not miss is the second one. */
        /* Never collapsed into "failed", and never softened. The first sentence
           is what is known; the second is the one an agent must not miss,
           because reading this as a failure is what makes someone send it
           again. `reason` is the persisted, sanitised text when there is one. */
        detail: `AlShrouq response could not be confirmed. The order has not been automatically retried.${
          reason ? ` (${reason})` : ""
        }`,
        at,
        externalOrderId: ref,
        trackingUrl: null,
        tone: "danger",
      });
    }
  }

  return events.sort(byTime);
}

function byTime(a: AlShrouqTimelineEvent, b: AlShrouqTimelineEvent): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/**
 * How the dispatch stands right now, for a card that summarises rather than
 * narrates. Derived from the same row, so the two cannot disagree.
 */
export interface AlShrouqDispatchSummary {
  /** The persisted lifecycle value, or null when nothing has been approved. */
  status: string | null;
  /** Short, corporate, and never a claim the row does not support. */
  label: string;
  tone: "muted" | "info" | "success" | "warning" | "danger";
  /**
   * True once a dispatch exists in any state that is not cancelled — which is
   * exactly `blocksNewDispatch`, the same rule the service's duplicate check and
   * the unique index enforce. The card renders no send control while it is true,
   * so the screen and the server refuse on one rule rather than two.
   */
  handedOver: boolean;
  /** True only while the row is parked and waiting for its time. */
  awaitingSchedule: boolean;
  externalOrderId: string | null;
  trackingUrl: string | null;
  scheduledFor: string | null;
  /** The persisted failure text, sanitised. Null unless the dispatch failed. */
  failureReason: string | null;
  /** The operator's answer, when one has been recorded. */
  resolutionOutcome: string | null;
  /** True while the dispatch is stuck and nobody has settled it yet. */
  awaitingResolution: boolean;
  /**
   * AlShrouq's own word for where the delivery is, verbatim. Context beside the
   * label, never the label itself — see the `accepted` case.
   */
  courierStatus: string | null;
}

/**
 * Summarise the dispatch row.
 *
 * `handedOver` is the flag the UI uses to decide there is nothing left to
 * approve. It is true for `indeterminate` as well as `accepted`, deliberately:
 * an unconfirmed send is the case where a second attempt does the most damage.
 */
export function summariseAlShrouqDispatch(
  row: AlShrouqDispatchRow | null | undefined,
): AlShrouqDispatchSummary {
  const empty: AlShrouqDispatchSummary = {
    status: null,
    label: "Not scheduled",
    tone: "muted",
    handedOver: false,
    awaitingSchedule: false,
    externalOrderId: null,
    trackingUrl: null,
    scheduledFor: null,
    failureReason: null,
    courierStatus: null,
    resolutionOutcome: null,
    awaitingResolution: false,
  };
  if (!row) return empty;

  const status = row.dispatch_status ?? null;
  const base = {
    status,
    externalOrderId: reference(row),
    trackingUrl: safeTrackingUrl(row.tracking_url),
    scheduledFor: iso(row.scheduled_for),
    // Only meaningful for a failure; carried on every state so the card reads
    // one shape rather than branching on which fields exist.
    failureReason: status === "failed" ? safeFailureReason(row.last_error) : null,
    courierStatus: row.status?.trim() || null,
    resolutionOutcome: row.resolution_outcome?.trim() || null,
    // The operator's worklist condition, asked through the state contract so the
    // card and the server cannot disagree about what is resolvable.
    awaitingResolution: canResolveDispatch(status, row.resolution_outcome),
  };

  if (row.cancelled_at) {
    return {
      ...empty,
      ...base,
      label: "Scheduled delivery cancelled",
      tone: "warning",
      trackingUrl: null,
    };
  }

  // One rule, asked once. Every branch below reports it rather than deciding it.
  const handedOver = blocksNewDispatch(status);

  switch (status) {
    case WAITING:
      return {
        ...base,
        label: "Scheduled",
        tone: "info",
        handedOver,
        awaitingSchedule: true,
      };
    case "processing":
      return {
        ...base,
        // A claim, said as an action in progress rather than as an outcome.
        label: "Sending to AlShrouq",
        tone: "info",
        handedOver,
        awaitingSchedule: false,
      };
    case "accepted":
      return {
        ...base,
        /*
         * One heading for the state, not the courier's vocabulary.
         *
         * This used to show `row.status` — AlShrouq's own word, e.g. "Order
         * Created" — as the badge. It is more specific but it is not a status
         * *this* system defines, and a courier word an agent has never seen
         * reads as a fault. The verbatim value is still shown, on the timeline
         * event beside the reference, where it is context rather than a label.
         */
        label: "Accepted by AlShrouq",
        tone: "success",
        handedOver,
        awaitingSchedule: false,
      };
    case "failed":
      return {
        ...base,
        label: "Dispatch failed",
        tone: "danger",
        handedOver,
        awaitingSchedule: false,
      };
    case "indeterminate":
      return {
        ...base,
        // Not "failed", and not a word that sounds like an internal queue.
        label: "Delivery status unavailable",
        tone: "danger",
        handedOver,
        awaitingSchedule: false,
      };
    default:
      /*
       * A status this build does not recognise — a value added to the database
       * ahead of the client, or a row written by something newer.
       *
       * It is reported as handed over, because `blocksNewDispatch` treats an
       * unknown state as owning the slot and the UI must agree: offering "Send
       * to AlShrouq" beside a dispatch nobody here can interpret is precisely
       * how a second courier gets ordered. The label stays vague rather than
       * guessing what the state means.
       */
      return { ...empty, ...base, label: "Dispatch recorded", handedOver };
  }
}
