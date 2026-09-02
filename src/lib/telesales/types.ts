/**
 * Telesales CRM — the vocabulary.
 *
 * Pure types and constant tables, no imports. Everything else in the module
 * refers to this file so that "what is an outcome" has one answer shared by the
 * database CHECK constraints, the server functions and the queue UI.
 */

/* ------------------------------------------------------------------------- */
/* Lead types                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The three pipelines, and the reason the module is not one list.
 *
 * `cash` and `wasfaty` are generated from imported files; `retention` is
 * generated from this system's own outcomes. Adding a fourth is a value here, a
 * `CHECK` constraint edit and a dedup rule — deliberately not a schema change.
 */
export const LEAD_TYPES = ["cash", "retention", "wasfaty"] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const LEAD_TYPE_LABELS: Record<LeadType, string> = {
  cash: "Cash",
  retention: "Retention",
  wasfaty: "Wasfaty",
};

/**
 * The file shapes an operator can upload.
 *
 * `retention` is here for the cutover only. A retention lead is normally the
 * next cycle of a conversion this system recorded, but on the day the desk
 * switches over the Retention workbook holds 745 live rows — 328 of them with a
 * callback already promised to a customer. Importing them is the difference
 * between a migration and a restart.
 */
export const SOURCE_TYPES = ["cash", "wasfaty", "retention"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  cash: "Cash source extract",
  wasfaty: "Wasfaty source file",
  retention: "Retention backlog (one-time)",
};

/* ------------------------------------------------------------------------- */
/* Status                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Where a lead is, as distinct from what last happened to it.
 *
 * The spreadsheets had no status column at all — they had an "Action" column
 * carrying both. That is why `Reschedule call` (270 rows in Retention Leads)
 * could not be told apart from a lead that was simply untouched: both looked
 * like "not finished".
 */
export const LEAD_STATUSES = [
  "new",
  "assigned",
  "in_progress",
  "follow_up",
  "converted",
  "closed_lost",
  "closed_unreachable",
  "closed_duplicate",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  assigned: "Assigned",
  in_progress: "In progress",
  follow_up: "Follow-up",
  converted: "Converted",
  closed_lost: "Not interested",
  closed_unreachable: "Unreachable",
  closed_duplicate: "Duplicate",
};

/** Statuses that still represent work. The queue's default filter, and the
 *  `WHERE` clause of `telesales_leads_queue_idx`. */
export const OPEN_LEAD_STATUSES: LeadStatus[] = ["new", "assigned", "in_progress", "follow_up"];

/** Statuses nobody will call again. */
export const CLOSED_LEAD_STATUSES: LeadStatus[] = [
  "converted",
  "closed_lost",
  "closed_unreachable",
  "closed_duplicate",
];

export function isOpenStatus(status: string): boolean {
  return (OPEN_LEAD_STATUSES as string[]).includes(status);
}

/* ------------------------------------------------------------------------- */
/* Outcomes                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * What an agent records after a call.
 *
 * Every value here was observed in at least one of the three workbooks. The
 * spellings differed across sheets and sometimes within one — `"N/A"`, `"N.A"`,
 * `"duplicate "`, `"DUPLICATE"`, `"Duplicate "`, `"wrong number"`, `"wrong
 * information"` — which is most of the argument for an enum: those are four
 * distinct values in Excel and one fact in reality.
 *
 * `terminal` decides whether recording it closes the lead. `requiresFollowup`
 * decides whether the UI insists on a date before it will accept the outcome.
 */
export interface OutcomeDef {
  key: string;
  label: string;
  /** The status this outcome moves the lead to. */
  status: LeadStatus;
  /** Does this end the lead? */
  terminal: boolean;
  /** Must the agent supply a follow-up date? */
  requiresFollowup: boolean;
  /** Does this count as having reached the customer? Drives the contact rate. */
  connected: boolean;
  /** The spreadsheet Action values this replaces, for the import of history and
   *  for anybody comparing the two systems. */
  legacyLabels: string[];
}

export const OUTCOMES: OutcomeDef[] = [
  {
    key: "no_answer",
    label: "No answer / busy",
    status: "in_progress",
    terminal: false,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["No Answer or Busy"],
  },
  {
    key: "interested",
    label: "Interested",
    status: "follow_up",
    terminal: false,
    // An interested customer with no next step is how a lead is lost quietly.
    requiresFollowup: true,
    connected: true,
    legacyLabels: [],
  },
  {
    key: "reschedule",
    label: "Reschedule call",
    status: "follow_up",
    terminal: false,
    requiresFollowup: true,
    connected: true,
    legacyLabels: ["Reschedule call"],
  },
  {
    key: "order_created",
    label: "Order created",
    status: "converted",
    terminal: true,
    requiresFollowup: false,
    connected: true,
    legacyLabels: ["Answered - Order Created"],
  },
  {
    key: "no_order",
    label: "Answered — no order",
    status: "closed_lost",
    terminal: true,
    requiresFollowup: false,
    connected: true,
    legacyLabels: ["Answered - No Order"],
  },
  {
    key: "not_interested",
    label: "Not interested",
    status: "closed_lost",
    terminal: true,
    requiresFollowup: false,
    connected: true,
    legacyLabels: ["Discontinued"],
  },
  {
    key: "wrong_number",
    label: "Wrong number",
    status: "closed_unreachable",
    terminal: true,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["Wrong Number", "wrong number", "wrong information"],
  },
  {
    key: "unavailable",
    label: "Unavailable",
    status: "closed_unreachable",
    terminal: true,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["N/A", "N.A", "Pharmacist No."],
  },
  {
    key: "duplicate",
    label: "Duplicate lead",
    status: "closed_duplicate",
    terminal: true,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["Duplicated Lead", "duplicate", "Duplicate", "DUPLICATE"],
  },
  /*
   * The three Wasfaty-only outcomes. They appear nowhere in the Cash or
   * Retention workbooks and account for 1,437 of the Wasfaty rows, so they are
   * real operational vocabulary rather than typos — a prescription that has
   * already been collected or has expired is not a lost sale, and recording it
   * as one would understate the desk's conversion rate on every report.
   */
  {
    key: "dispensed_expired",
    label: "Dispensed / expired",
    status: "closed_duplicate",
    terminal: true,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["Dispensed / Expired"],
  },
  {
    key: "rejected",
    label: "Rejected",
    status: "closed_lost",
    terminal: true,
    requiresFollowup: false,
    connected: true,
    legacyLabels: ["Rejected"],
  },
  {
    key: "low_price",
    label: "Low value",
    status: "closed_lost",
    terminal: true,
    requiresFollowup: false,
    connected: false,
    legacyLabels: ["Low Price"],
  },
];

export const OUTCOME_BY_KEY: Map<string, OutcomeDef> = new Map(OUTCOMES.map((o) => [o.key, o]));

/** Outcomes an agent may pick for a lead of this type. */
export function outcomesForLeadType(leadType: LeadType): OutcomeDef[] {
  const wasfatyOnly = new Set(["dispensed_expired", "low_price"]);
  return OUTCOMES.filter((o) => leadType === "wasfaty" || !wasfatyOnly.has(o.key));
}

/* ------------------------------------------------------------------------- */
/* Activity                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Every kind of thing that gets written to the timeline.
 *
 * Free text in the database (`activity_type text`), enumerated here. The
 * database does not constrain it because a `CHECK` on an append-only audit table
 * is a migration every time the desk learns a new verb, and the cost of an
 * unrecognised type is a generic icon rather than a lost row.
 */
export const ACTIVITY_TYPES = [
  "created",
  "assigned",
  "unassigned",
  "reassigned",
  "call",
  "note",
  "followup_scheduled",
  "followup_completed",
  "followup_cancelled",
  "phone_added",
  "phone_updated",
  "order_recorded",
  "closed",
  "reopened",
  "cycle_started",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  created: "Lead created",
  assigned: "Assigned",
  unassigned: "Unassigned",
  reassigned: "Reassigned",
  call: "Call",
  note: "Note",
  followup_scheduled: "Follow-up scheduled",
  followup_completed: "Follow-up completed",
  followup_cancelled: "Follow-up cancelled",
  phone_added: "Phone number added",
  phone_updated: "Phone number updated",
  order_recorded: "Order recorded",
  closed: "Lead closed",
  reopened: "Lead reopened",
  cycle_started: "Retention cycle started",
};

/* ------------------------------------------------------------------------- */
/* Row shapes                                                                */
/* ------------------------------------------------------------------------- */

/** A normalised row read out of an uploaded workbook. */
export interface SourceRecordInput {
  sourceType: SourceType;
  rowNumber: number;
  contentHash: string;
  customerRef: string | null;
  customerName: string | null;
  /** The cell exactly as it arrived. Audit only — never the customer's number. */
  phoneRaw: string | null;
  /** The canonical Saudi mobile number — `05XXXXXXXX` — or null when the cell
   *  held nothing dialable. This is the CRM's phone value; `phoneRaw` is only
   *  ever evidence. */
  phone: string | null;
  /** Why `phone` is null, so the import summary can group the reasons rather
   *  than reporting one undifferentiated count. A `PhoneRejection` from
   *  `src/lib/phone.ts`. */
  phoneRejection: string | null;
  /** Further canonical numbers found on the row — a second number in the cell,
   *  or one an agent wrote into the note column. Never promoted to `phone`
   *  automatically: the Retention sheet's one example is a customer's wife's
   *  number. See `extractSaudiPhones`. */
  phoneAlternates: string[];
  branchNo: string | null;
  city: string | null;
  facility: string | null;
  itemCode: string | null;
  itemName: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalValue: number | null;
  /** The operative date: invoice date for Cash, next-dispense for Wasfaty. */
  sourceDate: string | null;
  fillDate: string | null;
  dispenseTime: string | null;
  documentNo: string | null;
  channel: string | null;
  patientId: string | null;
  prescriptionNo: string | null;
  /** The workbooks' "Date to be called" — a callback already promised. Only the
   *  retention backlog import populates it. */
  callbackDate: string | null;
  /** The workbooks' "Agent Name", e.g. `Ahmed Mousad (1000)`. Carried so the
   *  backlog import can hand a lead back to the agent who already owns it. */
  agentLabel: string | null;
  /** The workbooks' "Action", verbatim. Mapped to an outcome key on the way in;
   *  kept so an unrecognised spelling is visible rather than lost. */
  actionLabel: string | null;
  notes: string | null;
  raw: Record<string, unknown>;
}

/** One thing the parser could not do, reported to the operator by row number. */
export interface ImportIssue {
  /** Machine key, so counts can be tallied without string matching. */
  code:
    | "unparseable_date"
    | "missing_date"
    | "missing_identity"
    | "missing_product"
    | "duplicate_row"
    | "unusable_phone"
    | "phone_normalized"
    | "phone_alternates"
    | "empty_row";
  message: string;
  /** 1-based sheet row. */
  rows: number[];
}

export interface ParsedWorkbook {
  sourceType: SourceType;
  sheetName: string;
  /** Header row as read, for the preview panel. */
  headers: string[];
  records: SourceRecordInput[];
  issues: ImportIssue[];
  rowsSeen: number;
  /** Stable digest of the parsed records, for re-upload detection. */
  contentDigest: string;
}

/** The settings row, in the shape the pure functions want it. */
export interface TelesalesSettings {
  cashWindowDays: number;
  cashWindowLagDays: number;
  wasfatyWindowDays: number;
  retentionOverdueGraceDays: number;
  automationEnabled: boolean;
  generationHour: number;
}

export const DEFAULT_SETTINGS: TelesalesSettings = {
  cashWindowDays: 3,
  cashWindowLagDays: 1,
  wasfatyWindowDays: 2,
  retentionOverdueGraceDays: 14,
  automationEnabled: false,
  generationHour: 7,
};
