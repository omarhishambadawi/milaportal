/**
 * The dispatch timeline: what an agent is told about a courier handoff, and
 * what the Portal refuses to claim.
 *
 * Every event asserted here is derived from a *persisted column*. The point of
 * the suite is the negative space around that: no event without a stored
 * timestamp, no reference without a stored reference, no tracking URL that was
 * not returned by reconciliation, and — the one that matters most — "failed" and
 * "requires review" never collapsed into each other.
 *
 * Nothing renders. The module under test is pure, so the behaviour that matters
 * is a function of a row.
 */

import { describe, expect, it } from "vitest";
import {
  buildAlShrouqTimeline,
  safeFailureReason,
  safeTrackingUrl,
  summariseAlShrouqDispatch,
  type AlShrouqDispatchRow,
} from "../dispatch-timeline";
import { scheduledCountdownAt } from "../use-scheduled-countdown";

const APPROVED_AT = "2026-08-21T09:00:00.000Z";
const DUE_AT = "2026-08-21T12:30:00.000Z";
const CLAIMED_AT = "2026-08-21T12:30:04.000Z";
const SENT_AT = "2026-08-21T12:30:06.000Z";

/** A row with nothing in it — every column a fresh order would have. */
function row(over: Partial<AlShrouqDispatchRow> = {}): AlShrouqDispatchRow {
  return {
    dispatch_status: null,
    scheduled_for: null,
    scheduled_at: null,
    last_attempt_at: null,
    dispatched_at: null,
    cancelled_at: null,
    external_order_id: null,
    tracking_url: null,
    refreshed_at: null,
    last_error: null,
    status: null,
    resolution_outcome: null,
    resolved_at: null,
    resolution_note: null,
    ...over,
  };
}

/** The four rows the lifecycle actually produces, named once. */
const scheduledRow = row({
  dispatch_status: "scheduled",
  scheduled_at: APPROVED_AT,
  scheduled_for: DUE_AT,
});
const processingRow = row({
  dispatch_status: "processing",
  scheduled_at: APPROVED_AT,
  scheduled_for: DUE_AT,
  last_attempt_at: CLAIMED_AT,
});
const acceptedRow = row({
  dispatch_status: "accepted",
  scheduled_at: APPROVED_AT,
  scheduled_for: DUE_AT,
  last_attempt_at: CLAIMED_AT,
  dispatched_at: SENT_AT,
  external_order_id: "6099196",
  status: "Order Created",
});

const titles = (r: AlShrouqDispatchRow) => buildAlShrouqTimeline(r).map((e) => e.title);
const kinds = (r: AlShrouqDispatchRow) => buildAlShrouqTimeline(r).map((e) => e.kind);

describe("an order with no dispatch", () => {
  /**
   * The Store Pickup case, and every order that predates AlShrouq. The timeline
   * is exactly what it always was, because there is nothing to add to it.
   */
  it("contributes no events at all", () => {
    expect(buildAlShrouqTimeline(null)).toEqual([]);
    expect(buildAlShrouqTimeline(undefined)).toEqual([]);
    expect(buildAlShrouqTimeline(row())).toEqual([]);
  });

  it("summarises as nothing scheduled, and as something that may still be sent", () => {
    const s = summariseAlShrouqDispatch(null);
    expect(s.handedOver).toBe(false);
    expect(s.status).toBeNull();
    expect(s.externalOrderId).toBeNull();
    expect(s.trackingUrl).toBeNull();
  });
});

describe("scheduled", () => {
  it("renders from the persisted scheduled state, and from nothing else", () => {
    const events = buildAlShrouqTimeline(scheduledRow);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("scheduled");
    expect(events[0].title).toBe("AlShrouq delivery scheduled");
    // The event's own instant is when it was approved, not when it is due.
    expect(events[0].at).toBe(APPROVED_AT);
    // And the due time is named, so "scheduled" is never a bare adjective.
    expect(events[0].detail).toContain("2026");
  });

  /**
   * A row that says `scheduled` but carries no `scheduled_at` is not narrated.
   * The database's own CHECK requires `scheduled_for` on a scheduled row, and
   * `scheduleAlShrouqDispatch` writes both — so this only happens to data that
   * predates the feature, and inventing a timestamp for it would be fiction.
   */
  it("emits nothing without a persisted approval timestamp", () => {
    expect(
      buildAlShrouqTimeline(row({ dispatch_status: "scheduled", scheduled_for: DUE_AT })),
    ).toEqual([]);
  });

  it("claims no reference and no tracking while nothing has been sent", () => {
    const [event] = buildAlShrouqTimeline(scheduledRow);
    expect(event.externalOrderId).toBeNull();
    expect(event.trackingUrl).toBeNull();
  });

  it("summarises as scheduled and still waiting", () => {
    const s = summariseAlShrouqDispatch(scheduledRow);
    expect(s.label).toBe("Scheduled");
    expect(s.awaitingSchedule).toBe(true);
    // Already spoken for: a scheduled order must not offer a second send.
    expect(s.handedOver).toBe(true);
    expect(s.scheduledFor).toBe(DUE_AT);
    // Nothing is wrong, so nothing is claimed to be.
    expect(s.waitingProblem).toBeNull();
  });

  /**
   * The gap that let a dead scheduler look like a live one.
   *
   * A delivery past its time showed a countdown reading zero and nothing else,
   * for as long as it took anyone to notice — while the row said, in a column
   * no screen read, exactly why nothing had happened.
   */
  it("reports why a waiting delivery has not gone out, when the row says", () => {
    const s = summariseAlShrouqDispatch(
      row({
        dispatch_status: "scheduled",
        scheduled_for: DUE_AT,
        last_error:
          "The delivery scheduler is not connected on this deployment, so " +
          "nothing has been sent yet. An administrator needs to complete the setup.",
      }),
    );
    expect(s.waitingProblem).toMatch(/not connected on this deployment/);
    // Still scheduled, and still not a failure: the dispatch is intact.
    expect(s.label).toBe("Scheduled");
    expect(s.failureReason).toBeNull();
  });

  /** A finished dispatch's own failure text never leaks into the waiting slot. */
  it("keeps a failure reason out of the waiting slot", () => {
    const s = summariseAlShrouqDispatch(
      row({ dispatch_status: "failed", last_error: "AlShrouq refused the order (422)." }),
    );
    expect(s.waitingProblem).toBeNull();
    expect(s.failureReason).toBe("AlShrouq refused the order (422).");
  });
});

describe("the countdown beside a scheduled event", () => {
  /**
   * The countdown is a function of the *persisted* `scheduled_for` and nothing
   * else — no local state, no remembered start, no value carried from the
   * dialog. Two devices reconstruct the same figure from the same row.
   */
  it("counts down to scheduled_for, from the row alone", () => {
    const summary = summariseAlShrouqDispatch(scheduledRow);
    const c = scheduledCountdownAt(
      summary.scheduledFor,
      scheduledRow.dispatch_status,
      Date.parse(DUE_AT) - 2 * 60 * 60_000 - 3 * 60_000,
    );
    expect(c.state).toBe("waiting");
    expect(c.remainingLabel).toBe("2 hours 3 minutes");
  });

  it("stops the moment the row leaves scheduled, however the clock stands", () => {
    // A worker has claimed it. A number still ticking down beside an order
    // already on its way would be a lie.
    const c = scheduledCountdownAt(DUE_AT, "processing", Date.parse(DUE_AT) - 60_000);
    expect(c.state).toBe("inactive");
    expect(c.remainingMs).toBeNull();
  });

  /**
   * Crossing zero changes a label and nothing else.
   *
   * The dispatch is performed by pg_cron → the worker → the safety gate. A
   * countdown that fired the request would mean two open tabs sending two
   * couriers and a closed one sending none.
   */
  it("cannot dispatch: it returns a plain value with nothing callable on it", () => {
    const before = scheduledCountdownAt(DUE_AT, "scheduled", Date.parse(DUE_AT) - 1000);
    const after = scheduledCountdownAt(DUE_AT, "scheduled", Date.parse(DUE_AT) + 1000);
    expect(before.state).toBe("waiting");
    expect(after.state).toBe("due");
    expect(after.remainingMs).toBe(0);
    for (const value of Object.values(after)) {
      expect(typeof value).not.toBe("function");
    }
  });
});

describe("dispatch started", () => {
  it("renders from the claim timestamp", () => {
    const events = buildAlShrouqTimeline(processingRow);
    expect(kinds(processingRow)).toEqual(["scheduled", "started"]);
    const started = events[1];
    expect(started.title).toBe("AlShrouq dispatch initiated");
    // Named as a submission, not as an outcome: the claim says a request went,
    // never that anybody accepted it.
    expect(started.detail).toBe("Submitted to AlShrouq");
    expect(started.at).toBe(CLAIMED_AT);
  });

  it("is absent from an immediate dispatch, which was never claimed", () => {
    const immediate = row({ dispatch_status: "accepted", dispatched_at: SENT_AT });
    expect(kinds(immediate)).toEqual(["accepted"]);
  });

  /** `processing` is a claim, not a report. It must not read as delivered. */
  it("claims no outcome", () => {
    const events = buildAlShrouqTimeline(processingRow);
    expect(events.some((e) => e.kind === "accepted")).toBe(false);
    expect(summariseAlShrouqDispatch(processingRow).label).toBe("Sending to AlShrouq");
  });
});

describe("accepted", () => {
  it("renders the full sequence, ending with the send", () => {
    expect(kinds(acceptedRow)).toEqual(["scheduled", "started", "accepted"]);
    const accepted = buildAlShrouqTimeline(acceptedRow)[2];
    expect(accepted.title).toBe("Accepted by AlShrouq");
    expect(accepted.at).toBe(SENT_AT);
    expect(accepted.tone).toBe("success");
  });

  it("orders the events by when they happened", () => {
    const times = buildAlShrouqTimeline(acceptedRow).map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  /**
   * The courier's own word is context, not the heading.
   *
   * The badge used to read "Order Created" — AlShrouq's vocabulary, which an
   * agent has never seen and which reads as a fault. The state now has one name
   * this system defines, and the verbatim value keeps its place on the event
   * beside the reference.
   */
  it("keeps the courier's own status word as detail, not as the label", () => {
    expect(buildAlShrouqTimeline(acceptedRow)[2].detail).toContain("Order Created");
    expect(summariseAlShrouqDispatch(acceptedRow).label).toBe("Accepted by AlShrouq");
    expect(summariseAlShrouqDispatch(acceptedRow).courierStatus).toBe("Order Created");
  });
});

describe("the external reference", () => {
  it("is shown when it was persisted", () => {
    expect(buildAlShrouqTimeline(acceptedRow)[2].externalOrderId).toBe("6099196");
    expect(summariseAlShrouqDispatch(acceptedRow).externalOrderId).toBe("6099196");
  });

  /**
   * A 2xx says the delivery exists; the GET says what it is called. When
   * reconciliation found nothing there is no name, and none is invented from the
   * order number, the client id or anything else.
   */
  it("is absent when reconciliation persisted none", () => {
    const noRef = row({ dispatch_status: "accepted", dispatched_at: SENT_AT });
    expect(buildAlShrouqTimeline(noRef)[0].externalOrderId).toBeNull();
    expect(summariseAlShrouqDispatch(noRef).externalOrderId).toBeNull();
  });

  it("treats an empty string as no reference rather than as one", () => {
    const blank = row({
      dispatch_status: "accepted",
      dispatched_at: SENT_AT,
      external_order_id: "  ",
    });
    expect(buildAlShrouqTimeline(blank)[0].externalOrderId).toBeNull();
  });
});

describe("the tracking URL", () => {
  const tracked = row({
    dispatch_status: "accepted",
    dispatched_at: SENT_AT,
    external_order_id: "6099196",
    tracking_url: "https://track.example.com/o/6099196",
  });

  it("is shown on its own event when the reconciliation persisted one", () => {
    const events = buildAlShrouqTimeline(tracked);
    // Its own step, because a delivery can be accepted with no tracking page.
    expect(events.map((e) => e.kind)).toEqual(["accepted", "tracking"]);
    const trackingEvent = events[1];
    expect(trackingEvent.title).toBe("Tracking available");
    expect(trackingEvent.trackingUrl).toBe("https://track.example.com/o/6099196");
    // Offered once, not twice in a row.
    expect(events[0].trackingUrl).toBeNull();
    expect(summariseAlShrouqDispatch(tracked).trackingUrl).toBe(
      "https://track.example.com/o/6099196",
    );
  });

  /** Anchored to when the record carrying it was read, never to "now". */
  it("takes its timestamp from the reconciliation read", () => {
    const events = buildAlShrouqTimeline({ ...tracked, refreshed_at: "2026-08-21T12:31:00.000Z" });
    expect(events.find((e) => e.kind === "tracking")!.at).toBe("2026-08-21T12:31:00.000Z");
  });

  /** No tracking URL, no tracking event. The lifecycle simply ends earlier. */
  it("produces no tracking event when none was persisted", () => {
    const events = buildAlShrouqTimeline({ ...tracked, tracking_url: null });
    expect(events.some((e) => e.kind === "tracking")).toBe(false);
  });

  /**
   * The whole point of the column. No format is assumed and nothing is built
   * from the reference — a courier's tracking destination is theirs to publish,
   * and a guessed URL is a link to somewhere nobody verified.
   */
  it("is never fabricated from a reference that has no URL beside it", () => {
    const refOnly = row({
      dispatch_status: "accepted",
      dispatched_at: SENT_AT,
      external_order_id: "6099196",
    });
    const [event] = buildAlShrouqTimeline(refOnly);
    // The reference survives; the link does not appear.
    expect(event.externalOrderId).toBe("6099196");
    expect(event.trackingUrl).toBeNull();
    expect(summariseAlShrouqDispatch(refOnly).trackingUrl).toBeNull();
  });

  it("refuses a URL that is not safe to put behind an anchor", () => {
    // The column is populated from upstream text, so the scheme is checked
    // rather than trusted.
    expect(safeTrackingUrl("javascript:alert(1)")).toBeNull();
    expect(safeTrackingUrl("data:text/html,<script>")).toBeNull();
    expect(safeTrackingUrl("/orders/../admin")).toBeNull();
    expect(safeTrackingUrl("")).toBeNull();
    expect(safeTrackingUrl(null)).toBeNull();
    expect(safeTrackingUrl("https://track.example.com/x")).toBe("https://track.example.com/x");
  });

  it("carries no tracking on a scheduled or failed row", () => {
    expect(buildAlShrouqTimeline(scheduledRow).every((e) => e.trackingUrl === null)).toBe(true);
    const failed = row({
      dispatch_status: "failed",
      last_attempt_at: CLAIMED_AT,
      tracking_url: "https://track.example.com/x",
    });
    expect(buildAlShrouqTimeline(failed).every((e) => e.trackingUrl === null)).toBe(true);
  });
});

describe("failed", () => {
  const failed = row({
    dispatch_status: "failed",
    scheduled_at: APPROVED_AT,
    scheduled_for: DUE_AT,
    last_attempt_at: CLAIMED_AT,
    last_error: "AlShrouq refused the order (422).",
  });

  it("renders as a refusal, with the stored reason", () => {
    const events = buildAlShrouqTimeline(failed);
    const event = events[events.length - 1];
    expect(event.kind).toBe("failed");
    expect(event.title).toBe("AlShrouq dispatch failed");
    expect(event.detail).toBe("AlShrouq refused the order (422).");
    expect(event.tone).toBe("danger");
    expect(event.at).toBe(CLAIMED_AT);
  });

  it("says something honest when no reason was stored", () => {
    const bare = row({ dispatch_status: "failed", last_attempt_at: CLAIMED_AT });
    expect(buildAlShrouqTimeline(bare).at(-1)!.detail).toContain("Nothing was sent");
  });

  it("claims no reference and no tracking", () => {
    const event = buildAlShrouqTimeline(failed).at(-1)!;
    expect(event.externalOrderId).toBeNull();
    expect(event.trackingUrl).toBeNull();
  });
});

describe("indeterminate", () => {
  const unknown = row({
    dispatch_status: "indeterminate",
    scheduled_at: APPROVED_AT,
    scheduled_for: DUE_AT,
    last_attempt_at: CLAIMED_AT,
    last_error: "The CRM did not respond in time. Whether the delivery was created is unknown.",
  });

  it("renders as review required, not as a failure", () => {
    const event = buildAlShrouqTimeline(unknown).at(-1)!;
    expect(event.kind).toBe("indeterminate");
    expect(event.title).toBe("Delivery status unavailable");
    expect(event.at).toBe(CLAIMED_AT);
  });

  /**
   * The distinction the whole error model exists for.
   *
   * "Failed" is AlShrouq saying no, and it is safe to try again. This is nobody
   * knowing, and it is not. An agent who reads one as the other sends a second
   * driver to a customer's door.
   */
  it("is never worded as a failure", () => {
    const event = buildAlShrouqTimeline(unknown).at(-1)!;
    expect(event.title).not.toContain("failed");
    expect(event.detail).not.toMatch(/\bfailed\b/i);
    expect(event.detail).not.toMatch(/\brejected\b/i);
  });

  /** And never as a success. No evidence, no claim. */
  it("is never worded as a delivery that was sent", () => {
    const events = buildAlShrouqTimeline(unknown);
    expect(events.some((e) => e.kind === "accepted")).toBe(false);
    expect(events.some((e) => e.title === "Order sent to AlShrouq")).toBe(false);
  });

  /**
   * The sentence that must not go missing. Nothing retries an indeterminate
   * result — not the worker, not the page — and the person reading it is the one
   * who has to know that.
   */
  it("states that it was not retried automatically", () => {
    const event = buildAlShrouqTimeline(unknown).at(-1)!;
    expect(event.detail).toMatch(/has not been automatically retried/i);
    expect(event.detail).toContain("could not be confirmed");
    // The persisted reason is kept alongside it, not instead of it.
    expect(event.detail).toContain("did not respond in time");
  });

  it("summarises as requiring review, and as already spoken for", () => {
    const s = summariseAlShrouqDispatch(unknown);
    expect(s.label).toBe("Delivery status unavailable");
    // The critical flag: an unconfirmed send is exactly where a second attempt
    // does the most damage, so the UI must treat it as handed over.
    expect(s.handedOver).toBe(true);
  });
});

describe("cancelled", () => {
  const cancelled = row({
    dispatch_status: "cancelled",
    scheduled_at: APPROVED_AT,
    scheduled_for: DUE_AT,
    cancelled_at: "2026-08-21T11:00:00.000Z",
    external_order_id: "6099196",
    tracking_url: "https://track.example.com/o/6099196",
  });

  it("renders as a cancellation and ends the story there", () => {
    const events = buildAlShrouqTimeline(cancelled);
    const event = events.at(-1)!;
    expect(event.kind).toBe("cancelled");
    expect(event.title).toBe("AlShrouq delivery cancelled");
    expect(event.at).toBe("2026-08-21T11:00:00.000Z");
    // The scheduled event that preceded it is still history.
    expect(titles(cancelled)).toContain("AlShrouq delivery scheduled");
  });

  it("offers no tracking for a delivery that is not happening", () => {
    expect(buildAlShrouqTimeline(cancelled).at(-1)!.trackingUrl).toBeNull();
    expect(summariseAlShrouqDispatch(cancelled).trackingUrl).toBeNull();
  });

  /** A cancelled row frees the unique index's slot, so a resend is legitimate. */
  it("leaves the order sendable again", () => {
    const s = summariseAlShrouqDispatch(cancelled);
    expect(s.label).toBe("Scheduled delivery cancelled");
    expect(s.handedOver).toBe(false);
  });
});

describe("failure text never carries internals", () => {
  it("keeps the sentences this codebase actually writes", () => {
    expect(safeFailureReason("AlShrouq refused the order (400).")).toBe(
      "AlShrouq refused the order (400).",
    );
    expect(safeFailureReason("The approved dispatch details are missing.")).toBe(
      "The approved dispatch details are missing.",
    );
  });

  it("drops anything shaped like a credential, a URL or a stack trace", () => {
    expect(safeFailureReason("POST https://shams-crm.cloud/integrations failed")).toBeNull();
    expect(safeFailureReason("Authorization: Bearer abc.def")).toBeNull();
    expect(safeFailureReason("x-webhook-secret rejected")).toBeNull();
    expect(safeFailureReason("TypeError at /app/src/lib/x.ts:12")).toBeNull();
    expect(safeFailureReason("   ")).toBeNull();
  });

  it("caps a reason that would otherwise run down the page", () => {
    const long = safeFailureReason("x".repeat(500));
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(200);
  });
});

describe("the module cannot cause a dispatch", () => {
  /**
   * It is a reader. There is no transport, no Supabase client and no server
   * function in its import graph, and every export returns data.
   */
  it("returns plain data and holds nothing callable", () => {
    for (const event of buildAlShrouqTimeline(acceptedRow)) {
      for (const value of Object.values(event)) {
        expect(typeof value).not.toBe("function");
      }
    }
    for (const value of Object.values(summariseAlShrouqDispatch(acceptedRow))) {
      expect(typeof value).not.toBe("function");
    }
  });
});
