import { describe, expect, it } from "vitest";
import { parseSheet } from "../parse";
import {
  IMPORT_TEMPLATES,
  TEMPLATE_ORDER,
  checkMapping,
  requiredColumns,
  templateExampleRow,
  templateFor,
  templateHeaders,
  wasfatyUsesFillDateFallback,
} from "../templates";
import {
  DIAGNOSIS_EXPLANATIONS,
  DIAGNOSIS_LABELS,
  describeDiagnosis,
  diagnoseImport,
  type DiagnosableRecord,
} from "../diagnostics";
import {
  generateCashLeads,
  generateWasfatyLeads,
  judgeCashRecord,
  judgeWasfatyRecord,
} from "../generation";
import { buildCatalog } from "../products";
import { cashWindow, wasfatyWindow } from "../dates";
import { DEFAULT_SETTINGS, type SourceType } from "../types";

/**
 * Import → validate → review → generate.
 *
 * The numbers in these tests are the live ones. A Wasfaty file of 3,937 rows was
 * imported and 46 leads appeared; every row carried a Patient ID and a
 * Prescription No, none was missing a date, and 3,891 simply fell outside
 * today-and-tomorrow — 3,721 in the past and 170 in the future. The system was
 * right and could not say so, which is what these tests are about.
 */

const TODAY = "2026-09-03";

const CATALOGUE = buildCatalog(
  [
    {
      itemCode: "10611028",
      itemName: "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
      family: "mounjaro",
      strength: "5 MG",
      category: null,
      eligibleCash: true,
      eligibleRetention: true,
      refillDays: 28,
      active: true,
    },
    {
      itemCode: "99001",
      itemName: "FREESTYLE OPTIUM STRIPS 50'S",
      family: "other",
      strength: null,
      category: null,
      eligibleCash: false,
      eligibleRetention: false,
      refillDays: null,
      active: true,
    },
  ],
  [],
);

let seq = 0;
function record(over: Partial<DiagnosableRecord> = {}): DiagnosableRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    sourceType: "wasfaty",
    rowNumber: seq,
    contentHash: `h${seq}`,
    customerRef: null,
    customerName: null,
    phoneRaw: null,
    phone: null,
    phoneRejection: null,
    phoneAlternates: [],
    branchNo: null,
    city: null,
    facility: null,
    itemCode: null,
    itemName: null,
    quantity: null,
    unitPrice: null,
    totalValue: null,
    sourceDate: TODAY,
    fillDate: null,
    dispenseTime: null,
    documentNo: null,
    channel: null,
    patientId: "1098765432",
    prescriptionNo: "J8952992",
    callbackDate: null,
    agentLabel: null,
    actionLabel: null,
    notes: null,
    raw: {},
    ...over,
  };
}

/* ===================================================================== */
/* A. Templates                                                          */
/* ===================================================================== */

describe("import templates", () => {
  it("covers all three source types", () => {
    expect(TEMPLATE_ORDER).toEqual(["cash", "retention", "wasfaty"]);
    for (const type of TEMPLATE_ORDER) {
      expect(IMPORT_TEMPLATES[type].sourceType).toBe(type);
    }
  });

  /*
   * The reliability claim, tested behaviourally rather than by comparing
   * against the alias table. A template is only useful if the *importer*
   * understands it, so the test builds the sheet the download would produce and
   * runs the real parser over it.
   */
  for (const type of ["cash", "retention", "wasfaty"] as SourceType[]) {
    it(`the ${type} template parses with every column mapped`, () => {
      const template = templateFor(type);
      const grid = [templateHeaders(template), templateExampleRow(template)];
      const parsed = parseSheet(grid, { sourceType: type });

      const mapped = new Set(parsed.mappedFields);
      for (const column of template.columns) {
        expect(mapped.has(column.field), `${type}: "${column.header}" did not map`).toBe(true);
      }

      // And the example row survives as a usable record.
      expect(parsed.records).toHaveLength(1);
      expect(parsed.issues.filter((i) => i.code === "missing_identity")).toHaveLength(0);
    });
  }

  it("every template declares at least one required column", () => {
    for (const type of TEMPLATE_ORDER) {
      expect(requiredColumns(templateFor(type)).length).toBeGreaterThan(0);
    }
  });

  it("every column carries copy a pharmacy operator can act on", () => {
    for (const type of TEMPLATE_ORDER) {
      for (const c of templateFor(type).columns) {
        expect(c.description.length, `${type}/${c.header}`).toBeGreaterThan(15);
        expect(c.example.length, `${type}/${c.header}`).toBeGreaterThan(0);
        // Never a database column name.
        expect(c.header).not.toMatch(/_/);
      }
    }
  });

  it("the Wasfaty template requires the next-dispense date, not the fill date", () => {
    /*
     * The column the template exists for. The live file carried `raw fill date`
     * and no next-dispense column, so a forward window was applied to a
     * backward-looking field and 3,721 rows landed in the past.
     */
    const wasfaty = templateFor("wasfaty");
    const required = requiredColumns(wasfaty).map((c) => c.field);
    expect(required).toContain("nextDispenseDate");
    expect(required).toContain("patientId");
    expect(required).toContain("prescriptionNo");
    // The fill date is present but optional, and never decides eligibility.
    const fill = wasfaty.columns.find((c) => c.field === "fillDate");
    expect(fill?.required).toBe(false);
  });
});

describe("checkMapping", () => {
  const wasfaty = templateFor("wasfaty");

  it("accepts a file that supplies every required field", () => {
    const check = checkMapping(
      wasfaty,
      new Set(["nextDispenseDate", "patientId", "prescriptionNo"] as any),
    );
    expect(check.ok).toBe(true);
    expect(check.missingRequired).toHaveLength(0);
  });

  it("names the required fields a file did not supply", () => {
    const check = checkMapping(wasfaty, new Set(["patientId"] as any));
    expect(check.ok).toBe(false);
    expect(check.missingRequired.map((c) => c.field).sort()).toEqual([
      "nextDispenseDate",
      "prescriptionNo",
    ]);
  });

  it("does not fail a file for missing optional columns", () => {
    const check = checkMapping(
      wasfaty,
      new Set(["nextDispenseDate", "patientId", "prescriptionNo"] as any),
    );
    expect(check.ok).toBe(true);
    expect(check.missingOptional.length).toBeGreaterThan(0);
  });

  it("detects the fill-date fallback that produces no leads", () => {
    expect(wasfatyUsesFillDateFallback(new Set(["fillDate", "patientId"] as any))).toBe(true);
    expect(wasfatyUsesFillDateFallback(new Set(["fillDate", "nextDispenseDate"] as any))).toBe(
      false,
    );
    expect(wasfatyUsesFillDateFallback(new Set(["nextDispenseDate"] as any))).toBe(false);
  });
});

/* ===================================================================== */
/* B. The diagnostic reconciles                                          */
/* ===================================================================== */

describe("diagnoseImport", () => {
  const window = wasfatyWindow(TODAY, { days: DEFAULT_SETTINGS.wasfatyWindowDays });

  function diagnose(records: DiagnosableRecord[], extra: Record<string, unknown> = {}) {
    return diagnoseImport({
      leadType: "wasfaty",
      anchorDate: TODAY,
      window,
      records,
      catalog: CATALOGUE,
      ...extra,
    });
  }

  it("accounts for every row exactly once", () => {
    /*
     * The property the whole feature rests on. A reconciliation that does not
     * reconcile invites the reader to trust a number that is quietly wrong.
     */
    const records = [
      record({ sourceDate: TODAY }),
      record({ sourceDate: "2026-09-04" }),
      record({ sourceDate: "2026-08-01" }),
      record({ sourceDate: "2026-12-09" }),
      record({ sourceDate: null }),
      record({ patientId: null, prescriptionNo: null }),
    ];
    const d = diagnose(records);
    expect(d.rowsExamined).toBe(6);
    expect(d.buckets.reduce((s, b) => s + b.rows, 0)).toBe(6);
    expect(d.eligibleNow + d.alreadyGenerated + d.pendingFutureDate + d.permanentlyExcluded).toBe(
      6,
    );
  });

  it("reproduces the live shape: today and tomorrow qualify, the rest do not", () => {
    const records = [
      ...Array.from({ length: 25 }, () => record({ sourceDate: TODAY })),
      ...Array.from({ length: 21 }, () => record({ sourceDate: "2026-09-04" })),
      ...Array.from({ length: 3721 }, () => record({ sourceDate: "2026-08-02" })),
      ...Array.from({ length: 170 }, () => record({ sourceDate: "2026-10-02" })),
    ];
    const d = diagnose(records);
    expect(d.rowsExamined).toBe(3937);
    expect(d.eligibleNow).toBe(46);
    expect(d.pendingFutureDate).toBe(170);
    expect(d.permanentlyExcluded).toBe(3721);
  });

  it("splits outside-window by which side of the window the row fell on", () => {
    const d = diagnose([
      record({ sourceDate: "2026-08-01" }),
      record({ sourceDate: "2026-12-09" }),
    ]);
    const reasons = Object.fromEntries(d.buckets.map((b) => [b.reason, b.rows]));
    expect(reasons.outside_window_past).toBe(1);
    expect(reasons.outside_window_future).toBe(1);
  });

  it("reports a row already represented by a lead as already generated", () => {
    const d = diagnose([record({ sourceDate: TODAY })], {
      existingDedupKeys: new Set(["k1"]),
      dedupKeyFor: () => "k1",
    });
    expect(d.alreadyGenerated).toBe(1);
    expect(d.eligibleNow).toBe(0);
  });

  it("never reports an ineligible row as already generated", () => {
    /*
     * Precedence. "Already generated" is only meaningful for a row that would
     * otherwise qualify; claiming it for a refused row would say the generator
     * had accepted something it did not.
     */
    const d = diagnose([record({ sourceDate: "2026-01-01" })], {
      existingDedupKeys: new Set(["k1"]),
      dedupKeyFor: () => "k1",
    });
    expect(d.alreadyGenerated).toBe(0);
    expect(d.permanentlyExcluded).toBe(1);
  });

  it("applies one reason per row, in the generator's own precedence", () => {
    // No date *and* no identity: reported once, as the first rule that refused.
    const d = diagnose([record({ sourceDate: null, patientId: null, prescriptionNo: null })]);
    expect(d.rowsExamined).toBe(1);
    expect(d.buckets).toHaveLength(1);
    expect(d.buckets[0].reason).toBe("no_date");
  });

  it("refuses a Wasfaty row carrying neither a Patient ID nor a Prescription No", () => {
    const d = diagnose([record({ patientId: null, prescriptionNo: null })]);
    expect(d.buckets[0].reason).toBe("no_contact_identity");
  });

  it("keeps a Wasfaty row with no phone — finding the number is the agent's job", () => {
    const d = diagnose([record({ phone: null })]);
    expect(d.eligibleNow).toBe(1);
  });

  it("counts how many rows in each bucket can actually be dialled", () => {
    const d = diagnose([
      record({ sourceDate: TODAY, phone: "0504630565" }),
      record({ sourceDate: TODAY, phone: null }),
    ]);
    const eligible = d.buckets.find((b) => b.reason === "eligible")!;
    expect(eligible.rows).toBe(2);
    expect(eligible.withPhone).toBe(1);
  });

  it("reports the date range of each bucket", () => {
    const d = diagnose([
      record({ sourceDate: "2026-01-08" }),
      record({ sourceDate: "2026-09-02" }),
    ]);
    const past = d.buckets.find((b) => b.reason === "outside_window_past")!;
    expect(past.earliest).toBe("2026-01-08");
    expect(past.latest).toBe("2026-09-02");
  });

  it("orders the buckets so the actionable ones read first", () => {
    const d = diagnose([
      record({ sourceDate: "2026-08-01" }),
      record({ sourceDate: TODAY }),
      record({ sourceDate: "2026-12-01" }),
    ]);
    expect(d.buckets.map((b) => b.reason)).toEqual([
      "eligible",
      "outside_window_future",
      "outside_window_past",
    ]);
  });

  it("summarises itself as an equation", () => {
    const d = diagnose([record({ sourceDate: TODAY }), record({ sourceDate: "2026-08-01" })]);
    const text = describeDiagnosis(d);
    expect(text).toContain("2 rows");
    expect(text).toContain("1 eligible now");
    expect(text).toContain("1 excluded");
  });

  it("has copy for every reason it can report", () => {
    for (const reason of Object.keys(DIAGNOSIS_LABELS) as (keyof typeof DIAGNOSIS_LABELS)[]) {
      expect(DIAGNOSIS_LABELS[reason]).toBeTruthy();
      expect(DIAGNOSIS_EXPLANATIONS[reason].length).toBeGreaterThan(20);
    }
  });

  it("diagnoses Cash against the Cash window and the product catalogue", () => {
    const cash = cashWindow(TODAY, {
      days: DEFAULT_SETTINGS.cashWindowDays,
      lagDays: DEFAULT_SETTINGS.cashWindowLagDays,
    });
    const d = diagnoseImport({
      leadType: "cash",
      anchorDate: TODAY,
      window: cash,
      catalog: CATALOGUE,
      records: [
        record({
          sourceType: "cash",
          sourceDate: cash.to,
          itemCode: "10611028",
          customerName: "A",
        }),
        // In the window, but a product the desk does not work.
        record({ sourceType: "cash", sourceDate: cash.to, itemCode: "99001", customerName: "B" }),
      ],
    });
    expect(d.eligibleNow).toBe(1);
    const reasons = Object.fromEntries(d.buckets.map((b) => [b.reason, b.rows]));
    expect(reasons.ineligible_product).toBe(1);
  });

  it("diagnoses the retention backlog with no window at all", () => {
    const d = diagnoseImport({
      leadType: "retention",
      anchorDate: TODAY,
      window: null,
      catalog: CATALOGUE,
      records: [
        record({ sourceType: "retention", itemCode: "10611028", customerName: "A" }),
        record({ sourceType: "retention", itemCode: "99001", customerName: "B" }),
      ],
    });
    expect(d.eligibleNow).toBe(1);
    expect(d.pendingFutureDate).toBe(0);
  });

  it("handles an empty import without inventing a bucket", () => {
    const d = diagnose([]);
    expect(d.rowsExamined).toBe(0);
    expect(d.buckets).toHaveLength(0);
  });
});

/* ===================================================================== */
/* C. The diagnostic and the generator cannot disagree                   */
/* ===================================================================== */

describe("the report explains the run that would actually happen", () => {
  it("eligible rows equal the drafts the Wasfaty generator produces", () => {
    const window = wasfatyWindow(TODAY, { days: DEFAULT_SETTINGS.wasfatyWindowDays });
    const records = [
      record({ sourceDate: TODAY }),
      record({ sourceDate: "2026-09-04" }),
      record({ sourceDate: "2026-08-01" }),
      record({ sourceDate: null }),
      record({ patientId: null, prescriptionNo: null }),
    ];

    const d = diagnoseImport({
      leadType: "wasfaty",
      anchorDate: TODAY,
      window,
      records,
      catalog: CATALOGUE,
    });
    const run = generateWasfatyLeads(TODAY, records, DEFAULT_SETTINGS);

    expect(d.eligibleNow).toBe(run.drafts.length);
  });

  it("eligible rows equal the drafts the Cash generator produces", () => {
    const window = cashWindow(TODAY, {
      days: DEFAULT_SETTINGS.cashWindowDays,
      lagDays: DEFAULT_SETTINGS.cashWindowLagDays,
    });
    const records = [
      record({
        sourceType: "cash",
        sourceDate: window.to,
        itemCode: "10611028",
        customerName: "A",
      }),
      record({ sourceType: "cash", sourceDate: window.to, itemCode: "99001", customerName: "B" }),
      record({
        sourceType: "cash",
        sourceDate: "2020-01-01",
        itemCode: "10611028",
        customerName: "C",
      }),
      // In the window with a good product, but nothing identifying anybody.
      record({ sourceType: "cash", sourceDate: window.to, itemCode: "10611028" }),
    ];

    const d = diagnoseImport({
      leadType: "cash",
      anchorDate: TODAY,
      window,
      records,
      catalog: CATALOGUE,
    });
    const run = generateCashLeads(TODAY, records, CATALOGUE, DEFAULT_SETTINGS);

    expect(d.eligibleNow).toBe(run.drafts.length);
  });

  it("the judges are the functions the generators call", () => {
    /*
     * Asserted directly, because the guarantee is structural rather than
     * numerical: if the generator stopped calling the judge, the counts could
     * still coincide on a small fixture and drift on a real file.
     */
    const window = wasfatyWindow(TODAY, { days: 2 });
    const good = record({ sourceDate: TODAY });
    const bad = record({ sourceDate: "2020-01-01" });

    expect(judgeWasfatyRecord(good, window)).toEqual({ eligible: true });
    expect(judgeWasfatyRecord(bad, window)).toEqual({
      eligible: false,
      reason: "outside_window",
    });

    const cash = cashWindow(TODAY, { days: 3, lagDays: 1 });
    expect(
      judgeCashRecord(
        record({
          sourceType: "cash",
          sourceDate: cash.to,
          itemCode: "10611028",
          customerName: "A",
        }),
        cash,
        CATALOGUE,
      ),
    ).toEqual({ eligible: true });
    expect(
      judgeCashRecord(
        record({ sourceType: "cash", sourceDate: cash.to, itemCode: "99001", customerName: "A" }),
        cash,
        CATALOGUE,
      ),
    ).toEqual({ eligible: false, reason: "ineligible_product" });
  });

  it("a generator run reports the same skip totals the diagnosis buckets do", () => {
    const window = wasfatyWindow(TODAY, { days: DEFAULT_SETTINGS.wasfatyWindowDays });
    const records = [
      record({ sourceDate: TODAY }),
      record({ sourceDate: "2026-08-01" }),
      record({ sourceDate: "2026-12-01" }),
      record({ sourceDate: null }),
    ];
    const run = generateWasfatyLeads(TODAY, records, DEFAULT_SETTINGS);
    const d = diagnoseImport({
      leadType: "wasfaty",
      anchorDate: TODAY,
      window,
      records,
      catalog: CATALOGUE,
    });

    const reasons = Object.fromEntries(d.buckets.map((b) => [b.reason, b.rows]));
    expect(run.skipped.outside_window).toBe(
      (reasons.outside_window_past ?? 0) + (reasons.outside_window_future ?? 0),
    );
    expect(run.skipped.no_date).toBe(reasons.no_date ?? 0);
  });
});

/* ===================================================================== */
/* D. Import does not generate                                           */
/* ===================================================================== */

describe("importing is not generating", () => {
  it("parsing a workbook produces records and no leads", () => {
    /*
     * The architectural claim, asserted on the pure layer: the parser's output
     * is source rows. Nothing in it is a lead, and nothing about parsing a file
     * decides that anybody will be called.
     */
    const template = templateFor("wasfaty");
    const parsed = parseSheet([templateHeaders(template), templateExampleRow(template)], {
      sourceType: "wasfaty",
    });
    expect(parsed.records.length).toBe(1);
    expect(Object.keys(parsed)).not.toContain("drafts");
    expect(Object.keys(parsed)).not.toContain("leads");
  });

  it("a row stored today can be eligible on a later day, and the report says so", () => {
    // The honest answer to "why did my 170 future rows not become leads".
    const future = record({ sourceDate: "2026-09-10" });
    const notYet = diagnoseImport({
      leadType: "wasfaty",
      anchorDate: TODAY,
      window: wasfatyWindow(TODAY, { days: 2 }),
      records: [future],
      catalog: CATALOGUE,
    });
    expect(notYet.pendingFutureDate).toBe(1);
    expect(notYet.eligibleNow).toBe(0);

    const onTheDay = diagnoseImport({
      leadType: "wasfaty",
      anchorDate: "2026-09-10",
      window: wasfatyWindow("2026-09-10", { days: 2 }),
      records: [future],
      catalog: CATALOGUE,
    });
    expect(onTheDay.eligibleNow).toBe(1);
  });
});
