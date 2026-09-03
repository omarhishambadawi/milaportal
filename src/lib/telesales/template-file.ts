import {
  TEMPLATE_DATE_FORMAT,
  templateExampleRow,
  templateHeaders,
  type ImportTemplate,
} from "./templates";

/**
 * Turning a template specification into a workbook the operator can fill in.
 *
 * Kept apart from `templates.ts` for the same reason `parse.ts` keeps its
 * `xlsx` loader at the bottom: the library is ~900 kB and nothing that merely
 * *describes* a template should drag it into the bundle. The spec is pure and
 * testable; this is the one function that needs the dependency, and it imports
 * it dynamically at the moment somebody clicks Download.
 *
 * Two sheets, deliberately:
 *
 *   **Data** — the header row the importer will read, plus one example row.
 *   **Instructions** — what each column means, whether it is required, the
 *   expected format, and the rule that decides which rows become leads.
 *
 * The example row is on the data sheet rather than the instructions sheet
 * because that is where it is useful — an operator fills downward from it — and
 * it is the first thing they will delete. The importer would treat it as a row
 * if left in, which is why the instructions say to remove it and why the
 * example uses obviously-fake identifiers.
 */

/** The sheet the importer reads. Named so `pickSheet` cannot pick the wrong one. */
export const TEMPLATE_DATA_SHEET = "Data";
const TEMPLATE_INFO_SHEET = "Instructions";

/**
 * Build the template workbook as a byte array.
 *
 * Returns bytes rather than triggering a download, so the caller owns the
 * browser interaction and this stays testable without a DOM.
 */
export async function buildTemplateWorkbook(template: ImportTemplate): Promise<Uint8Array> {
  const XLSX = await import("xlsx");

  const headers = templateHeaders(template);
  const example = templateExampleRow(template);

  const data = XLSX.utils.aoa_to_sheet([headers, example]);

  /*
   * Column widths from the header and example lengths.
   *
   * Cosmetic, but a template whose columns all read `#####` is a template
   * somebody has to fix before they can use it, and the widths cost one line.
   */
  (data as any)["!cols"] = headers.map((h, i) => ({
    wch: Math.min(44, Math.max(14, h.length + 2, (example[i] ?? "").length + 2)),
  }));

  const info: string[][] = [
    [`MilaPortal Telesales — ${template.title} import template`],
    [],
    ["What this file is for"],
    [template.purpose],
    [],
    ["Which rows become leads"],
    [template.eligibility],
    [],
    ["How to use it"],
    [`1. Fill your rows into the "${TEMPLATE_DATA_SHEET}" sheet, under the existing headers.`],
    ["2. Delete the example row — it is only there to show the expected format."],
    ["3. Do not rename, reorder or remove the header row."],
    ["4. Upload the file on the Telesales Import page and choose this source type."],
    [
      "5. Importing stores the rows. It does not create leads — you generate those separately, once you have reviewed the import.",
    ],
    [],
    ["Formats"],
    [`Dates: ${TEMPLATE_DATE_FORMAT} (an Excel date cell also works).`],
    ["Phone: 05XXXXXXXX. Numbers are normalised on import, so +966 and 5XXXXXXXX are accepted."],
    ["Numbers: plain digits, no thousands separators and no currency symbol."],
    [],
    ["Columns"],
    ["Column", "Required", "Type", "Example", "What it is"],
    ...template.columns.map((c) => [
      c.header,
      c.required ? "Required" : "Optional",
      c.type,
      c.example,
      c.description,
    ]),
  ];

  const instructions = XLSX.utils.aoa_to_sheet(info);
  (instructions as any)["!cols"] = [{ wch: 24 }, { wch: 11 }, { wch: 9 }, { wch: 30 }, { wch: 90 }];

  const wb = XLSX.utils.book_new();
  /*
   * Data first. `pickSheet` chooses the largest sheet by cell count when a
   * workbook has several, and a template's instructions sheet is longer than
   * its single example row — so the data sheet is named explicitly and placed
   * first, and the import page passes that name through.
   */
  XLSX.utils.book_append_sheet(wb, data, TEMPLATE_DATA_SHEET);
  XLSX.utils.book_append_sheet(wb, instructions, TEMPLATE_INFO_SHEET);

  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as Uint8Array;
}

/**
 * Build the template and hand it to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: Safari
 * has historically cancelled the download when the URL disappears in the same
 * frame as the click.
 */
export async function downloadTemplate(template: ImportTemplate): Promise<void> {
  const bytes = await buildTemplateWorkbook(template);
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = template.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
