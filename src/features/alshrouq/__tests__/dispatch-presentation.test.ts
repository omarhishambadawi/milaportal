/**
 * What the AlShrouq surfaces actually say, and what they refuse to say.
 *
 * Two kinds of assertion, as elsewhere in this feature. The **model** ones run
 * the pure derivation and check the vocabulary an agent reads. The **source**
 * ones read the components, because a handful of these properties are facts
 * about where code lives rather than about any value a function returns — "the
 * countdown cannot dispatch" is true because the component contains no mutation,
 * and no runtime test over a pure clock could demonstrate that.
 *
 * Nothing renders: the suite runs in Node, like every other in this repository.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAlShrouqTimeline,
  summariseAlShrouqDispatch,
  type AlShrouqDispatchRow,
} from "../dispatch-timeline";
import { scheduledCountdownAt } from "../use-scheduled-countdown";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const card = read("../components/dispatch-section.tsx");
const timeline = read("../../orders/components/order-activity-timeline.tsx");
const countdownHook = read("../use-scheduled-countdown.ts");
const orderForm = read("../../orders/components/order-form.tsx");

const DUE_AT = "2026-08-21T12:30:00.000Z";
const APPROVED_AT = "2026-08-21T09:00:00.000Z";
const SENT_AT = "2026-08-21T12:30:06.000Z";

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

/* ------------------------------------------------------------------------- */
/* Status vocabulary                                                         */
/* ------------------------------------------------------------------------- */

describe("the status an agent reads", () => {
  it.each<[string, string]>([
    ["scheduled", "Scheduled"],
    ["processing", "Sending to AlShrouq"],
    ["accepted", "Accepted by AlShrouq"],
    ["failed", "Dispatch failed"],
    ["indeterminate", "Delivery status unavailable"],
  ])("%s reads as %s", (status, label) => {
    expect(summariseAlShrouqDispatch(row({ dispatch_status: status })).label).toBe(label);
  });

  it("a cancelled dispatch names what was cancelled", () => {
    const s = summariseAlShrouqDispatch(
      row({ dispatch_status: "cancelled", cancelled_at: "2026-08-21T11:00:00.000Z" }),
    );
    expect(s.label).toBe("Scheduled delivery cancelled");
  });

  /**
   * No database vocabulary on screen. `dispatch_status` values, table names and
   * the words this codebase uses internally are not what an operations screen
   * should be teaching an agent.
   */
  it("exposes no internal terminology as a label", () => {
    for (const status of ["scheduled", "processing", "accepted", "failed", "indeterminate"]) {
      const { label } = summariseAlShrouqDispatch(row({ dispatch_status: status }));
      expect(label).not.toMatch(/dispatch_status|payload|snapshot|POST|cron|worker|reconcil/i);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Countdown                                                                 */
/* ------------------------------------------------------------------------- */

describe("the scheduled countdown", () => {
  const scheduled = row({
    dispatch_status: "scheduled",
    scheduled_at: APPROVED_AT,
    scheduled_for: DUE_AT,
  });

  it("renders from the persisted scheduled_for, reconstructed on every read", () => {
    const summary = summariseAlShrouqDispatch(scheduled);
    expect(summary.scheduledFor).toBe(DUE_AT);
    const c = scheduledCountdownAt(
      summary.scheduledFor,
      scheduled.dispatch_status,
      Date.parse(DUE_AT) - 2 * 60 * 60_000 - 3 * 60_000,
    );
    expect(c.state).toBe("waiting");
    expect(c.remainingLabel).toBe("2 hours 3 minutes");
    // A refresh recomputes the identical figure — there is no local state.
    expect(
      scheduledCountdownAt(
        summary.scheduledFor,
        scheduled.dispatch_status,
        Date.parse(DUE_AT) - 2 * 60 * 60_000 - 3 * 60_000,
      ),
    ).toEqual(c);
  });

  /** It stops the moment the row moves on, whatever the clock says. */
  it.each(["processing", "accepted", "failed", "indeterminate", "cancelled"])(
    "goes inactive once the status is %s",
    (status) => {
      const c = scheduledCountdownAt(DUE_AT, status, Date.parse(DUE_AT) - 60_000);
      expect(c.state).toBe("inactive");
      expect(c.remainingMs).toBeNull();
    },
  );

  /**
   * The time has passed and the worker has not reported. It has **not** been
   * sent, and the screen must not imply that it has.
   */
  it("says the moment has passed without claiming anything was sent", () => {
    const c = scheduledCountdownAt(DUE_AT, "scheduled", Date.parse(DUE_AT) + 60_000);
    expect(c.state).toBe("due");
    expect(card).toContain('"Awaiting dispatch"');
    expect(timeline).toContain('"Awaiting dispatch"');
    // Neither surface may say "Sent" on the strength of a clock.
    expect(card).not.toMatch(/state === "due"[\s\S]{0,120}Sent/);
  });

  /**
   * The countdown cannot dispatch. It owns one `setInterval` that re-renders,
   * and there is no request of any kind in its module.
   */
  it("cannot dispatch: its module holds no request, mutation or server function", () => {
    expect(countdownHook).toContain("setInterval");
    expect(countdownHook).not.toMatch(
      /\bfetch\(|useMutation|useServerFn|supabase|invalidateQueries/,
    );
    expect(countdownHook).not.toContain("alshrouqDispatchOrder");
  });

  it("returns a plain value with nothing callable to fire", () => {
    const after = scheduledCountdownAt(DUE_AT, "scheduled", Date.parse(DUE_AT) + 1000);
    expect(after.remainingMs).toBe(0);
    for (const value of Object.values(after)) expect(typeof value).not.toBe("function");
  });
});

/* ------------------------------------------------------------------------- */
/* Tracking                                                                  */
/* ------------------------------------------------------------------------- */

describe("tracking", () => {
  const accepted = row({
    dispatch_status: "accepted",
    dispatched_at: SENT_AT,
    external_order_id: "6099196",
  });

  it("appears only when a valid URL was persisted", () => {
    const tracked = { ...accepted, tracking_url: "https://track.example.com/o/6099196" };
    expect(summariseAlShrouqDispatch(tracked).trackingUrl).toBe(
      "https://track.example.com/o/6099196",
    );
    expect(summariseAlShrouqDispatch(accepted).trackingUrl).toBeNull();
    // A stored value that is not a safe absolute URL is treated as none.
    expect(
      summariseAlShrouqDispatch({ ...accepted, tracking_url: "javascript:alert(1)" }).trackingUrl,
    ).toBeNull();
    expect(summariseAlShrouqDispatch({ ...accepted, tracking_url: "  " }).trackingUrl).toBeNull();
  });

  /** Never assembled from the reference, and never a dead placeholder button. */
  it("is not fabricated, and renders nothing when absent", () => {
    expect(summariseAlShrouqDispatch(accepted).externalOrderId).toBe("6099196");
    expect(summariseAlShrouqDispatch(accepted).trackingUrl).toBeNull();
    // The card gates the control on the persisted value, with no else-branch.
    expect(card).toContain("summary.trackingUrl && (");
    expect(card).not.toMatch(/disabled[\s\S]{0,40}Open tracking/);
    expect(card).not.toMatch(/["'`]https?:\/\/[^"'`]*\$\{/);
  });

  it("opens externally, with the protections an external link needs", () => {
    expect(card).toContain('target="_blank"');
    expect(card).toContain('rel="noopener noreferrer"');
    expect(timeline).toContain('rel="noopener noreferrer"');
  });
});

/* ------------------------------------------------------------------------- */
/* One-time handoff                                                          */
/* ------------------------------------------------------------------------- */

describe("the one-time handoff", () => {
  /**
   * The sentence that stops an agent believing a later edit reaches the
   * courier. There is no AlShrouq update endpoint, so there must be no wording
   * or control that implies one.
   */
  it("says plainly that later Portal edits are not sent", () => {
    expect(card).toContain(
      "AlShrouq submission completed. Changes made in MilaPortal after submission are not sent to AlShrouq.",
    );
  });

  it("offers no update-AlShrouq action and no syncing state", () => {
    expect(card).not.toMatch(/Update AlShrouq|Resend|Re-send|Sync|Syncing/i);
  });

  it("shows no second dispatch action once the order has been handed over", () => {
    // One send control, in the else-branch of the handed-over test.
    expect(card.match(/Send to AlShrouq/g) ?? []).toHaveLength(1);
    const handedOver = card.indexOf("summary.handedOver ? (");
    expect(card.indexOf("Send to AlShrouq", handedOver)).toBeGreaterThan(
      card.indexOf("          ) : (", handedOver),
    );
  });

  /** Every state but cancelled counts as handed over — indeterminate included. */
  it.each(["scheduled", "processing", "accepted", "failed", "indeterminate"])(
    "treats %s as handed over, so nothing offers to send it again",
    (status) => {
      expect(summariseAlShrouqDispatch(row({ dispatch_status: status })).handedOver).toBe(true);
    },
  );

  /**
   * The page's primary action names what it does. An existing order updates; it
   * does not "create", and the approval dialog is intercepted only on create.
   */
  it("labels the primary action Update order for an existing order", () => {
    expect(orderForm).toContain('mode === "create" ? "Create order" : "Update order"');
    expect(orderForm).toContain(
      'const interceptsCreate = mode === "create" && form.delivery_type === ALSHROUQ',
    );
  });

  /** A Portal edit cannot reach the dispatch layer at all — one hook, on insert. */
  it("routes no edit into a dispatch", () => {
    const hook = read("../../orders/hooks/use-order-form.ts");
    expect(hook).toContain("afterCreate");
    expect(hook).not.toMatch(/afterUpdate|afterSave|afterEdit/);
    expect(hook).not.toContain("alshrouqDispatchOrder");
  });
});

/* ------------------------------------------------------------------------- */
/* The timeline invents nothing                                              */
/* ------------------------------------------------------------------------- */

describe("the timeline invents nothing", () => {
  it("shows no delivery event, because no delivered evidence exists", () => {
    const everyState = ["scheduled", "processing", "accepted", "failed", "indeterminate"].flatMap(
      (dispatch_status) =>
        buildAlShrouqTimeline(
          row({
            dispatch_status,
            scheduled_at: APPROVED_AT,
            scheduled_for: DUE_AT,
            last_attempt_at: "2026-08-21T12:30:04.000Z",
            dispatched_at: SENT_AT,
            tracking_url: "https://track.example.com/x",
          }),
        ),
    );
    for (const event of everyState) {
      expect(event.title).not.toMatch(/delivered|out for delivery|en route|driver assigned/i);
    }
  });

  /** An order nobody dispatched has no AlShrouq history to show. */
  it("emits nothing for an order with no dispatch row", () => {
    expect(buildAlShrouqTimeline(null)).toEqual([]);
    expect(buildAlShrouqTimeline(row())).toEqual([]);
  });

  /** Every event's timestamp is a stored column, never a browser clock. */
  it("uses only persisted timestamps", () => {
    const events = buildAlShrouqTimeline(
      row({
        dispatch_status: "accepted",
        scheduled_at: APPROVED_AT,
        scheduled_for: DUE_AT,
        last_attempt_at: "2026-08-21T12:30:04.000Z",
        dispatched_at: SENT_AT,
        refreshed_at: "2026-08-21T12:31:00.000Z",
        tracking_url: "https://track.example.com/x",
      }),
    );
    const persisted = [
      APPROVED_AT,
      "2026-08-21T12:30:04.000Z",
      SENT_AT,
      "2026-08-21T12:31:00.000Z",
    ];
    for (const event of events) expect(persisted).toContain(event.at);
    // And the derivation reads no clock of its own.
    const source = read("../dispatch-timeline.ts");
    expect(source).not.toContain("Date.now()");
    expect(source).not.toContain("new Date()");
  });

  /**
   * The full accepted lifecycle, in order, with nothing between the steps the
   * database can evidence.
   */
  it("renders the lifecycle in the order it happened", () => {
    const events = buildAlShrouqTimeline(
      row({
        dispatch_status: "accepted",
        scheduled_at: APPROVED_AT,
        scheduled_for: DUE_AT,
        last_attempt_at: "2026-08-21T12:30:04.000Z",
        dispatched_at: SENT_AT,
        refreshed_at: "2026-08-21T12:31:00.000Z",
        external_order_id: "6099196",
        tracking_url: "https://track.example.com/x",
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["scheduled", "started", "accepted", "tracking"]);
  });

  /** And the cancelled lifecycle, which stops where it stopped. */
  it("renders a cancelled schedule as scheduled then cancelled", () => {
    const events = buildAlShrouqTimeline(
      row({
        dispatch_status: "cancelled",
        scheduled_at: APPROVED_AT,
        scheduled_for: DUE_AT,
        cancelled_at: "2026-08-21T11:00:00.000Z",
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["scheduled", "cancelled"]);
    expect(events[1].detail).toBe("Cancelled before dispatch");
    expect(events.some((e) => e.kind === "accepted" || e.kind === "started")).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Nothing sensitive on screen                                               */
/* ------------------------------------------------------------------------- */

describe("no internals reach the timeline", () => {
  /**
   * `last_error` is the only upstream-influenced text that reaches an event, and
   * it is filtered rather than trusted.
   */
  it("drops a failure reason that carries a URL, a header or a trace", () => {
    const withUrl = buildAlShrouqTimeline(
      row({
        dispatch_status: "failed",
        last_attempt_at: SENT_AT,
        last_error: "POST https://shams-crm.cloud/integrations/alshrouq/orders failed",
      }),
    );
    expect(withUrl[0].detail).not.toContain("https://");
    expect(withUrl[0].detail).not.toContain("shams-crm");

    const withHeader = buildAlShrouqTimeline(
      row({
        dispatch_status: "failed",
        last_attempt_at: SENT_AT,
        last_error: "Authorization: Bearer abc.def.ghi",
      }),
    );
    expect(withHeader[0].detail).not.toMatch(/bearer|authorization/i);
  });

  /**
   * The customer's name, phone and address are on the dispatch row and in the
   * frozen snapshot. None of them belongs in a history entry — the timeline
   * answers "what happened", not "who was it for".
   */
  it("puts no customer identity into any event", () => {
    const events = buildAlShrouqTimeline(
      row({
        dispatch_status: "accepted",
        scheduled_at: APPROVED_AT,
        scheduled_for: DUE_AT,
        last_attempt_at: SENT_AT,
        dispatched_at: SENT_AT,
        external_order_id: "6099196",
        status: "Order Created",
        tracking_url: "https://track.example.com/x",
      }),
    );
    const text = JSON.stringify(events);
    for (const field of ["customer_name", "customer_phone", "customer_address", "payload"]) {
      expect(text).not.toContain(field);
    }
  });

  /** The client never fetches the snapshot, so it cannot leak from there. */
  it("never reads payload_snapshot into the browser", () => {
    const hook = read("../use-order-dispatch.ts");
    expect(hook).not.toMatch(/COLUMNS[\s\S]{0,400}payload_snapshot/);
    expect(hook).not.toMatch(/COLUMNS[\s\S]{0,400}last_response/);
    // The call, not the prose — the header explains why `select("*")` is wrong
    // here, and that sentence is not a use of it.
    expect(hook).toContain(".select(COLUMNS)");
    expect(hook).not.toContain('.select("*")');
  });
});
