/**
 * What the screen says when this deployment cannot call a courier — and what
 * the time picker does with a date and a time together.
 *
 * ## The report
 *
 * An agent filled in an AlShrouq order, chose **Create order + AlShrouq
 * delivery**, and got a toast reading *"AlShrouq dispatch is switched off, so
 * no courier was contacted."* Reopening the order showed **Ready to send** and
 * a **Send to AlShrouq** button, so they pressed it and got the same toast
 * again.
 *
 * Nothing there was lying, and that is what made it hard to see. The pipeline
 * ran, the gate stopped it before the POST, and the toast said so accurately.
 * The bug is one of *sequence*: the agent was told after committing what they
 * could have been told before, and the card described an order the deployment
 * could not send as one that was ready to go.
 *
 * ## What changed, and what deliberately did not
 *
 * The gate itself is untouched. `ALSHROUQ_LIVE_DISPATCH_ENABLED` is still read
 * inside `alshrouq-dispatch.server.ts` and nowhere else, it is still not a
 * parameter, and an immediate handover with it shut still writes **no row**.
 * These tests assert all three, because the fix must not have quietly opened
 * anything.
 *
 * What changed is that the server now *reports* the answer, one-way, and the
 * card and dialog stop offering a handover they know cannot happen. The order
 * and every AlShrouq field on it are saved either way — the promise is
 * withdrawn, not the data.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeApprovalAction,
  explainAlShrouqReadiness,
  type AlShrouqReadiness,
} from "../dispatch-presentation";
import { describeApprovalResult } from "../approval";
import { parseScheduleInput } from "../scheduling";
import { HOUR_OPTIONS, MERIDIEM_OPTIONS, MINUTE_OPTIONS } from "../schedule-picker";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const card = read("../components/dispatch-section.tsx");
const dialog = read("../components/approval-dialog.tsx");
const service = read("../../../lib/shams-crm/alshrouq-dispatch.server.ts");
const functions = read("../../../lib/shams.functions.ts");

/* ------------------------------------------------------------------------- */
/* I — a shut gate never claims a courier                                    */
/* ------------------------------------------------------------------------- */

describe("a shut gate is never reported as a delivery", () => {
  /**
   * The sentence an agent reads for `prepared`. It has always been honest, and
   * this pins it so it cannot drift into the reassuring wording that would make
   * the whole feature dangerous.
   */
  it("says no courier was contacted, and never says sent", () => {
    const { tone, message } = describeApprovalResult(
      { kind: "prepared", payload: {} as never, liveDispatchEnabled: false } as never,
      true,
    );
    expect(tone).toBe("info");
    expect(message).toContain("no courier was contacted");
    expect(message).not.toMatch(/\bSent to AlShrouq\b/);
    expect(message).not.toMatch(/\baccepted\b/i);
  });

  /** The card's own vocabulary for it. Not "ready", and not an error either. */
  it("describes the deployment rather than blaming the order", () => {
    const sentence = explainAlShrouqReadiness("prepared_only");
    expect(sentence).toContain("switched off");
    expect(sentence).toContain("no courier");
    // The details are kept, and the agent is told so — otherwise they re-enter
    // everything on the assumption it was lost.
    expect(sentence).toMatch(/saved/i);
    // It must not read as a permanent property of this order.
    expect(sentence).not.toBe(explainAlShrouqReadiness("unavailable"));
  });

  /** Every readiness still answers, so no state can fall through to blank. */
  it.each<AlShrouqReadiness>([
    "draft",
    "checking",
    "ready",
    "prepared_only",
    "unverified",
    "unavailable",
  ])("explains %s", (readiness) => {
    expect(explainAlShrouqReadiness(readiness).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- */
/* The button stops promising                                                */
/* ------------------------------------------------------------------------- */

describe("the primary action does not promise what cannot happen", () => {
  it("drops the hand-over wording when dispatch is unavailable", () => {
    const immediate = describeApprovalAction("create", "dispatch", null, false);
    expect(immediate).toContain("no courier is contacted");
    expect(immediate).not.toContain("hands it to AlShrouq");
    // The order and its details are still saved, and it says so.
    expect(immediate).toMatch(/Saves the order/);
  });

  /**
   * A scheduled handover reserves a slot without contacting anyone, so it is
   * normally the honest one to offer — but on a gated deployment the worker
   * that would eventually send it reads the same gate. One sentence covers
   * both, and neither promises a courier.
   */
  it("does not promise a scheduled courier either", () => {
    const scheduled = describeApprovalAction(
      "create",
      "dispatch",
      "Aug 24, 2026 · 07:30 PM",
      false,
    );
    expect(scheduled).toContain("no courier is contacted");
    expect(scheduled).not.toContain("reserves the delivery for");
  });

  /** With the gate open, every existing sentence is exactly what it was. */
  it("is unchanged when dispatch is available", () => {
    expect(describeApprovalAction("create", "dispatch", null)).toBe(
      "Saves the order and hands it to AlShrouq straight away.",
    );
    expect(describeApprovalAction("existing", "dispatch", null, true)).toBe(
      "Hands this order to AlShrouq straight away.",
    );
    expect(describeApprovalAction("create", "dispatch", "Aug 24, 2026 · 07:30 PM", true)).toContain(
      "reserves the delivery for",
    );
  });

  /**
   * "Create order only" was already accurate about contacting nobody, so the
   * gate must not change it — a sentence that changes for no reason is one
   * agents stop trusting.
   */
  it("leaves the order-only wording alone", () => {
    expect(describeApprovalAction("create", "order_only", null, false)).toBe(
      describeApprovalAction("create", "order_only", null, true),
    );
  });
});

/* ------------------------------------------------------------------------- */
/* H — the send control is withheld, and the data is not                     */
/* ------------------------------------------------------------------------- */

describe("the surfaces read the reported availability", () => {
  it("withholds the send control when no courier can be reached", () => {
    expect(card).toContain("const canContactCourier = ctx?.dispatchAvailable !== false");
    // It joins the same `ready` that already excludes a handed-over order.
    expect(card).toMatch(/covered && canContactCourier/);
    // And the badge says prepared rather than ready.
    expect(card).toContain('"prepared_only"');
    expect(card).toContain("Prepared — dispatch unavailable");
  });

  it("refuses the dialog's action rather than reporting it afterwards", () => {
    expect(dialog).toContain("disabled={busy || !ready || schedulePast || !dispatchAvailable}");
    expect(dialog).toContain("const primaryLabel = !dispatchAvailable");
    expect(dialog).toContain("AlShrouq dispatch unavailable");
  });

  /**
   * Optimistic while the answer is in flight, on both surfaces. A card that
   * flashed "switched off" on every page load would train agents to ignore it.
   */
  it("does not claim unavailability before the server has answered", () => {
    expect(card).toContain("!== false");
    expect(read("../use-alshrouq-order.ts")).toContain(
      "dispatchAvailable: options?.dispatchAvailable !== false",
    );
  });
});

/* ------------------------------------------------------------------------- */
/* The gate itself is untouched                                              */
/* ------------------------------------------------------------------------- */

describe("reporting the gate did not open it", () => {
  it("still reads the environment in the service and nowhere else", () => {
    expect(service).toContain('process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED === "true"');
    for (const source of [card, dialog]) {
      expect(source).not.toContain("ALSHROUQ_LIVE_DISPATCH_ENABLED");
      expect(source).not.toContain("process.env");
    }
  });

  /**
   * The report travels one way. It is computed through the service's own
   * accessor and returned; nothing reads it off a request, so there is no field
   * a crafted call could set to open the gate.
   */
  it("computes availability on the server, never from the caller", () => {
    expect(functions).toContain("dispatchAvailable: isAlShrouqLiveDispatchEnabled()");
    // Not accepted as input by either server function that reports it.
    expect(functions).not.toMatch(/dispatchAvailable\s*:\s*z\./);
    expect(functions).not.toMatch(/data\.dispatchAvailable/);
  });

  /** And `dispatchOrderToAlShrouq` still does not consult anything but the gate. */
  it("keeps the dispatch decision out of the report", () => {
    expect(service).not.toContain("dispatchAvailable");
  });
});

/* ------------------------------------------------------------------------- */
/* A and the idempotence cases — a courier is only ever asked for on purpose  */
/* ------------------------------------------------------------------------- */

describe("nothing dispatches without an explicit action", () => {
  const createHook = read("../use-create-approval.ts");

  /**
   * A — "Create order only" returns before the send.
   *
   * The guard is the first statement after the plan is taken, so there is no
   * path between choosing it and `send(...)`.
   */
  it("returns from the create journey before sending for an order-only choice", () => {
    expect(createHook).toContain('if (!current || current.intent !== "dispatch") return;');
    expect(createHook.indexOf('current.intent !== "dispatch"')).toBeLessThan(
      createHook.indexOf("await send("),
    );
  });

  /**
   * The plan is consumed, not remembered. `afterCreate` clears the ref before
   * it does anything else, so a second call — a re-render, a retried submit —
   * finds nothing to send rather than sending the same handover twice.
   */
  it("consumes the approved plan so a second call sends nothing", () => {
    expect(createHook).toContain("plan.current = null;");
    expect(createHook.indexOf("plan.current = null;")).toBeLessThan(
      createHook.indexOf("await send("),
    );
  });

  /**
   * Refreshing, reopening, refetching and navigating back all re-run queries
   * and effects. None of them can dispatch, because no effect ever does: the
   * only two callers are a mutation behind the card's button and `afterCreate`
   * behind the create dialog's.
   */
  it("has no effect-driven dispatch anywhere in the path", () => {
    for (const source of [card, createHook, read("../use-order-dispatch.ts")]) {
      expect(source).not.toContain("useEffect");
    }
    // The read-only hook cannot reach the dispatch function at all.
    expect(read("../use-order-dispatch.ts")).not.toContain("alshrouqDispatchOrder");
  });

  /**
   * And behind the UI, the database is what actually guarantees it. The
   * duplicate check runs before anything is built or sent, against the same
   * predicate as the unique index, so two racing requests cannot both win.
   */
  it("checks for an existing dispatch before building or sending anything", () => {
    const check = service.indexOf("const existing = await liveDispatch(supabase, orderId)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(service.indexOf("deps.createOrder("));
    expect(service).toContain('.is("cancelled_at", null)');
  });
});

/* ------------------------------------------------------------------------- */
/* J and K — the whole datetime decides, never one unit                      */
/* ------------------------------------------------------------------------- */

describe("the picker judges a date and a time together", () => {
  /** 10:15 PM in Riyadh, which is 19:15 UTC. */
  const now = new Date("2026-08-22T19:15:00.000Z");

  it("offers every hour, minute and meridiem whatever the clock says", () => {
    expect(HOUR_OPTIONS).toHaveLength(12);
    expect(MINUTE_OPTIONS).toHaveLength(60);
    expect(MERIDIEM_OPTIONS).toEqual(["AM", "PM"]);
  });

  it("refuses 9 PM today and accepts 9 PM tomorrow", () => {
    const today = parseScheduleInput("2026-08-22", "09:00 PM", now);
    expect(today.ok).toBe(false);
    if (!today.ok) expect(today.reason).toBe("past");

    const tomorrow = parseScheduleInput("2026-08-23", "09:00 PM", now);
    expect(tomorrow.ok).toBe(true);
  });

  it("accepts 9 AM tomorrow, which a per-unit rule also blocked", () => {
    expect(parseScheduleInput("2026-08-23", "09:00 AM", now).ok).toBe(true);
    expect(parseScheduleInput("2026-08-23", "01:00 AM", now).ok).toBe(true);
  });

  it("accepts a later hour today", () => {
    const later = parseScheduleInput("2026-08-22", "11:00 PM", now);
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.timing).toBe("scheduled");
  });

  /** K — the meridiem alone flips validity, on one unchanged date. */
  it("re-evaluates when only AM/PM changes", () => {
    expect(parseScheduleInput("2026-08-23", "09:00 AM", now).ok).toBe(true);
    expect(parseScheduleInput("2026-08-23", "09:00 PM", now).ok).toBe(true);
    // 9 AM today has gone; 11 PM today has not. Same date, same hour digits.
    expect(parseScheduleInput("2026-08-22", "09:00 AM", now).ok).toBe(false);
  });

  /**
   * The same hour, judged twice, by moving only the date. This is the journey
   * the old per-unit rule made impossible: the hour had to survive being
   * invalid on today's date long enough to be moved to tomorrow's.
   */
  it("re-evaluates the same time as the date moves and moves back", () => {
    const time = "09:00 PM";
    expect(parseScheduleInput("2026-08-22", time, now).ok).toBe(false);
    expect(parseScheduleInput("2026-08-23", time, now).ok).toBe(true);
    expect(parseScheduleInput("2026-08-22", time, now).ok).toBe(false);
  });

  /** Nothing snaps the selection forward as it is being made. */
  it("records the choice exactly as made", () => {
    expect(dialog).toContain("const pick = (next: ScheduleSelection) => setWhen(next);");
    expect(dialog).not.toContain("clampSelection");
    // No per-option predicate reaches the unit lists.
    expect(dialog).not.toContain("disabled={isPast");
  });
});

/* ------------------------------------------------------------------------- */
/* A refused payload names the field it refused                              */
/* ------------------------------------------------------------------------- */

describe("an incomplete dispatch says which field", () => {
  /**
   * The report: an agent looking at a branch, a customer, a phone and a pin all
   * visibly filled in was told "The AlShrouq details were incomplete", which
   * names nothing and cannot be acted on. The per-field list was in the result
   * the whole time and the sentence discarded it.
   */
  it("uses the server's own field messages", () => {
    const { tone, message } = describeApprovalResult(
      {
        kind: "invalid",
        errors: [
          { field: "customer_phone", message: "A customer phone number is required." },
          { field: "customer_lat", message: "The delivery location is missing coordinates." },
        ],
      } as never,
      true,
    );
    expect(tone).toBe("error");
    expect(message).toContain("customer phone number is required");
    expect(message).toContain("missing coordinates");
    // Still says nothing was sent, and still does not name a column at an agent.
    expect(message).toContain("Nothing was sent");
    expect(message).not.toContain("customer_phone");
    expect(message).not.toContain("were incomplete");
  });

  /** An empty or absent list falls back rather than producing a blank sentence. */
  it("keeps the generic sentence as the floor", () => {
    const { message } = describeApprovalResult({ kind: "invalid", errors: [] } as never, false);
    expect(message).toBe("The AlShrouq details were incomplete. Nothing was sent.");
  });
});
