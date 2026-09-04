import type { ColumnOverrides, Field } from "./parse";
import { templateFor, type TemplateColumn } from "./templates";
import type { SourceType } from "./types";

/**
 * Mapping a spreadsheet's columns to MilaPortal's fields, by hand.
 *
 * ===========================================================================
 * An override, never a replacement
 * ===========================================================================
 * Auto-detection is still what happens: `HEADER_ALIASES` recognises the three
 * workbooks the module was written against, and a file built from a MilaPortal
 * template maps with nothing to decide. This is for the fourth file — a
 * pharmacy's own export, a renamed column, a sheet whose `Mobile Number` the
 * alias table has never seen — where the choice today is "edit the spreadsheet
 * until the importer likes it" or "do not import it".
 *
 * So every row here starts at what detection found, and a row the operator does
 * not touch stays there. `auto` records which is which, so the screen can show
 * what it worked out and what a person decided.
 *
 * ===========================================================================
 * The fields are the template's
 * ===========================================================================
 * `IMPORT_TEMPLATES` already declares, per source type, which fields exist,
 * which are required, what each one means and what a value looks like. That is
 * exactly the list a mapping screen needs, and deriving it from there rather
 * than restating it means the template, the download, the validation panel and
 * this screen cannot disagree about what a Wasfaty file is supposed to contain.
 *
 * Nothing here knows a database column name. The labels are the template's
 * business words, because the person mapping the sheet is a pharmacy operator.
 */

/* ------------------------------------------------------------------------- */
/* The rows a mapping screen renders                                         */
/* ------------------------------------------------------------------------- */

export interface MappingRow {
  field: Field;
  /** The template's business label, e.g. "Next Dispense Date". */
  label: string;
  required: boolean;
  description: string;
  /** The column index this field reads from, or null when it reads from none. */
  column: number | null;
  /**
   * True when `column` is what detection found and the operator has not
   * overridden it. False once they choose — including when they choose the same
   * column, because "I checked this" is worth distinguishing from "nobody
   * looked".
   */
  auto: boolean;
}

/**
 * The mapping as it currently stands: detection, with the operator's choices
 * laid over it.
 *
 * `detected` is `ParsedWorkbook.mappedFields` expanded back to indices — the
 * parser reports which fields it resolved, and the screen needs to know from
 * where, so it is passed the column map directly.
 */
export function buildMapping(
  sourceType: SourceType,
  detected: ReadonlyMap<string, number>,
  overrides: ColumnOverrides = {},
): MappingRow[] {
  return templateFor(sourceType).columns.map((c: TemplateColumn) => {
    const overridden = Object.prototype.hasOwnProperty.call(overrides, c.field);
    const column = overridden ? (overrides[c.field] ?? null) : (detected.get(c.field) ?? null);
    return {
      field: c.field,
      label: c.header,
      required: c.required,
      description: c.description,
      column,
      auto: !overridden,
    };
  });
}

/**
 * The rows reduced to what `parseSheet` takes.
 *
 * Only the operator's own choices travel. A row still on its detected value
 * contributes nothing, so re-parsing with these overrides and re-parsing
 * without them agree wherever nobody intervened — which is what makes this an
 * override rather than a second mapping the parser has to reconcile.
 */
export function overridesFromMapping(rows: readonly MappingRow[]): ColumnOverrides {
  const out: ColumnOverrides = {};
  for (const row of rows) {
    if (!row.auto) out[row.field] = row.column;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

export type MappingProblem =
  | { kind: "missing_required"; field: Field; label: string }
  | { kind: "duplicate_column"; column: number; header: string; labels: string[] };

/**
 * Fields the parser reads from one column on purpose, so mapping both to the
 * same place is a legitimate answer rather than a mistake.
 *
 * Exactly one pair, and it is not a guess: for Wasfaty, `parseSheet` picks a
 * `primaryDateField` of `nextDispenseDate` or `fillDate` and, when it lands on
 * the latter, assigns the same parsed value to both. A file carrying one date
 * column that is both the fill date and the next-dispense date is the shape the
 * older per-city sheets actually have.
 *
 * Everything else is refused. Two different business fields fed from one column
 * — a phone that is also a customer id — is an operator error every time, and
 * the import would succeed and be wrong.
 */
const SHARED_COLUMN_PAIRS: ReadonlySet<string> = new Set(["fillDate|nextDispenseDate"]);

/**
 * How a column is named in a message to the operator.
 *
 * A blank header is a real and common shape — an export with an unlabelled
 * first column — and `headers[i]` returns `""` for it rather than undefined, so
 * a `??` fallback never fires. Naming it by position is what the mapping panel
 * already does, and the two must agree or a problem would point at a column the
 * operator cannot find in the dropdown.
 */
function columnLabel(headers: readonly string[], column: number): string {
  const header = headers[column];
  return header && header.trim() !== "" ? header : `Column ${column + 1}`;
}

function pairKey(a: Field, b: Field): string {
  return [a, b].sort().join("|");
}

/** May these two fields legitimately read from the same column? */
export function mayShareColumn(a: Field, b: Field): boolean {
  return a === b || SHARED_COLUMN_PAIRS.has(pairKey(a, b));
}

export interface MappingVerdict {
  ok: boolean;
  problems: MappingProblem[];
}

/**
 * Can this mapping be imported?
 *
 * Two rules, and no more:
 *
 *   * every **required** field reads from some column, because the eligibility
 *     rules downstream cannot judge a row without them and the import would
 *     store rows that can never become leads;
 *   * no column feeds two fields that the parser does not deliberately share.
 *
 * An unmapped optional field is not a problem — most files carry a subset, and
 * refusing them would make the template a requirement rather than a
 * convenience.
 */
export function validateMapping(
  rows: readonly MappingRow[],
  headers: readonly string[],
): MappingVerdict {
  const problems: MappingProblem[] = [];

  for (const row of rows) {
    if (row.required && row.column == null) {
      problems.push({ kind: "missing_required", field: row.field, label: row.label });
    }
  }

  const byColumn = new Map<number, MappingRow[]>();
  for (const row of rows) {
    if (row.column == null) continue;
    const bucket = byColumn.get(row.column);
    if (bucket) bucket.push(row);
    else byColumn.set(row.column, [row]);
  }

  for (const [column, sharing] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
    if (sharing.length < 2) continue;
    const allowed = sharing.every((a, i) =>
      sharing.every((b, j) => i === j || mayShareColumn(a.field, b.field)),
    );
    if (allowed) continue;
    problems.push({
      kind: "duplicate_column",
      column,
      header: columnLabel(headers, column),
      labels: sharing.map((r) => r.label),
    });
  }

  return { ok: problems.length === 0, problems };
}

/** One sentence per problem, in the operator's terms. */
export function describeProblem(problem: MappingProblem): string {
  if (problem.kind === "missing_required") {
    return `${problem.label} is required and is not mapped to a column.`;
  }
  return (
    `"${problem.header}" is mapped to ${problem.labels.join(" and ")}. ` +
    `One column cannot mean two different things.`
  );
}

/* ------------------------------------------------------------------------- */
/* Recording what was used                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The mapping as it is stored with the import.
 *
 * Header text rather than column indices: an index means nothing a month later,
 * and "Mobile Number → Phone" is the sentence somebody auditing an import
 * actually wants. `null` records a field that was left unmapped on purpose.
 *
 * Per import, never global. Nothing reads this back to pre-fill a later upload
 * — that would be a saved mapping, which is a different feature with a
 * different failure mode (a stale mapping applied silently to a file whose
 * columns moved).
 */
export type StoredColumnMapping = Record<string, { column: string | null; auto: boolean }>;

export function storedMapping(
  rows: readonly MappingRow[],
  headers: readonly string[],
): StoredColumnMapping {
  const out: StoredColumnMapping = {};
  for (const row of rows) {
    out[row.label] = {
      column: row.column == null ? null : columnLabel(headers, row.column),
      auto: row.auto,
    };
  }
  return out;
}

/** How many fields the operator decided themselves. Shown before importing. */
export function manualCount(rows: readonly MappingRow[]): number {
  return rows.filter((r) => !r.auto).length;
}
