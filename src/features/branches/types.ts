import type { ReferenceKind } from "./normalize";

/** A branch as stored, one row of `public.branches`. */
export interface Branch {
  branch_no: string;
  city: string;
  phone: string | null;
  area_manager: string | null;
  area_manager_phone: string | null;
  email: string | null;
  address: string | null;
  maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
  scooter: boolean;
  scooter_note: string | null;
  working_hours: string | null;
  friday_hours: string | null;
  duty_hours: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A branch plus everything derived from it that the directory needs on every
 * keystroke: the search haystack, the display-formatted phone numbers and the
 * map link. Computed once when the query resolves (see `decorate`), never
 * inside a filter callback -- rebuilding these per render is the difference
 * between an instant search box and a laggy one.
 */
export interface BranchView extends Branch {
  /** Normalized, space-joined text every searchable field contributes to. */
  haystack: string;
  /** Digits of both phone numbers, for numeric-only queries. */
  phoneDigits: string;
  phoneE164: string | null;
  managerPhoneE164: string | null;
  phoneDisplay: string | null;
  managerPhoneDisplay: string | null;
  /** Google Maps link: the sheet's own URL when present, else built from coordinates. */
  mapsLink: string | null;
  /** Turn-by-turn link, always built from coordinates. */
  navLink: string | null;
  hasCoords: boolean;
  /** English name for the city when known, for search and for the map. */
  cityEnglish: string | null;
  /**
   * District (حي), read out of the address — there is no column for it. Null
   * whenever the address does not state one clearly; see `extractDistrict`.
   */
  district: string | null;
  /**
   * Set when this row is a facility rather than a pharmacy — head office,
   * regional office or a warehouse. Null for every numbered branch, which is
   * what lets the card badge only the rows that need the warning.
   */
  reference: ReferenceKind | null;
  /**
   * The address with the leading city segment removed, which is the only part
   * worth showing on a card that already names the city in its header.
   */
  addressLine: string | null;
  /** Short, readable stand-in for the Google Maps URL, e.g. "maps.app.goo.gl". */
  mapsLabel: string | null;
}

/** How an uploaded workbook is reconciled with the branches already stored. */
export type ImportMode = "replace" | "merge" | "update" | "add";

export const IMPORT_MODES: {
  value: ImportMode;
  label: string;
  description: string;
}[] = [
  {
    value: "replace",
    label: "Replace All",
    description:
      "The file becomes the directory. Branches missing from it are deactivated (never deleted — orders reference them).",
  },
  {
    value: "merge",
    label: "Merge Existing",
    description:
      "Update the branches in the file, add the ones that are new, and leave everything else untouched.",
  },
  {
    value: "update",
    label: "Update Existing Only",
    description:
      "Only overwrite branches that already exist. New branch codes in the file are skipped.",
  },
  {
    value: "add",
    label: "Add New Only",
    description:
      "Only insert branch codes that do not exist yet. Existing branches are left as they are.",
  },
];

/**
 * Severity of something found while validating an uploaded row.
 *
 * Three levels, and only the first one blocks:
 *
 *   - `critical` — the row cannot be stored or cannot be identified. No branch
 *     code, no city, a pharmacy code that repeats. These rows are dropped and
 *     the operator has to fix the source.
 *   - `warning` — the row imports, but something about it is incomplete and
 *     somebody should chase it: a missing phone, absent coordinates, an
 *     unreadable hours string.
 *   - `info` — the importer did something on the operator's behalf that they
 *     should know about but need not act on: auto-coding a second warehouse
 *     row, skipping a branch the chosen mode does not touch.
 *
 * Ordered by severity so `LEVEL_RANK` can sort a mixed list.
 */
export type IssueLevel = "critical" | "warning" | "info";

export const LEVEL_RANK: Record<IssueLevel, number> = { critical: 0, warning: 1, info: 2 };

export interface ImportIssue {
  /** 1-based row number as it appears in Excel, so the operator can go fix it. */
  row: number;
  branchNo: string;
  field: string;
  level: IssueLevel;
  message: string;
}

/**
 * What to do when a branch code appears twice in one file.
 *
 * Split by what the code *is*, because the two cases are genuinely different.
 * A repeated pharmacy code is a data-entry mistake: `P0021` identifies one shop,
 * orders reference it, and two rows claiming it is a contradiction that must be
 * resolved by a human. A repeated facility code is not a mistake at all — the
 * master sheet legitimately holds two rows coded "المستودع" because the business
 * has two warehouses, and refusing the file over that is the tool being wrong
 * about the world rather than the data being wrong.
 */
export type FacilityDuplicateStrategy = "suffix" | "first-wins" | "last-wins" | "reject";

export const FACILITY_DUPLICATE_STRATEGIES: {
  value: FacilityDuplicateStrategy;
  label: string;
  description: string;
}[] = [
  {
    value: "suffix",
    label: "Number them",
    description:
      "Keep every row, giving the repeats a numbered code (المستودع, المستودع-2). Best when the duplicates are genuinely different places.",
  },
  {
    value: "first-wins",
    label: "Keep the first",
    description: "Import the first occurrence and skip the rest.",
  },
  {
    value: "last-wins",
    label: "Keep the last",
    description: "Later rows overwrite earlier ones, so the bottom of the sheet wins.",
  },
  {
    value: "reject",
    label: "Reject duplicates",
    description: "Treat any repeated code as an error, facilities included.",
  },
];

export interface ImportOptions {
  /** How repeated facility codes are reconciled. Pharmacy codes are always unique. */
  facilityDuplicates: FacilityDuplicateStrategy;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { facilityDuplicates: "suffix" };

/** Counts by severity, stored on the import record. */
export interface ValidationSummary {
  critical: number;
  warning: number;
  info: number;
  /** Distinct rows carrying at least one warning. */
  flaggedRows: number;
  /** Rows dropped for a critical issue. */
  rejected: number;
}

/** What `summarize()` returns: the stored summary plus the importable count. */
export type ImportLevelCounts = ValidationSummary & { valid: number };

/** A row that parsed cleanly enough to be written. */
export interface ParsedBranch {
  row: number;
  branch_no: string;
  city: string;
  phone: string | null;
  area_manager: string | null;
  area_manager_phone: string | null;
  email: string | null;
  address: string | null;
  maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
  scooter: boolean;
  scooter_note: string | null;
  working_hours: string | null;
  friday_hours: string | null;
  duty_hours: number | null;
}

export interface ImportPreview {
  fileName: string;
  sheetName: string;
  /** Rows that will be written. */
  rows: ParsedBranch[];
  issues: ImportIssue[];
  /** Rows dropped for a critical issue. */
  rejected: number;
  /** Rows skipped by a duplicate policy rather than rejected. */
  ignored: number;
  /** Header columns found in the file, in order — shown when the shape is wrong. */
  headers: string[];
  /** Template columns the file did not supply. */
  missingColumns: string[];
}

export interface ImportHistoryEntry {
  id: string;
  imported_at: string;
  imported_by: string | null;
  importer_name: string | null;
  /** The importer's role at the time, not today — see the migration. */
  actor_role: string | null;
  mode: string;
  file_name: string | null;
  rows_total: number;
  rows_added: number;
  rows_updated: number;
  /** Deactivated, never deleted. */
  rows_removed: number;
  /** Carried by the file but skipped by the chosen mode. */
  rows_ignored: number;
  /** Rejected for a critical validation issue. */
  rows_failed: number;
  validation_summary: ValidationSummary | null;
  reverted_from: string | null;
  notes: string | null;
  /** True when the snapshot still holds rows to restore. */
  restorable: boolean;
}
