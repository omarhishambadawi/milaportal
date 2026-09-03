import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  decodeQueueContext,
  encodeQueueContext,
  isDefaultQueueSearch,
  queueStateFromSearch,
  searchFromQueueState,
  validateLeadSearch,
  validateQueueSearch,
  type QueueState,
} from "../queue-search";
import { DEFAULT_PAGE_SIZE } from "../constants";
import { DEFAULT_QUEUE_FILTERS } from "../types";

/**
 * The queue's filters, kept across a lead.
 *
 * An agent filtered to Follow-up · Retention · overdue, found the lead on page
 * three, opened it, and came back to an unfiltered first page. The filters were
 * component state and a route change threw them away — as did a refresh, and as
 * did browser Back.
 *
 * The round trip is what these tests are mostly about: a state that survives
 * `searchFromQueueState` and then `queueStateFromSearch` must come back
 * identical, or returning from a lead silently drops a filter, which is the
 * same bug in a quieter form.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const QUEUE_PAGE = "routes/_app.telesales.index.tsx";
const LEAD_PAGE = "routes/_app.telesales.$id.tsx";
const ROW = "features/telesales/components/lead-row.tsx";

/** The default queue, as the page holds it. */
const DEFAULTS: QueueState = {
  leadType: DEFAULT_QUEUE_FILTERS.leadType,
  status: DEFAULT_QUEUE_FILTERS.status,
  branch: "all",
  family: "all",
  followup: DEFAULT_QUEUE_FILTERS.followup,
  lifecycle: DEFAULT_QUEUE_FILTERS.lifecycle,
  term: "",
  mineOnly: false,
  unassignedOnly: false,
  page: 0,
  pageSize: DEFAULT_PAGE_SIZE,
};

const state = (over: Partial<QueueState> = {}): QueueState => ({ ...DEFAULTS, ...over });

/** State → URL → state, which is exactly what opening a lead and coming back does. */
const roundTrip = (s: QueueState) =>
  queueStateFromSearch(validateQueueSearch(searchFromQueueState(s) as Record<string, unknown>));

/* ===================================================================== */
/* A. The round trip                                                     */
/* ===================================================================== */

describe("queue state survives the URL", () => {
  it("keeps the default queue empty", () => {
    /*
     * Nothing is written for the default, or opening the page would rewrite the
     * URL with nine parameters saying "as it was" and every Back would land on
     * a duplicate entry.
     */
    expect(searchFromQueueState(DEFAULTS)).toEqual({});
    expect(isDefaultQueueSearch(searchFromQueueState(DEFAULTS))).toBe(true);
    expect(roundTrip(DEFAULTS)).toEqual(DEFAULTS);
  });

  it("preserves the brief's own example", () => {
    // Status = Follow-up, Source = Retention, mine only, Search = 050...
    const s = state({
      status: "follow_up",
      leadType: "retention",
      mineOnly: true,
      term: "0504630565",
    });
    expect(roundTrip(s)).toEqual(s);
  });

  it("preserves every filter individually", () => {
    const cases: Partial<QueueState>[] = [
      { leadType: "cash" },
      { leadType: "wasfaty" },
      { status: "converted" },
      { status: "all" },
      { branch: "P0001" },
      { family: "mounjaro" },
      { followup: "overdue" },
      { followup: "none" },
      { lifecycle: "stale" },
      { lifecycle: "archived" },
      { term: "0504630565" },
      { mineOnly: true },
      { unassignedOnly: true },
      { page: 3 },
      { pageSize: 100 },
      { pageSize: 25 },
    ];
    for (const over of cases) {
      const s = state(over);
      expect(roundTrip(s), JSON.stringify(over)).toEqual(s);
    }
  });

  it("preserves several filters at once, with search and paging", () => {
    const s = state({
      leadType: "retention",
      status: "follow_up",
      branch: "P0001",
      family: "mounjaro",
      followup: "overdue",
      lifecycle: "stale",
      term: "0504",
      unassignedOnly: true,
      page: 2,
      pageSize: 25,
    });
    expect(roundTrip(s)).toEqual(s);
  });

  it("writes the page one-based, so a pasted link reads correctly", () => {
    // The queue's index is zero-based; nobody pasting a URL thinks that way.
    expect(searchFromQueueState(state({ page: 0 })).page).toBeUndefined();
    expect(searchFromQueueState(state({ page: 1 })).page).toBe(2);
    expect(queueStateFromSearch({ page: 2 }).page).toBe(1);
  });
});

/* ===================================================================== */
/* B. Validation                                                         */
/* ===================================================================== */

describe("validateQueueSearch refuses what it does not recognise", () => {
  it("collapses an unknown value to the default", () => {
    /*
     * Several of these reach PostgREST as filters. A hand-edited URL must not
     * put the queue into a state it has no rendering for.
     */
    expect(validateQueueSearch({ status: "nonsense" })).toEqual({});
    expect(validateQueueSearch({ type: "../etc/passwd" })).toEqual({});
    expect(validateQueueSearch({ followup: 42 })).toEqual({});
    expect(validateQueueSearch({ lifecycle: null })).toEqual({});
  });

  it("refuses a branch or product code that is not code-shaped", () => {
    expect(validateQueueSearch({ branch: "P0001" })).toEqual({ branch: "P0001" });
    expect(validateQueueSearch({ branch: "'; drop table --" })).toEqual({});
    expect(validateQueueSearch({ family: "x".repeat(200) })).toEqual({});
  });

  it("round-trips a whitespace-only term rather than erasing it", () => {
    /*
     * The input adopts the URL back into itself, so a term the URL refuses is a
     * character the agent watches disappear as they type it. The query trims.
     */
    expect(validateQueueSearch({ q: " " })).toEqual({ q: " " });
    expect(queueStateFromSearch({ q: " " }).term).toBe(" ");
    expect(roundTrip(state({ term: " " }))).toEqual(state({ term: " " }));
  });

  it("caps the search term rather than rejecting it", () => {
    // Truncating keeps a long paste usable; rejecting would lose the search.
    const long = "0".repeat(500);
    expect(validateQueueSearch({ q: long }).q).toHaveLength(80);
  });

  it("ignores an out-of-range page or page size", () => {
    expect(validateQueueSearch({ page: 0 })).toEqual({});
    expect(validateQueueSearch({ page: -5 })).toEqual({});
    expect(validateQueueSearch({ page: 99_999_999 })).toEqual({});
    expect(validateQueueSearch({ size: 7 })).toEqual({});
    // The default size is not written, even when asked for explicitly.
    expect(validateQueueSearch({ size: DEFAULT_PAGE_SIZE })).toEqual({});
  });

  it("accepts a boolean flag as a string, because a URL only has strings", () => {
    expect(validateQueueSearch({ mine: "true" })).toEqual({ mine: true });
    expect(validateQueueSearch({ mine: true })).toEqual({ mine: true });
    expect(validateQueueSearch({ mine: "yes" })).toEqual({});
  });
});

/* ===================================================================== */
/* C. Carrying the context onto a lead                                   */
/* ===================================================================== */

describe("the lead carries the queue context", () => {
  it("packs and unpacks a filtered queue", () => {
    const s = searchFromQueueState(
      state({ status: "follow_up", leadType: "retention", term: "0504", page: 2 }),
    );
    const packed = encodeQueueContext(s);
    expect(packed).toBeTruthy();
    expect(decodeQueueContext(packed)).toEqual(s);
  });

  it("packs nothing for the default queue", () => {
    // An unfiltered view adds nothing to the address bar.
    expect(encodeQueueContext({})).toBeUndefined();
  });

  it("degrades to the default queue rather than breaking", () => {
    /*
     * A truncated, mangled or hand-edited value lands the agent on the default
     * queue — where the button went before this existed — instead of throwing
     * on a page they opened mid-call.
     */
    for (const bad of [undefined, null, "", "{", "[]", '{"status":', "x".repeat(9999), 42]) {
      expect(decodeQueueContext(bad), String(bad)).toEqual({});
    }
  });

  it("re-validates what it unpacks", () => {
    // The string is in a URL, so it is untrusted even though we wrote it.
    expect(decodeQueueContext('{"status":"nonsense","mine":true}')).toEqual({ mine: true });
  });

  it("bounds what the lead route will accept", () => {
    expect(validateLeadSearch({ from: "{}" })).toEqual({ from: "{}" });
    expect(validateLeadSearch({ from: "x".repeat(9999) })).toEqual({});
    expect(validateLeadSearch({})).toEqual({});
    expect(validateLeadSearch({ from: 42 })).toEqual({});
  });
});

/* ===================================================================== */
/* D. The wiring                                                         */
/* ===================================================================== */

describe("the pages are wired to the URL", () => {
  it("the queue reads its filters from the search params", () => {
    const page = source(QUEUE_PAGE);
    expect(page).toContain("validateSearch: validateQueueSearch");
    expect(page).toContain("Route.useSearch()");
    expect(page).toContain("queueStateFromSearch");
    // And no longer holds them in component state, which is what lost them.
    expect(page).not.toMatch(/useState\(DEFAULT_QUEUE_FILTERS/);
    expect(page).not.toMatch(/const \[term, setTerm\] = useState/);
    expect(page).not.toMatch(/const \[page, setPage\] = useState/);
  });

  it("a row links to the lead carrying the queue context", () => {
    const row = source(ROW);
    expect(row).toContain("queueContext");
    expect(row).toMatch(/search=\{queueContext \? \{ from: queueContext \} : \{\}\}/);
  });

  it("the lead's Back action returns to that context", () => {
    const lead = source(LEAD_PAGE);
    expect(lead).toContain("validateSearch: validateLeadSearch");
    expect(lead).toContain("decodeQueueContext");
    // Both back links, not just one.
    const backLinks = lead.match(/<Link to="\/telesales" search=\{backToQueue\}>/g) ?? [];
    expect(backLinks).toHaveLength(2);
  });

  it("the lead page does not read inside the context", () => {
    /*
     * The constraint that keeps the two pages independent: the lead knows there
     * is a string, not what is in it. Adding a queue filter tomorrow changes
     * `queue-search.ts` and nothing else.
     */
    const lead = source(LEAD_PAGE);
    /*
     * Names unique to the queue's filter set. `followup` is deliberately not on
     * this list: the lead has follow-ups of its own, so asserting on the word
     * would test the vocabulary rather than the coupling.
     */
    for (const filter of ["lifecycle", "unassignedOnly", "pageSize", "mineOnly"]) {
      expect(lead, `the lead page must not know about ${filter}`).not.toContain(filter);
    }
    // It also does not reach for the queue's own helpers.
    expect(lead).not.toContain("queueStateFromSearch");
    expect(lead).not.toContain("searchFromQueueState");
  });

  it("typing does not push a history entry per keystroke", () => {
    // Otherwise Back from a lead steps backwards through the typed word.
    const page = source(QUEUE_PAGE);
    expect(page).toMatch(/put\(\{ term: v, page: 0 \}, true\)/);
  });

  it("a filter change returns to the first page", () => {
    // Page 4 of a different result set is a page nobody asked for.
    const page = source(QUEUE_PAGE);
    for (const setter of ["setStatus", "setBranch", "setFamily", "setFollowup", "setLifecycle"]) {
      expect(page, setter).toMatch(new RegExp(`const ${setter} = .*page: 0`));
    }
  });
});

/* ===================================================================== */
/* E. Nothing new is fetched                                             */
/* ===================================================================== */

describe("restoring state costs no request", () => {
  it("the queue's data loading is unchanged", () => {
    const page = source(QUEUE_PAGE);
    // Same hook, same arguments, same shape.
    expect(page).toContain("useTelesalesQueue(filters, page, pageSize, canView)");
  });

  it("the search module reaches nothing", () => {
    /*
     * It is pure string handling. Restoring a filter must not cost a lookup, a
     * fetch, or a database read.
     */
    const mod = source("features/telesales/queue-search.ts");
    expect(mod).not.toContain("supabase");
    expect(mod).not.toMatch(/\bfetch\(/);
    expect(mod).not.toContain("useQuery");
    // Imports rather than prose: the header names `/shams` as the pattern this
    // copies, which is documentation, not a dependency.
    expect(mod).not.toMatch(/^import .*shams/m);
  });

  it("the queue still makes no per-row request", () => {
    const row = source(ROW);
    for (const forbidden of [
      "@/lib/shams.functions",
      "use-customer-intelligence",
      "use-lead-verification",
      "useLeadCrossSell",
      "lookupCallsByNumber",
      "useQuery",
    ]) {
      expect(row, `the row must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});
