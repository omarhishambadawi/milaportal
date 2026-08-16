import { describe, expect, it } from "vitest";
import {
  RETURN_HIGHLIGHT_MS,
  decideRestore,
  isRowVisible,
  scrollTopForRow,
  armOrderReturn,
  isLeaving,
  setReturnedOrderId,
  takeReturnedOrderId,
} from "../hooks/use-orders-scroll-restoration";

/**
 * The rule these pin: a row that is missing while the query is still fetching
 * means "not yet"; a row still missing once it has settled means "not here".
 *
 * That distinction is the whole reason the restore needs no timeout. Collapse it
 * — treat any missing row as absent — and the restore fires against a half-built
 * list, scrolls to an offset the incoming rows immediately invalidate, and the
 * agent lands back at the top, which is the bug this replaced.
 */

const base = { ready: true, settled: true, hasAnchor: true, rowFound: false, fallbackY: 900 };

describe("decideRestore", () => {
  it("does nothing until the list can be scrolled", () => {
    expect(decideRestore({ ...base, ready: false, rowFound: true }).kind).toBe("none");
  });

  it("goes to the edited row whenever it is on screen", () => {
    expect(decideRestore({ ...base, rowFound: true }).kind).toBe("row");
    // Even mid-fetch: the row is right there, and waiting for the refetch to
    // finish would only delay putting the agent back where they were.
    expect(decideRestore({ ...base, rowFound: true, settled: false }).kind).toBe("row");
    // And even with no offset to fall back on.
    expect(decideRestore({ ...base, rowFound: true, fallbackY: 0 }).kind).toBe("row");
  });

  it("waits, rather than falling back, while the row could still arrive", () => {
    expect(decideRestore({ ...base, settled: false }).kind).toBe("wait");
  });

  it("falls back once the query has settled without the row", () => {
    // The edited order changed status/date and no longer matches the filter, or
    // moved to another page. The remembered offset is the best answer left.
    expect(decideRestore({ ...base }).kind).toBe("offset");
  });

  it("never waits when there is no order to wait for", () => {
    // Arriving from elsewhere in the app: there is no anchor, so a mid-fetch
    // commit must not park the restore forever — the plain offset applies.
    expect(decideRestore({ ...base, hasAnchor: false, settled: false }).kind).toBe("offset");
  });

  it("does nothing when there is nowhere to go back to", () => {
    // Top of the list, no anchor: restoring would be a no-op scroll to 0.
    expect(decideRestore({ ...base, hasAnchor: false, fallbackY: 0 }).kind).toBe("none");
    expect(decideRestore({ ...base, fallbackY: 0 }).kind).toBe("none");
  });
});

/**
 * The arithmetic that makes the return seamless rather than merely close: the
 * row goes back to the *same screen position* it held, so the agent's eye does
 * not have to re-find it. Sign errors here are invisible in review and obvious
 * only as a page that scrolls the wrong way.
 */
describe("scrollTopForRow", () => {
  it("leaves the page alone when the row is already where it was", () => {
    expect(scrollTopForRow({ scrollY: 4000, rowTop: 300, targetOffset: 300 })).toBe(4000);
  });

  it("scrolls down when the save pushed the row further down the page", () => {
    // Row now sits 500px down the viewport but was at 300 — scroll down by 200
    // to lift it back to 300.
    expect(scrollTopForRow({ scrollY: 4000, rowTop: 500, targetOffset: 300 })).toBe(4200);
  });

  it("scrolls up when rows above it disappeared", () => {
    expect(scrollTopForRow({ scrollY: 4000, rowTop: 120, targetOffset: 300 })).toBe(3820);
  });

  it("never asks the page to scroll above the top", () => {
    // A row near the top of a now-much-shorter list: the naive result is
    // negative, which some browsers accept and others clamp inconsistently.
    expect(scrollTopForRow({ scrollY: 40, rowTop: 10, targetOffset: 600 })).toBe(0);
  });
});

describe("isRowVisible", () => {
  const viewport = 800;

  it("accepts a row fully inside the viewport", () => {
    expect(isRowVisible(300, 72, viewport)).toBe(true);
  });

  it("rejects a row scrolled off the top or past the bottom", () => {
    expect(isRowVisible(-10, 72, viewport)).toBe(false);
    expect(isRowVisible(760, 72, viewport)).toBe(false);
  });

  it("accepts a row taller than the viewport once its top is in view", () => {
    // Otherwise a very tall row (many stacked invoice numbers) would be judged
    // invisible forever and trigger an endless re-centre.
    expect(isRowVisible(0, 1200, viewport)).toBe(true);
  });
});

/**
 * The mark on the row the agent just came back from.
 *
 * This is a *separate* slot from the scroll anchor, and the separation is the
 * whole fix. The mark was previously set inside the restore, in the one branch
 * where it both had an anchor and found the row in the DOM on that exact commit.
 * Every other way of coming back — the row rendering a commit later, the list
 * already settled, the browser's own back-button scroll restoration — took a
 * different branch and produced no mark at all, which is why nothing was ever
 * visible.
 */
describe("the returned-from order", () => {
  it("is remembered on the way out and read on the way back", () => {
    setReturnedOrderId("order-8937");
    expect(takeReturnedOrderId()).toBe("order-8937");
  });

  it("is consumed, so one return marks exactly one row once", () => {
    setReturnedOrderId("order-8937");
    expect(takeReturnedOrderId()).toBe("order-8937");
    // Every later render of the same list must find nothing left to claim,
    // or a refetch would re-arm the flash indefinitely.
    expect(takeReturnedOrderId()).toBeNull();
  });

  it("is empty when the agent arrives from anywhere else", () => {
    setReturnedOrderId(null);
    expect(takeReturnedOrderId()).toBeNull();
  });

  it("does not depend on the restore finding the row", () => {
    // The case that was broken: the row is not in the DOM on the commit the
    // restore runs, so `decideRestore` never reaches `row` — and the mark must
    // survive that, because the class is applied by id when the row renders.
    setReturnedOrderId("order-8937");
    const action = decideRestore({
      ready: true,
      settled: true,
      hasAnchor: true,
      rowFound: false,
      fallbackY: 400,
    });
    expect(action.kind).toBe("offset");
    expect(takeReturnedOrderId()).toBe("order-8937");
  });

  it("outlives the flash it triggers, so the class is not pulled mid-animation", () => {
    // The CSS animation is 2.8s; the state that applies it must last longer.
    expect(RETURN_HIGHLIGHT_MS).toBeGreaterThan(2800);
  });
});

/**
 * The arming rule, which is the whole bug.
 *
 * Opening an order re-mounts the Orders list *during the outgoing transition* —
 * the router keeps the old route rendered while the lazily-split detail
 * component loads. A claim that ran on mount therefore consumed the id on the
 * way out, and the row flashed on a list the agent was already leaving; by the
 * time they came back there was nothing left to claim. Measured in the browser:
 * `parked` at t=9701, `claimed` at t=9807, and at t=9967 the mark was live and
 * animating while `location.pathname` was already the detail route.
 *
 * Arming on unmount did not fix it either — that transition is a full
 * unmount/remount cycle, so the unmount armed it and the very next mount claimed
 * it 6ms later. Only the *order page mounting* is downstream of the whole
 * transition, so that is what arms the return.
 *
 * The same guard covers the scroll anchor, which had been silently losing the
 * position the same way: the premature mount consumed it and latched `restored`,
 * so coming back landed at the top of the list.
 */
describe("a return is only claimable once the agent has arrived", () => {
  it("refuses to be claimed while still leaving", () => {
    setReturnedOrderId("order-8990", false);
    expect(isLeaving()).toBe(true);
    // The mid-transition remount asks, and must be told no.
    expect(takeReturnedOrderId()).toBeNull();
    // …and asking must not have consumed it.
    expect(isLeaving()).toBe(true);
  });

  it("becomes claimable once the order page mounts", () => {
    setReturnedOrderId("order-8990", false);
    armOrderReturn();
    expect(isLeaving()).toBe(false);
    expect(takeReturnedOrderId()).toBe("order-8990");
  });

  it("is consumed exactly once, so a refetch cannot re-arm the flash", () => {
    setReturnedOrderId("order-8990", false);
    armOrderReturn();
    expect(takeReturnedOrderId()).toBe("order-8990");
    expect(takeReturnedOrderId()).toBeNull();
  });

  it("reports no trip in progress when nothing was parked", () => {
    setReturnedOrderId(null);
    expect(isLeaving()).toBe(false);
    expect(takeReturnedOrderId()).toBeNull();
  });

  it("arming without a parked order is a no-op", () => {
    setReturnedOrderId(null);
    armOrderReturn();
    expect(takeReturnedOrderId()).toBeNull();
  });
});
