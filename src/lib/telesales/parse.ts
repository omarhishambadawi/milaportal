import { PHONE_REJECTION_LABELS, extractSaudiPhones, normalizeSaudiPhone } from "@/lib/phone";
import { contentHash } from "./dedup";
import { inferDayFirst, parseSheetDate, type DateOrder } from "./dates";
import type { ImportIssue, ParsedWorkbook, SourceRecordInput, SourceType } from "./types";
import { workbookDigest } from "./dedup";

/**
 * Reading a telesales workbook.
 *
 * Split the same way the Branch Directory importer is: `parseSheet` is a pure
 * function over a grid of cells and holds every judgement, and the thin
 * `xlsx`-loading wrapper lives beside it. The judgements are the part an
 * operator will argue with, so they are the part under unit test.
 *
 * ===========================================================================
 * What the parser is up against
 * ===========================================================================
 * Three workbooks, and between them five different column layouts:
 *
 *   1. Cash "Main Database"  Id, Name, Mobileno, Wh_Cd, Customer, InvNo,
 *                            InvDate, Itm_Cd, Itm_Name, Qty
 *   2. Cash working sheet    the same plus sub Categ, PriceIncludeTAX, Agent
 *                            Name, Action, Date to be called, Days to refill
 *   3. Retention             Name, Mobileno, Wh_Cd, InvNo, InvDate, Itm_Cd,
 *                            Itm_Name, Agent Name, Action, Date to be called
 *   4. Wasfaty current       Pharmacy, City, Patient ID, Prescription No,
 *                            Patient Name, Phone, Total Value (SAR), Dispense
 *                            Time, Agent, Action, Next Dispense Date
 *   5. Wasfaty per-city      BRANCH, ID, PRESCRIPTION NO., TOTAL VALUE (SAR),
 *                            FILL DATE, Agent, Action, Date to be called
 *
 * — plus a sixth, "Riyadh", which is layout 4 with the columns in a different
 * order and a `Facility` column added. Column *position* is therefore never
 * used; everything resolves by header name.
 *
 * Dates arrive as `03-07-26`, `7/13/26 0:00`, `2026-09-05`, `15/05/2026`,
 * `05/17/2026`, the Excel serial `46228`, and the strings `" "`, `"N/A"`,
 * `"no record"` and `"زSAR 150.0"`. Phones arrive as `0535323292`,
 * `563499119`, `9.66555E+11` and `0`.
 *
 * Nothing here guesses. A cell that cannot be read becomes an issue against a
 * numbered row, and the row is either rejected or stored with a null — never
 * silently defaulted.
 */

/* ------------------------------------------------------------------------- */
/* Header resolution                                                         */
/* ------------------------------------------------------------------------- */

/** The fields a sheet can supply, whatever it calls them. */
export type Field =
  | "customerRef"
  | "customerName"
  | "phone"
  | "branchNo"
  | "city"
  | "facility"
  | "channel"
  | "documentNo"
  | "sourceDate"
  | "fillDate"
  | "nextDispenseDate"
  | "callbackDate"
  | "dispenseTime"
  | "itemCode"
  | "itemName"
  | "category"
  | "quantity"
  | "unitPrice"
  | "totalValue"
  | "patientId"
  | "prescriptionNo"
  | "agentLabel"
  | "actionLabel"
  | "notes";

/**
 * Header text reduced to a comparison key.
 *
 * Lower-cased, punctuation dropped, whitespace collapsed. That is what makes
 * `PRESCRIPTION NO.`, `Prescription No` and `prescription no` one header, and
 * `TOTAL VALUE (SAR)` match `Total Value (SAR)`. The parenthesised unit is kept
 * as a word rather than stripped, because `Total Value` and `Total Value (SAR)`
 * are the same column and dropping the unit costs nothing.
 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/[.()'"]/g, " ")
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Every header spelling observed, mapped to a field.
 *
 * Deliberately a literal list rather than fuzzy matching. A header this table
 * does not know is a column the parser ignores, which is a visible, debuggable
 * outcome; a fuzzy match that lands `Days to refill` on `Date to be called`
 * would be neither.
 */
const HEADER_ALIASES: Record<string, Field> = {
  // identity
  id: "customerRef",
  "customer id": "customerRef",
  name: "customerName",
  "patient name": "customerName",
  "customer name": "customerName",
  mobileno: "phone",
  mobile: "phone",
  "mobile no": "phone",
  phone: "phone",
  "phone number": "phone",

  // place
  "wh cd": "branchNo",
  whcd: "branchNo",
  branch: "branchNo",
  "branch code": "branchNo",
  pharmacy: "branchNo",
  city: "city",
  facility: "facility",

  // Cash `Customer` is the payment/fulfilment channel — CASH IN BOX, TAMARA,
  // JEDDAH DRIVERS, HOME DELIVERY, CALL CENTER SALES, ONLINE CUSTOMER — and not
  // a customer name. Mapping it by its header would be a subtle, expensive
  // mistake, so it gets its own field.
  customer: "channel",
  channel: "channel",

  // documents
  invno: "documentNo",
  "inv no": "documentNo",
  "invoice no": "documentNo",
  "prescription no": "prescriptionNo",
  "patient id": "patientId",

  // dates
  invdate: "sourceDate",
  "inv date": "sourceDate",
  "invoice date": "sourceDate",
  "fill date": "fillDate",
  "raw fill date": "fillDate",
  "next dispense date": "nextDispenseDate",
  "dispense date": "nextDispenseDate",
  "date to be called": "callbackDate",
  "dispense time": "dispenseTime",

  // product
  "itm cd": "itemCode",
  itmcd: "itemCode",
  "item code": "itemCode",
  "itm name": "itemName",
  itmname: "itemName",
  "item name": "itemName",
  "sub categ": "category",
  "sub category": "category",
  qty: "quantity",
  quantity: "quantity",
  priceincludetax: "unitPrice",
  "price include tax": "unitPrice",
  "total value sar": "totalValue",
  "total value": "totalValue",

  // the desk's own columns
  agent: "agentLabel",
  "agent name": "agentLabel",
  action: "actionLabel",
  notes: "notes",
  note: "notes",
  // `Days to refill` is deliberately absent. It is `=TODAY()-<callback>` in all
  // three workbooks, so it carries no information the callback date does not,
  // and importing its rendered text ("46266 Days Overdue") would import a bug.
};

/** How far down to look for a header row before giving up. */
const HEADER_SCAN_DEPTH = 10;
/** Minimum recognised columns for a row to count as the header. */
const HEADER_MIN_MATCHES = 4;

type Grid = unknown[][];

interface HeaderResult {
  index: number;
  headers: string[];
  columns: Map<Field, number>;
}

/** A row's cells as header text: collapsed whitespace, trimmed. */
function headerCells(row: unknown[]): string[] {
  return row.map((c) =>
    String(c ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function locateHeader(grid: Grid): HeaderResult | null {
  const depth = Math.min(HEADER_SCAN_DEPTH, grid.length);
  for (let index = 0; index < depth; index++) {
    const row = grid[index] ?? [];
    const columns = new Map<Field, number>();
    for (let col = 0; col < row.length; col++) {
      const field = HEADER_ALIASES[normalizeHeader(row[col])];
      // First occurrence wins. `Wasfaty Aug` has a blank first column and a
      // `Pharmacy` column in its September sibling; taking the leftmost match is
      // what a person reading the sheet would do.
      if (field && !columns.has(field)) columns.set(field, col);
    }
    if (columns.size >= HEADER_MIN_MATCHES) {
      return { index, headers: headerCells(row), columns };
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Source type detection                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Which pipeline is this sheet for?
 *
 * By columns, not by file name. An operator renames files; a Wasfaty extract
 * always has a prescription number and a Cash extract always has an invoice
 * number, and no sheet in any of the three workbooks has both.
 *
 * Retention is the ambiguous one — it is a Cash-shaped sheet — so it is
 * distinguished by the presence of a `Date to be called` column *without* the
 * `Id`/`Qty` columns that mark a raw Cash extract. When that inference is wrong,
 * the operator's explicit choice on the import screen overrides it; this is a
 * default, not a verdict.
 */
export function detectSourceType(columns: Map<Field, number>): SourceType | null {
  if (columns.has("prescriptionNo") || columns.has("patientId")) return "wasfaty";
  if (!columns.has("documentNo") && !columns.has("itemCode")) return null;
  const looksLikeWorked = columns.has("callbackDate") || columns.has("actionLabel");
  const looksLikeRawExtract = columns.has("customerRef") && columns.has("quantity");
  if (looksLikeWorked && !looksLikeRawExtract) return "retention";
  return "cash";
}

/* ------------------------------------------------------------------------- */
/* Cell readers                                                              */
/* ------------------------------------------------------------------------- */

function cell(row: unknown[], columns: Map<Field, number>, field: Field): unknown {
  const idx = columns.get(field);
  return idx == null ? undefined : row[idx];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s.length > 0 ? s : null;
}

/**
 * A number out of a cell that may be text, may carry a currency word, and may be
 * a literal dash.
 *
 * `"-"` appears in the `Al Qassim` sheet's Total Value column and means "no
 * value recorded", not zero. Returning zero there would put a 0.00 SAR
 * conversion into the reports.
 */
function num(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value)
    .replace(/[^\d.-]/g, "")
    .trim();
  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The Shams branch code, normalised to `P0001`.
 *
 * Cash extracts write `P0001`. Wasfaty sheets write a bare pharmacy number
 * (`123`, `401`, `1`) in a different identifier space, which is left exactly as
 * it came — inventing a `P` prefix for it would produce codes that look like
 * `branches.branch_no` values and are not.
 */
function branchCode(value: unknown, sourceType: SourceType): string | null {
  const s = text(value);
  if (!s) return null;
  if (sourceType === "wasfaty") return s;
  const m = /^p?\s*(\d{1,5})$/i.exec(s);
  return m ? `P${m[1].padStart(4, "0")}` : s.toUpperCase();
}

/**
 * What a Wasfaty Prescription No looks like.
 *
 * A lowercase English letter, then letters and digits: `a123456`. Not
 * `A123456`, not `123456`.
 *
 * The rule is the desk's, and the two failures it catches are different. A row
 * with no leading letter is a truncated or mistyped identifier — it will not be
 * found in the portal, and an agent will spend the call looking for it. A row
 * with an uppercase leading letter is a spreadsheet that has been through
 * somebody's "clean up the data" pass, which matters because the identifier is
 * case-sensitive where it is used.
 *
 * Neither is corrected here, and the uppercase one especially is not
 * lower-cased: `A123456` might be a different prescription from `a123456`, and
 * quietly rewriting an identifier to satisfy a format rule is how a call gets
 * made about the wrong prescription. The row is stored exactly as it arrived
 * and reported by row number so the file can be fixed at source.
 */
export const PRESCRIPTION_NO_PATTERN = /^[a-z][A-Za-z0-9]*$/;

export function isValidPrescriptionNo(value: string | null | undefined): boolean {
  return typeof value === "string" && PRESCRIPTION_NO_PATTERN.test(value);
}

/**
 * A row that is present but says nothing.
 *
 * The workbooks are full of these — trailing blank rows Excel keeps because a
 * formula once referenced them, and the `Retention` sheet's 2,092-row `!ref`
 * against 745 real rows. They are not errors and are not reported as such.
 */
function isBlankRow(row: unknown[]): boolean {
  return !row.some((c) => c != null && String(c).trim() !== "");
}

/* ------------------------------------------------------------------------- */
/* Issue accumulation                                                        */
/* ------------------------------------------------------------------------- */

/** How many offending row numbers are kept per issue. Enough to investigate,
 *  bounded so a wholly broken file does not produce a 170,000-element array. */
const MAX_ISSUE_ROWS = 50;

class Issues {
  private map = new Map<ImportIssue["code"], ImportIssue>();

  add(code: ImportIssue["code"], message: string, row: number): void {
    const existing = this.map.get(code);
    if (existing) {
      if (existing.rows.length < MAX_ISSUE_ROWS) existing.rows.push(row);
      return;
    }
    this.map.set(code, { code, message, rows: [row] });
  }

  /** Total occurrences, not the truncated sample. Held separately so the
   *  summary can say "1,204 rows" while listing 50. */
  private counts = new Map<ImportIssue["code"], number>();

  count(code: ImportIssue["code"]): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
  }

  total(code: ImportIssue["code"]): number {
    return this.counts.get(code) ?? 0;
  }

  list(): ImportIssue[] {
    return [...this.map.values()].map((i) => ({
      ...i,
      message:
        this.total(i.code) > i.rows.length
          ? `${i.message} (${this.total(i.code)} rows, first ${i.rows.length} listed)`
          : i.message,
    }));
  }
}

/* ------------------------------------------------------------------------- */
/* The parser                                                                */
/* ------------------------------------------------------------------------- */

/**
 * A hand-made column mapping, laid over the detected one.
 *
 * `field -> column index`, or `field -> null` to unmap a column the header
 * names would otherwise have claimed. Only the fields present are touched;
 * everything else keeps whatever `locateHeader` found, which is what makes this
 * an override rather than a replacement.
 */
export type ColumnOverrides = Partial<Record<Field, number | null>>;

export interface ParseOptions {
  /** Override the detected type. The import screen's dropdown. */
  sourceType?: SourceType;
  /** Override the inferred date order. Escape hatch for a sheet whose column
   *  gives no evidence and whose neighbours disagree. */
  dateOrder?: DateOrder;
  sheetName?: string;
  /**
   * The operator's own column mapping.
   *
   * Auto-detection runs first and stays the default; this is applied on top,
   * for the file whose headers are spelled a way `HEADER_ALIASES` has never
   * seen. Supplying it also lets a sheet with no recognisable header row be
   * parsed at all — see the fallback below.
   */
  columnOverrides?: ColumnOverrides;
}

/**
 * Parse one sheet.
 *
 * Pure: a grid in, records and issues out. It reads the *whole* date column
 * before parsing any single cell, because `06/04/26` is unreadable alone and
 * unambiguous beside two hundred neighbours (see `inferDayFirst`).
 */
export function parseSheet(grid: Grid, options: ParseOptions = {}): ParsedWorkbook {
  const detected = locateHeader(grid);

  /*
   * A sheet whose headers nothing recognises is still mappable by hand.
   *
   * `locateHeader` needs four recognised columns before it will call a row the
   * header, which is right for detection and wrong as a precondition for the
   * manual escape hatch: an arbitrary export spells every column differently
   * and would therefore be unmappable precisely when mapping is what it needs.
   * So when the operator has supplied a mapping, the first row is taken as the
   * header row and their choices are read against it.
   */
  const hasOverrides = Object.keys(options.columnOverrides ?? {}).length > 0;
  const located =
    detected ??
    (hasOverrides
      ? { index: 0, headers: headerCells(grid[0] ?? []), columns: new Map<Field, number>() }
      : null);

  if (!located) {
    return {
      sourceType: options.sourceType ?? "cash",
      sheetName: options.sheetName ?? "",
      /*
       * The first row's cells, so the import screen can offer them to map from.
       * Detection failed; the operator has not been given the chance to try
       * yet, and an empty list would leave them nothing to work with.
       */
      headers: headerCells(grid[0] ?? []),
      mappedFields: [],
      mappedColumns: {},
      records: [],
      issues: [
        {
          code: "missing_identity",
          message:
            "No recognisable header row in the first 10 rows. Expected columns such as InvDate/Itm_Cd (Cash) or Patient ID/Prescription No (Wasfaty).",
          rows: [],
        },
      ],
      rowsSeen: 0,
      contentDigest: "",
    };
  }

  const { headers, index: headerIndex } = located;

  /*
   * Detection first, the operator second.
   *
   * A field they mapped wins; a field they did not mention keeps what the
   * headers said. `null` is how a column is taken *away* — an operator who sees
   * `Customer` claimed as the channel and knows this file means the customer's
   * name needs a way to say "not that one".
   */
  const columns = new Map(located.columns);
  for (const [field, index] of Object.entries(options.columnOverrides ?? {})) {
    if (index == null) columns.delete(field as Field);
    else if (Number.isInteger(index) && index >= 0) columns.set(field as Field, index);
  }
  const sourceType = options.sourceType ?? detectSourceType(columns) ?? "cash";
  const body = grid.slice(headerIndex + 1);

  /*
   * Which column carries the operative date.
   *
   * Cash and the retention backlog use the invoice date. Wasfaty prefers the
   * next-dispense date and falls back to the fill date, because the older
   * per-city sheets have only the latter — and the fallback is *recorded*
   * (`fill_date` is stored either way), so a lead generated off a fill date can
   * be told apart from one generated off a real next-dispense date.
   */
  const primaryDateField: Field =
    sourceType === "wasfaty"
      ? columns.has("nextDispenseDate")
        ? "nextDispenseDate"
        : "fillDate"
      : "sourceDate";

  const dateOrder =
    options.dateOrder ??
    inferDayFirst(body.map((row) => cell(row, columns, primaryDateField)).slice(0, 3000));

  const issues = new Issues();
  const records: SourceRecordInput[] = [];
  const seenHashes = new Set<string>();
  let rowsSeen = 0;

  for (let i = 0; i < body.length; i++) {
    const row = body[i] ?? [];
    // 1-based, and counted from the sheet's own first row so the number matches
    // what the operator sees in Excel.
    const rowNumber = headerIndex + 2 + i;

    if (isBlankRow(row)) continue;
    rowsSeen++;

    const itemCode = text(cell(row, columns, "itemCode"));
    const itemName = text(cell(row, columns, "itemName"));
    const patientId = text(cell(row, columns, "patientId"));
    const prescriptionNo = text(cell(row, columns, "prescriptionNo"));
    const documentNo = text(cell(row, columns, "documentNo"));
    const customerName = text(cell(row, columns, "customerName"));
    const phoneRaw = text(cell(row, columns, "phone"));

    /*
     * Does the row identify anybody?
     *
     * Cash needs a product and something to key a customer on; Wasfaty needs the
     * prescription pair. A row failing this is rejected rather than stored,
     * because it cannot become a lead and keeping it would only inflate the
     * source table.
     */
    const hasIdentity =
      sourceType === "wasfaty"
        ? Boolean(patientId || prescriptionNo)
        : Boolean(itemCode || itemName);
    if (!hasIdentity) {
      issues.count("missing_identity");
      issues.add(
        "missing_identity",
        sourceType === "wasfaty"
          ? "Row has neither a Patient ID nor a Prescription No"
          : "Row has no product code or product name",
        rowNumber,
      );
      continue;
    }

    /*
     * The prescription number's format, checked but never corrected.
     *
     * Reported and stored, exactly like an unreadable date: the row may still
     * be worked — a Patient ID alone identifies the patient in the portal — and
     * dropping it would make the correction impossible. Only checked for
     * Wasfaty, because the rule is the Wasfaty portal's; a Cash invoice number
     * has nothing to do with it.
     */
    if (sourceType === "wasfaty" && prescriptionNo && !isValidPrescriptionNo(prescriptionNo)) {
      issues.count("invalid_prescription_no");
      issues.add(
        "invalid_prescription_no",
        "Prescription No must start with a lowercase letter (e.g. a123456); the row is stored unchanged",
        rowNumber,
      );
    }

    const rawDateCell = cell(row, columns, primaryDateField);
    const sourceDate = parseSheetDate(rawDateCell, dateOrder);
    if (!sourceDate) {
      // Recorded, and the row is still stored. A date this parser cannot read is
      // a row the desk may still want to see and fix — dropping it would make
      // the fix impossible, and the generator ignores rows without a date
      // anyway, so nothing leaks into a queue.
      const hadSomething = rawDateCell != null && String(rawDateCell).trim() !== "";
      issues.count(hadSomething ? "unparseable_date" : "missing_date");
      issues.add(
        hadSomething ? "unparseable_date" : "missing_date",
        hadSomething
          ? "Date cell could not be read as a date; the row is stored but will not generate a lead"
          : "Date cell is empty; the row is stored but will not generate a lead",
        rowNumber,
      );
    }

    const fillDate =
      primaryDateField === "fillDate"
        ? sourceDate
        : parseSheetDate(cell(row, columns, "fillDate"), dateOrder);

    /*
     * The phone, normalised at the point of entry.
     *
     * One call to the one implementation. Everything downstream — the lead, the
     * queue, the deduplication key, the agent's screen — sees the canonical
     * `05XXXXXXXX` and never the twelve ways the workbooks write it.
     *
     * A cell that cannot become a number is *not* a reason to reject the row:
     * 88,096 of the July extract's rows have no usable number and the desk
     * worked them anyway. The value is kept in `phoneRaw`, the reason is
     * recorded, and the row goes through with `phone: null`.
     */
    const phoneResult = normalizeSaudiPhone(phoneRaw);
    // `extractSaudiPhones` also handles a cell holding more than one number,
    // which `normalizeSaudiPhone` correctly refuses as a single value.
    const phoneCell = phoneRaw ? extractSaudiPhones(phoneRaw) : null;
    const phone = phoneResult.phone ?? phoneCell?.phone ?? null;
    if (phoneRaw && !phone) {
      issues.count("unusable_phone");
      issues.add(
        "unusable_phone",
        `Phone cell is present but unusable (${PHONE_REJECTION_LABELS[phoneResult.rejection ?? "no_digits"]})`,
        rowNumber,
      );
    } else if (phone && !phoneResult.wasCanonical) {
      // Not a problem — a count, so the operator can see how much of the file
      // was rewritten and satisfy themselves that it was rewritten correctly.
      issues.count("phone_normalized");
      issues.add("phone_normalized", "Phone number normalised to 05XXXXXXXX", rowNumber);
    }

    /*
     * Numbers hiding in the note column.
     *
     * Checked against the real files rather than assumed: no phone *cell* in any
     * of the three workbooks holds two numbers, but the notes hold 448 — 167 of
     * them on the four per-city Wasfaty sheets, which have no phone column at
     * all, and 281 more on `Wasfaty Aug`, which does.
     *
     * They are collected as alternates and never promoted. The Retention sheet
     * has exactly one and it is the argument against promoting them:
     * `0509736898 رقم زوجه العميل اللي تستخدم الابر` — the customer's *wife's*
     * number. An agent decides; the importer only stops the number being lost.
     */
    const noteText = text(cell(row, columns, "notes"));
    const fromNote = noteText ? extractSaudiPhones(noteText) : null;
    const alternates: string[] = [];
    for (const candidate of [
      ...(phoneCell?.alternates ?? []),
      ...(fromNote?.phone ? [fromNote.phone, ...fromNote.alternates] : []),
    ]) {
      if (candidate !== phone && !alternates.includes(candidate)) alternates.push(candidate);
    }
    if (alternates.length > 0) {
      issues.count("phone_alternates");
      issues.add(
        "phone_alternates",
        "Another phone number appears on this row (kept, not used as the customer's number)",
        rowNumber,
      );
    }

    const branchNo = branchCode(cell(row, columns, "branchNo"), sourceType);

    const hash = contentHash([
      sourceType,
      text(cell(row, columns, "customerRef")),
      phone ?? phoneRaw,
      itemCode ?? itemName,
      branchNo,
      sourceDate,
      documentNo,
      patientId,
      prescriptionNo,
    ]);

    /*
     * A row identical to one earlier in the same sheet.
     *
     * Counted and skipped. `Taif` has 184 repeated Patient+Prescription pairs
     * and `Wasfaty Sep` has 165; storing both copies would mean the import
     * summary reported more rows than the file usefully contained.
     */
    if (seenHashes.has(hash)) {
      issues.count("duplicate_row");
      issues.add("duplicate_row", "Identical to an earlier row in the same sheet", rowNumber);
      continue;
    }
    seenHashes.add(hash);

    records.push({
      sourceType,
      rowNumber,
      contentHash: hash,
      customerRef: text(cell(row, columns, "customerRef")),
      customerName,
      phoneRaw,
      phone,
      phoneRejection: phone ? null : (phoneResult.rejection ?? null),
      phoneAlternates: alternates,
      branchNo,
      city: text(cell(row, columns, "city")),
      facility: text(cell(row, columns, "facility")),
      itemCode,
      itemName,
      quantity: num(cell(row, columns, "quantity")),
      unitPrice: num(cell(row, columns, "unitPrice")),
      totalValue: num(cell(row, columns, "totalValue")),
      sourceDate,
      fillDate,
      dispenseTime: text(cell(row, columns, "dispenseTime")),
      documentNo,
      channel: text(cell(row, columns, "channel")),
      patientId,
      prescriptionNo,
      callbackDate: parseSheetDate(cell(row, columns, "callbackDate"), dateOrder),
      agentLabel: text(cell(row, columns, "agentLabel")),
      actionLabel: text(cell(row, columns, "actionLabel")),
      notes: text(cell(row, columns, "notes")),
      raw: rawObject(headers, row),
    });
  }

  return {
    sourceType,
    sheetName: options.sheetName ?? "",
    headers,
    // Sorted, so the reported mapping is a set rather than an artefact of
    // whichever order the header columns happened to appear in.
    mappedFields: [...columns.keys()].sort(),
    mappedColumns: Object.fromEntries([...columns.entries()].sort()),
    records,
    issues: issues.list(),
    rowsSeen,
    contentDigest: workbookDigest(records.map((r) => r.contentHash)),
  };
}

/**
 * The row as it was, keyed by its own headers.
 *
 * Stored in `telesales_source_records.raw` so a parsing decision can be audited
 * against what the cell actually said. Bounded at 40 columns and 500 characters
 * per value: none of these sheets is wider than 16 columns, and the bound stops
 * a pathological file from writing megabytes of JSONB per row.
 */
function rawObject(headers: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const width = Math.min(headers.length, row.length, 40);
  for (let i = 0; i < width; i++) {
    const key = headers[i] || `col${i + 1}`;
    const value = row[i];
    if (value == null || String(value).trim() === "") continue;
    const s = String(value);
    out[key] = s.length > 500 ? `${s.slice(0, 500)}…` : s;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Workbook wrapper                                                          */
/* ------------------------------------------------------------------------- */

/** Extensions the import screen accepts. */
export const ACCEPTED_EXTENSIONS = [".xlsx", ".xls", ".xlsm", ".csv"] as const;

/**
 * Read a `File` into a parsed sheet.
 *
 * `xlsx` is imported dynamically so the 900 kB parser is not in the bundle of
 * every page that merely links to the import screen — the same treatment the
 * Branch Directory importer gives it.
 *
 * The sheet is chosen rather than assumed: an operator hands over "July
 * Leads.xlsx", which has thirteen sheets, and the one they mean is the one with
 * the most data rows under a recognisable header. That is `Main Database` for
 * the Cash extract and `Wasfaty Sep` for the current Wasfaty file, and the
 * import screen shows which was picked with a dropdown to change it.
 */
export async function parseWorkbookFile(
  file: File,
  options: ParseOptions & { sheetName?: string } = {},
): Promise<ParsedWorkbook & { availableSheets: string[] }> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  /*
   * `cellDates: false` — dates arrive as Excel serials, deliberately.
   *
   * The two alternatives both lose data:
   *
   *   - `raw: false` renders each cell through its *display* format, so the
   *     Retention workbook's callback column arrives as "Thursday, August 20".
   *     That is prose, it carries no year, and all 328 promised callbacks parse
   *     as null.
   *   - `cellDates: true` builds a Date at **local** midnight, which then reads
   *     back a day early anywhere east of Greenwich.
   *
   * A serial is an integer with no timezone and no locale in it, and
   * `fromExcelSerial` turns it into a calendar date with one subtraction. It is
   * the only one of the three that cannot be wrong for a reason nobody can see.
   */
  const wb = XLSX.read(buffer, { type: "array", cellDates: false });

  const availableSheets = wb.SheetNames.slice();
  if (availableSheets.length === 0) {
    return {
      ...parseSheet([], options),
      availableSheets,
    };
  }

  const chosen =
    options.sheetName && availableSheets.includes(options.sheetName)
      ? options.sheetName
      : pickSheet(wb, XLSX);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[chosen], {
    header: 1,
    // Underlying values, not display strings. Item codes arrive as numbers and
    // dates as serials; `normalizeItemCode` and `parseSheetDate` both take
    // either, and the audit blob in `raw` then records what the cell actually
    // held rather than how this workbook happened to be formatted.
    raw: true,
    defval: null,
    blankrows: false,
  });

  return {
    ...parseSheet(grid, { ...options, sheetName: chosen }),
    availableSheets,
  };
}

/**
 * The sheet with the most parseable rows.
 *
 * Only the header of each sheet is read to decide, not its body — `July
 * Leads.xlsx` is 15 MB and fully parsing all thirteen sheets to choose one would
 * be seconds of work to answer a question the row count already answers.
 */
function pickSheet(
  wb: { SheetNames: string[]; Sheets: Record<string, unknown> },
  XLSX: any,
): string {
  let best = wb.SheetNames[0];
  let bestRows = -1;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name] as { "!ref"?: string };
    if (!ws?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const rows = range.e.r - range.s.r;
    if (rows > bestRows) {
      bestRows = rows;
      best = name;
    }
  }
  return best;
}
