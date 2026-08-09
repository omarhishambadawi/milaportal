import { describe, expect, it } from "vitest";
import {
  decideRestore,
  isRowVisible,
  scrollTopForRow,
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
