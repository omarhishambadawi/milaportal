import type { LeadStatus, LeadType } from "@/lib/telesales/types";
import type { LifecycleState as LeadLifecycleState } from "@/lib/telesales/lifecycle";

/**
 * Row shapes the Telesales screens read.
 *
 * Snake_case, because these come straight back from PostgREST and renaming them
 * on the way in would mean a mapping layer whose only job is to make the
 * property names look like the rest of the app — and whose failure mode is a
 * column that silently arrives `undefined`.
 */

/** One row of the agent queue. Deliberately narrower than the table: the queue
 *  renders 50 of these and does not need the columns it will not show. */
export interface QueueLead {
  id: string;
  lead_type: LeadType;
  status: LeadStatus;
  priority: number;
  last_outcome: string | null;
  assigned_to: string | null;
  customer_name: string | null;
  phone: string | null;
  branch_no: string | null;
  city: string | null;
  item_name: string | null;
  product_family: string | null;
  product_strength: string | null;
  patient_id: string | null;
  prescription_no: string | null;
  document_no: string | null;
  source_date: string | null;
  next_followup_on: string | null;
  /** Other numbers found on the source row — a second number in the cell, or
   *  one an agent wrote into the note column. Never used as the customer’s
   *  number without somebody choosing it. */
  phone_alternates: string[] | null;
  contact_attempts: number;
  /** Who last recorded a *call*. Not the owner: a lead can be assigned to one
   *  agent and last dialled by another, and the queue shows both. */
  last_contacted_by: string | null;
  last_contacted_at: string | null;
  /** The consolidated customer identity, keyed on the canonical phone. */
  customer_id: string | null;
  cycle_number: number;
  total_value: number | null;
  created_at: string;
  /* ----------------------------------------------------------------------
   * Derived by `telesales_lead_lifecycle`, not stored on the lead.
   *
   * The view computes these on every read, so they cannot disagree with the
   * clock the way a persisted `is_stale` column would.
   * -------------------------------------------------------------------- */
  /** "active" | "stale" | "none" */
  lifecycle: LeadLifecycleState;
  /** The date the refill is judged against: agreed callback, else projection. */
  refill_due_on: string | null;
  /** The last day the opportunity is still current (`refill_due_on` + cycle). */
  stale_after: string | null;
  /** `telesales_products.refill_days` for this lead's product. */
  refill_cycle_days: number | null;
  /** Most recent purchase of this product by this customer. */
  last_purchased_on: string | null;
  /* ----------------------------------------------------------------------
   * Operational archive. A soft state on the lead itself, not a deletion:
   * the row, its activities and its customer all survive it.
   * -------------------------------------------------------------------- */
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

/** The lead detail page's read — every column, plus its history. */
export interface LeadDetail extends QueueLead {
  archived_at: string | null;
  archive_reason: string | null;
  source_record_id: string | null;
  generation_run_id: string | null;
  parent_lead_id: string | null;
  dedup_key: string;
  customer_ref: string | null;
  facility: string | null;
  channel: string | null;
  item_code: string | null;
  quantity: number | null;
  generation_reason: string | null;
  assigned_at: string | null;
  first_contacted_at: string | null;
  last_contacted_at: string | null;
  converted_at: string | null;
  order_id: string | null;
  converted_value: number | null;
  closed_at: string | null;
  closed_reason: string | null;
  updated_at: string;
}

export interface LeadActivity {
  id: string;
  lead_id: string;
  activity_type: string;
  outcome: string | null;
  note: string | null;
  from_status: string | null;
  to_status: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Followup {
  id: string;
  lead_id: string;
  assigned_to: string | null;
  due_on: string;
  due_time: string | null;
  reason: string | null;
  status: "scheduled" | "completed" | "cancelled";
  completed_at: string | null;
  result: string | null;
  notes: string | null;
  created_at: string;
}

export interface PatientContact {
  id: string;
  patient_id: string;
  phone: string;
  source: string;
  prescription_no: string | null;
  added_by: string | null;
  added_at: string;
  superseded_at: string | null;
  notes: string | null;
}

/** The filter set that identifies a queue query. Part of the React Query key,
 *  so every field must be a primitive. */
export interface QueueFilters {
  leadType: string;
  status: string;
  agent: string;
  branch: string;
  family: string;
  /** "all" | "today" | "overdue" | "upcoming" | "none" */
  followup: string;
  /**
   * "active" | "stale" | "all".
   *
   * Orthogonal to `status`, which is workflow. A lead can be `follow_up` and
   * stale at once, so the two are separate filters and neither implies the
   * other.
   */
  lifecycle: string;
  /** Free text over customer name, phone, patient id, prescription, invoice. */
  term: string;
  mineOnly: boolean;
  unassignedOnly: boolean;
  userId: string | undefined;
}

export const DEFAULT_QUEUE_FILTERS: Omit<QueueFilters, "userId"> = {
  leadType: "all",
  // "open" rather than "all": an agent opening the queue wants work, not an
  // archive. The workbooks had no such distinction, which is why a sheet from
  // May still listed 745 rows nobody was going to call.
  status: "open",
  agent: "all",
  branch: "all",
  family: "all",
  followup: "all",
  /*
   * Actionable work by default.
   *
   * 501 of the 712 open leads are more than a full refill cycle past due --
   * a backlog the retention workbook accumulated since March. An agent opening
   * the queue to a list that is 70% dead opportunities is the problem this
   * phase exists to fix. The stale count sits beside the filter and is one
   * click away, so this prioritises rather than hides.
   */
  lifecycle: "active",
  term: "",
  mineOnly: false,
  unassignedOnly: false,
};

export interface ManagementMetrics {
  leads_today: number;
  cash_today: number;
  retention_today: number;
  wasfaty_today: number;
  open_total: number;
  unassigned: number;
  assigned: number;
  contacted_today: number;
  converted_today: number;
  closed_today: number;
  followups_due: number;
  followups_overdue: number;
  followups_upcoming: number;
  calls_today: number;
  no_answer_today: number;
}

export interface AgentWorkload {
  agent_id: string;
  agent_name: string | null;
  open_leads: number;
  contacted_today: number;
  converted_today: number;
  followups_due: number;
  followups_overdue: number;
}

export interface ImportHistoryEntry {
  id: string;
  source_type: string;
  file_name: string;
  file_size: number | null;
  sheet_name: string | null;
  status: string;
  rows_total: number;
  rows_stored: number;
  rows_duplicate: number;
  rows_rejected: number;
  issues: { items?: { code: string; message: string; rows: number[] }[] };
  error_summary: string | null;
  imported_by: string | null;
  actor_role: string | null;
  imported_at: string;
}

export interface GenerationRun {
  id: string;
  lead_type: LeadType;
  execution_source: string;
  anchor_date: string;
  window_from: string | null;
  window_to: string | null;
  status: string;
  candidates: number;
  leads_created: number;
  skipped_duplicate: number;
  skipped_ineligible: number;
  errors: number;
  error_summary: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface TelesalesProductRow {
  item_code: string;
  item_name: string;
  family: string;
  strength: string | null;
  category: string | null;
  eligible_cash: boolean;
  eligible_retention: boolean;
  refill_days: number | null;
  notes: string | null;
  active: boolean;
}
