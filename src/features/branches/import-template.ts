import { TEMPLATE_COLUMNS, TEMPLATE_FILE_NAME } from "./constants";

/**
 * The downloadable import template.
 *
 * Generated from `TEMPLATE_COLUMNS` at click time rather than checked in as a
 * static file, which is what makes "the system should always generate and
 * provide the latest template automatically" true by construction: a column
 * added to the contract appears in the next download without anyone
 * remembering to re-upload a fixture.
 *
 * Two sheets ship: the data sheet the operator fills in, and a Guide sheet
 * explaining each column. The guide is on its own tab so the parser — which
 * reads the first sheet with a recognizable header — never sees it.
 */

/** Sample rows, kept realistic so the expected formats are unambiguous. */
const SAMPLE_ROWS: Record<string, string>[] = [
  {
    "Branch Code": "P0001",
    "Phone No": "599089497",
    City: "الرياض",
    Scooter: "سكوتر",
    "Area Manager": "DR / Mohamed Abd Elmohsen",
    "Area Manager Contact Number": "+966 50 073 3054",
    Email: "ph01@ghodafpharmacy.com",
    Address: "الرياض/ حي الحزم /ش علي النقيب",
    Location: "https://maps.app.goo.gl/oy8ZPVd5tX9nEh4W7",
    Latitude: "24.53728256",
    Longitude: "46.64560984",
    "Duty Hours": "",
    "Start - End": "06 AM - 06 AM",
    "Friday Duty": "12.30 PM - 12.30 AM",
  },
  {
    "Branch Code": "P0002",
    "Phone No": "0592624549",
    City: "جدة",
    Scooter: "N/A",
    "Area Manager": "DR / Ahmed Elshikh",
    "Area Manager Contact Number": "+966 58 107 6630",
    Email: "ph02@ghodafpharmacy.com",
    Address: "جدة/حي اليرموك/ش ابوجعفر المنصور",
    Location: "",
    Latitude: "21.4858",
    Longitude: "39.1925",
    "Duty Hours": "",
    "Start - End": "07 AM - 03 AM",
    "Friday Duty": "01 PM - 01 AM",
  },
];

export async function downloadImportTemplate(): Promise<void> {
  const XLSX = await import("xlsx");
  const headers = TEMPLATE_COLUMNS.map((column) => column.header);

  const sheet = XLSX.utils.json_to_sheet(SAMPLE_ROWS, { header: headers });
  sheet["!cols"] = TEMPLATE_COLUMNS.map((column) => ({ wch: column.width }));
  // Freeze the header so it stays visible while an operator scrolls a
  // thousand-row paste.
  sheet["!freeze"] = { xSplit: "0", ySplit: "1", topLeftCell: "A2", activePane: "bottomLeft" };

  const guide = XLSX.utils.json_to_sheet(
    TEMPLATE_COLUMNS.map((column) => ({
      Column: column.header,
      Required: column.required ? "Yes" : "No",
      "What to put in it": column.note,
      "Also accepted as": (column.aliases ?? []).join(", "),
    })),
  );
  guide["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 74 }, { wch: 42 }];

  const workbook = XLSX.utils.book_new();
  // Data sheet first: `chooseSheet` looks for a tab called "Branches", and this
  // is the name it will find.
  XLSX.utils.book_append_sheet(workbook, sheet, "Branches");
  XLSX.utils.book_append_sheet(workbook, guide, "Guide");
  XLSX.writeFile(workbook, TEMPLATE_FILE_NAME);
}
