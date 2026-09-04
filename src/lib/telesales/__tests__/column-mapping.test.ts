import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMapping,
  describeProblem,
  manualCount,
  mayShareColumn,
  overridesFromMapping,
  storedMapping,
  validateMapping,
  type MappingRow,
} from "../column-mapping";
import { parseSheet, type ColumnOverrides } from "../parse";
import { requiredColumns, templateFor, templateHeaders } from "../templates";
import { generateCashLeads, generateWasfatyLeads } from "../generation";
import { buildCatalog } from "../products";
import { cashWindow, wasfatyWindow } from "../dates";
import { DEFAULT_SETTINGS, type SourceType } from "../types";

/**
 * Mapping a spreadsheet's columns to MilaPortal's fields, by hand.
 *
 * The feature is an *override*, so most of these tests are about what does not
 * change: a file the importer already understands parses identically, and a
 * mapping that touches nothing produces the same records it did before this
 * existed. What is new is the fourth file — a pharmacy's own export whose
 * headers `HEADER_ALIASES` has never seen — which was previously unimportable.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** A Cash sheet the importer recognises without help. */
const KNOWN_CASH = [
  ["Id", "Name", "Mobileno", "Wh_Cd", "InvNo", "InvDate", "Itm_Cd", "Itm_Name"],
  ["1", "Ahmed", "0504630565", "P0001", "188767", "2026-09-02", "10611028", "MOUNJARO 5 MG"],
];

/**
 * The same rows, under headers nothing recognises.
 *
 * This is the file the feature exists for: every column is spelled the
 * pharmacy's own way, so `locateHeader` finds fewer than its four matches and
 * refuses the sheet outright.
 */
const FOREIGN_CASH = [
  ["Ref", "Buyer", "Cell", "Store", "Doc", "Sold On", "SKU", "Description"],
  ["1", "Ahmed", "0504630565", "P0001", "188767", "2026-09-02", "10611028", "MOUNJARO 5 MG"],
];

const CATALOGUE = buildCatalog(
  [
    {
      itemCode: "10611028",
      itemName: "MOUNJARO 5 MG",
      family: "mounjaro",
      strength: "5 MG",
      category: null,
      eligibleCash: true,
      eligibleRetention: true,
      refillDays: 28,
      active: true,
    },
  ],
  [],
);

const detectedOf = (grid: unknown[][], type: SourceType, overrides: ColumnOverrides = {}) =>
  new Map(
    Object.entries(
      parseSheet(grid, { sourceType: type, columnOverrides: overrides }).mappedColumns,
    ),
  );

/* ===================================================================== */
/* A. Auto-mapping is untouched                                          */
/* ===================================================================== */

describe("auto-mapping remains the default", () => {
  it("a recognised file parses identically with no overrides", () => {
    const before = parseSheet(KNOWN_CASH, { sourceType: "cash" });
    const after = parseSheet(KNOWN_CASH, { sourceType: "cash", columnOverrides: {} });
    expect(after).toEqual(before);
    expect(after.records).toHaveLength(1);
  });

  it("still refuses an unrecognised sheet when nobody has mapped it", () => {
    // The existing behaviour, unchanged: guessing is worse than refusing.
    const parsed = parseSheet(FOREIGN_CASH, { sourceType: "cash" });
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0].code).toBe("missing_identity");
  });

  it("offers the first row's columns even when detection failed", () => {
    /*
     * Without this the mapping screen would have nothing to map *from*,
     * precisely on the file that needs mapping.
     */
    const parsed = parseSheet(FOREIGN_CASH, { sourceType: "cash" });
    expect(parsed.headers).toEqual(FOREIGN_CASH[0]);
  });

  it("every field a mapping row can carry starts on what detection found", () => {
    const rows = buildMapping("cash", detectedOf(KNOWN_CASH, "cash"));
    const invoiceDate = rows.find((r) => r.field === "sourceDate")!;
    expect(invoiceDate.column).toBe(5);
    expect(invoiceDate.auto).toBe(true);
    // A field the file does not carry is simply unmapped, not an error.
    expect(rows.find((r) => r.field === "quantity")?.column).toBeNull();
  });
});

/* ===================================================================== */
/* B. The override                                                       */
/* ===================================================================== */

describe("a manual mapping overrides detection", () => {
  it("points a field at a different column", () => {
    // `Name` is column 1 and `Itm_Name` is 7; say the customer name is in 7.
    const parsed = parseSheet(KNOWN_CASH, {
      sourceType: "cash",
      columnOverrides: { customerName: 7 },
    });
    expect(parsed.records[0].customerName).toBe("MOUNJARO 5 MG");
    // And leaves everything it did not mention alone.
    expect(parsed.records[0].phone).toBe("0504630565");
  });

  it("unmaps a column with null", () => {
    /*
     * The escape hatch for a header the alias table claims wrongly — an
     * operator who can see `Customer` taken as the channel needs a way to say
     * "not that one".
     */
    const parsed = parseSheet(KNOWN_CASH, {
      sourceType: "cash",
      columnOverrides: { phone: null },
    });
    expect(parsed.records[0].phone).toBeNull();
    expect(parsed.mappedFields).not.toContain("phone");
  });

  it("makes an otherwise unimportable file importable", () => {
    // The whole point. Same rows, unrecognised headers, mapped by hand.
    const overrides: ColumnOverrides = {
      customerRef: 0,
      customerName: 1,
      phone: 2,
      branchNo: 3,
      documentNo: 4,
      sourceDate: 5,
      itemCode: 6,
      itemName: 7,
    };
    const parsed = parseSheet(FOREIGN_CASH, { sourceType: "cash", columnOverrides: overrides });
    expect(parsed.issues.find((i) => i.code === "missing_identity")).toBeUndefined();
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      customerName: "Ahmed",
      phone: "0504630565",
      branchNo: "P0001",
      documentNo: "188767",
      sourceDate: "2026-09-02",
      itemCode: "10611028",
    });
  });

  it("records which fields a person chose", () => {
    const rows = buildMapping("cash", detectedOf(KNOWN_CASH, "cash"), { customerName: 7 });
    const chosen = rows.find((r) => r.field === "customerName")!;
    expect(chosen.column).toBe(7);
    expect(chosen.auto).toBe(false);
    expect(manualCount(rows)).toBe(1);
    // Choosing the same column detection found still counts as a decision:
    // "I checked this" is worth distinguishing from "nobody looked".
    const same = buildMapping("cash", detectedOf(KNOWN_CASH, "cash"), { customerName: 1 });
    expect(same.find((r) => r.field === "customerName")?.auto).toBe(false);
  });

  it("round-trips through the parser's option shape", () => {
    /*
     * Only the operator's own choices travel, so re-parsing with these and
     * re-parsing without them agree wherever nobody intervened — which is what
     * makes this an override rather than a second mapping.
     */
    const rows = buildMapping("cash", detectedOf(KNOWN_CASH, "cash"), { customerName: 7 });
    expect(overridesFromMapping(rows)).toEqual({ customerName: 7 });
    expect(overridesFromMapping(buildMapping("cash", detectedOf(KNOWN_CASH, "cash")))).toEqual({});
  });
});

/* ===================================================================== */
/* C. Validation                                                         */
/* ===================================================================== */

describe("validateMapping", () => {
  const headers = FOREIGN_CASH[0];

  const rowsFor = (type: SourceType, overrides: ColumnOverrides) =>
    buildMapping(type, new Map(), overrides);

  it("accepts a mapping with every required field placed", () => {
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6, itemName: 7 });
    expect(validateMapping(rows, headers).ok).toBe(true);
  });

  it("refuses a required field with no column, and names it", () => {
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6 });
    const verdict = validateMapping(rows, headers);
    expect(verdict.ok).toBe(false);
    const missing = verdict.problems.filter((p) => p.kind === "missing_required");
    expect(missing).toHaveLength(1);
    expect(describeProblem(missing[0])).toContain("Item Name");
    expect(describeProblem(missing[0])).toContain("required");
  });

  it("names every required field for each source type", () => {
    // The lists come from the templates, so they cannot drift from the download.
    for (const type of ["cash", "retention", "wasfaty"] as SourceType[]) {
      const verdict = validateMapping(rowsFor(type, {}), headers);
      expect(verdict.ok, type).toBe(false);
      expect(verdict.problems, type).toHaveLength(requiredColumns(templateFor(type)).length);
    }
  });

  it("allows an unmapped optional field", () => {
    // Most files carry a subset; refusing them would make the template a
    // requirement rather than a convenience.
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6, itemName: 7 });
    expect(rows.some((r) => !r.required && r.column == null)).toBe(true);
    expect(validateMapping(rows, headers).ok).toBe(true);
  });

  it("refuses one column feeding two different fields", () => {
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6, itemName: 7, phone: 7 });
    const verdict = validateMapping(rows, headers);
    expect(verdict.ok).toBe(false);
    const dupe = verdict.problems.find((p) => p.kind === "duplicate_column");
    expect(dupe).toBeTruthy();
    expect(describeProblem(dupe!)).toContain("Description");
    expect(describeProblem(dupe!)).toContain("cannot mean two different things");
  });

  it("allows the one pair the parser deliberately shares", () => {
    /*
     * For Wasfaty, `parseSheet` picks a primary date field of next-dispense or
     * fill date and, when it lands on the latter, assigns the same parsed value
     * to both. A sheet with one date column that is both is a real shape.
     */
    expect(mayShareColumn("fillDate", "nextDispenseDate")).toBe(true);
    expect(mayShareColumn("phone", "customerRef")).toBe(false);

    const rows = rowsFor("wasfaty", {
      nextDispenseDate: 5,
      fillDate: 5,
      patientId: 0,
      prescriptionNo: 4,
    });
    expect(validateMapping(rows, headers).ok).toBe(true);
  });

  it("reports the header the operator will recognise", () => {
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6, itemName: 7, phone: 7 });
    const dupe = validateMapping(rows, headers).problems.find((p) => p.kind === "duplicate_column");
    expect(dupe && dupe.kind === "duplicate_column" && dupe.header).toBe("Description");
  });

  it("falls back to a column number when the header is blank", () => {
    const blank = ["", "", "", "", "", "", "", ""];
    const rows = rowsFor("cash", { sourceDate: 5, itemCode: 6, itemName: 7, phone: 7 });
    const dupe = validateMapping(rows, blank).problems.find((p) => p.kind === "duplicate_column");
    expect(dupe && dupe.kind === "duplicate_column" && dupe.header).toBe("Column 8");
  });
});

/* ===================================================================== */
/* D. Generation uses the confirmed mapping                              */
/* ===================================================================== */

describe("generation reads what the mapping produced", () => {
  const TODAY = "2026-09-03";

  it("a hand-mapped Cash file produces the same leads a recognised one would", () => {
    /*
     * The end-to-end claim. Mapping changes which column a field is read from;
     * it changes no eligibility rule, so the same underlying row yields the
     * same lead either way.
     */
    const window = cashWindow(TODAY, {
      days: DEFAULT_SETTINGS.cashWindowDays,
      lagDays: DEFAULT_SETTINGS.cashWindowLagDays,
    });
    const dated = (grid: unknown[][]) =>
      grid.map((row, i) => (i === 0 ? row : row.map((c, j) => (j === 5 ? window.to : c))));

    const auto = parseSheet(dated(KNOWN_CASH), { sourceType: "cash" });
    const manual = parseSheet(dated(FOREIGN_CASH), {
      sourceType: "cash",
      columnOverrides: {
        customerRef: 0,
        customerName: 1,
        phone: 2,
        branchNo: 3,
        documentNo: 4,
        sourceDate: 5,
        itemCode: 6,
        itemName: 7,
      },
    });

    const withIds = (p: typeof auto) => p.records.map((r, i) => ({ ...r, id: `r${i}` }));
    const a = generateCashLeads(TODAY, withIds(auto), CATALOGUE, DEFAULT_SETTINGS);
    const m = generateCashLeads(TODAY, withIds(manual), CATALOGUE, DEFAULT_SETTINGS);

    expect(a.drafts).toHaveLength(1);
    expect(m.drafts).toHaveLength(1);
    // Same customer, same product, same day — therefore the same dedup key, so
    // importing the same data twice under two mappings cannot double the work.
    expect(m.drafts[0].dedupKey).toBe(a.drafts[0].dedupKey);
    expect(m.drafts[0].itemCode).toBe("10611028");
  });

  it("a Wasfaty file mapped onto the wrong date column is still judged by the window", () => {
    /*
     * Mapping does not relax eligibility. A dispense date outside today and
     * tomorrow produces no lead however it was mapped.
     */
    const grid = [
      ["Pt", "Rx", "When"],
      ["1098765432", "J8952992", "2026-01-08"],
    ];
    const parsed = parseSheet(grid, {
      sourceType: "wasfaty",
      columnOverrides: { patientId: 0, prescriptionNo: 1, nextDispenseDate: 2 },
    });
    expect(parsed.records).toHaveLength(1);

    const run = generateWasfatyLeads(
      TODAY,
      parsed.records.map((r, i) => ({ ...r, id: `r${i}` })),
      DEFAULT_SETTINGS,
    );
    expect(run.drafts).toHaveLength(0);
    expect(run.skipped.outside_window).toBe(1);

    // And in the window, the same mapping produces one.
    const open = wasfatyWindow(TODAY, { days: DEFAULT_SETTINGS.wasfatyWindowDays });
    const inWindow = parseSheet([grid[0], ["1098765432", "J8952992", open.from]], {
      sourceType: "wasfaty",
      columnOverrides: { patientId: 0, prescriptionNo: 1, nextDispenseDate: 2 },
    });
    expect(
      generateWasfatyLeads(
        TODAY,
        inWindow.records.map((r, i) => ({ ...r, id: `r${i}` })),
        DEFAULT_SETTINGS,
      ).drafts,
    ).toHaveLength(1);
  });

  it("a template file needs no mapping at all", () => {
    // The reliability path stays the reliability path.
    for (const type of ["cash", "retention", "wasfaty"] as SourceType[]) {
      const template = templateFor(type);
      const parsed = parseSheet(
        [templateHeaders(template), template.columns.map((c) => c.example)],
        {
          sourceType: type,
        },
      );
      const rows = buildMapping(type, new Map(Object.entries(parsed.mappedColumns)));
      expect(validateMapping(rows, parsed.headers).ok, type).toBe(true);
      expect(manualCount(rows), type).toBe(0);
    }
  });
});

/* ===================================================================== */
/* E. What is recorded                                                   */
/* ===================================================================== */

describe("the mapping recorded with the import", () => {
  it("is written in headers a person can read, not indices", () => {
    const rows = buildMapping("cash", detectedOf(KNOWN_CASH, "cash"), { customerName: 7 });
    const stored = storedMapping(rows, KNOWN_CASH[0] as string[]);
    expect(stored["Customer Name"]).toEqual({ column: "Itm_Name", auto: false });
    expect(stored["Invoice Date"]).toEqual({ column: "InvDate", auto: true });
    expect(stored["Quantity"]).toEqual({ column: null, auto: true });
  });

  it("is per import and never reapplied", () => {
    /*
     * A saved, reapplied mapping is a different feature with a worse failure
     * mode: applied silently to a file whose columns have moved, producing an
     * import that succeeds and is wrong.
     */
    for (const file of [
      "lib/telesales/column-mapping.ts",
      "features/telesales/components/column-mapping-panel.tsx",
    ]) {
      const text = source(file);
      expect(text).not.toContain("localStorage");
      expect(text).not.toContain("supabase");
    }
  });
});

/* ===================================================================== */
/* F. One parser, one pipeline                                           */
/* ===================================================================== */

describe("nothing was forked", () => {
  it("the mapping module makes no decisions the parser makes", () => {
    const mod = source("lib/telesales/column-mapping.ts");
    /*
     * It offers fields and validates choices; it does not read cells. Asserted
     * on code rather than on words -- the header comment names `HEADER_ALIASES`
     * to explain what this is *not*, which is documentation, not a dependency.
     */
    expect(mod).not.toMatch(/HEADER_ALIASES\[/);
    expect(mod).not.toMatch(/\bparseSheet\(/);
    expect(mod).not.toMatch(/\bnormalizeHeader\(/);
    /*
     * It takes the parser's *types* — `Field` and `ColumnOverrides` — which is
     * the reuse, and no value from it, which would be the fork. Type imports
     * are erased, so this cannot become a runtime dependency by accident.
     */
    expect(mod).toMatch(/^import type \{[^}]*\} from "\.\/parse"/m);
    expect(mod).not.toMatch(/^import \{[^}]*\} from "\.\/parse"/m);
  });

  it("the field list comes from the templates rather than a second copy", () => {
    const mod = source("lib/telesales/column-mapping.ts");
    expect(mod).toContain("templateFor");
    // Required flags too — one declaration, used by the download and the panel.
    const rows = buildMapping("wasfaty", new Map());
    const required = rows
      .filter((r) => r.required)
      .map((r) => r.field)
      .sort();
    expect(required).toEqual(
      requiredColumns(templateFor("wasfaty"))
        .map((c) => c.field)
        .sort(),
    );
  });

  it("the import screen re-parses through the same entry point", () => {
    const page = source("routes/_app.telesales.import.tsx");
    expect(page).toContain("parseWorkbookFile");
    // One call site, taking the override as an option.
    expect(page).toContain("columnOverrides");
    expect(page.match(/parseWorkbookFile\(/g) ?? []).toHaveLength(1);
  });

  it("the mapping is sent with the import rather than applied server-side", () => {
    // Rows arrive already normalised, so generation needs no knowledge of it.
    const page = source("routes/_app.telesales.import.tsx");
    expect(page).toContain("columnMapping: storedMapping(");
    const generate = source("lib/telesales/generate.server.ts");
    expect(generate).not.toContain("columnOverrides");
    expect(generate).not.toContain("column_mapping");
  });
});
