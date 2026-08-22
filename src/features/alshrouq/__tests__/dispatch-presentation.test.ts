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
import {
  alshrouqRequirements,
  branchCoverage,
  coverageAllowsDispatch,
  describeBranchCoverage,
  describeLocationReading,
  readLocation,
  readyForAlShrouq,
  type AlShrouqOrderInput,
  type BranchCoverage,
} from "../order-requirements";
import { parseScheduleInput } from "../scheduling";
import {
  HOUR_OPTIONS,
  MERIDIEM_OPTIONS,
  MINUTE_OPTIONS,
  businessDate,
  businessMinutes,
  calendarDate,
  dateFromCalendar,
  defaultScheduleSelection,
  formatPickedDate,
  scheduleInputFor,
} from "../schedule-picker";
import { resolveAlShrouqBranch } from "@/lib/shams-crm/alshrouq-branches";
import type { AlShrouqBranchOption } from "@/lib/shams-crm/alshrouq-branches";
import { scheduledCountdownAt } from "../use-scheduled-countdown";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/** A fixed instant. Every schedule assertion pins the clock rather than reading it. */
const at = (iso: string) => new Date(iso);

const card = read("../components/dispatch-section.tsx");
const dialog = read("../components/approval-dialog.tsx");
const section = read("../components/order-requirements-section.tsx");
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
   * `current` is by definition the row that is *not* cancelled, because that is
   * the question the send control has to answer. Reporting on it too meant an
   * order whose only dispatch had been cancelled came back from the orders list
   * looking as though it had never had one.
   */
  it("is named by the card, from the rows the query already returns", () => {
    expect(summariseAlShrouqDispatch(cancelled).label).toBe("Scheduled delivery cancelled");
    // The fallback moved into `dispatch-selection.ts`, where it is a pure
    // function with its own tests rather than an expression inside a component.
    // `shownDispatch` *is* `current ?? latest` — see `dispatch-selection.test.ts`.
    expect(card).toContain("const shown = shownDispatch(dispatchState?.rows ?? []);");
    expect(card).toContain("summariseAlShrouqDispatch(shown)");
  });

  /** The order is still sendable, because the slot really is free. */
  it("still leaves the order sendable", () => {
    expect(summariseAlShrouqDispatch(cancelled).handedOver).toBe(false);
  });

  /** And nothing counts down to a delivery nobody is going to make. */
  it("drives the countdown from the live row, never the displayed one", () => {
    expect(card).toContain(
      "useScheduledDispatchCountdown(current?.scheduled_for, current?.dispatch_status)",
    );
  });

  /**
   * Nothing tells an agent their edits will not reach a courier that was never
   * contacted. `handedOver` covers the slot, not the submission.
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
});

/* ------------------------------------------------------------------------- */
/* The card survives the order being reopened                                */
/* ------------------------------------------------------------------------- */

describe("reopening an order", () => {
  /**
   * The regression this pins: create an AlShrouq order, leave the page, come
   * back. Every state the order has been in must still be on the card — and the
   * one that used to vanish is `cancelled`, because it is the only state for
   * which `current` is null while rows is not empty.
   *
   * Modelled the way the hook models it, rather than by rendering: `current` is
   * the uncancelled row, `rows` is the history, and `shown` is what the card
   * reports on.
   */
  const asHook = (rows: AlShrouqDispatchRow[]) => ({
    rows,
    current: rows.find((r) => r.cancelled_at == null) ?? null,
  });
  const shownBy = (state: { rows: AlShrouqDispatchRow[]; current: AlShrouqDispatchRow | null }) =>
    state.current ?? (state.rows.length ? state.rows[state.rows.length - 1]! : null);

  it.each([
    ["scheduled", "Scheduled"],
    ["processing", "Sending to AlShrouq"],
    ["accepted", "Accepted by AlShrouq"],
    ["failed", "Dispatch failed"],
    ["indeterminate", "Delivery status unavailable"],
  ])("still reports %s when the order is opened again", (status, label) => {
    const state = asHook([row({ dispatch_status: status, dispatched_at: SENT_AT })]);
    expect(summariseAlShrouqDispatch(shownBy(state)).label).toBe(label);
  });

  /** The case that actually broke: a cancelled row leaves `current` null. */
  it("still reports a cancelled dispatch, which has no current row at all", () => {
    const state = asHook([
      row({
        dispatch_status: "cancelled",
        scheduled_at: APPROVED_AT,
        cancelled_at: "2026-08-21T11:00:00.000Z",
      }),
    ]);
    expect(state.current).toBeNull();
    expect(summariseAlShrouqDispatch(shownBy(state)).label).toBe("Scheduled delivery cancelled");
    // …and the order may still be sent, because the slot is free.
    expect(summariseAlShrouqDispatch(shownBy(state)).handedOver).toBe(false);
  });

  /** An operator's conclusion survives the round trip too. */
  it("still reports an operator resolution", () => {
    const state = asHook([
      row({
        dispatch_status: "indeterminate",
        last_attempt_at: SENT_AT,
        resolution_outcome: "delivered",
        resolved_at: "2026-08-21T15:00:00.000Z",
      }),
    ]);
    expect(summariseAlShrouqDispatch(shownBy(state)).resolutionOutcome).toBe("delivered");
  });

  /** A live dispatch beside an older cancelled one reports the live one. */
  it("prefers the live dispatch over a cancelled predecessor", () => {
    const state = asHook([
      row({ dispatch_status: "cancelled", cancelled_at: "2026-08-21T11:00:00.000Z" }),
      row({ dispatch_status: "accepted", dispatched_at: SENT_AT, external_order_id: "6099196" }),
    ]);
    expect(summariseAlShrouqDispatch(shownBy(state)).label).toBe("Accepted by AlShrouq");
  });

  /** And an order that never had one still contributes no card state at all. */
  it("reports nothing for an order that was never dispatched", () => {
    const state = asHook([]);
    expect(shownBy(state)).toBeNull();
    expect(summariseAlShrouqDispatch(shownBy(state)).status).toBeNull();
  });

  /**
   * The card is present the moment an order says AlShrouq, before and after any
   * handover — and it stays present once a dispatch exists whatever the form
   * happens to say.
   *
   * This used to assert `{form.delivery_type === ALSHROUQ && (` literally, which
   * is how it went on passing while the card disappeared on every reopen: the
   * form's value is React state seeded by an effect, and the assertion could not
   * tell "renders on the delivery method" from "renders on a copy of it that is
   * empty until an effect runs". The rule is `showAlShrouqSection` now, which
   * reads the persisted order and the persisted dispatch rows.
   */
  it("renders on the order's delivery method, not on a transient copy of it", () => {
    expect(orderForm).toContain("{showsAlShrouqSection && (");
    expect(orderForm).toContain("<AlShrouqDispatchSection");
    expect(orderForm).toContain("showAlShrouqSection({");
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

  /**
   * The button says what will happen; one muted line says what that means.
   *
   * The label used to be printed twice — once on the button and once as the
   * heading of a tinted outcome panel above it. The panel is gone: it repeated
   * the button in a coloured box and was a large part of why the dialog did not
   * fit an 800px screen. The sentence underneath it survived, because it is the
   * part the button has no room for and the one that must never read as "sent".
   */
  it("says once what the primary button will do", () => {
    expect(dialog).toContain("const primaryLabel = creating");
    expect(dialog.match(/\{primaryLabel\}/g) ?? []).toHaveLength(1);
    expect(dialog).toContain('describeApprovalAction(mode, "dispatch", scheduledLabel)');
    expect(dialog).toContain("Create order only");
    expect(dialog).toContain("Create order + AlShrouq delivery");
    // No tinted panel around it: a confirmation is text and buttons.
    expect(dialog).not.toContain("outcomeTone");
  });
});

/* ------------------------------------------------------------------------- */
/* The dialog confirms; it does not collect                                  */
/* ------------------------------------------------------------------------- */

describe("the confirmation dialog", () => {
  /**
   * The whole point of this pass. Pressing *Create order* used to produce a
   * second, taller form: a payment select, a location box with its own resolve
   * button, a driver note and a free-typed date and time — questions the agent
   * thought they had already finished answering.
   */
  it("has no order-form controls left in it", () => {
    expect(dialog).not.toContain("<Input");
    /*
     * Three `Select`s, and all three are the hour, the minute and the AM/PM of
     * the delivery time — never a payment method, a branch or anything else the
     * order form already asked for. The count is the guard: a fourth would mean
     * a field crept back in.
     */
    expect(dialog.match(/<SelectTrigger/g) ?? []).toHaveLength(1);
    expect(dialog.match(/<TimeUnit/g) ?? []).toHaveLength(3);
    expect(dialog).not.toContain("paymentOptions");
    expect(dialog).not.toContain("branchOptions");
    // Two controls, and only two: when the delivery starts, and the note the
    // driver gets. The note came back deliberately — it is the one thing that
    // belongs at the moment of handover rather than in the order above it — and
    // it is capped here so "one small box" cannot grow back into the second form
    // this dialog used to be.
    expect(dialog).toContain("<RadioGroup");
    expect(dialog.match(/<Textarea/g) ?? []).toHaveLength(1);
    expect(dialog).toContain('id="alshrouq-delivery-note"');
  });

  /** It fetches nothing and resolves nothing: every value arrives as a prop. */
  it("owns no data of its own", () => {
    expect(dialog).not.toContain("useQuery");
    expect(dialog).not.toContain("useMutation");
    expect(dialog).not.toContain("useServerFn");
    expect(dialog).not.toContain("alshrouqResolveLocation");
    expect(dialog).not.toContain("alshrouqDeliveryOptions");
  });

  /**
   * And it holds no copy of what the form already knows.
   *
   * Four pieces of state, and all four are about *when* — the choice, the date
   * and time behind it, and whether each of the two pickers is open. Nothing
   * here duplicates the customer, the branch, the payment method or the note:
   * those arrive as props and are handed straight back in the plan.
   */
  it("keeps no state but the delivery timing", () => {
    const states = dialog.match(/useState[<(]/g) ?? [];
    expect(states).toHaveLength(4);
    expect(dialog).toContain("const [timing, setTiming]");
    expect(dialog).toContain("const [when, setWhen]");
    expect(dialog).toContain("const [dateOpen, setDateOpen]");
    expect(dialog).toContain("const [timeOpen, setTimeOpen]");
    for (const owned of ["customerName", "paymentType", "mapUrl", "details"]) {
      expect(dialog).not.toContain(`useState<string>(${owned}`);
    }
  });

  /** What it shows is a summary of the order, read-only. */
  it("summarises the order the agent already filled in", () => {
    for (const label of ["Customer", "Phone", "Branch", "Order value", "Payment", "Location"]) {
      expect(dialog).toContain(`label="${label}"`);
    }
  });

  /**
   * A 200-character Maps URL is the one value on this screen that cannot be
   * broken across lines by anything but a rule that says so — and printing it
   * tells an agent nothing they can check. The coordinates are the readable part.
   */
  it("never prints the raw map URL", () => {
    expect(dialog).not.toMatch(/\{mapUrl\}/);
    expect(dialog).toContain("formatCoordinate(Number(latitude))");
  });

  /** It still assembles no request and knows no endpoint. */
  it("hands back a plan and nothing else", () => {
    expect(dialog).toContain("onApprove({");
    expect(dialog).not.toContain("buildAlshrouqOrderPayload");
    expect(dialog).not.toContain("branch_id");
    expect(dialog).not.toMatch(/["'`]\/integrations/);
    expect(dialog).not.toContain("ALSHROUQ_LIVE_DISPATCH_ENABLED");
  });
});

/* ------------------------------------------------------------------------- */
/* Choosing when                                                             */
/* ------------------------------------------------------------------------- */

describe("choosing when to deliver", () => {
  /**
   * The generated slot list is gone, and must not come back.
   *
   * It offered five whole hours as radio cards — the tallest block in a dialog
   * that had to fit 800px — could not express 7:30, and implied AlShrouq knew
   * about a "slot" it had never been told of. What replaced it is a binary
   * choice plus the portal's own calendar and an hour / minute / AM-PM triple.
   */
  it("offers two choices, not a list of generated times", () => {
    expect(dialog).toContain("As soon as possible");
    expect(dialog).toContain("Schedule delivery");
    // The module that generated them no longer exists, and nothing imports it.
    expect(dialog).not.toContain("scheduleOptionsAt");
    expect(dialog).not.toContain("schedule-options");
    expect(dialog).not.toContain("SlotOption");
  });

  /** A calendar, and the portal's own — not a second one written for this. */
  it("picks the date with the shared Calendar primitive", () => {
    expect(dialog).toContain('from "@/components/ui/calendar"');
    expect(dialog).toContain('mode="single"');
    // A day already gone cannot be chosen.
    expect(dialog).toContain("{ before: today }");
    // And still not a typed date box, which is what the calendar replaced.
    expect(dialog).not.toContain('type="date"');
    expect(dialog).not.toContain("<Input");
  });

  /**
   * Date and time cost one row, not two.
   *
   * Stacked, they were 118px of a phone's height and the reason the scheduled
   * state ran past a 375×812 viewport. Both are popover triggers reading their
   * own answer back, side by side in a flex row — not a two-column grid, which
   * the phone-layout contract rightly forbids for a form.
   */
  it("puts the date and the time side by side, each behind its own trigger", () => {
    expect(dialog).toContain('<div className="flex items-start gap-2">');
    expect(dialog.match(/min-w-0 flex-1 space-y-1/g) ?? []).toHaveLength(2);
    // Each trigger reads back the value it owns, in the form a person reads.
    expect(dialog).toContain("{formatPickedDate(when.date)}");
    expect(dialog).toContain("{formatTime12(when.hour, when.minute, when.meridiem)}");
    // Two popovers, one per control, and both closed when the dialog reopens.
    expect(dialog).toContain("const [timeOpen, setTimeOpen]");
    expect(dialog).toContain("setTimeOpen(false);");
  });

  /**
   * A `Select` portals its list to the body, which is outside the time
   * popover's subtree — so without this guard, choosing an hour registers as a
   * click outside and closes the popover under the agent's finger.
   */
  it("keeps the time popover open while a unit is being chosen", () => {
    expect(dialog).toContain("onInteractOutside");
    expect(dialog).toContain('target?.closest("[data-radix-popper-content-wrapper]")');
    expect(dialog).toContain("event.preventDefault()");
  });

  /** Hour, minute and AM/PM — every minute, and never a 24-hour clock. */
  it("picks the time to the minute, in 12-hour form", () => {
    expect(dialog).toContain('label="Hour"');
    expect(dialog).toContain('label="Minute"');
    expect(dialog).toContain('label="AM or PM"');
    expect(HOUR_OPTIONS).toHaveLength(12);
    expect(HOUR_OPTIONS[0]).toBe("01");
    expect(HOUR_OPTIONS[11]).toBe("12");
    // Every minute, so 7:47 is expressible. Not quarters, not whole hours.
    expect(MINUTE_OPTIONS).toHaveLength(60);
    expect(MINUTE_OPTIONS).toContain("47");
    expect(MERIDIEM_OPTIONS).toEqual(["AM", "PM"]);
    // A 24-hour hour would show as 13 or later, which this cannot produce.
    for (const hour of HOUR_OPTIONS) expect(Number(hour)).toBeLessThanOrEqual(12);
  });

  /** The arithmetic is untouched: the same parser, on the same two strings. */
  it("changes no scheduling logic", () => {
    expect(dialog).toContain("parseScheduleInput(input.date, input.time)");
    // "As soon as possible" sends no instant at all, as a blank pair always did.
    expect(dialog).toContain('if (timing === "asap") return { ok: true as const, iso: null');
    const picker = read("../schedule-picker.ts");
    expect(picker).not.toContain("Date.now()");
    expect(picker).not.toMatch(/\bfetch\(|useMutation|useServerFn|supabase/);
  });

  /** The selection is handed to the parser in exactly the shape it takes. */
  it("produces the pair the existing parser accepts", () => {
    const selection = { date: "2026-08-23", hour: "07", minute: "30", meridiem: "PM" as const };
    expect(scheduleInputFor(selection)).toEqual({ date: "2026-08-23", time: "07:30 PM" });

    const now = at("2026-08-22T09:05:00.000Z");
    const parsed = parseScheduleInput("2026-08-23", "07:30 PM", now);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.timing).toBe("scheduled");
  });
});

/* ------------------------------------------------------------------------- */
/* The date and time the picker offers                                       */
/* ------------------------------------------------------------------------- */

describe("the schedule picker", () => {
  // 12:05 PM in Riyadh, which is 09:05 UTC.
  const NOON_ISH = at("2026-08-22T09:05:00.000Z");

  it("reads the day and the clock in Riyadh, not in the host zone", () => {
    expect(businessDate(NOON_ISH)).toBe("2026-08-22");
    expect(businessMinutes(NOON_ISH)).toBe(12 * 60 + 5);
    // 10:30 PM UTC is already the next day in Riyadh.
    expect(businessDate(at("2026-08-22T21:30:00.000Z"))).toBe("2026-08-23");
  });

  /** Midnight and noon, the two the naive 12-hour formula gets wrong. */
  it("converts midnight and noon correctly", () => {
    const asInstant = (time: string, date = "2026-08-22") =>
      parseScheduleInput(date, time, at("2026-08-21T00:00:00.000Z"));
    for (const [time, hourUtc] of [
      ["12:00 AM", 21], // midnight Riyadh is 21:00 UTC the previous day
      ["12:00 PM", 9],
      ["07:30 PM", 16],
    ] as const) {
      const parsed = asInstant(time);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(new Date(parsed.iso).getUTCHours()).toBe(hourUtc);
    }
  });

  /** The default is far enough out that reading the dialog cannot expire it. */
  it("starts at a time the parser accepts as scheduled", () => {
    const selection = defaultScheduleSelection(NOON_ISH);
    const { date, time } = scheduleInputFor(selection);
    const parsed = parseScheduleInput(date, time, NOON_ISH);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.timing).toBe("scheduled");
    // 12:05 PM + 30 minutes, rounded up to the quarter hour.
    expect(time).toBe("12:45 PM");
    expect(date).toBe("2026-08-22");
  });

  /** Rather than offering a time that has gone, it rolls into tomorrow. */
  it("rolls past midnight into the next day", () => {
    // 11:50 PM Riyadh: the lead time lands after midnight.
    const late = at("2026-08-22T20:50:00.000Z");
    const selection = defaultScheduleSelection(late);
    expect(selection.date).toBe("2026-08-23");
    const { date, time } = scheduleInputFor(selection);
    const parsed = parseScheduleInput(date, time, late);
    expect(parsed.ok).toBe(true);
  });

  /**
   * **Every hour, minute and meridiem is selectable, always.**
   *
   * The picker used to judge one unit at a time: at 10:15 PM the hours 01–09
   * were disabled, so an agent could not reach *9 PM tomorrow* by touching the
   * hour first — the route to a perfectly valid answer was closed. An hour is
   * not in the past; only a whole datetime is.
   */
  it("offers every unit whatever the clock says", () => {
    expect(HOUR_OPTIONS).toHaveLength(12);
    expect(MINUTE_OPTIONS).toHaveLength(60);
    expect(MERIDIEM_OPTIONS).toEqual(["AM", "PM"]);
    // The component passes no per-option predicate at all any more, so nothing
    // can grey one out. The unit renders the list it is given.
    expect(dialog).not.toContain("isPast");
    expect(dialog).not.toContain("disabled={isPast");
  });

  /**
   * Validity is a property of `date + hour + minute + AM/PM` together, and it is
   * `parseScheduleInput` — unchanged — that decides it.
   */
  it("judges the complete datetime, not the unit", () => {
    // 10:15 PM Riyadh.
    const now = at("2026-08-22T19:15:00.000Z");
    const hour = { hour: "09", minute: "30" } as const;

    // 9:30 PM *today* has gone — refused, as it should be.
    const today = parseScheduleInput("2026-08-22", "09:30 PM", now);
    expect(today.ok).toBe(false);
    if (!today.ok) expect(today.reason).toBe("past");

    // The very same hour is fine on the next day…
    const tomorrowPm = parseScheduleInput("2026-08-23", "09:30 PM", now);
    expect(tomorrowPm.ok).toBe(true);
    // …and so is the morning of it, which the old per-unit rule also blocked.
    const tomorrowAm = parseScheduleInput("2026-08-23", "09:30 AM", now);
    expect(tomorrowAm.ok).toBe(true);

    // And flipping the meridiem alone rescues it on today's date.
    const laterToday = parseScheduleInput("2026-08-22", "11:30 PM", now);
    expect(laterToday.ok).toBe(true);
    if (laterToday.ok) expect(laterToday.timing).toBe("scheduled");
    void hour;
  });

  /** Nothing snaps the selection forward as it is being made. */
  it("records the choice exactly as made", () => {
    expect(dialog).toContain("const pick = (next: ScheduleSelection) => setWhen(next);");
    expect(dialog).not.toContain("clampSelection");
  });

  /** A day that has ended is the one thing still refused outright. */
  it("bounds the calendar at today, in business time", () => {
    expect(dialog).toContain("calendarDate(businessDate(new Date()))");
    expect(dialog).toContain("{ before: today }");
  });

  /** The trigger reads as a date, not as an ISO string. */
  it("labels the chosen date the way a person reads one", () => {
    expect(formatPickedDate("2026-08-23")).toBe("Sun, Aug 23, 2026");
  });

  /**
   * The calendar works in the browser's own `Date`, so the two conversions must
   * be each other's inverse — otherwise a click lands on the previous day for
   * anyone west of UTC.
   */
  it("round-trips a calendar day without shifting it", () => {
    for (const date of ["2026-08-23", "2026-01-01", "2026-12-31", "2027-03-01"]) {
      expect(dateFromCalendar(calendarDate(date)!)).toBe(date);
    }
    // Local parts on both sides, never `Date.UTC` on one of them: a UTC-midnight
    // Date is the *previous* day everywhere west of UTC, which would highlight
    // the wrong cell and cut `disabled: { before }` a day short.
    const day = calendarDate("2026-08-23")!;
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 7, 23]);
    expect(day.getHours()).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Google Maps links                                                         */
/* ------------------------------------------------------------------------- */

describe("reading a location out of a link", () => {
  /** The ordinary desktop URL, with the dropped pin in the `/data=` blob. */
  it("reads a place URL", () => {
    const reading = readLocation(
      "https://www.google.com/maps/place/Pharmacy/@24.7136,46.6753,17z/data=!3m1!4b1!4m5!3m4!1s0x0:0x0!8m2!3d24.53728!4d46.64561",
    );
    expect(reading).toEqual({ kind: "resolved", latitude: 24.53728, longitude: 46.64561 });
  });

  /** `?q=lat,lng` — the form the branch mapping itself uses. */
  it("reads a ?q= URL", () => {
    expect(readLocation("https://www.google.com/maps?q=24.537276,46.645605")).toEqual({
      kind: "resolved",
      latitude: 24.537276,
      longitude: 46.645605,
    });
  });

  /** The `@lat,lng` camera, when there is no pin to prefer. */
  it("reads an @lat,lng URL", () => {
    const reading = readLocation("https://www.google.com/maps/@24.8061703,46.77527122,15z");
    expect(reading.kind).toBe("resolved");
    if (reading.kind === "resolved") expect(reading.latitude).toBeCloseTo(24.8061703, 6);
  });

  /** A phone's own share sheet, and a pasted pair. */
  it("reads a geo: share and a bare pair", () => {
    expect(readLocation("geo:24.7136,46.6753").kind).toBe("resolved");
    expect(readLocation("24.7136, 46.6753").kind).toBe("resolved");
  });

  /**
   * A short link is not a failure. It is a perfectly good location this browser
   * cannot read, and the honest answer is to offer to ask the server.
   */
  it("asks for a check rather than guessing at a short link", () => {
    const reading = readLocation("https://maps.app.goo.gl/aBcDeFgHiJkLmNoP");
    expect(reading.kind).toBe("needs_check");
    expect(describeLocationReading(reading)).toMatch(/short link/i);
    // And no coordinate is invented on the way.
    expect(JSON.stringify(reading)).not.toMatch(/latitude|longitude/);
  });

  /** A swapped pair lands outside the country and is refused rather than sent. */
  it("refuses coordinates outside Saudi Arabia", () => {
    const reading = readLocation("https://www.google.com/maps?q=46.6753,24.7136");
    expect(reading.kind).toBe("out_of_range");
    expect(describeLocationReading(reading)).toMatch(/outside Saudi Arabia/i);
  });

  /** A link naming a place by name only yields nothing, not a nearby guess. */
  it("yields nothing for a link with no coordinates", () => {
    expect(readLocation("https://www.google.com/maps/place/Some+Pharmacy").kind).toBe(
      "unsupported",
    );
    expect(readLocation("https://example.com/not-maps").kind).toBe("unsupported");
    expect(readLocation("").kind).toBe("empty");
  });

  /** The form reads links itself; only the shortener costs a request. */
  it("spends a server call only on the link it must", () => {
    expect(section).toContain('location.kind === "needs_check"');
    expect(section).toContain("Check location");
    expect(section).toContain("alshrouqResolveLocation");
    // The button exists only for that case — no permanently disabled control.
    expect(section).toMatch(/\{location\.kind === "needs_check" && \([\s\S]{0,900}Check location/);
  });

  /** Coordinates are shown, never typed. */
  it("offers no way to type a coordinate", () => {
    expect(section).toContain("readOnly");
    expect(section).toMatch(/readOnly[\s\S]{0,120}aria-readonly="true"/);
    expect(section).not.toMatch(/onChange=\{[^}]*latitude/i);
    expect(section).not.toMatch(/onChange=\{[^}]*longitude/i);
  });
});

/* ------------------------------------------------------------------------- */
/* Branch coverage                                                           */
/* ------------------------------------------------------------------------- */

describe("branch coverage", () => {
  const option = (over: Partial<AlShrouqBranchOption>): AlShrouqBranchOption => ({
    id: "9999927657121",
    internal_code: "P0001",
    branch_name: "Hazm RDHS",
    label: "P0001 Hazm RDHS",
    covered: true,
    note: null,
    ...over,
  });

  const coverageOf = (options: AlShrouqBranchOption[], branchNo: string | null) =>
    branchCoverage(resolveAlShrouqBranch(options, branchNo));

  it("reports a covered branch, and allows the handover", () => {
    const coverage = coverageOf([option({})], "P0001");
    expect(coverage.kind).toBe("covered");
    expect(coverageAllowsDispatch(coverage)).toBe(true);
    expect(describeBranchCoverage(coverage)).toMatch(/AlShrouq delivers from this branch/i);
  });

  /** Case and padding are the agent's, not the data's. */
  it("matches a branch code however it was typed", () => {
    expect(coverageOf([option({})], " p0001 ").kind).toBe("covered");
  });

  /**
   * The warning must be unmissable and must not read as something the agent
   * typed wrong — it is not fixable, and the only useful next step is another
   * delivery method.
   */
  it("warns clearly, and blocks, on a branch AlShrouq does not serve", () => {
    const coverage = coverageOf([option({ covered: false })], "P0001");
    expect(coverage.kind).toBe("not_covered");
    expect(coverageAllowsDispatch(coverage)).toBe(false);
    const message = describeBranchCoverage(coverage);
    expect(message).toMatch(/does not cover this branch/i);
    expect(message).toMatch(/cannot be handed over/i);
    expect(message).toMatch(/another delivery method/i);
  });

  /** A branch the list does not carry is somebody else's problem to fix. */
  it("distinguishes an unlisted branch from an uncovered one", () => {
    const unlisted = coverageOf([option({})], "P9999");
    expect(unlisted).toEqual({ kind: "unlisted", reason: "not_in_crm" });
    expect(describeBranchCoverage(unlisted)).toMatch(/not in AlShrouq's list/i);

    const noId = coverageOf([option({ id: null })], "P0001");
    expect(noId).toEqual({ kind: "unlisted", reason: "no_id_published" });
    expect(describeBranchCoverage(noId)).toMatch(/no AlShrouq id/i);
  });

  /** No branch yet is not a warning. */
  it("says nothing alarming before a branch is chosen", () => {
    expect(coverageOf([option({})], null).kind).toBe("no_branch");
    expect(describeBranchCoverage({ kind: "no_branch" })).toMatch(/choose a branch/i);
  });

  /**
   * An unreachable list is never read as "covered". The server returns empty
   * lists on failure, which resolves to `not_in_crm` and blocks — failing closed.
   */
  it("never assumes coverage when the list is missing", () => {
    expect(coverageAllowsDispatch(branchCoverage(null))).toBe(false);
    expect(coverageAllowsDispatch(coverageOf([], "P0001"))).toBe(false);
  });

  /**
   * Coverage comes from the CRM's live `branch_options`, the only list carrying
   * `covered`. No branch id and no copy of the workbook is written down here —
   * a frozen list cannot learn that a branch stopped being served, which is why
   * the reverted integration's migration was wrong to exist.
   */
  it("holds no branch ids of its own", () => {
    const requirements = read("../order-requirements.ts");
    const hook = read("../use-alshrouq-order.ts");
    for (const source of [requirements, hook, section]) {
      // The AlShrouq ids are 13-digit numbers beginning 99999.
      expect(source).not.toMatch(/\b99999\d{8}\b/);
      // A branch code as *data* — quoted or listed. Prose that names one while
      // explaining why the mapping is not stored here is not a mapping.
      expect(source).not.toMatch(/["\x27][Pp]0\d{3}["\x27]/);
    }
    expect(hook).toContain("resolveAlShrouqBranch(options.branchOptions, branchNo)");
  });

  /** And no credential from the workbook that carries the same mapping. */
  it("carries no AlShrouq credential", () => {
    for (const source of [
      read("../order-requirements.ts"),
      read("../use-alshrouq-order.ts"),
      section,
      dialog,
      card,
    ]) {
      expect(source).not.toMatch(/alshrouqdelivery\.com/i);
      expect(source).not.toMatch(/shams@alshrouq/i);
      expect(source).not.toMatch(/webhook_auth_value/);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* What AlShrouq makes required                                              */
/* ------------------------------------------------------------------------- */

describe("what AlShrouq requires of an order", () => {
  const covered: BranchCoverage = { kind: "covered", branchName: "Hazm RDHS" };

  const complete = (over: Partial<AlShrouqOrderInput> = {}): AlShrouqOrderInput => ({
    deliveryType: "AlShrouq",
    customerName: "Abdullah",
    customerPhone: "0551234567",
    mapUrl: "https://www.google.com/maps?q=24.537276,46.645605",
    latitude: "24.537276",
    longitude: "46.645605",
    paymentType: "3",
    ...over,
  });

  it("is satisfied by a complete order on a covered branch", () => {
    expect(alshrouqRequirements(complete(), covered)).toEqual([]);
    expect(readyForAlShrouq(complete(), covered)).toBe(true);
  });

  const missing = (over: Partial<AlShrouqOrderInput>) =>
    alshrouqRequirements(complete(over), covered).map((r) => r.field);

  it("requires the customer's name", () => {
    expect(missing({ customerName: "  " })).toContain("customer_name");
  });

  it("requires the customer's phone", () => {
    expect(missing({ customerPhone: "" })).toContain("customer_phone");
  });

  it("requires a payment method, and never guesses one", () => {
    expect(missing({ paymentType: "" })).toContain("payment_type");
    const message = alshrouqRequirements(complete({ paymentType: "" }), covered)[0]!.message;
    expect(message).toMatch(/how the customer pays/i);
  });

  it("requires a location, and both halves of the point", () => {
    expect(missing({ mapUrl: "" })).toContain("customer_location");
    expect(missing({ latitude: "", longitude: "" })).toEqual(
      expect.arrayContaining(["customer_lat", "customer_lng"]),
    );
    // Half a point is not a location.
    expect(missing({ longitude: "" })).toContain("customer_lng");
  });

  it("blocks an uncovered branch", () => {
    const fields = alshrouqRequirements(complete(), {
      kind: "not_covered",
      branchName: "Hazm RDHS",
      note: null,
    }).map((r) => r.field);
    expect(fields).toContain("branch_coverage");
    expect(
      readyForAlShrouq(complete(), { kind: "not_covered", branchName: null, note: null }),
    ).toBe(false);
  });

  /**
   * The safety property the whole design rests on: none of this can reach an
   * ordinary order. Every other delivery method exits before any rule runs.
   */
  it.each(["Store Pickup", "Azman", "Branch Scooter", ""])(
    "says nothing at all about a %s order",
    (deliveryType) => {
      const empty: AlShrouqOrderInput = {
        deliveryType,
        customerName: "",
        customerPhone: "",
        mapUrl: "",
        latitude: "",
        longitude: "",
        paymentType: "",
      };
      expect(alshrouqRequirements(empty, { kind: "no_branch" })).toEqual([]);
      expect(readyForAlShrouq(empty, { kind: "no_branch" })).toBe(true);
    },
  );

  /** It returns problems; it never throws one into a submit handler. */
  it("returns issues rather than throwing", () => {
    expect(() =>
      alshrouqRequirements(complete({ customerName: "" }), { kind: "unknown" }),
    ).not.toThrow();
  });

  /** And the save path is still untouched by any of it. */
  it("leaves orderFormSchema and the payload builder alone", () => {
    const schema = read("../../orders/schema.ts");
    const payload = read("../../orders/payload.ts");
    for (const source of [schema, payload]) {
      expect(source).not.toMatch(/alshrouq/i);
      expect(source).not.toContain("payment_type");
    }
    const hook = read("../../orders/hooks/use-order-form.ts");
    expect(hook).not.toMatch(/alshrouq/i);
  });

  /** The form marks them required where the agent can see it. */
  it("marks the customer fields required on the form", () => {
    expect(orderForm).toContain("required={alshrouq.active}");
    expect(orderForm).toContain("optional={!alshrouq.active}");
    expect(orderForm).toContain("<AlShrouqOrderRequirements");
  });

  /** And the handover is refused while anything is missing. */
  it("disables the handover until every requirement is met", () => {
    // `schedulePast` joined the guard with the picker: the controls disable a
    // time that has gone, and this refuses one that got through anyway.
    expect(dialog).toContain("disabled={busy || !ready || schedulePast}");
    expect(dialog).toContain("AlShrouq delivery is not available yet");
  });
});

/* ------------------------------------------------------------------------- */
/* Nothing cramps, and nothing scrolls sideways                              */
/* ------------------------------------------------------------------------- */

describe("the layout survives a phone", () => {
  /**
   * Every grid starts at one column and earns a second, rather than starting at
   * two and being squeezed into a 375px screen.
   */
  it("stacks its grids before it splits them", () => {
    for (const source of [card, dialog, section]) {
      for (const grid of source.match(/(?<!sm:)grid-cols-\d/g) ?? []) {
        expect(grid).toBe("grid-cols-1");
      }
    }
  });

  /**
   * The dialog is bounded on both axes by the viewport, so it can neither be
   * wider than the screen nor taller than it.
   */
  it("bounds the dialog to the viewport", () => {
    expect(dialog).toContain("max-h-[85vh]");
    expect(dialog).toContain("w-[calc(100vw-2rem)]");
    // 34rem = 544px, inside the 500–560px this confirmation is designed for.
    // `max-h`/`overflow-y-auto` are a last resort for a genuinely short screen,
    // not the way the height is made to fit — see the density notes in the file.
    expect(dialog).toContain("max-w-[34rem]");
  });

  /**
   * Nothing inside it is unbreakable. A long value wraps in its own column
   * rather than widening the dialog, and the raw URL — the one genuinely
   * unbreakable string in the flow — is never printed at all.
   */
  it("lets every value in the dialog break", () => {
    expect(dialog).toContain("break-words");
    expect(dialog).toContain("min-w-0");
    expect(dialog).not.toMatch(/\{mapUrl\}/);
  });

  /**
   * The horizontal scrollbar had a cause, and this is the fix for it rather
   * than a cover for it. `DialogContent` is a `grid` with an implicit `auto`
   * column, so its single track was sized to the *max-content* width of its
   * widest child: one long summary value widened the track, every sibling
   * stretched to match, and the dialog overflowed its own `max-width`. A track
   * that may shrink to zero constrains the children instead.
   */
  it("fixes the overflow at the grid rather than hiding it", () => {
    expect(dialog).toContain("grid-cols-[minmax(0,1fr)]");
    expect(dialog).not.toContain("overflow-x-hidden");
    expect(dialog).not.toContain("overflow-x-clip");
  });

  /** No fixed pixel widths, which are what actually force a sideways scroll. */
  it("uses no fixed widths anywhere in the flow", () => {
    for (const source of [card, dialog, section]) {
      expect(source).not.toMatch(/\bw-\[\d+px\]/);
      expect(source).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
    }
  });

  /**
   * The actions are thumb-sized targets on a narrow screen, and cost two rows
   * rather than three.
   *
   * Three stacked full-width buttons were 136px of a phone's height, which is
   * most of what pushed the scheduling state past the viewport. The two
   * secondary actions now share a row inside a wrapper that becomes
   * `display: contents` from `sm` up, so the desktop footer is one row of three
   * exactly as before and nothing was removed to buy the space.
   */
  it("gives the actions room on a phone", () => {
    // The primary spans the width on its own; the secondaries share a row.
    expect(dialog.match(/w-full sm:w-auto/g) ?? []).toHaveLength(1);
    expect(dialog.match(/flex-1 sm:w-auto sm:flex-none/g) ?? []).toHaveLength(2);
    expect(dialog).toContain('className="flex gap-2 sm:contents"');
    expect(card).toContain("w-full sm:w-auto");
    expect(dialog).toContain("flex-col-reverse gap-2 sm:flex-row sm:justify-end");
  });

  /** The location row on the form stacks its input and its button too. */
  it("stacks the location controls before it puts them side by side", () => {
    expect(section).toContain("flex flex-col gap-2 sm:flex-row");
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

  /** One AlShrouq state, shared: the form fills it, the card and dialog read it. */
  it("shares one AlShrouq state across the form, the card and the dialog", () => {
    expect(orderForm).toContain("const alshrouq = useAlShrouqOrder(");
    expect(orderForm).toContain("alshrouq={alshrouq}");
    expect(orderForm.match(/alshrouq=\{alshrouq\}/g) ?? []).toHaveLength(2);
    expect(card).toContain("alshrouq.coverage");
  });
});
