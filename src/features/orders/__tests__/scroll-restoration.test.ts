import { describe, expect, it } from "vitest";
import { decideRestore } from "../hooks/use-orders-scroll-restoration";

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
