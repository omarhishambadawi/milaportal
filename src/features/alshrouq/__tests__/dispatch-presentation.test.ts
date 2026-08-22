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
import {
  ALSHROUQ_TONE_STYLES,
  alshrouqToneStyle,
  describeApprovalAction,
  explainAlShrouqReadiness,
  explainAlShrouqState,
  type AlShrouqReadiness,
} from "../dispatch-presentation";
import { scheduledCountdownAt } from "../use-scheduled-countdown";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const card = read("../components/dispatch-section.tsx");
const dialog = read("../components/approval-dialog.tsx");
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

/* ------------------------------------------------------------------------- */
/* What the state means, not what it is called                               */
/* ------------------------------------------------------------------------- */

describe("every state explains itself", () => {
  const states = [
    "scheduled",
    "processing",
    "accepted",
    "failed",
    "indeterminate",
    "cancelled",
  ] as const;

  const summaryFor = (dispatch_status: string) =>
    summariseAlShrouqDispatch(
      row({
        dispatch_status,
        cancelled_at: dispatch_status === "cancelled" ? "2026-08-21T11:00:00.000Z" : null,
      }),
    );

  /**
   * A badge names a state; it cannot say what to do about one. "Scheduled" needs
   * nothing from anybody and "Delivery status unavailable" needs a phone call,
   * and an agent should not have to have been told which is which.
   */
  it.each(states)("gives %s a sentence an agent can act on", (status) => {
    const sentence = explainAlShrouqState(summaryFor(status));
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toBe(summaryFor(status).label);
    expect(sentence.trim()).toMatch(/\.$/);
  });

  /** The same prohibition the labels are under. No table talk on an ops screen. */
  it("exposes no internal terminology in any explanation", () => {
    const all = [
      ...states.map((s) => explainAlShrouqState(summaryFor(s))),
      explainAlShrouqState(summariseAlShrouqDispatch(null)),
      ...(["draft", "checking", "ready", "unverified", "unavailable"] as AlShrouqReadiness[]).map(
        explainAlShrouqReadiness,
      ),
    ];
    for (const sentence of all) {
      expect(sentence).not.toMatch(
        /dispatch_status|payload|snapshot|POST|cron|worker|reconcil|server function|endpoint/i,
      );
    }
  });

  /**
   * The distinction the whole integration rests on: whether a courier was
   * contacted. Each of these is a different instruction to the reader, and
   * collapsing any two is what puts a second driver on the road.
   */
  it("says whether a courier was contacted, per state", () => {
    expect(explainAlShrouqState(summaryFor("scheduled"))).toMatch(/not been contacted/i);
    expect(explainAlShrouqState(summaryFor("cancelled"))).toMatch(/no courier was contacted/i);
    // Never a failure, and never something anyone should send again.
    const unknown = explainAlShrouqState(summaryFor("indeterminate"));
    expect(unknown).toMatch(/not known/i);
    expect(unknown).toMatch(/not been sent again/i);
    expect(unknown).not.toMatch(/failed|rejected/i);
    // And a failure is stated as one, with nothing on its way.
    expect(explainAlShrouqState(summaryFor("failed"))).toMatch(/did not accept/i);
  });

  /** An unrecognised state is reported, never guessed at. */
  it("reports a state this build does not know without inventing a meaning", () => {
    const sentence = explainAlShrouqState(summaryFor("some_future_state"));
    expect(sentence).toMatch(/cannot be sent again/i);
    expect(sentence).not.toContain("some_future_state");
  });

  /** No dispatch row at all is its own answer, not an error. */
  it("says plainly when nothing has been arranged", () => {
    expect(explainAlShrouqState(summariseAlShrouqDispatch(null))).toMatch(/no alshrouq delivery/i);
  });
});

/* ------------------------------------------------------------------------- */
/* One colour language, and it is the portal's own                           */
/* ------------------------------------------------------------------------- */

describe("the state colours", () => {
  const tones = ["muted", "info", "success", "warning", "danger"] as const;

  it("covers every tone the summary can report", () => {
    for (const tone of tones) {
      const style = alshrouqToneStyle(tone);
      expect(style.badge).not.toBe("");
      expect(style.band).not.toBe("");
      expect(style.icon).not.toBe("");
    }
    expect(Object.keys(ALSHROUQ_TONE_STYLES).sort()).toEqual([...tones].sort());
  });

  /**
   * The design system, not a new one. Every colour is an existing token —
   * `primary`, `success`, `warning`, `destructive`, `muted`, `border`,
   * `foreground` — so light and dark mode are handled by the theme rather than
   * by anything written here.
   */
  it("uses only the portal's own tokens, and no literal colours", () => {
    const classes = Object.values(ALSHROUQ_TONE_STYLES)
      .flatMap((s) => [s.badge, s.band, s.icon])
      .join(" ");
    expect(classes).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(classes).not.toMatch(/\b(rgb|hsl|oklch)\(/);
    for (const token of classes.split(/\s+/).filter(Boolean)) {
      expect(token).toMatch(
        /^(dark:)?(text|bg|border)-(primary|success|warning|destructive|muted|foreground|border)(-foreground)?(\/\d{1,3})?$/,
      );
    }
  });

  /** Trouble does not arrive in the same colour as an accepted delivery. */
  it("does not paint an uncertain dispatch like an accepted one", () => {
    const accepted = summariseAlShrouqDispatch(row({ dispatch_status: "accepted" }));
    const unknown = summariseAlShrouqDispatch(row({ dispatch_status: "indeterminate" }));
    const waiting = summariseAlShrouqDispatch(row({ dispatch_status: "scheduled" }));
    expect(alshrouqToneStyle(accepted.tone)).not.toEqual(alshrouqToneStyle(unknown.tone));
    expect(alshrouqToneStyle(waiting.tone)).not.toEqual(alshrouqToneStyle(accepted.tone));
  });

  /** The card asks for the tone rather than deciding it, so the two cannot drift. */
  it("is applied by the card from the summary's own tone", () => {
    expect(card).toContain("alshrouqToneStyle(status.tone)");
    expect(card).toContain("{ label: summary.label, tone: summary.tone }");
  });
});

/* ------------------------------------------------------------------------- */
/* A cancelled delivery is still something that happened                     */
/* ------------------------------------------------------------------------- */

describe("a cancelled dispatch", () => {
  const cancelled = row({
    dispatch_status: "cancelled",
    scheduled_at: APPROVED_AT,
    scheduled_for: DUE_AT,
    cancelled_at: "2026-08-21T11:00:00.000Z",
  });

  /**
   * `current` is by definition the row that is *not* cancelled, so a cancelled
   * dispatch reaches the card as no dispatch at all. The badge is therefore
   * right to read "Ready to send" — and the card would otherwise be completely
   * silent about a slot that was booked and called off, which is what this band
   * exists to say.
   */
  it("is still reported, from the history the card already holds", () => {
    expect(summariseAlShrouqDispatch(cancelled).label).toBe("Scheduled delivery cancelled");
    expect(card).toContain("const lastCancelled");
    expect(card).toContain("(r) => r.cancelled_at != null");
    expect(card).toContain("{!current && lastCancelled && (");
    expect(card).toMatch(/was cancelled[\s\S]{0,240}No courier was contacted/);
  });

  /** A persisted state still outranks the readiness fallback on the badge. */
  it("lets a live dispatch name itself before any readiness is consulted", () => {
    expect(card).toContain("summary.status !== null");
    expect(card.indexOf("summary.status !== null")).toBeLessThan(
      card.indexOf('{ label: "Ready to send"'),
    );
  });

  /**
   * And nothing tells an agent their edits will not reach a courier that was
   * never contacted. `handedOver` covers the slot, not the submission.
   */
  it("claims a completed submission only where one happened", () => {
    expect(card).toContain(
      'summary.handedOver && summary.status !== "scheduled" && summary.status !== "failed"',
    );
    expect(card).toContain("{submitted && (");
    for (const status of ["accepted", "indeterminate"]) {
      expect(summariseAlShrouqDispatch(row({ dispatch_status: status })).handedOver).toBe(true);
    }
  });

  /** The order is still sendable, because the slot really is free. */
  it("still leaves the order sendable", () => {
    expect(summariseAlShrouqDispatch(cancelled).handedOver).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* The two create choices                                                    */
/* ------------------------------------------------------------------------- */

describe("what confirming will do", () => {
  it("distinguishes saving the order from handing it over", () => {
    const only = describeApprovalAction("create", "order_only", null);
    const send = describeApprovalAction("create", "dispatch", null);
    expect(only).not.toBe(send);
    expect(only).toMatch(/not contacted/i);
    expect(only).toMatch(/later/i);
    expect(send).toMatch(/straight away/i);
  });

  /**
   * "Send" reads as *sent* to somebody in a hurry, and on the scheduled path
   * nothing is sent at all. So the scheduled wording names the time and says so.
   */
  it("never lets the scheduled wording imply a courier is already moving", () => {
    const at = "Aug 22, 2026 · 04:00 PM";
    for (const mode of ["create", "existing"] as const) {
      const sentence = describeApprovalAction(mode, "dispatch", at);
      expect(sentence).toContain(at);
      expect(sentence).toMatch(/no courier is contacted now/i);
      expect(sentence).not.toMatch(/straight away|immediately|on its way/i);
    }
  });

  /** The button and the paragraph explaining it are the same words, written once. */
  it("heads the explanation with the primary button's own label", () => {
    expect(dialog).toContain("const primaryLabel = creating");
    expect(dialog.match(/\{primaryLabel\}/g) ?? []).toHaveLength(2);
    expect(dialog).toContain("What happens when you confirm");
    expect(dialog).toContain('describeApprovalAction(mode, "order_only", null)');
  });
});

/* ------------------------------------------------------------------------- */
/* Timing is a choice, not a blank field                                     */
/* ------------------------------------------------------------------------- */

describe("choosing when to deliver", () => {
  /**
   * The rule used to be "leave the date and time blank to send now" — a rule an
   * agent has to be told, standing between a driver leaving in a minute and a
   * driver leaving tomorrow.
   */
  it("asks for immediate or scheduled outright", () => {
    expect(dialog).toContain('useState<"now" | "later">("now")');
    expect(dialog).toContain("As soon as possible");
    expect(dialog).toContain("At a set time");
    expect(dialog).not.toContain("Leave both blank");
  });

  /** The arithmetic is untouched: the same parser, on the same inputs. */
  it("changes no scheduling logic", () => {
    expect(dialog).toContain("parseScheduleInput(date, time)");
    // "Now" means no instant is sent at all, exactly as two blank boxes did.
    expect(dialog).toContain('if (timing === "now")');
    // No clock arithmetic of its own beyond the one figure it renders.
    expect(dialog.match(/Date\.now\(\)/g) ?? []).toHaveLength(1);
  });

  /** The date and time are only asked for when they are going to be used. */
  it("shows the date and time only for a scheduled delivery", () => {
    expect(dialog).toContain('{timing === "later" && (');
  });
});

/* ------------------------------------------------------------------------- */
/* The delivery location reads as verified order information                 */
/* ------------------------------------------------------------------------- */

describe("the delivery location", () => {
  /**
   * Different facts, kept apart: the link the customer sent, the place it
   * resolved to, and the point a driver routes to. Merging them is how an agent
   * ends up checking the wrong one.
   */
  it("separates the customer's link from the coordinates", () => {
    expect(card).toContain("Delivery location");
    expect(card).toContain("Location shared by the customer");
    expect(card).toContain(">Lat<");
    expect(card).toContain(">Lng<");
    expect(dialog).toContain("Location verified");
    expect(dialog).toContain("Open the customer's link");
  });

  /** Verified is claimed only where there is a resolved point to justify it. */
  it("claims verification only when coordinates exist", () => {
    expect(card).toMatch(/\{coordinates && \([\s\S]{0,400}Verified/);
  });

  /**
   * The stored address is upstream-influenced text that ends up behind an
   * anchor, so it goes through the same guard the tracking link uses rather than
   * a second, subtly different one.
   */
  it("opens the stored link through the existing URL guard", () => {
    expect(card).toContain("safeTrackingUrl as safeExternalUrl");
    expect(card).toContain("safeExternalUrl(locationText)");
    expect(card).toMatch(/href=\{customerLink\}[\s\S]{0,200}rel="noopener noreferrer"/);
    // Nothing is assembled: the destination is the persisted value or nothing.
    expect(card).not.toMatch(/["'`]https?:\/\/[^"'`]*\$\{/);
  });

  /** Latitude and longitude are read-only evidence — there is no input for them. */
  it("offers no way to type a coordinate", () => {
    expect(card).not.toMatch(/<Input[\s\S]{0,200}(lat|lng|latitude|longitude)/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Nothing cramps, and nothing scrolls sideways                              */
/* ------------------------------------------------------------------------- */

describe("the layout survives a phone", () => {
  /**
   * The card lives in a column that is full-width on a phone and roughly a third
   * of the page on a desktop. Every grid in it therefore starts at one column
   * and earns a second, rather than starting at two and being squeezed.
   */
  it("stacks its grids before it splits them", () => {
    for (const source of [card, dialog]) {
      for (const grid of source.match(/(?<!sm:)grid-cols-\d/g) ?? []) {
        expect(grid).toBe("grid-cols-1");
      }
      expect(source).toContain("sm:grid-cols-2");
    }
  });

  /**
   * Long values shorten instead of widening their container: an Arabic branch
   * name or a customer's map URL must not push the page sideways.
   */
  it("truncates rather than overflowing", () => {
    for (const source of [card, dialog]) {
      expect(source).toContain("min-w-0");
      expect(source).toContain("truncate");
      // No fixed pixel widths, which are what actually force a sideways scroll.
      expect(source).not.toMatch(/\bw-\[\d+px\]/);
      expect(source).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
    }
  });

  /** The actions are thumb-sized targets on a narrow screen. */
  it("gives the actions room on a phone", () => {
    expect(dialog.match(/w-full sm:w-auto/g) ?? []).toHaveLength(3);
    expect(card).toContain("w-full sm:w-auto");
    // The primary sits last in source and so lowest on a stacked phone footer.
    expect(dialog).toContain("flex-col-reverse gap-2 sm:flex-row sm:justify-end");
  });

  /** The dialog can always be scrolled to its buttons, however tall it gets. */
  it("keeps a tall dialog inside the viewport", () => {
    expect(dialog).toContain("max-h-[85vh] overflow-y-auto");
  });
});

/* ------------------------------------------------------------------------- */
/* The create journey says what it is about to do                            */
/* ------------------------------------------------------------------------- */

describe("choosing AlShrouq on the order form", () => {
  /**
   * Choosing AlShrouq changes what the page's primary button does. Saying so at
   * the point of choice is what stops the approval dialog arriving as a surprise
   * two fields later.
   */
  it("explains the choice where the choice is made", () => {
    expect(orderForm).toContain("form.delivery_type === ALSHROUQ ? (");
    expect(orderForm).toMatch(/AlShrouq delivers this order/);
    expect(orderForm).toMatch(/save it only, or to hand the delivery to AlShrouq/);
  });

  /** And the intercepted button still names itself honestly. */
  it("leaves the primary action's own label alone", () => {
    expect(orderForm).toContain('mode === "create" ? "Create order" : "Update order"');
  });

  /**
   * A draft cannot dispatch, and a permanently disabled button beside it invites
   * a click that can never work. The card points at the real action instead.
   */
  it("points a draft at the page's own primary action", () => {
    expect(card).toContain("Choose <span");
    expect(card).toMatch(/Create order<\/span> at the top of/);
    expect(card).not.toMatch(/disabled[\s\S]{0,80}Pending order creation/);
  });
});
