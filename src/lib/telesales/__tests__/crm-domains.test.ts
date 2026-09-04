import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DOMAIN_LEAD_TYPES,
  LEAD_DOMAINS,
  LEAD_TYPES,
  OUTCOMES,
  OUTCOME_BY_KEY,
  WASFATY_OUTCOME_KEYS,
  domainOfLeadType,
  outcomesForLeadType,
} from "../types";
import { isValidPrescriptionNo, parseSheet } from "../parse";
import { proposeFollowup } from "../status";
import {
  queueStateFromSearch,
  searchFromQueueState,
  validateQueueSearch,
} from "@/features/telesales/queue-search";
import { WASFATY_VIEWS, wasfatyView } from "@/features/telesales/wasfaty-views";
import { OUTCOME_STYLES, REFILL_SEVERITY_STYLES } from "@/features/telesales/constants";
import { navKey, resolveActivePath, type NavItemData } from "@/components/app-sidebar";

/**
 * Cash and Wasfaty as two desks, and the three Wasfaty views over one lead.
 *
 * ===========================================================================
 * What is worth pinning here
 * ===========================================================================
 * The split is navigational, which makes it exactly the kind of change that can
 * look right and be wrong: the pages separate, the menu separates, and then one
 * query forgets its scope and a Cash agent is looking at prescriptions again.
 * So the scope clause, the view predicates and the URL round trip are asserted
 * rather than inspected.
 *
 * The structural reads follow `queue-isolation`'s technique — the rule is in
 * the code and a test that only exercised the pure functions would pass while
 * the screen did something else.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const QUEUE_HOOK = "features/telesales/hooks/use-telesales-queue.ts";
const QUEUE_BODY = "features/telesales/components/lead-queue.tsx";
const CASH_PAGE = "routes/_app.telesales.index.tsx";
const WASFATY_PAGE = "features/telesales/components/wasfaty-page.tsx";
const LAYOUT = "routes/_app.tsx";
const ROW = "features/telesales/components/lead-row.tsx";

const icon = () => null;

/* ===================================================================== */
/* A. Two domains                                                        */
/* ===================================================================== */

describe("Cash and Wasfaty are separate domains", () => {
  it("every pipeline belongs to exactly one", () => {
    const claimed = LEAD_DOMAINS.flatMap((d) => DOMAIN_LEAD_TYPES[d]);
    expect([...claimed].sort()).toEqual([...LEAD_TYPES].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("Retention is Cash's, not its own domain", () => {
    // A retention lead is the next cycle of a Cash conversion this system
    // recorded. Same customers, same catalogue, same question.
    expect(DOMAIN_LEAD_TYPES.cash).toEqual(["cash", "retention"]);
    expect(domainOfLeadType("retention")).toBe("cash");
    expect(domainOfLeadType("wasfaty")).toBe("wasfaty");
  });

  it("the queue scopes to the domain before it applies the user's filter", () => {
    /*
     * The load-bearing clause. Without it `?type=wasfaty` on the Cash queue
     * would serve the other desk's leads, and the separation would be a menu
     * rather than a boundary.
     */
    const hook = source(QUEUE_HOOK);
    const scope = hook.indexOf('filters.domain.split(",")');
    const narrow = hook.indexOf('filters.leadType !== "all"');
    expect(scope).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(scope);
    // And the user's choice is intersected with the scope rather than trusted.
    expect(hook).toContain("domain.includes(filters.leadType)");
  });

  it("the Cash page carries only Cash and Retention", () => {
    const page = source(CASH_PAGE);
    expect(page).toContain("DOMAIN_LEAD_TYPES.cash");
    // Not the whole list of pipelines: the chip row is the domain's, so adding
    // a fourth pipeline tomorrow cannot put it on this page by accident.
    expect(page).not.toMatch(/\bLEAD_TYPES\b(?!\s*\.)/);
    expect(page).not.toMatch(/import \{[^}]*\bLEAD_TYPES\b/);
    // An old bookmark is redirected rather than silently widened or narrowed.
    expect(page).toContain('search.type === "wasfaty"');
    expect(page).toContain('redirect({ to: "/telesales/wasfaty"');
  });

  it("the Wasfaty pages carry only Wasfaty", () => {
    const page = source(WASFATY_PAGE);
    expect(page).toContain("DOMAIN_LEAD_TYPES.wasfaty");
    // No pipeline chips: there is only one pipeline here, and a chip row of one
    // is a control that cannot change anything.
    expect(page).not.toContain("typeChips");
  });

  it("the branch and backlog reads are scoped too", () => {
    // A Cash agent's branch dropdown must not offer the Wasfaty pharmacy
    // numbers, which are a different identifier space entirely.
    const hook = source(QUEUE_HOOK);
    expect(hook).toMatch(/useTelesalesBranches\(enabled: boolean, domain: string\)/);
    expect(hook).toMatch(/useStaleLeadCount\(\s*enabled: boolean,\s*domain: string/);
  });
});

/* ===================================================================== */
/* B. One lead, three views                                              */
/* ===================================================================== */

describe("the three Wasfaty views", () => {
  it("are three predicates, not three tables", () => {
    /*
     * The rule the brief is most explicit about. Every view reads the same
     * lead rows through the same hook; what differs is two defaults and one
     * `worked` value.
     */
    const page = source(WASFATY_PAGE);
    expect(page).toContain("<LeadQueue");
    expect(page).toContain("worked={view.worked}");
    // Nothing writes, copies or duplicates a lead to populate a view.
    expect(page).not.toMatch(/\.(insert|upsert|update)\(/);
  });

  it("Generated Leads is the default page and keeps the queue's own defaults", () => {
    const generated = wasfatyView("generated");
    expect(generated.to).toBe("/telesales/wasfaty");
    // Empty, deliberately: this view must not drift from what the daily run
    // produces, so it inherits rather than restates.
    expect(generated.defaults).toEqual({});
    expect(generated.worked).toBe("all");
  });

  it("All Leads widens both narrowing defaults and nothing else", () => {
    expect(wasfatyView("all").defaults).toEqual({ status: "all", lifecycle: "all" });
    expect(wasfatyView("all").worked).toBe("all");
  });

  it("Worked Leads asks about the recorded action, not the status", () => {
    /*
     * Three of the eight Wasfaty actions leave the lead open, so a status-based
     * Worked view would omit every lead that was called, actioned and correctly
     * left in the queue.
     */
    expect(wasfatyView("worked").worked).toBe("worked");
    const hook = source(QUEUE_HOOK);
    expect(hook).toContain('filters.worked === "worked"');
    expect(hook).toContain('q.not("last_outcome", "is", null)');
  });

  it("each view is a real URL", () => {
    for (const v of WASFATY_VIEWS) {
      const file =
        v.id === "generated"
          ? "routes/_app.telesales.wasfaty.index.tsx"
          : `routes/_app.telesales.wasfaty.${v.id}.tsx`;
      expect(existsSync(join(ROOT, file)), v.to).toBe(true);
    }
  });

  it("a view's defaults survive the URL round trip", () => {
    /*
     * The subtle one. `searchFromQueueState` omits whatever equals the default,
     * so if the writer and the reader disagreed about what the default is,
     * choosing "Open" on All Leads would write nothing and read back as "All".
     */
    const d = wasfatyView("all").defaults;
    const state = queueStateFromSearch({}, d);
    expect(state.status).toBe("all");

    const chosen = { ...state, status: "open" };
    const url = searchFromQueueState(chosen, d);
    expect(url.status).toBe("open");
    expect(queueStateFromSearch(url, d).status).toBe("open");
  });
});

/* ===================================================================== */
/* C. Date filtering, in the database                                    */
/* ===================================================================== */

describe("the date range", () => {
  it("becomes a WHERE clause on the lead's own business date", () => {
    const hook = source(QUEUE_HOOK);
    expect(hook).toContain('q.gte("source_date", filters.dateFrom)');
    expect(hook).toContain('q.lte("source_date", filters.dateTo)');
    // Never a filter the browser finishes, which would break paging.
    expect(hook).not.toMatch(/rows\.filter\(/);
  });

  it("accepts a business date and refuses anything else", () => {
    expect(validateQueueSearch({ dateFrom: "2026-09-01" }).dateFrom).toBe("2026-09-01");
    expect(validateQueueSearch({ dateFrom: "yesterday" }).dateFrom).toBeUndefined();
    expect(validateQueueSearch({ dateTo: 20260901 }).dateTo).toBeUndefined();
    expect(validateQueueSearch({ dateFrom: "01/09/2026" }).dateFrom).toBeUndefined();
  });

  it("corrects a backwards range rather than returning nothing", () => {
    // Trivially reachable: pick the "to" first, then a "from" after it. An empty
    // queue with two dates on screen reads as broken data, not as a bad range.
    const out = validateQueueSearch({ dateFrom: "2026-09-30", dateTo: "2026-09-01" });
    expect(out).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  });

  it("either end may stand alone", () => {
    expect(validateQueueSearch({ dateFrom: "2026-09-01" })).toEqual({ dateFrom: "2026-09-01" });
    expect(validateQueueSearch({ dateTo: "2026-09-01" })).toEqual({ dateTo: "2026-09-01" });
  });

  it("survives the round trip with everything else", () => {
    const state = queueStateFromSearch({
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      q: "mounjaro",
      page: 3,
    });
    const back = queueStateFromSearch(searchFromQueueState(state));
    expect(back).toEqual(state);
  });

  it("changing a date returns to the first page", () => {
    // Page 4 of a narrower range is a page nobody asked for, and usually empty.
    const body = source(QUEUE_BODY);
    expect(body).toMatch(/dateFrom: e\.target\.value, page: 0/);
    expect(body).toMatch(/dateTo: e\.target\.value, page: 0/);
  });
});

/* ===================================================================== */
/* D. The CRM flyout                                                     */
/* ===================================================================== */

describe("the CRM navigation", () => {
  const layout = source(LAYOUT);

  it("groups Cash over its two pipelines and stands Wasfaty beside them", () => {
    expect(layout).toMatch(/label: "CRM"[\s\S]{0,1600}groupLabel: "Cash"/);
    expect(layout).toMatch(/search: \{ type: "cash" \}/);
    expect(layout).toMatch(/search: \{ type: "retention" \}/);
    expect(layout).toMatch(/to: "\/telesales\/wasfaty"[\s\S]{0,200}groupLabel: "Wasfaty"/);
  });

  it("Cash and Retention are one route asked two questions", () => {
    // Not two routes: a second one would have to be kept in step with the
    // parent, and there is nothing different about it to keep.
    const crm: NavItemData = {
      to: "/telesales",
      label: "CRM",
      icon,
      children: [
        { to: "/telesales", search: { type: "cash" }, label: "Cash", icon },
        { to: "/telesales", search: { type: "retention" }, label: "Retention", icon },
        { to: "/telesales/wasfaty", label: "Wasfaty", icon },
      ],
    };
    expect(navKey(crm.children![0])).toBe("/telesales?type=cash");
    expect(navKey(crm.children![1])).toBe("/telesales?type=retention");
    expect(navKey(crm.children![2])).toBe("/telesales/wasfaty");

    // Only the one whose pin matches lights up.
    expect(resolveActivePath([crm], "/telesales", { type: "cash" })).toBe("/telesales?type=cash");
    expect(resolveActivePath([crm], "/telesales", { type: "retention" })).toBe(
      "/telesales?type=retention",
    );
    // And with no pin, the parent — not whichever child happened to be first.
    expect(resolveActivePath([crm], "/telesales", {})).toBe("/telesales");
    expect(resolveActivePath([crm], "/telesales/wasfaty", {})).toBe("/telesales/wasfaty");
  });

  it("the layout passes the search in, or the two children could never differ", () => {
    expect(layout).toMatch(/resolveActivePath\(\s*nav,\s*location\.pathname,\s*location\.search/);
  });
});

/* ===================================================================== */
/* E. Wasfaty's recorded actions                                         */
/* ===================================================================== */

describe("the eight Wasfaty actions", () => {
  it("are exactly the eight, in the order the desk reads them", () => {
    expect(outcomesForLeadType("wasfaty").map((o) => o.label)).toEqual([
      "Order Created",
      "No Order",
      "No Answer",
      "Reschedule Call",
      "Dispensed / Expired",
      "Below Threshold",
      "Refill Too Soon",
      "Out of Stock",
    ]);
  });

  it("keeps the Cash vocabulary off the Wasfaty dialog and vice versa", () => {
    const cash = outcomesForLeadType("cash").map((o) => o.key);
    expect(cash).not.toContain("dispensed_expired");
    expect(cash).not.toContain("out_of_stock");
    expect(cash).toContain("wrong_number");
    expect(outcomesForLeadType("wasfaty").map((o) => o.key)).not.toContain("wrong_number");
  });

  it("did not rename a stored key to make a label read better", () => {
    /*
     * "Below Threshold" is `low_price`, which 1,437 historical Wasfaty rows
     * carry. Renaming the key would either orphan them or require rewriting
     * history so a screen reads better. Keys are storage; labels are language.
     */
    expect(WASFATY_OUTCOME_KEYS).toContain("low_price");
    expect(OUTCOME_BY_KEY.get("low_price")?.label).toBe("Below Threshold");
    for (const key of ["order_created", "no_order", "no_answer", "reschedule", "dispensed_expired"])
      expect(OUTCOME_BY_KEY.has(key), key).toBe(true);
  });

  it("still resolves the spreadsheets' old spellings", () => {
    // The label moved; the import of history must not.
    const noAnswer = OUTCOME_BY_KEY.get("no_answer")!;
    expect(noAnswer.legacyLabels).toContain("No Answer or Busy");
    expect(OUTCOME_BY_KEY.get("no_order")!.legacyLabels).toContain("Answered - No Order");
  });

  it("the two new actions leave the lead open and carry a date", () => {
    // "Too soon" and "out of stock" without a next step are indistinguishable
    // from a lead nobody finished.
    for (const key of ["refill_too_soon", "out_of_stock"]) {
      const def = OUTCOME_BY_KEY.get(key)!;
      expect(def.terminal, key).toBe(false);
      expect(def.status, key).toBe("follow_up");
      expect(def.requiresFollowup, key).toBe(true);
    }
  });

  it("proposes a date that matches the reason", () => {
    const today = "2026-09-04";
    // Still supplied: the product's own cycle when the catalogue knows it.
    expect(
      proposeFollowup(today, { outcomeKey: "refill_too_soon", refillDays: 30, leadType: "wasfaty" })
        .dueOn,
    ).toBe("2026-10-04");
    expect(
      proposeFollowup(today, {
        outcomeKey: "refill_too_soon",
        refillDays: null,
        leadType: "wasfaty",
      }).dueOn,
    ).toBe("2026-09-18");
    // Stock, not the customer.
    expect(
      proposeFollowup(today, { outcomeKey: "out_of_stock", refillDays: null, leadType: "wasfaty" })
        .dueOn,
    ).toBe("2026-09-07");
  });

  it("gives every action a colour, and no two the same", () => {
    const used = WASFATY_OUTCOME_KEYS.map((k) => OUTCOME_STYLES[k]);
    expect(used.every(Boolean)).toBe(true);
    expect(new Set(used).size).toBe(WASFATY_OUTCOME_KEYS.length);
  });

  it("every outcome the desk can record has a colour", () => {
    // Otherwise one falls back to a grey nobody can tell from another grey.
    for (const o of OUTCOMES) expect(OUTCOME_STYLES[o.key], o.key).toBeTruthy();
  });
});

/* ===================================================================== */
/* F. The Wasfaty row                                                    */
/* ===================================================================== */

describe("the Wasfaty row", () => {
  const row = source(ROW);

  it("shows the price without opening the lead", () => {
    /*
     * It was the last fragment of a dot-joined muted line behind the family and
     * the city, which meant prioritising forty prescriptions by value required
     * opening forty of them.
     */
    expect(row).toMatch(/lead\.total_value != null \? \(/);
    expect(row).toContain("text-sm font-medium tabular-nums");
    expect(row).toContain("fmtSAR(lead.total_value)");
    // And no longer appended to the secondary line.
    expect(row).not.toMatch(/join\(" · "\)\}\s*\{lead\.total_value/);
  });

  it("uses the brief's colour for the Wasfaty label", () => {
    const constants = source("features/telesales/constants.ts");
    expect(constants).toMatch(
      /wasfaty: "bg-\[#584C7E\]\/15 text-\[#584C7E\] border-\[#584C7E\]\/40/,
    );
    // Dark mode lifts the ink: #584C7E on a dark card is about 2:1 and
    // unreadable, so the hue is preserved where it is actually seen.
    expect(constants).toContain("dark:text-violet-200");
  });

  it("says what was recorded, not only what state that left", () => {
    // Three of the eight actions land on `follow_up` and two on `closed_lost`,
    // so the status column alone cannot tell them apart.
    expect(row).toContain("<OutcomeBadge outcome={lead.last_outcome} />");
  });
});

/* ===================================================================== */
/* G. Days to Refill                                                     */
/* ===================================================================== */

describe("Days to Refill", () => {
  it("is green today, light blue later, and unchanged when overdue", () => {
    expect(REFILL_SEVERITY_STYLES.due).toContain("#10B981");
    expect(REFILL_SEVERITY_STYLES.soon).toContain("#38BDF8");
    expect(REFILL_SEVERITY_STYLES.future).toContain("#38BDF8");
    // Overdue is the queue's one real alarm. Recolouring it to tidy the set up
    // would cost the queue that.
    expect(REFILL_SEVERITY_STYLES.overdue).toContain("#EF4444");
    expect(REFILL_SEVERITY_STYLES.overdue).toContain("font-semibold");
  });

  it("moves only for today, and only a dot", () => {
    /*
     * Fifty badges breathing in unison turns a work list into a slot machine.
     * The badge is still; a 6px dot beside the label carries the motion.
     */
    const badge = source("features/telesales/components/refill-badge.tsx");
    expect(badge).toContain('refill.severity === "due"');
    expect(badge).toContain("refill-today-dot");
    expect(badge).toContain("bg-current");
  });

  it("the animation is slow, and stops under reduced motion", () => {
    const css = source("styles.css");
    expect(css).toContain("@keyframes refill-today-dot");
    // Anything near a second reads as an alert, and this is the good news.
    expect(css).toMatch(/animation: refill-today-dot (2[0-9]{3})ms/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,200}\.refill-today-dot/);
  });

  it("is one component, so the queue and the profile cannot disagree", () => {
    for (const file of [ROW, "routes/_app.telesales.customers.$id.tsx"]) {
      expect(source(file), file).toContain("<RefillBadge");
      // Neither indexes the severity table by hand any more.
      expect(source(file), file).not.toContain("REFILL_SEVERITY_STYLES[");
    }
  });
});

/* ===================================================================== */
/* H. Wasfaty's own data rules                                           */
/* ===================================================================== */

describe("a Wasfaty prescription without a phone number", () => {
  const grid = [
    ["Patient ID", "Prescription No", "Next Dispense Date", "Mobile"],
    ["1098765432", "a8952992", "2026-09-05", ""],
    ["1098765433", "a8952993", "2026-09-05", "0501234567"],
  ];

  it("is imported, not rejected", () => {
    /*
     * A Wasfaty number is obtained by looking the patient up in the portal by
     * Patient ID, so most rows have none by design — 2,774 of the 3,952 rows in
     * `Wasfaty Aug`, and none at all in the five per-city sheets.
     */
    const parsed = parseSheet(grid, { sourceType: "wasfaty" });
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].phone).toBeNull();
    expect(parsed.records[1].phone).toBe("0501234567");
  });

  it("is not reported as a problem", () => {
    // An empty cell is the normal state here; only a cell that holds something
    // undialable is worth a row number.
    const parsed = parseSheet(grid, { sourceType: "wasfaty" });
    expect(parsed.issues.map((i) => i.code)).not.toContain("unusable_phone");
  });

  it("never gets a number invented for it", () => {
    const parsed = parseSheet(grid, { sourceType: "wasfaty" });
    expect(parsed.records[0].phoneRaw).toBeNull();
    expect(parsed.records[0].phoneAlternates).toEqual([]);
  });
});

describe("the Prescription No format", () => {
  it("wants a lowercase English letter first", () => {
    expect(isValidPrescriptionNo("a123456")).toBe(true);
    expect(isValidPrescriptionNo("a12b34")).toBe(true);
    expect(isValidPrescriptionNo("A123456")).toBe(false);
    expect(isValidPrescriptionNo("123456")).toBe(false);
    expect(isValidPrescriptionNo("")).toBe(false);
    expect(isValidPrescriptionNo(null)).toBe(false);
  });

  it("reports a bad one by row number and stores the row unchanged", () => {
    /*
     * Not corrected, and especially not lower-cased. `A123456` might be a
     * different prescription from `a123456`, and rewriting an identifier to
     * satisfy a format rule is how a call gets made about the wrong one.
     */
    const parsed = parseSheet(
      [
        // Four recognised headers, which is what `locateHeader` needs before it
        // will accept a row as the header row.
        ["Patient ID", "Prescription No", "Next Dispense Date", "Mobile"],
        ["1098765432", "A8952992", "2026-09-05", ""],
        ["1098765433", "8952993", "2026-09-05", ""],
        ["1098765434", "a8952994", "2026-09-05", ""],
      ],
      { sourceType: "wasfaty" },
    );

    expect(parsed.records).toHaveLength(3);
    expect(parsed.records.map((r) => r.prescriptionNo)).toEqual([
      "A8952992",
      "8952993",
      "a8952994",
    ]);

    const issue = parsed.issues.find((i) => i.code === "invalid_prescription_no");
    expect(issue?.rows).toEqual([2, 3]);
  });

  it("is a Wasfaty rule, not a Cash one", () => {
    // A Cash invoice number has nothing to do with the Wasfaty portal.
    const parsed = parseSheet(
      [
        ["Id", "Doc_No", "InvDate", "Itm_Cd", "Itm_Name"],
        ["437812", "A188767", "2026-09-01", "10611028", "MOUNJARO 5 MG"],
      ],
      { sourceType: "cash" },
    );
    expect(parsed.issues.map((i) => i.code)).not.toContain("invalid_prescription_no");
  });
});
