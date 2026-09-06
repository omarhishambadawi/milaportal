/**
 * "Clear" removes the reader's filters. It does not apply one.
 *
 * ---------------------------------------------------------------------------
 * The failure this pins
 * ---------------------------------------------------------------------------
 * A supervisor opens Wasfaty → **All Leads**, which exists to show the whole of
 * an import cycle — worked and unworked, open and closed. A Clear button is
 * already on screen although nothing has been filtered. They press it, and every
 * converted and closed prescription disappears.
 *
 * One mismatch caused both halves. `LeadQueue` measured "is anything filtered"
 * against, and reset to, the *queue's global* defaults — `status: "open"` —
 * while All Leads and Worked Leads rest at `status: "all"`. So the button was
 * permanently visible (the page's resting status never equalled the global one)
 * and pressing it wrote `status = "open"`, which the queue turns into
 * `.in("status", OPEN_LEAD_STATUSES)`.
 *
 * It was unrecoverable from the UI as well as invisible: Wasfaty renders the
 * outcome control in the status control's place (`statusFilter="outcome"`), so
 * there was no widget on the page holding the filter that had just been applied.
 *
 * ---------------------------------------------------------------------------
 * How it is asserted
 * ---------------------------------------------------------------------------
 * `clearedQueueFilters` and `queueFiltersActive` are the two functions the
 * button uses, extracted so both readings of one rule are exercised directly
 * rather than described. The view definitions come from `wasfaty-views.ts`, so
 * these tests follow a change to a view's resting position instead of restating
 * it — a fourth view added with a different default is covered the day it lands.
 */

import { describe, expect, it } from "vitest";

import {
  clearedQueueFilters,
  queueDefaults,
  queueFiltersActive,
  queueStateFromSearch,
  searchFromQueueState,
  validateQueueSearch,
  type QueueState,
} from "../queue-search";
import { WASFATY_VIEWS, wasfatyView } from "../wasfaty-views";
import { DEFAULT_QUEUE_FILTERS } from "../types";

/** The state a page opens in: no search params, this view's defaults applied. */
function restingState(viewId: "generated" | "all" | "worked"): QueueState {
  const defaults = wasfatyView(viewId).defaults();
  return queueStateFromSearch(validateQueueSearch({}, defaults), defaults);
}

function defaultsFor(viewId: "generated" | "all" | "worked") {
  return queueDefaults(wasfatyView(viewId).defaults());
}

/* -------------------------------------------------------------------------- */
/* The views mean what the pages claim                                         */
/* -------------------------------------------------------------------------- */

describe("what each Wasfaty view opens on", () => {
  /**
   * The premise everything below depends on, checked rather than assumed.
   *
   * If All Leads ever legitimately becomes an open-work view, this fails first
   * and the rest of the file should be re-read rather than patched.
   */
  it("All Leads and Worked Leads are retrospective; Generated is open work", () => {
    expect(restingState("all").status).toBe("all");
    expect(restingState("worked").status).toBe("all");
    expect(restingState("generated").status).toBe(DEFAULT_QUEUE_FILTERS.status);
    // The global default is the thing they must not be reset to, so the whole
    // bug is only expressible while these two differ.
    expect(DEFAULT_QUEUE_FILTERS.status).not.toBe("all");
  });

  it("All Leads shows worked and unworked; Worked Leads narrows to recorded actions", () => {
    expect(wasfatyView("all").worked).toBe("all");
    expect(wasfatyView("worked").worked).toBe("worked");
    // `worked` is the view's own predicate and is not a user filter, so Clear
    // must never touch it. It is not part of `QueueState` at all.
    expect(Object.keys(clearedQueueFilters(defaultsFor("worked")))).not.toContain("worked");
  });
});

/* -------------------------------------------------------------------------- */
/* Clear on an untouched page                                                  */
/* -------------------------------------------------------------------------- */

describe("the Clear button is offered only when it would do something", () => {
  for (const view of WASFATY_VIEWS) {
    it(`is hidden on an untouched ${view.label} page`, () => {
      expect(queueFiltersActive(restingState(view.id), defaultsFor(view.id))).toBe(false);
    });
  }

  it("appears once the reader narrows the list, on every view", () => {
    for (const view of WASFATY_VIEWS) {
      const state = { ...restingState(view.id), outcome: "no_answer" };
      expect(queueFiltersActive(state, defaultsFor(view.id))).toBe(true);
    }
  });

  it("does not count paging as a filter", () => {
    const state = { ...restingState("all"), page: 4, pageSize: 100 };
    expect(queueFiltersActive(state, defaultsFor("all"))).toBe(false);
  });

  it("ignores a search box holding only whitespace", () => {
    const state = { ...restingState("all"), term: "   " };
    expect(queueFiltersActive(state, defaultsFor("all"))).toBe(false);
    expect(queueFiltersActive({ ...state, term: " nan " }, defaultsFor("all"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* What Clear actually writes                                                  */
/* -------------------------------------------------------------------------- */

describe("Clear returns the page to where it opens", () => {
  /**
   * The regression itself, on both retrospective views.
   *
   * A supervisor who has narrowed All Leads to one agent's converted work
   * presses Clear. Every user-applied filter goes; the *view's* status does not
   * move; and nothing that was visible before becomes invisible after.
   */
  for (const viewId of ["all", "worked"] as const) {
    it(`keeps closed and converted leads visible on ${wasfatyView(viewId).label}`, () => {
      const defaults = defaultsFor(viewId);
      const filtered: QueueState = {
        ...restingState(viewId),
        status: "converted",
        outcome: "delivered",
        agent: "3f7c1a90-1c2b-4f3e-9a11-0c5b6d7e8f90",
        branch: "P0142",
        term: "insulin",
        mineOnly: true,
        page: 3,
      };

      const cleared = { ...filtered, ...clearedQueueFilters(defaults) };

      // The whole point: not "open".
      expect(cleared.status).toBe("all");
      expect(cleared.status).toBe(restingState(viewId).status);
      // And every filter the reader actually applied is gone.
      expect(cleared.outcome).toBe("all");
      expect(cleared.agent).toBe("all");
      expect(cleared.branch).toBe("all");
      expect(cleared.term).toBe("");
      expect(cleared.mineOnly).toBe(false);
      expect(cleared.page).toBe(0);
    });
  }

  it("still returns Generated Leads to open work in its daily window", () => {
    // The view that *is* a to-do list keeps its narrowing defaults. Clearing
    // there means "today's work back", not "every prescription ever imported".
    const defaults = defaultsFor("generated");
    const cleared = clearedQueueFilters(defaults);
    expect(cleared.status).toBe(DEFAULT_QUEUE_FILTERS.status);
    expect(cleared.dateFrom).toBe(defaults.dateFrom);
    expect(cleared.dateTo).toBe(defaults.dateTo);
    expect(defaults.dateFrom).not.toBe("");
  });

  /**
   * Clearing must leave the button gone.
   *
   * That is the "make the resulting state visually obvious" requirement, stated
   * as the property that produces it: the two functions read one rule, so a
   * cleared page cannot still be reported as filtered.
   */
  for (const view of WASFATY_VIEWS) {
    it(`leaves ${view.label} reporting no active filters after a Clear`, () => {
      const defaults = defaultsFor(view.id);
      const filtered: QueueState = {
        ...restingState(view.id),
        outcome: "no_answer",
        term: "nan",
        unassignedOnly: true,
        lifecycle: "archived",
      };
      expect(queueFiltersActive(filtered, defaults)).toBe(true);

      const cleared = { ...filtered, ...clearedQueueFilters(defaults) };
      expect(queueFiltersActive(cleared, defaults)).toBe(false);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* And the URL agrees                                                          */
/* -------------------------------------------------------------------------- */

describe("a cleared page writes nothing to the address bar", () => {
  /**
   * The round trip, because the URL is where a supervisor's confusion started.
   *
   * A page at its resting position writes no search params, so the link a
   * supervisor shares after clearing is the bare view URL — and opening that URL
   * reproduces exactly the list they were looking at. Before the fix the cleared
   * state carried `?status=open`, which is how "the data vanished" travelled to
   * whoever they sent it to.
   */
  for (const view of WASFATY_VIEWS) {
    it(`${view.label} clears to a bare URL that reads back unchanged`, () => {
      const defaults = defaultsFor(view.id);
      const cleared = { ...restingState(view.id), ...clearedQueueFilters(defaults) } as QueueState;

      const search = searchFromQueueState(cleared, defaults);
      expect(search.status).toBeUndefined();
      expect(search.lifecycle).toBeUndefined();

      expect(queueStateFromSearch(search, defaults)).toEqual(cleared);
    });
  }

  it("keeps an explicitly chosen Open filter on All Leads, because it differs from the default", () => {
    // The inverse of the bug: on a view resting at "all", choosing Open is a
    // real filter and must survive the URL. If the writer and the reader ever
    // disagreed about the default again, this is where it would show.
    const defaults = defaultsFor("all");
    const state: QueueState = { ...restingState("all"), status: "open" };

    const search = searchFromQueueState(state, defaults);
    expect(search.status).toBe("open");
    expect(queueStateFromSearch(search, defaults).status).toBe("open");
    expect(queueFiltersActive(state, defaults)).toBe(true);
  });
});
