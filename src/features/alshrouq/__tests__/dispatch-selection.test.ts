/**
 * The AlShrouq card's survival across a reopen, and the row it reports on.
 *
 * ## The bug this exists for
 *
 * An order was created with an AlShrouq delivery, the delivery was scheduled,
 * and the card showed it. The agent left the order and opened it again: the
 * activity timeline still narrated the scheduled dispatch — *from the dispatch
 * rows* — and the card beside it was gone.
 *
 * Two surfaces, one delivery, two different sources. The timeline rendered from
 * the persisted rows; the card was gated on `form.delivery_type`, which is React
 * state written by an effect that runs once per order id after the `orders`
 * fetch resolves. Everything downstream of that gate was correct and none of it
 * ran. So the assertions here are about *where the decision reads from*, and the
 * suite deliberately never constructs a form state that is already hydrated —
 * that is the state the bug does not occur in.
 *
 * Nothing renders: the decisions are pure functions precisely so they can be
 * tested without a DOM, which is also what stopped them being three inline
 * expressions in three components.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  currentDispatch,
  latestDispatch,
  showAlShrouqSection,
  shownDispatch,
} from "../dispatch-selection";

/** A dispatch row, in the shape the client reads it. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    dispatch_status: "scheduled",
    cancelled_at: null as string | null,
    created_at: "2026-08-22T13:58:00Z",
    ...over,
  };
}

/**
 * One page load, with **no client state at all**.
 *
 * This is the whole point of the regression: a reopen, a browser refresh and a
 * fresh login all start here — an empty form, an empty cache, and whatever the
 * database holds. If the card needs anything more than this to appear, it can
 * disappear again.
 */
function freshLoad(db: { deliveryType: string | null; rows: ReturnType<typeof row>[] }) {
  return showAlShrouqSection({
    storedDeliveryType: db.deliveryType,
    // Empty, because `useOrderForm` seeds the form in an effect that has not run.
    formDeliveryType: "",
    hasDispatchHistory: db.rows.length > 0,
  });
}

describe("which dispatch a surface reports on", () => {
  it("treats the row with no cancellation as the live one", () => {
    const live = row({ id: "b", cancelled_at: null });
    const rows = [row({ id: "a", cancelled_at: "2026-08-21T10:00:00Z" }), live];
    expect(currentDispatch(rows)).toBe(live);
  });

  it("has no live dispatch once every row is cancelled", () => {
    const rows = [row({ id: "a", cancelled_at: "2026-08-21T10:00:00Z" })];
    expect(currentDispatch(rows)).toBeNull();
  });

  it("takes the newest row last, matching the query's ascending order", () => {
    const newest = row({ id: "c", created_at: "2026-08-22T15:00:00Z" });
    const rows = [
      row({ id: "a", created_at: "2026-08-20T09:00:00Z" }),
      row({ id: "b", created_at: "2026-08-21T09:00:00Z" }),
      newest,
    ];
    expect(latestDispatch(rows)).toBe(newest);
  });

  it("reports on the live row when there is one", () => {
    const live = row({ id: "b", cancelled_at: null });
    expect(shownDispatch([row({ id: "a", cancelled_at: "2026-08-21T10:00:00Z" }), live])).toBe(
      live,
    );
  });

  it("falls back to the newest cancelled row rather than reporting nothing", () => {
    // An order whose only delivery was called off still had a delivery, and the
    // card is the only place that says so.
    const second = row({ id: "b", cancelled_at: "2026-08-22T12:00:00Z" });
    const rows = [row({ id: "a", cancelled_at: "2026-08-21T10:00:00Z" }), second];
    expect(shownDispatch(rows)).toBe(second);
  });

  it("has nothing to report for an order that was never dispatched", () => {
    expect(shownDispatch([])).toBeNull();
    expect(latestDispatch([])).toBeNull();
  });
});

describe("the card survives a reopen", () => {
  /*
   * Each of these is the same journey: the dispatch exists in the database, the
   * client has just been created and holds nothing, and the form has not been
   * hydrated yet. Before the fix every one of them rendered no card while the
   * timeline rendered the dispatch.
   */
  const states = [
    { name: "scheduled", patch: { dispatch_status: "scheduled" } },
    { name: "accepted", patch: { dispatch_status: "accepted", external_order_id: "6099196" } },
    { name: "failed", patch: { dispatch_status: "failed", last_error: "refused" } },
    { name: "indeterminate", patch: { dispatch_status: "indeterminate" } },
    {
      name: "cancelled",
      patch: { dispatch_status: "scheduled", cancelled_at: "2026-08-22T14:10:00Z" },
    },
    {
      name: "resolved",
      patch: {
        dispatch_status: "indeterminate",
        resolution_outcome: "confirmed_delivered",
        resolved_at: "2026-08-22T18:00:00Z",
      },
    },
  ];

  for (const state of states) {
    it(`shows a ${state.name} dispatch after the client state is thrown away`, () => {
      expect(freshLoad({ deliveryType: "AlShrouq", rows: [row(state.patch)] })).toBe(true);
    });

    it(`shows a ${state.name} dispatch even if the order row has not arrived`, () => {
      // The `orders` fetch and the dispatch fetch are two requests and either
      // may land first. The card must not depend on which.
      expect(freshLoad({ deliveryType: null, rows: [row(state.patch)] })).toBe(true);
    });
  }

  it("shows a saved AlShrouq order that has never been dispatched", () => {
    expect(freshLoad({ deliveryType: "AlShrouq", rows: [] })).toBe(true);
  });

  it("shows an order with several dispatches, the newest of them cancelled", () => {
    const rows = [
      row({ id: "a", cancelled_at: "2026-08-21T10:00:00Z" }),
      row({ id: "b", cancelled_at: "2026-08-22T12:00:00Z" }),
    ];
    expect(freshLoad({ deliveryType: "AlShrouq", rows })).toBe(true);
    expect(shownDispatch(rows)?.id).toBe("b");
  });

  it("still shows nothing for an order that has nothing to do with AlShrouq", () => {
    // The fix must not turn the card on for every order on the system.
    expect(freshLoad({ deliveryType: "Store Pickup", rows: [] })).toBe(false);
    expect(freshLoad({ deliveryType: null, rows: [] })).toBe(false);
  });

  it("shows a draft the moment the agent picks AlShrouq, before anything is saved", () => {
    expect(
      showAlShrouqSection({
        storedDeliveryType: undefined,
        formDeliveryType: "AlShrouq",
        hasDispatchHistory: false,
      }),
    ).toBe(true);
  });

  it("does not let a stale form value hide a stored AlShrouq order", () => {
    // The mirror image: whatever the form holds, the order's own column and its
    // dispatch history are the facts.
    expect(
      showAlShrouqSection({
        storedDeliveryType: "AlShrouq",
        formDeliveryType: "Azman",
        hasDispatchHistory: true,
      }),
    ).toBe(true);
  });
});

/**
 * The wiring, asserted on the source.
 *
 * The rule above is pure and tested, and would go on passing while the order
 * form ignored it — which is exactly how the previous fix was undone: the card
 * that read the persisted order was replaced by a section behind a form-state
 * guard, and no test noticed. So the guard itself is the contract here.
 */
describe("the order form's gate", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../orders/components/order-form.tsx", import.meta.url)),
    "utf8",
  );

  it("does not gate the AlShrouq section on form state", () => {
    expect(source).not.toMatch(
      /\{form\.delivery_type === ALSHROUQ && \(\s*<AlShrouqDispatchSection/,
    );
  });

  it("gates it on the shared, tested rule", () => {
    expect(source).toContain("showAlShrouqSection({");
    expect(source).toMatch(/\{showsAlShrouqSection && \(\s*<AlShrouqDispatchSection/);
  });

  it("feeds that rule the persisted order and the persisted dispatch rows", () => {
    expect(source).toContain("storedDeliveryType:");
    expect(source).toContain("hasDispatchHistory:");
    // The same hook the card and the timeline read, so one query answers all
    // three and none of them can see a different delivery from the others.
    expect(source).toContain("useOrderAlShrouqDispatch(id,");
  });
});
