import { describe, expect, it } from "vitest";
import { normalizeHeader, parseSheet } from "../parse";

/**
 * The five layouts, as they actually appear.
 *
 * Every header row below is copied verbatim from one of the three workbooks, and
 * every data row is a real row from it (names and numbers included, because the
 * point of these tests is that the parser survives the data as it is). The
 * layouts are:
 *
 *   1. `July Leads` → `Main Database`
 *   2. `July Leads` → `5-6`            (a worked Cash sheet)
 *   3. `Retention Leads` → `Retention`
 *   4. `Wasfaty Leads` → `Wasfaty Sep` (the current Wasfaty shape)
 *   5. `Wasfaty Leads` → `Taif`        (the per-city shape)
 */

describe("header normalisation", () => {
  it("makes one header out of the spellings the workbooks use", () => {
    expect(normalizeHeader("PRESCRIPTION NO.")).toBe("prescription no");
    expect(normalizeHeader("Prescription No")).toBe("prescription no");
    expect(normalizeHeader("Total Value (SAR)")).toBe("total value sar");
    expect(normalizeHeader("Wh_Cd")).toBe("wh cd");
    expect(normalizeHeader("  ")).toBe("");
    expect(normalizeHeader(null)).toBe("");
  });
});

describe("layout 1 — the raw Cash extract", () => {
  const grid: unknown[][] = [
    [
      "Id",
      "Name",
      "Mobileno",
      "Wh_Cd",
      "Customer",
      "InvNo",
      "InvDate",
      "Itm_Cd",
      "Itm_Name",
      "Qty",
    ],
    [
      "509226",
      "MOHAMED",
      "0535323292",
      "P0001",
      "CASH IN BOX",
      "188767",
      "7/21/26 0:00",
      "10611031",
      "MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR",
      "1",
    ],
    [
      "509226",
      "MOHAMED",
      "0535323292",
      "P0001",
      "CASH IN BOX",
      "188767",
      "7/21/26 0:00",
      "10609943",
      "NERVAN 500 MG TAB 30'S",
      "1",
    ],
  ];

  it("detects Cash and reads every field", () => {
    const parsed = parseSheet(grid);
    expect(parsed.sourceType).toBe("cash");
    expect(parsed.records).toHaveLength(2);

    const [first] = parsed.records;
    expect(first.customerRef).toBe("509226");
    expect(first.customerName).toBe("MOHAMED");
    expect(first.phoneE164).toBe("+966535323292");
    expect(first.branchNo).toBe("P0001");
    expect(first.documentNo).toBe("188767");
    expect(first.sourceDate).toBe("2026-07-21");
    expect(first.itemCode).toBe("10611031");
    expect(first.quantity).toBe(1);
  });

  it("reads `Customer` as the channel, not as a customer name", () => {
    // The mistake this guards against: `CASH IN BOX` is a payment channel, and a
    // parser that treated it as the customer would key every Cash lead in the
    // file on the same three customers.
    const parsed = parseSheet(grid);
    expect(parsed.records[0].channel).toBe("CASH IN BOX");
    expect(parsed.records[0].customerName).toBe("MOHAMED");
  });

  it("stores every row, eligible or not — filtering is the generator's job", () => {
    // NERVAN is not a telesales product, but the source table keeps the whole
    // extract so a later eligibility change can be applied retrospectively.
    expect(parseSheet(grid).records.map((r) => r.itemCode)).toEqual(["10611031", "10609943"]);
  });

  it("numbers rows the way Excel does", () => {
    expect(parseSheet(grid).records.map((r) => r.rowNumber)).toEqual([2, 3]);
  });
});

describe("layout 2 — a worked Cash sheet", () => {
  const grid: unknown[][] = [
    [
      "Itm_Cd",
      "Name",
      "Mobileno",
      "Wh_Cd",
      "Customer",
      "InvNo",
      "InvDate",
      "Itm_Name",
      "Qty",
      "sub Categ",
      "PriceIncludeTAX",
      "Agent Name",
      "Action",
      "Date to be called",
      "Days to refill",
      "Notes",
    ],
    [
      "10602062",
      "SULTAN",
      "563499119",
      "P0001",
      "CASH IN BOX",
      "187433",
      "05-07-26",
      "RYBELSUS 3MG TAB, 30'S",
      "1",
      "ANTI-DIABETIC",
      "456.7",
      "Ahmed Mousad (1000)",
      "No Answer or Busy",
      null,
      "46266 Days Overdue",
      null,
    ],
    [
      "10611030",
      "MOSTSHAR NADER HEGAZY",
      "552799678",
      "P0002",
      "CASH IN BOX",
      "205495",
      "05-07-26",
      "MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA",
      "1",
      "ANTI-DIABETIC",
      "1261.4",
      "Ahmed Mousad (1000)",
      "Reschedule call",
      "Thursday, September 3",
      "2 Days Remaining",
      null,
    ],
  ];

  it("reads the desk's own columns and ignores the derived one", () => {
    const parsed = parseSheet(grid);
    const [first] = parsed.records;
    expect(first.agentLabel).toBe("Ahmed Mousad (1000)");
    expect(first.actionLabel).toBe("No Answer or Busy");
    expect(first.unitPrice).toBe(456.7);
    expect(first.sourceDate).toBe("2026-07-05");
    // "Days to refill" has no field. It is `=TODAY()-<callback>` and importing
    // its rendered text would import the bug.
    expect(Object.keys(first)).not.toContain("daysToRefill");
  });

  it("refuses a callback date Excel rendered as prose", () => {
    // "Thursday, September 3" is a display format, not a date this parser will
    // guess at. It becomes null and the raw cell is kept for the operator.
    const parsed = parseSheet(grid);
    expect(parsed.records[1].callbackDate).toBeNull();
    expect(parsed.records[1].raw["Date to be called"]).toBe("Thursday, September 3");
  });

  it("keeps the untouched row for auditing", () => {
    const parsed = parseSheet(grid);
    expect(parsed.records[0].raw["Days to refill"]).toBe("46266 Days Overdue");
  });
});

describe("layout 3 — the Retention backlog", () => {
  const grid: unknown[][] = [
    [
      "Name",
      "Mobileno",
      "Wh_Cd",
      "InvNo",
      "InvDate",
      "Itm_Cd",
      "Itm_Name",
      "Agent Name",
      "Action",
      "Date to be called",
      "Days to refill",
      "Notes",
    ],
    [
      "SHAHIN",
      "508718039",
      "P0011",
      "211946",
      "02/03/2026",
      "10611028",
      "MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA",
      "Ahmed Mousad (1000)",
      "Reschedule call",
      "2026-08-20",
      "12 Days Overdue",
      null,
    ],
  ];

  it("is detected as retention, not as a raw Cash extract", () => {
    // It is Cash-shaped, so the discriminator is the presence of worked columns
    // without the `Id`/`Qty` pair that marks a raw extract.
    expect(parseSheet(grid).sourceType).toBe("retention");
  });

  it("carries the promised callback across", () => {
    const parsed = parseSheet(grid);
    expect(parsed.records[0].callbackDate).toBe("2026-08-20");
    expect(parsed.records[0].actionLabel).toBe("Reschedule call");
  });

  it("can be overridden by the operator's explicit choice", () => {
    expect(parseSheet(grid, { sourceType: "cash" }).sourceType).toBe("cash");
  });
});

describe("layout 4 — the current Wasfaty shape", () => {
  const grid: unknown[][] = [
    [
      "Pharmacy",
      "City",
      "Patient ID",
      "Prescription No",
      "Patient Name",
      "Phone",
      "Total Value (SAR)",
      "Dispense Time",
      "Agent",
      "Action",
      "Next Dispense Date",
      "Days to refill",
      "Notes",
    ],
    [
      "202",
      "Jeddah",
      "1201435151",
      "v0982999",
      "حسن عبدالله الشريف",
      null,
      "1049.94",
      "14:07",
      "Ahmed Mousad (1000)",
      "Rejected",
      "2026-11-11",
      "71 Days Remaining",
      "15:43",
    ],
    [
      "701",
      "Ihsaa",
      "1143646618",
      "l9564343",
      null,
      null,
      "1049.94",
      "18:23",
      null,
      null,
      "2026-09-05",
      "4 Days Remaining",
      null,
    ],
  ];

  it("detects Wasfaty from its identifiers", () => {
    const parsed = parseSheet(grid);
    expect(parsed.sourceType).toBe("wasfaty");
    expect(parsed.records).toHaveLength(2);
  });

  it("uses Next Dispense Date as the operative date", () => {
    const parsed = parseSheet(grid);
    expect(parsed.records[0].sourceDate).toBe("2026-11-11");
    expect(parsed.records[1].sourceDate).toBe("2026-09-05");
  });

  it("keeps the pharmacy code out of the P-code identifier space", () => {
    // `202` is a Wasfaty pharmacy number, not a `branches.branch_no` value.
    // Prefixing it to `P0202` would produce a code that looks like a Shams
    // branch and is not one.
    expect(parseSheet(grid).records[0].branchNo).toBe("202");
  });

  it("records a missing phone without complaining about it", () => {
    const parsed = parseSheet(grid);
    expect(parsed.records[0].phoneE164).toBeNull();
    // No `unusable_phone` issue: the cell is empty, which is the normal case.
    expect(parsed.issues.some((i) => i.code === "unusable_phone")).toBe(false);
  });

  it("reads Arabic patient names unchanged", () => {
    expect(parseSheet(grid).records[0].customerName).toBe("حسن عبدالله الشريف");
  });
});

describe("layout 5 — the per-city Wasfaty sheets", () => {
  const grid: unknown[][] = [
    [
      "BRANCH",
      "ID",
      "PRESCRIPTION NO.",
      "TOTAL VALUE (SAR)",
      "FILL DATE",
      "Agent",
      "Action",
      "Date to be called",
      "Days to refill",
      "Note",
    ],
    [
      "123",
      "1005977416",
      "a2158588",
      "248.11",
      "06/04/26",
      "Ahmed Mousad (1000)",
      null,
      null,
      "46266 Days Overdue",
      null,
    ],
    [
      "123",
      "1004470439",
      "l8000544",
      "164.87",
      "30/06/26",
      "Ahmed Mousad (1000)",
      "No Answer or Busy",
      null,
      "63 Days Overdue",
      "533007995",
    ],
    [
      "123",
      "1004460000",
      "j7432306",
      "-",
      "no record",
      "Ahmed Mousad (1000)",
      null,
      null,
      null,
      null,
    ],
  ];

  it("falls back to the fill date when there is no next-dispense column", () => {
    const parsed = parseSheet(grid);
    expect(parsed.sourceType).toBe("wasfaty");
    // 30/06/26 is unambiguous and proves the column is day-first, which then
    // resolves 06/04/26 as 6 April rather than 4 June.
    expect(parsed.records[0].sourceDate).toBe("2026-04-06");
    expect(parsed.records[1].sourceDate).toBe("2026-06-30");
    // The fill date is recorded as such, so a lead generated off it can be told
    // apart from one generated off a real next-dispense date.
    expect(parsed.records[0].fillDate).toBe("2026-04-06");
  });

  it("stores a row whose date is unreadable, and reports the row number", () => {
    const parsed = parseSheet(grid);
    expect(parsed.records).toHaveLength(3);
    expect(parsed.records[2].sourceDate).toBeNull();
    const issue = parsed.issues.find((i) => i.code === "unparseable_date");
    expect(issue?.rows).toEqual([4]);
  });

  it("reads a dash in a money column as no value, not as zero", () => {
    expect(parseSheet(grid).records[2].totalValue).toBeNull();
    expect(parseSheet(grid).records[0].totalValue).toBe(248.11);
  });
});

describe("what the parser refuses", () => {
  it("reports a sheet with no recognisable header instead of guessing", () => {
    const parsed = parseSheet([
      ["some", "unrelated", "spreadsheet"],
      [1, 2, 3],
    ]);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues[0].code).toBe("missing_identity");
  });

  it("skips blank rows without counting them as errors", () => {
    const parsed = parseSheet([
      ["Id", "Name", "Mobileno", "Wh_Cd", "InvNo", "InvDate", "Itm_Cd", "Itm_Name"],
      ["1", "A", "0500000000", "P0001", "1", "2026-07-30", "10611031", "MOUNJARO"],
      [null, null, null, null, null, null, null, null],
      ["", "", "", "", "", "", "", ""],
    ]);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.rowsSeen).toBe(1);
    expect(parsed.issues).toHaveLength(0);
  });

  it("collapses a row repeated inside one sheet, and counts it", () => {
    // Taif has 184 repeated Patient+Prescription pairs.
    const parsed = parseSheet([
      ["BRANCH", "ID", "PRESCRIPTION NO.", "TOTAL VALUE (SAR)", "FILL DATE"],
      ["123", "1005977416", "a2158588", "248.11", "30/06/26"],
      ["123", "1005977416", "a2158588", "248.11", "30/06/26"],
    ]);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.issues.find((i) => i.code === "duplicate_row")?.rows).toEqual([3]);
  });

  it("drops a row that identifies nobody", () => {
    const parsed = parseSheet([
      ["Id", "Name", "Mobileno", "Wh_Cd", "InvNo", "InvDate", "Itm_Cd", "Itm_Name"],
      ["1", "A", "0500000000", "P0001", "1", "2026-07-30", null, null],
    ]);
    expect(parsed.records).toHaveLength(0);
    expect(parsed.issues.find((i) => i.code === "missing_identity")?.rows).toEqual([2]);
  });

  it("flags a phone cell that is present but unusable", () => {
    const parsed = parseSheet([
      ["Id", "Name", "Mobileno", "Wh_Cd", "InvNo", "InvDate", "Itm_Cd", "Itm_Name"],
      [
        "1",
        "REFUSED TO GET MOBILE NUMBER",
        "0",
        "P0001",
        "1",
        "2026-07-30",
        "10611031",
        "MOUNJARO",
      ],
    ]);
    // The row is kept — it is a real lead — and the phone is reported.
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].phoneE164).toBeNull();
    expect(parsed.issues.find((i) => i.code === "unusable_phone")?.rows).toEqual([2]);
  });
});

describe("re-upload detection", () => {
  it("gives the same workbook the same digest and a changed one a different digest", () => {
    const header = ["Id", "Name", "Mobileno", "Wh_Cd", "InvNo", "InvDate", "Itm_Cd", "Itm_Name"];
    const a = parseSheet([
      header,
      ["1", "A", "0500000000", "P0001", "1", "2026-07-30", "10611031", "MOUNJARO"],
    ]);
    const b = parseSheet([
      header,
      ["1", "A", "0500000000", "P0001", "1", "2026-07-30", "10611031", "MOUNJARO"],
    ]);
    const c = parseSheet([
      header,
      ["1", "A", "0500000000", "P0001", "1", "2026-07-31", "10611031", "MOUNJARO"],
    ]);
    expect(a.contentDigest).toBe(b.contentDigest);
    expect(a.contentDigest).not.toBe(c.contentDigest);
  });
});
