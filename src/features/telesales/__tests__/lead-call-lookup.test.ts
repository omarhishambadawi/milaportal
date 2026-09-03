import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_LOOKBACK_DAYS, defaultLookupWindow } from "../components/lead-call-lookup";
import { __lookupWindow } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { telHref } from "@/lib/phone";

/**
 * Call Lookup on the lead page.
 *
 * Two kinds of assertion, deliberately. The window arithmetic is pure and is
 * tested by calling it; the "reuses the existing implementation" requirement is
 * structural — it is about which module is imported, not about a value — so it
 * is pinned by reading the source, the same technique `queue-isolation` uses.
 * A behavioural test cannot tell a shared lookup from a faithful copy of one,
 * and the copy is the thing to prevent.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const PANEL = "features/telesales/components/lead-call-lookup.tsx";
const LEAD_PAGE = "routes/_app.telesales.$id.tsx";
const QUEUE_FILES = [
  "features/telesales/hooks/use-telesales-queue.ts",
  "features/telesales/components/lead-row.tsx",
  "routes/_app.telesales.index.tsx",
];

/* ===================================================================== */
/* A. The Call button                                                    */
/* ===================================================================== */

describe("the Call action", () => {
  it("dials the lead's own number through the platform's one tel: builder", () => {
    /*
     * `telHref` is the only place a `tel:` URI is constructed, and it emits
     * E.164 because that is what dials from a softphone or a roaming handset.
     * The lead page must not build its own.
     */
    expect(telHref("0504630565")).toBe("tel:+966504630565");
    const page = source(LEAD_PAGE);
    expect(page).toContain("telHref");
    expect(page).toMatch(/const tel = telHref\(l\.phone\)/);
    // The button uses that value, not a re-derived one.
    expect(page).toMatch(/<a href=\{tel\}[\s\S]{0,160}Call\b/);
    // And nothing here hand-rolls a tel: string.
    expect(page).not.toMatch(/["'`]tel:\+?\d/);
  });

  it("refuses to dial a number that is not a usable Saudi mobile", () => {
    // A dead `tel:` link is worse than a disabled control: it looks like it
    // worked. `telHref` returns null and the page renders "Not on file".
    for (const bad of [null, undefined, "", "0", "0000", "m", "12345"]) {
      expect(telHref(bad as any)).toBeNull();
    }
    expect(source(LEAD_PAGE)).toContain("Not on file");
  });
});

/* ===================================================================== */
/* B. The default window is the last month                               */
/* ===================================================================== */

describe("the default lookup window", () => {
  it("is the last month, ending today", () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(30);
    // 1 March 2026, so the arithmetic crosses a month boundary rather than
    // being checked only inside one.
    const now = Date.parse("2026-03-01T09:00:00Z");
    expect(defaultLookupWindow(now)).toEqual({ from: "2026-01-31", to: "2026-03-01" });
  });

  it("is inclusive of both ends, so 30 days means 30 days", () => {
    const now = Date.parse("2026-06-30T00:00:00Z");
    const { from, to } = defaultLookupWindow(now);
    const span =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) +
      1;
    expect(span).toBe(DEFAULT_LOOKBACK_DAYS);
  });
});

/* ===================================================================== */
/* C. The server resolves the window                                     */
/* ===================================================================== */

describe("resolveLookupWindow", () => {
  const { resolveLookupWindow, LOOKUP_MAX_DAYS } = __lookupWindow;
  const NOW = Date.parse("2026-09-03T09:00:00Z");

  it("keeps the lookback behaviour when no range is given", () => {
    // What /calls/lookup sends, unchanged.
    expect(resolveLookupWindow({ days: 30 }, NOW)).toEqual({
      from: "2026-08-05",
      to: "2026-09-03",
      days: 30,
    });
  });

  it("uses an explicit range when one is given", () => {
    expect(resolveLookupWindow({ days: 30, from: "2026-07-01", to: "2026-07-31" }, NOW)).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
      days: 31,
    });
  });

  it("ignores a partial range rather than half-applying it", () => {
    // One date without the other is mid-edit, not an instruction.
    expect(resolveLookupWindow({ days: 7, from: "2026-07-01" }, NOW).to).toBe("2026-09-03");
    expect(resolveLookupWindow({ days: 7, to: "2026-07-01" }, NOW).to).toBe("2026-09-03");
  });

  it("never reads past today", () => {
    // The PBX has no future calls, and asking for them turns a typo into a
    // sweep of an empty window.
    const w = resolveLookupWindow({ days: 30, from: "2026-09-01", to: "2027-01-01" }, NOW);
    expect(w.to).toBe("2026-09-03");
  });

  it("collapses an inverted range to a single day instead of throwing", () => {
    const w = resolveLookupWindow({ days: 30, from: "2026-08-30", to: "2026-08-01" }, NOW);
    expect(w).toEqual({ from: "2026-08-01", to: "2026-08-01", days: 1 });
  });

  it("clamps a long range to the same ceiling the lookback carries", () => {
    /*
     * Without this, a hand-typed range would be the one way to ask for an
     * unbounded sweep — exactly what LOOKUP_MAX_DAYS exists to prevent.
     */
    const w = resolveLookupWindow({ days: 30, from: "2020-01-01", to: "2026-09-01" }, NOW);
    expect(w.days).toBe(LOOKUP_MAX_DAYS);
    expect(w.to).toBe("2026-09-01");
  });
});

/* ===================================================================== */
/* D. It reuses the Calls implementation                                 */
/* ===================================================================== */

describe("the lead panel reuses the Calls module", () => {
  it("calls the Calls module's own lookup server function", () => {
    const panel = source(PANEL);
    expect(panel).toContain("lookupCallsByNumber");
    // Not a second transport, and not a second normalizer.
    expect(panel).not.toMatch(/\bfetch\(/);
    expect(panel).not.toContain("yeastar/client.server");
    expect(panel).not.toContain("cdr.server");
  });

  it("renders the Calls page's own results table", () => {
    /*
     * Two copies of this would be two vocabularies for one PBX field — the same
     * call reading "No answer" on one screen and "Failed" on another.
     */
    const panel = source(PANEL);
    expect(panel).toContain("call-lookup-results");
    expect(panel).toContain("ResultsTable");
    // And it defines none of the display itself.
    expect(panel).not.toContain("OUTCOME_LABELS");
    expect(panel).not.toContain("function DirectionBadge");
  });

  it("and the Calls page renders from the same module", () => {
    // The extraction has to be a move, not a fork: if /calls/lookup kept its
    // own copy the two would drift immediately.
    const callsPage = source("routes/_app.calls.lookup.tsx");
    expect(callsPage).toContain("call-lookup-results");
    expect(callsPage).not.toContain("const ResultsTable");
    expect(callsPage).not.toContain("OUTCOME_LABELS");
  });

  it("invents no call-history fields of its own", () => {
    // Every column comes from CallLookupRow as the normalizer produced it.
    const panel = source(PANEL);
    for (const invented of ["sentiment", "rating", "score", "notes:", "summary:"]) {
      expect(panel.toLowerCase()).not.toContain(invented);
    }
  });

  it("keys its cache apart from the lookback lookup", () => {
    /*
     * `lookup(n, 30)` slides forward every midnight; `lookupWindow(n, from, to)`
     * names a closed period. Sharing one entry would serve one as the other.
     */
    const a = queryKeys.callCenter.lookupWindow("0504630565", "2026-08-01", "2026-08-31");
    const b = queryKeys.callCenter.lookup("0504630565", 30);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    // Same number, different window -> different entry, so changing the dates
    // refetches rather than repainting the previous answer.
    const c = queryKeys.callCenter.lookupWindow("0504630565", "2026-07-01", "2026-07-31");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});

/* ===================================================================== */
/* E. States                                                             */
/* ===================================================================== */

describe("the panel handles every state", () => {
  const panel = source(PANEL);

  it("has a loading state", () => {
    expect(panel).toContain("q.isPending");
    expect(panel).toContain("ResultsSkeleton");
  });

  it("has an empty state that names the window it searched", () => {
    expect(panel).toMatch(/rows\.length === 0/);
    expect(panel).toContain("No calls to or from this number");
  });

  it("has an error state that does not take the lead page down with it", () => {
    expect(panel).toContain("q.isError");
    // Contained inside the panel: the lead page renders it as one card among
    // several and never awaits it.
    const page = source(LEAD_PAGE);
    expect(page).toContain("<LeadCallLookup phone={l.phone} />");
    expect(page).not.toMatch(/await[\s\S]{0,40}LeadCallLookup/);
  });

  it("distinguishes an unconfigured PBX from a failure", () => {
    // Nothing is broken in that case; the integration is simply not set up.
    expect(panel).toContain("!result.configured");
  });

  it("handles a lead with no phone number at all", () => {
    // Routine for Wasfaty, where finding the number is the agent's job.
    expect(panel).toContain("No phone number on this lead yet");
    // And it does not ask the PBX about an empty string.
    expect(panel).toMatch(/enabled[\s\S]{0,120}Boolean\(number\)/);
  });
});

/* ===================================================================== */
/* F. Performance and authorization                                      */
/* ===================================================================== */

describe("the lookup runs only on an opened lead", () => {
  it("is absent from every queue file", () => {
    /*
     * The failure this prevents is not a wrong answer but one PBX request per
     * queue row, which only shows up under load.
     */
    for (const file of QUEUE_FILES) {
      const text = source(file);
      expect(text, `${file} must not look calls up`).not.toContain("lookupCallsByNumber");
      expect(text, `${file} must not render the lookup`).not.toContain("LeadCallLookup");
    }
  });

  it("is rendered exactly once, by the lead detail page", () => {
    expect(source(LEAD_PAGE)).toContain("LeadCallLookup");
  });

  it("does not poll or refetch on focus", () => {
    // A closed window's history does not change while it is on screen.
    const panel = source(PANEL);
    expect(panel).toContain("refetchOnWindowFocus: false");
    expect(panel).toContain("refetchOnMount: false");
    expect(panel).not.toContain("refetchInterval");
  });
});

describe("authorization is unchanged", () => {
  it("honours the Calls module's own permission on the client", () => {
    const panel = source(PANEL);
    expect(panel).toContain("canViewCallsPage");
    expect(panel).toMatch(/canViewCallsPage\([\s\S]{0,80}"lookup"\)/);
    // Absent rather than refused: the lead page is theirs, this section is not.
    expect(panel).toContain("if (!authLoading && !canViewCalls) return null;");
  });

  it("does not widen access merely by displaying calls inside the CRM", () => {
    /*
     * The client gate is a courtesy. `lookupCallsByNumber` re-checks
     * independently through `callCenterAccess` and throws for anybody without
     * it, so calling the function directly gains nothing — and this phase did
     * not touch that check.
     */
    const fns = source("lib/yeastar.functions.ts");
    const handler = fns.slice(
      fns.indexOf("export const lookupCallsByNumber"),
      fns.indexOf("export const lookupCallsByNumber") + 1200,
    );
    expect(handler).toContain("callCenterAccess");
    expect(handler).toContain("Forbidden: call analytics access required");
    // The panel holds no service-role client and no permission of its own.
    expect(source(PANEL)).not.toContain("supabaseAdmin");
    expect(source(PANEL)).not.toContain("view_telesales");
  });
});
