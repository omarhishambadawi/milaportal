import type { LeadStatus, LeadType } from "@/lib/telesales/types";

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
  phone_e164: string | null;
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
  contact_attempts: number;
  cycle_number: number;
  total_value: number | null;
  created_at: string;
}

/** The lead detail page's read — every column, plus its history. */
export interface LeadDetail extends QueueLead {
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
  phone_e164: string;
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
