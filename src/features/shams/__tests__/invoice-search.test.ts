/**
 * How the Invoices tab decides what to ask the MIS.
 *
 * The expensive thing on this page is the branch sweep: the MIS cannot look a
 * document up across warehouses, so finding one by number alone means asking
 * every branch — 141 of the 144 rows in `branches` carry a sweepable code — in
 * four parallel parts at 24 in flight. Naming the branch makes that exactly one
 * request instead.
 *
 * Nothing here renders. What is asserted is the wiring that decides between the
 * two paths, because it is invisible to the type checker and a plausible-looking
 * edit could quietly reinstate the sweep for every search.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../components/invoices-tab.tsx", import.meta.url)),
  "utf8",
);

const hook = readFileSync(
  fileURLToPath(new URL("../hooks/use-shams-data.ts", import.meta.url)),
  "utf8",
);

describe("naming a branch skips the sweep", () => {
  it("disables discovery when the search carried a branch", () => {
    // The whole optimisation, in one argument.
    expect(source).toContain("useInvoiceBranches(submitted, !submittedBranch)");
  });

  it("gates every part of the sweep on that flag, not just the first", () => {
    // Four queries run in parallel; one ungated part would still probe a
    // quarter of the chain.
    expect(hook).toContain("const active = enabled && Boolean(docNo);");
    expect(hook).toMatch(
      /queries: Array\.from\(\{ length: DISCOVERY_PARTS \}[\s\S]*?enabled: active,/,
    );
  });

  it("sends the chosen branch straight to the document lookup", () => {
    expect(source).toContain("setBranchCode(branchFilter);");
    expect(source).toContain("useInvoiceLookup(");
  });
});

describe("the branch filter is optional", () => {
  it("starts unset, so a bare number still searches everywhere", () => {
    expect(source).toContain("useState<string | null>(null)");
    expect(source).toContain("All branches");
  });

  it("can be cleared back to every branch", () => {
    expect(source).toContain('aria-label="Clear branch filter"');
    expect(source).toContain("onChange(null)");
  });

  it("does not gate submission on a branch being chosen", () => {
    // `canSubmit` is about the number and nothing else.
    expect(source).toContain('const canSubmit = docNo.trim() !== "";');
  });

  it("re-reads the filter only on submit, not as it changes", () => {
    // Otherwise changing the picker would silently re-scope results already on
    // screen without re-running the search behind them.
    expect(source).toContain("setSubmittedBranch(branchFilter);");
  });
});

describe("the branch pickers search the same two things", () => {
  it("offers code and city in the selector", () => {
    expect(source).toContain('value={`${b.branchNo} ${b.city} ${b.cityEnglish ?? ""}`}');
    expect(source).toContain('placeholder="Search a branch code or city…"');
  });

  it("filters the returned matches without another request", () => {
    // Narrowing a list already in hand: no refetch, no new sweep.
    expect(source).toContain("const shown = useMemo(");
    expect(source).toContain("matches.filter(");
  });

  it("only offers that filter once the list is long enough to need it", () => {
    expect(source).toContain("const FILTERABLE_FROM = 6;");
    expect(source).toContain("matches.length >= FILTERABLE_FROM");
  });
});

describe("nothing is fetched before a search", () => {
  it("has no invoice query outside a submitted number", () => {
    // The tab opens on an empty state. There is no list to preload and no
    // invoices table to page through — invoices live in the MIS, and the only
    // reads are the two lookups a submission triggers.
    expect(source).toContain("Enter an invoice number to look it up across all Shams branches.");
    expect(source).not.toContain("useQuery({");
  });
});
