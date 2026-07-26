import {
  HEADER_LOOKUP,
  PREFERRED_SHEET_NAME,
  REQUIRED_COLUMNS,
  TEMPLATE_COLUMNS,
  normalizeHeader,
} from "./constants";
import {
  cleanCell,
  isNumberedBranch,
  parseCoordinate,
  parseDutyHours,
  parsePhone,
  parseScooter,
} from "./normalize";
import {
  DEFAULT_IMPORT_OPTIONS,
  LEVEL_RANK,
  type FacilityDuplicateStrategy,
  type ImportIssue,
  type ImportOptions,
  type ImportPreview,
  type ParsedBranch,
  type ValidationSummary,
} from "./types";

/**
 * Reading an uploaded workbook into rows the importer can write.
 *
 * Split deliberately in two: `parseSheet` is a pure function over a grid of
 * cells and carries all the judgement, while `parseWorkbookFile` is the thin
 * browser wrapper that lazy-loads `xlsx`. The rules below are the ones an
 * operator will argue with, so they are the ones under unit test — testing them
 * would otherwise mean constructing a File in Node.
 */

/** How far down to look for the header before giving up. */
const HEADER_SCAN_DEPTH = 12;

/** Minimum recognizable columns for a row to count as the header. */
const HEADER_MIN_MATCHES = 3;

type Grid = unknown[][];

function locateHeader(grid: Grid): { index: number; headers: string[] } | null {
  const depth = Math.min(HEADER_SCAN_DEPTH, grid.length);
  for (let index = 0; index < depth; index++) {
    const row = grid[index] ?? [];
    const resolved = row.map((cell) => HEADER_LOOKUP.get(normalizeHeader(cell)) ?? null);
    const matches = resolved.filter(Boolean).length;
    if (matches >= HEADER_MIN_MATCHES && resolved.includes("Branch Code")) {
      return {
        index,
        headers: row.map((cell) =>
          String(cell ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        ),
      };
    }
  }
  return null;
}

/**
 * Column header → column index.
 *
 * First occurrence wins. The master sheet's companion tab has both "City" and
 * "City 2"; "City 2" does not resolve to anything, but were a future sheet to
 * repeat a real header, taking the leftmost is the same thing a human reading
 * the file would do.
 */
function mapColumns(headerRow: unknown[]): Map<string, number> {
  const columns = new Map<string, number>();
  headerRow.forEach((cell, index) => {
    const canonical = HEADER_LOOKUP.get(normalizeHeader(cell));
    if (canonical && !columns.has(canonical)) columns.set(canonical, index);
  });
  return columns;
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((cell) => cleanCell(cell) === null);
}

export interface ParseSheetOptions {
  fileName: string;
  sheetName: string;
  /** Duplicate reconciliation. Defaults to numbering repeated facility codes. */
  options?: ImportOptions;
}

/**
 * Reconcile a branch code against the ones already seen in this file.
 *
 * Returns the code to store, or null to drop the row. The asymmetry between
 * pharmacies and facilities is the whole point — see `FacilityDuplicateStrategy`
 * for why a repeated "المستودع" is data and a repeated "P0021" is a mistake.
 */
function reconcileDuplicate(
  branchNo: string,
  excelRow: number,
  seen: Map<string, number>,
  strategy: FacilityDuplicateStrategy,
  issues: ImportIssue[],
): { code: string | null; replaces: string | null } {
  const previous = seen.get(branchNo);
  if (previous == null) return { code: branchNo, replaces: null };

  // A numbered pharmacy code identifies one shop that orders point at. Two rows
  // claiming it is a contradiction only a human can resolve.
  if (isNumberedBranch(branchNo) || strategy === "reject") {
    issues.push({
      row: excelRow,
      branchNo,
      field: "Branch Code",
      level: "critical",
      message: isNumberedBranch(branchNo)
        ? `Duplicate pharmacy code — already used on row ${previous}. Pharmacy codes identify a single branch and must be unique.`
        : `Duplicate branch code — already used on row ${previous}.`,
    });
    return { code: null, replaces: null };
  }

  if (strategy === "first-wins") {
    issues.push({
      row: excelRow,
      branchNo,
      field: "Branch Code",
      level: "info",
      message: `Skipped — row ${previous} already supplied "${branchNo}".`,
    });
    return { code: null, replaces: null };
  }

  if (strategy === "last-wins") {
    issues.push({
      row: excelRow,
      branchNo,
      field: "Branch Code",
      level: "info",
      message: `Replaces the "${branchNo}" from row ${previous}.`,
    });
    return { code: branchNo, replaces: branchNo };
  }

  // "suffix": give the repeat its own code so both facilities survive.
  let suffix = 2;
  while (seen.has(`${branchNo}-${suffix}`)) suffix++;
  const code = `${branchNo}-${suffix}`;
  issues.push({
    row: excelRow,
    branchNo: code,
    field: "Branch Code",
    level: "info",
    message: `"${branchNo}" is already used by row ${previous}, so this facility was imported as "${code}".`,
  });
  return { code, replaces: null };
}

/**
 * Validate and convert a sheet.
 *
 * The rule that decides severity: **critical** is something that makes the row
 * unstorable or unidentifiable, **warning** is a gap in a row that is otherwise
 * fine, **info** is a decision the importer made on the operator's behalf. A
 * branch with no coordinates cannot be put on the map but is still worth having
 * in the search box, so that is a warning; a branch with no code cannot be
 * written at all, so that is critical. Only critical rows are dropped.
 */
export function parseSheet(grid: Grid, options: ParseSheetOptions): ImportPreview {
  const importOptions = options.options ?? DEFAULT_IMPORT_OPTIONS;
  const issues: ImportIssue[] = [];
  const rows: ParsedBranch[] = [];

  const header = locateHeader(grid);
  if (!header) {
    return {
      fileName: options.fileName,
      sheetName: options.sheetName,
      rows: [],
      issues: [
        {
          row: 1,
          branchNo: "",
          field: "Header",
          level: "critical",
          message:
            "No header row found. The sheet must have a row containing at least a Branch Code column — download the template to see the expected layout.",
        },
      ],
      rejected: 0,
      ignored: 0,
      headers: [],
      missingColumns: TEMPLATE_COLUMNS.map((c) => c.header),
    };
  }

  const columns = mapColumns(grid[header.index] ?? []);
  const missingColumns = TEMPLATE_COLUMNS.map((c) => c.header).filter((h) => !columns.has(h));

  for (const required of REQUIRED_COLUMNS) {
    if (!columns.has(required)) {
      issues.push({
        row: header.index + 1,
        branchNo: "",
        field: required,
        level: "critical",
        message: `Required column "${required}" is missing from the sheet.`,
      });
    }
  }
  if (issues.length > 0) {
    return {
      fileName: options.fileName,
      sheetName: options.sheetName,
      rows: [],
      issues,
      rejected: 0,
      ignored: 0,
      headers: header.headers,
      missingColumns,
    };
  }

  const cellAt = (row: unknown[], column: string): unknown => {
    const index = columns.get(column);
    return index == null ? null : row[index];
  };

  // Branch codes already seen, and the Excel row that claimed each. The master
  // sheet has two rows both coded "المستودع" (warehouse), so this is a case the
  // real data hits, not a defensive check.
  const seen = new Map<string, number>();
  let rejected = 0;
  /** Rows the file carried that a duplicate policy deliberately skipped. */
  let ignored = 0;

  for (let index = header.index + 1; index < grid.length; index++) {
    const row = grid[index] ?? [];
    // Excel's own row number: the operator has to find this row to fix it.
    const excelRow = index + 1;

    // The master sheet is 1010 rows of which 865 are empty padding below the
    // data. Skipping silently is the point — reporting 865 "missing branch
    // code" errors would bury the twelve that matter.
    if (isBlankRow(row)) continue;

    const rawBranchNo = cleanCell(cellAt(row, "Branch Code"));
    if (!rawBranchNo) {
      rejected++;
      issues.push({
        row: excelRow,
        branchNo: "",
        field: "Branch Code",
        level: "critical",
        message: "Row has data but no branch code, so there is nothing to key it by.",
      });
      continue;
    }

    const duplicate = reconcileDuplicate(
      rawBranchNo,
      excelRow,
      seen,
      importOptions.facilityDuplicates,
      issues,
    );
    if (!duplicate.code) {
      // Only a critical outcome counts as a rejection; "first-wins" skipping is
      // informational and belongs in rows_ignored, not rows_failed.
      if (issues[issues.length - 1]?.level === "critical") rejected++;
      else ignored++;
      continue;
    }
    const branchNo = duplicate.code;
    // last-wins: drop the earlier row so the upsert carries one entry per code.
    if (duplicate.replaces) {
      const existingIndex = rows.findIndex((entry) => entry.branch_no === duplicate.replaces);
      if (existingIndex >= 0) rows.splice(existingIndex, 1);
    }
    seen.set(branchNo, excelRow);

    const city = cleanCell(cellAt(row, "City"));
    if (!city) {
      rejected++;
      issues.push({
        row: excelRow,
        branchNo,
        field: "City",
        level: "critical",
        message: "City is required — it drives the city filter and the map.",
      });
      continue;
    }

    const phone = parsePhone(cellAt(row, "Phone No"));
    if (phone.suspicious) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Phone No",
        level: "warning",
        message: `"${phone.display}" is not a valid Saudi number. It will be stored as typed but cannot be dialled from the card.`,
      });
    } else if (!phone.e164) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Phone No",
        level: "warning",
        message: "No branch phone number.",
      });
    }

    const managerPhone = parsePhone(cellAt(row, "Area Manager Contact Number"));
    if (managerPhone.suspicious) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Area Manager Contact Number",
        level: "warning",
        message: `"${managerPhone.display}" is not a valid Saudi number — check the country code.`,
      });
    }

    const coords = parseCoordinate(cellAt(row, "Latitude"), cellAt(row, "Longitude"));
    if (coords.outOfRange) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Latitude / Longitude",
        level: "warning",
        message:
          "Coordinates fall outside Saudi Arabia — latitude and longitude may be the wrong way round. The branch will not appear on the map.",
      });
    } else if (coords.latitude == null) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Latitude / Longitude",
        level: "warning",
        message: "No coordinates, so this branch will be searchable but not on the map.",
      });
    }

    const workingHours = cleanCell(cellAt(row, "Start - End"));
    // An explicit Duty Hours column wins when it holds a number; otherwise the
    // duration is derived. The live sheet has no such column at all, which is
    // exactly why deriving has to be the fallback rather than the exception.
    const declaredDuty = cleanCell(cellAt(row, "Duty Hours"));
    const declaredDutyNumber =
      declaredDuty != null ? Number(declaredDuty.replace(/[^\d.]/g, "")) : NaN;
    const dutyHours =
      Number.isFinite(declaredDutyNumber) && declaredDutyNumber > 0 && declaredDutyNumber <= 24
        ? Math.round(declaredDutyNumber * 10) / 10
        : parseDutyHours(workingHours);

    if (workingHours && dutyHours == null) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Start - End",
        level: "warning",
        message: `Could not read "${workingHours}" as opening hours, so this branch will not match the duty-hour filters.`,
      });
    }

    const email = cleanCell(cellAt(row, "Email"));
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Email",
        level: "warning",
        message: `"${email}" does not look like an email address.`,
      });
    }

    const address = cleanCell(cellAt(row, "Address"));
    if (!address) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Address",
        level: "warning",
        message: "No address — agents will have only the map link to go on.",
      });
    }

    const areaManager = cleanCell(cellAt(row, "Area Manager"));
    // Only raised for real pharmacies: the facility rows (warehouses, head
    // office) legitimately have no area manager, and flagging them every import
    // would train operators to ignore the warnings list.
    if (!areaManager && isNumberedBranch(branchNo)) {
      issues.push({
        row: excelRow,
        branchNo,
        field: "Area Manager",
        level: "warning",
        message: "No area manager assigned.",
      });
    }

    const scooter = parseScooter(cellAt(row, "Scooter"));
    const mapsUrl = cleanCell(cellAt(row, "Location"));

    rows.push({
      row: excelRow,
      branch_no: branchNo,
      city,
      phone: phone.e164 ?? (phone.digits ? phone.digits : null),
      area_manager: areaManager,
      area_manager_phone: managerPhone.e164 ?? (managerPhone.digits ? managerPhone.digits : null),
      email,
      address,
      maps_url: mapsUrl && /^https?:\/\//i.test(mapsUrl) ? mapsUrl : null,
      latitude: coords.latitude,
      longitude: coords.longitude,
      scooter: scooter.available,
      scooter_note: scooter.note,
      working_hours: workingHours,
      friday_hours: cleanCell(cellAt(row, "Friday Duty")),
      duty_hours: dutyHours,
    });
  }

  if (rows.length === 0 && issues.length === 0) {
    issues.push({
      row: header.index + 1,
      branchNo: "",
      field: "Sheet",
      level: "critical",
      message: "The sheet has a valid header but no data rows below it.",
    });
  }

  return {
    fileName: options.fileName,
    sheetName: options.sheetName,
    rows,
    // Most severe first, then by row, so the list an operator reads opens with
    // what actually blocks the import rather than with an auto-numbered warehouse.
    issues: issues.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.row - b.row),
    rejected,
    ignored,
    headers: header.headers,
    missingColumns,
  };
}

/**
 * Which sheet to read from a multi-tab workbook.
 *
 * Prefers a tab named "Branches", because the master workbook also carries a
 * pivot table and an "Alshrouq Covered Branches" tab whose columns overlap
 * enough to be picked up by accident. Failing that, the first tab whose header
 * the parser recognizes wins, so a single-sheet file named anything still works.
 */
export function chooseSheet(
  sheetNames: string[],
  hasHeader: (name: string) => boolean,
): string | null {
  const preferred = sheetNames.find(
    (name) => normalizeHeader(name) === normalizeHeader(PREFERRED_SHEET_NAME),
  );
  if (preferred && hasHeader(preferred)) return preferred;
  return sheetNames.find((name) => hasHeader(name)) ?? sheetNames[0] ?? null;
}

/** Read an uploaded .xlsx/.csv into a validated preview. */
export async function parseWorkbookFile(
  file: File,
  importOptions: ImportOptions = DEFAULT_IMPORT_OPTIONS,
): Promise<ImportPreview> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });

  // `raw: false` makes xlsx hand back the *formatted* text of every cell, which
  // is what the sheet's author saw. It matters for coordinates: raw mode
  // returns the full float, formatted mode returns the trimmed display value,
  // and for hours, where raw mode can turn "07 AM - 03 AM" into a date serial.
  const gridOf = (name: string): Grid =>
    XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    }) as Grid;

  const sheetName = chooseSheet(workbook.SheetNames, (name) => {
    const grid = gridOf(name);
    return grid.some((row, index) =>
      index < HEADER_SCAN_DEPTH
        ? (row ?? []).some((cell) => HEADER_LOOKUP.get(normalizeHeader(cell)) === "Branch Code")
        : false,
    );
  });

  if (!sheetName) {
    return {
      fileName: file.name,
      sheetName: "",
      rows: [],
      issues: [
        {
          row: 1,
          branchNo: "",
          field: "File",
          level: "critical",
          message: "That workbook has no sheets.",
        },
      ],
      ignored: 0,
      rejected: 0,
      headers: [],
      missingColumns: TEMPLATE_COLUMNS.map((c) => c.header),
    };
  }

  return parseSheet(gridOf(sheetName), {
    fileName: file.name,
    sheetName,
    options: importOptions,
  });
}

/**
 * Counts for the preview header and for the stored audit record.
 *
 * `flaggedRows` counts distinct rows carrying a warning, not warnings: one row
 * missing both an email and an address is one row needing attention, not two,
 * and reporting the larger number makes a tidy file look alarming.
 */
export function summarize(preview: ImportPreview): ValidationSummary & { valid: number } {
  const by = (level: ImportIssue["level"]) =>
    preview.issues.filter((issue) => issue.level === level);
  return {
    valid: preview.rows.length,
    critical: by("critical").length,
    warning: by("warning").length,
    info: by("info").length,
    flaggedRows: new Set(by("warning").map((issue) => issue.branchNo)).size,
    rejected: preview.rejected,
  };
}

/** Only a critical issue stops an import. */
export function canImport(preview: ImportPreview): boolean {
  return preview.rows.length > 0;
}
