import { describe, expect, it } from "vitest";
import { chooseSheet, parseSheet, summarize } from "../import-parse";

/**
 * The header row is transcribed from the live master workbook, trailing newline
 * in "Scooter\n" included, and it deliberately has no "Duty Hours" column —
 * that is the shape the importer has to accept on day one.
 */
const HEADER = [
  "Branch Code",
  "Phone No",
  "City",
  "Scooter\n",
  "Area Manager",
  "Area Manager Contact Number",
  "Email",
  "Address",
  "Location",
  "Latitude",
  "Longitude",
  "Start - End",
  "Friday Duty",
];

const P0001 = [
  "P0001",
  "599089497",
  "الرياض",
  "سكوتر",
  "DR / Mohamed Abd Elmohsen",
  "=+966 50 073 3054",
  "ph01@ghodafpharmacy.com",
  "الرياض/ حي الحزم /ش علي النقيب",
  "https://maps.app.goo.gl/oy8ZPVd5tX9nEh4W7",
  "24.53728256",
  "46.64560984",
  "06 AM - 06 AM",
  "12.30 PM - 12.30 AM",
];

/** A facility row: dashes in most columns, no area manager, no coordinates. */
const WAREHOUSE = [
  "المستودع",
  "-",
  "الرياض",
  "-",
  "-",
  "-",
  "-",
  "الرياض/السلي",
  "",
  "",
  "",
  "-",
  "-",
];

const SECOND_WAREHOUSE = (() => {
  const row = [...WAREHOUSE];
  row[2] = "جدة";
  row[7] = "جدة/حراج الصواريخ";
  return row;
})();

const BLANK = HEADER.map(() => "");

const options = { fileName: "master.xlsx", sheetName: "Branches" };

describe("parseSheet", () => {
  it("reads a row from the real sheet, quirks and all", () => {
    const preview = parseSheet([HEADER, P0001], options);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      row: 2,
      branch_no: "P0001",
      city: "الرياض",
      phone: "+966599089497",
      // The "=" prefix Excel adds is stripped before parsing.
      area_manager_phone: "+966500733054",
      scooter: true,
      scooter_note: "سكوتر",
      latitude: 24.5372826,
      longitude: 46.6456098,
      // No Duty Hours column, so it is derived from "06 AM - 06 AM".
      duty_hours: 24,
    });
    expect(preview.missingColumns).toEqual(["Duty Hours"]);
  });

  it("matches the Scooter column despite the newline in its header", () => {
    const preview = parseSheet([HEADER, P0001], options);
    expect(preview.rows[0].scooter).toBe(true);
  });

  it("skips the sheet's trailing blank rows silently", () => {
    // The live file is 1010 rows for 145 branches. Reporting 865 errors would
    // bury the handful that matter.
    const grid = [HEADER, P0001, ...Array.from({ length: 200 }, () => [...BLANK])];
    const preview = parseSheet(grid, options);
    expect(preview.rows).toHaveLength(1);
    expect(preview.issues.filter((issue) => issue.level === "critical")).toHaveLength(0);
  });

  it("keeps both warehouse rows by numbering the repeat", () => {
    // Both warehouse rows in the master sheet are coded "المستودع". They are two
    // real, different places, so the default policy must not lose one of them.
    const preview = parseSheet([HEADER, WAREHOUSE, SECOND_WAREHOUSE], options);

    expect(preview.rows.map((row) => row.branch_no)).toEqual(["المستودع", "المستودع-2"]);
    expect(preview.rejected).toBe(0);
    const note = preview.issues.find((issue) => issue.level === "info");
    expect(note).toMatchObject({ row: 3, branchNo: "المستودع-2", field: "Branch Code" });
    // The second warehouse keeps its own address rather than the first's.
    expect(preview.rows[1].address).toBe("جدة/حراج الصواريخ");
  });

  it("never auto-numbers a repeated pharmacy code", () => {
    // A pharmacy code identifies one shop that 2,000+ orders point at. Silently
    // minting "P0001-2" would invent a branch nobody has.
    const second = [...P0001];
    second[7] = "عنوان آخر";
    const preview = parseSheet([HEADER, P0001, second], options);

    expect(preview.rows).toHaveLength(1);
    expect(preview.rejected).toBe(1);
    const critical = preview.issues.find((issue) => issue.level === "critical");
    expect(critical).toMatchObject({ row: 3, branchNo: "P0001" });
    expect(critical?.message).toContain("unique");
  });

  it("honours first-wins for facility duplicates", () => {
    const preview = parseSheet([HEADER, WAREHOUSE, SECOND_WAREHOUSE], {
      ...options,
      options: { facilityDuplicates: "first-wins" },
    });
    expect(preview.rows.map((row) => row.branch_no)).toEqual(["المستودع"]);
    expect(preview.rows[0].address).toBe("الرياض/السلي");
    expect(preview.ignored).toBe(1);
    expect(preview.rejected).toBe(0);
  });

  it("honours last-wins for facility duplicates", () => {
    const preview = parseSheet([HEADER, WAREHOUSE, SECOND_WAREHOUSE], {
      ...options,
      options: { facilityDuplicates: "last-wins" },
    });
    expect(preview.rows.map((row) => row.branch_no)).toEqual(["المستودع"]);
    expect(preview.rows[0].address).toBe("جدة/حراج الصواريخ");
  });

  it("honours reject for facility duplicates when asked", () => {
    const preview = parseSheet([HEADER, WAREHOUSE, SECOND_WAREHOUSE], {
      ...options,
      options: { facilityDuplicates: "reject" },
    });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rejected).toBe(1);
    expect(preview.issues.some((issue) => issue.level === "critical")).toBe(true);
  });

  it("rejects a row with data but no branch code", () => {
    const orphan = [...BLANK];
    orphan[2] = "الرياض";
    const preview = parseSheet([HEADER, orphan], options);
    expect(preview.rows).toHaveLength(0);
    expect(preview.issues[0]).toMatchObject({ field: "Branch Code", level: "critical" });
  });

  it("rejects a row with no city", () => {
    const noCity = [...P0001];
    noCity[2] = "";
    const preview = parseSheet([HEADER, noCity], options);
    expect(preview.rows).toHaveLength(0);
    expect(
      preview.issues.some((issue) => issue.field === "City" && issue.level === "critical"),
    ).toBe(true);
  });

  it("warns about a bad phone but still imports the branch", () => {
    const badPhone = [...P0001];
    badPhone[5] = "968 50 726 2291";
    const preview = parseSheet([HEADER, badPhone], options);
    expect(preview.rows).toHaveLength(1);
    expect(
      preview.issues.some(
        (issue) => issue.field === "Area Manager Contact Number" && issue.level === "warning",
      ),
    ).toBe(true);
  });

  it("warns about missing coordinates without rejecting the row", () => {
    const noCoords = [...P0001];
    noCoords[9] = "";
    noCoords[10] = "";
    const preview = parseSheet([HEADER, noCoords], options);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].latitude).toBeNull();
    expect(
      preview.issues.some(
        (issue) => issue.field === "Latitude / Longitude" && issue.level === "warning",
      ),
    ).toBe(true);
  });

  it("warns when latitude and longitude look swapped", () => {
    const swapped = [...P0001];
    swapped[9] = "46.6456098";
    swapped[10] = "24.5372826";
    const preview = parseSheet([HEADER, swapped], options);
    expect(preview.rows[0].latitude).toBeNull();
    expect(
      preview.issues.find((issue) => issue.field === "Latitude / Longitude")?.message,
    ).toContain("wrong way round");
  });

  it("does not nag about a missing area manager on a facility row", () => {
    const preview = parseSheet([HEADER, WAREHOUSE], options);
    expect(preview.issues.some((issue) => issue.field === "Area Manager")).toBe(false);
  });

  it("prefers an explicit Duty Hours column when the file supplies one", () => {
    const header = [...HEADER, "Duty Hours"];
    const row = [...P0001, "18"];
    const preview = parseSheet([header, row], options);
    expect(preview.rows[0].duty_hours).toBe(18);
    expect(preview.missingColumns).toEqual([]);
  });

  it("refuses a sheet with no recognizable header", () => {
    const preview = parseSheet(
      [
        ["a", "b", "c"],
        ["1", "2", "3"],
      ],
      options,
    );
    expect(preview.rows).toHaveLength(0);
    expect(preview.issues[0]).toMatchObject({ field: "Header", level: "critical" });
  });

  it("refuses a sheet missing a required column", () => {
    const header = HEADER.filter((column) => column !== "City");
    const row = P0001.filter((_, index) => index !== 2);
    const preview = parseSheet([header, row], options);
    expect(preview.rows).toHaveLength(0);
    expect(preview.issues[0].message).toContain("City");
  });

  it("finds the header when it is not the first row", () => {
    const preview = parseSheet([["Master branch list"], BLANK, HEADER, P0001], options);
    expect(preview.rows).toHaveLength(1);
    // Row 4 in Excel terms — the operator has to be able to find it.
    expect(preview.rows[0].row).toBe(4);
  });
});

describe("summarize", () => {
  it("counts rows needing attention once, not once per warning", () => {
    const gappy = [...P0001];
    gappy[1] = ""; // no phone
    gappy[7] = ""; // no address
    const preview = parseSheet([HEADER, gappy], options);
    const counts = summarize(preview);
    expect(counts.valid).toBe(1);
    expect(counts.warning).toBeGreaterThan(1);
    expect(counts.flaggedRows).toBe(1);
  });

  it("separates the three severities", () => {
    // One file carrying all three: a rejected pharmacy duplicate (critical), a
    // gappy row (warning), and an auto-numbered warehouse (info).
    const dupPharmacy = [...P0001];
    const gappy = [...P0001];
    gappy[0] = "P0009";
    gappy[1] = "";
    const preview = parseSheet(
      [HEADER, P0001, dupPharmacy, gappy, WAREHOUSE, SECOND_WAREHOUSE],
      options,
    );
    const counts = summarize(preview);

    expect(counts.critical).toBe(1);
    expect(counts.info).toBe(1);
    expect(counts.warning).toBeGreaterThan(0);
    // Only the critical one is dropped; warnings and notes still import.
    expect(counts.rejected).toBe(1);
    expect(preview.rows.map((row) => row.branch_no)).toEqual([
      "P0001",
      "P0009",
      "المستودع",
      "المستودع-2",
    ]);
  });
});

describe("chooseSheet", () => {
  const hasHeader = (name: string) => name !== "Branches Pivot Table";

  it("prefers the Branches tab over the workbook's other tabs", () => {
    expect(
      chooseSheet(["Branches Pivot Table", "Branches", "Alshrouq Covered Branches"], hasHeader),
    ).toBe("Branches");
  });

  it("falls back to the first tab that has a usable header", () => {
    expect(chooseSheet(["Branches Pivot Table", "Sheet1"], hasHeader)).toBe("Sheet1");
  });
});
