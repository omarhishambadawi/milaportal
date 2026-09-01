import { businessToday, type BusinessDate } from "./dates";
import { toE164 } from "./dedup";
import { applyOutcome, canActOnLead, canRecordOutcome, type ActorContext } from "./status";
import { OUTCOME_BY_KEY } from "./types";

/**
 * The agent's write path.
 *
 * Every function here is one operational act — record a call, claim a lead,
 * schedule a follow-up, add a phone number — and each of them touches between
 * two and four tables. That is why they are server functions running as
 * `service_role` rather than client writes under RLS: a browser that could
 * update the lead but then failed to append the activity would leave a lead
 * whose state disagrees with its own history, which is precisely the condition
 * the spreadsheets were in.
 *
 * ### The activity row is written last, and always
 *
 * Order matters. The lead is updated first and the timeline second, so a crash
 * between them leaves a lead with no entry rather than an entry describing a
 * change that did not happen. The former is visibly odd; the latter is a lie in
 * an append-only audit table that a database trigger then refuses to let anyone
 * correct.
 */

export interface ActorIdentity extends ActorContext {
  name: string | null;
  role: string | null;
}

export interface LeadRow {
  id: string;
  lead_type: string;
  status: string;
  assigned_to: string | null;
  contact_attempts: number;
  first_contacted_at: string | null;
  cycle_number: number;
  item_code: string | null;
  item_name: string | null;
  patient_id: string | null;
}

const LEAD_COLUMNS =
  "id,lead_type,status,assigned_to,contact_attempts,first_contacted_at,cycle_number," +
  "item_code,item_name,patient_id";

export async function loadLead(supabase: any, leadId: string): Promise<LeadRow> {
  const { data, error } = await supabase
    .from("telesales_leads")
    .select(LEAD_COLUMNS)
    .eq("id", leadId)
    .single();
  if (error || !data) throw new Error("Lead not found");
  return data as LeadRow;
}

/** Append one row to the timeline. Never updates; the table refuses updates. */
async function appendActivity(
  supabase: any,
  input: {
    leadId: string;
    actor: ActorIdentity | null;
    activityType: string;
    outcome?: string | null;
    note?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("telesales_lead_activities").insert({
    lead_id: input.leadId,
    activity_type: input.activityType,
    outcome: input.outcome ?? null,
    note: input.note ?? null,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    actor_id: input.actor?.userId ?? null,
    actor_name: input.actor?.name ?? null,
    actor_role: input.actor?.role ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) throw new Error(`Could not record the activity: ${error.message}`);
}

/* ------------------------------------------------------------------------- */
/* Assignment                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Claim, assign or reassign.
 *
 * This is the replacement for the spreadsheet's "Agent Name" column, and the
 * important difference is that it refuses. In the workbook an agent typed their
 * name into a row a colleague had already claimed and the second name simply
 * overwrote the first; here, an agent acting on somebody else's lead is told to
 * ask a team lead.
 *
 * `assigneeId` is honoured only for a manager. An agent's request to assign the
 * lead to somebody else is downgraded to a self-claim rather than refused,
 * because the useful reading of "claim" from an agent is always "give it to me".
 */
export async function assignLead(
  supabase: any,
  input: {
    leadId: string;
    assigneeId: string | null;
    actor: ActorIdentity;
    note?: string | null;
  },
): Promise<{ assignedTo: string | null }> {
  const lead = await loadLead(supabase, input.leadId);

  const decision = canActOnLead(input.actor, lead);
  if (!decision.allowed) throw new Error(decision.reason);

  const target = input.actor.canManage ? input.assigneeId : input.actor.userId;
  const wasAssigned = lead.assigned_to;

  const { error } = await supabase
    .from("telesales_leads")
    .update({
      assigned_to: target,
      assigned_at: target ? new Date().toISOString() : null,
      assigned_by: target ? input.actor.userId : null,
      // Claiming moves a new lead into the assigned state; a lead already being
      // worked keeps whatever state it is in, because reassigning somebody
      // else's in-progress call does not undo the calls already made.
      status: target && lead.status === "new" ? "assigned" : lead.status,
    })
    .eq("id", input.leadId);
  if (error) throw new Error(error.message);

  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: target == null ? "unassigned" : wasAssigned ? "reassigned" : "assigned",
    note: input.note ?? null,
    fromStatus: lead.status,
    toStatus: target && lead.status === "new" ? "assigned" : lead.status,
    metadata: { from: wasAssigned, to: target },
  });

  return { assignedTo: target };
}

/* ------------------------------------------------------------------------- */
/* Recording a call                                                          */
/* ------------------------------------------------------------------------- */

export interface RecordOutcomeInput {
  leadId: string;
  outcomeKey: string;
  note?: string | null;
  /** Required when the outcome says so; ignored otherwise. */
  followupDueOn?: BusinessDate | null;
  followupTime?: string | null;
  followupReason?: string | null;
  /** For `order_created`. */
  orderId?: string | null;
  orderValue?: number | null;
  actor: ActorIdentity;
}

/**
 * Record what happened on a call.
 *
 * The whole transition, in order:
 *
 *   1. Refuse if the lead is closed, or is somebody else's.
 *   2. Claim it if it was unassigned — dialling a lead is claiming it, and
 *      making that implicit is what keeps the queue to one click per call.
 *   3. Move the lead to the status the outcome dictates, bump the attempt
 *      counter, stamp first/last contact.
 *   4. Settle the open follow-up, and open a new one if asked.
 *   5. Append the activity.
 */
export async function recordOutcome(
  supabase: any,
  input: RecordOutcomeInput,
): Promise<{ status: string; followupDueOn: BusinessDate | null }> {
  const lead = await loadLead(supabase, input.leadId);

  if (!canRecordOutcome(lead.status as any)) {
    throw new Error("This lead is closed. Reopen it before recording another outcome.");
  }
  const decision = canActOnLead(input.actor, lead);
  if (!decision.allowed) throw new Error(decision.reason);

  const effect = applyOutcome(lead.status as any, input.outcomeKey);
  const outcome = OUTCOME_BY_KEY.get(input.outcomeKey)!;

  if (effect.requiresFollowup && !input.followupDueOn) {
    throw new Error(`"${outcome.label}" needs a follow-up date.`);
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: effect.status,
    last_outcome: input.outcomeKey,
    contact_attempts: lead.contact_attempts + (effect.countsAsAttempt ? 1 : 0),
    last_contacted_at: now,
    first_contacted_at: lead.first_contacted_at ?? now,
  };

  // Dialling a lead claims it. The agent had to be allowed to act on it to get
  // here, so this cannot take a lead from anyone.
  if (decision.claims) {
    update.assigned_to = input.actor.userId;
    update.assigned_at = now;
    update.assigned_by = input.actor.userId;
  }

  if (effect.status === "converted") {
    update.converted_at = now;
    update.order_id = input.orderId ?? null;
    update.converted_value = input.orderValue ?? null;
  }
  if (effect.terminal) {
    update.closed_at = now;
    update.closed_reason = effect.closedReason;
  }

  const { error } = await supabase.from("telesales_leads").update(update).eq("id", input.leadId);
  if (error) throw new Error(error.message);

  /*
   * The open follow-up is settled either way.
   *
   * A call that happened is the completion of whatever reminder produced it, and
   * leaving it scheduled would show the lead as still due today after it had
   * been dealt with. The partial unique index also permits only one open
   * follow-up per lead, so a new one cannot be opened until this closes.
   */
  await supabase
    .from("telesales_followups")
    .update({
      status: "completed",
      completed_at: now,
      completed_by: input.actor.userId,
      result: input.outcomeKey,
    })
    .eq("lead_id", input.leadId)
    .eq("status", "scheduled");

  let followupDueOn: BusinessDate | null = null;
  if (input.followupDueOn) {
    followupDueOn = input.followupDueOn;
    const { error: fErr } = await supabase.from("telesales_followups").insert({
      lead_id: input.leadId,
      assigned_to: input.actor.userId,
      due_on: input.followupDueOn,
      due_time: input.followupTime ?? null,
      reason: input.followupReason ?? outcome.label,
      status: "scheduled",
    });
    if (fErr) throw new Error(`Could not schedule the follow-up: ${fErr.message}`);
  }

  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: "call",
    outcome: input.outcomeKey,
    note: input.note ?? null,
    fromStatus: lead.status,
    toStatus: effect.status,
    metadata: {
      connected: effect.connected,
      followup_due_on: followupDueOn,
      ...(input.orderId ? { order_id: input.orderId } : {}),
      ...(input.orderValue != null ? { order_value: input.orderValue } : {}),
    },
  });

  if (effect.status === "converted") {
    await appendActivity(supabase, {
      leadId: input.leadId,
      actor: input.actor,
      activityType: "order_recorded",
      note: input.orderId ? `Linked to order ${input.orderId}` : "Order recorded",
      metadata: { order_id: input.orderId ?? null, value: input.orderValue ?? null },
    });
  }

  return { status: effect.status, followupDueOn };
}

/* ------------------------------------------------------------------------- */
/* Notes and follow-ups                                                      */
/* ------------------------------------------------------------------------- */

export async function addNote(
  supabase: any,
  input: { leadId: string; note: string; actor: ActorIdentity },
): Promise<void> {
  const lead = await loadLead(supabase, input.leadId);
  // A note is deliberately *not* gated on ownership. An agent who learns
  // something about a customer another agent owns should be able to write it
  // down; withholding that is how knowledge stays in somebody's head.
  if (!input.actor.canWork && !input.actor.canManage) {
    throw new Error("You do not have permission to write on leads.");
  }
  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: "note",
    note: input.note,
    fromStatus: lead.status,
    toStatus: lead.status,
  });
}

export async function scheduleFollowup(
  supabase: any,
  input: {
    leadId: string;
    dueOn: BusinessDate;
    dueTime?: string | null;
    reason?: string | null;
    actor: ActorIdentity;
  },
): Promise<void> {
  const lead = await loadLead(supabase, input.leadId);
  const decision = canActOnLead(input.actor, lead);
  if (!decision.allowed) throw new Error(decision.reason);

  const now = new Date().toISOString();
  // Replace rather than add: one open follow-up per lead is a database
  // guarantee, and rescheduling is the common case.
  await supabase
    .from("telesales_followups")
    .update({
      status: "cancelled",
      completed_at: now,
      completed_by: input.actor.userId,
      result: "rescheduled",
    })
    .eq("lead_id", input.leadId)
    .eq("status", "scheduled");

  const { error } = await supabase.from("telesales_followups").insert({
    lead_id: input.leadId,
    assigned_to: lead.assigned_to ?? input.actor.userId,
    due_on: input.dueOn,
    due_time: input.dueTime ?? null,
    reason: input.reason ?? null,
    status: "scheduled",
    created_by: input.actor.userId,
  });
  if (error) throw new Error(error.message);

  await supabase
    .from("telesales_leads")
    .update({ status: lead.status === "new" ? "follow_up" : lead.status })
    .eq("id", input.leadId);

  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: "followup_scheduled",
    note: input.reason ?? null,
    metadata: { due_on: input.dueOn, due_time: input.dueTime ?? null },
  });
}

/* ------------------------------------------------------------------------- */
/* Closing and reopening                                                     */
/* ------------------------------------------------------------------------- */

export async function closeLead(
  supabase: any,
  input: { leadId: string; reason: string; actor: ActorIdentity },
): Promise<void> {
  const lead = await loadLead(supabase, input.leadId);
  const decision = canActOnLead(input.actor, lead);
  if (!decision.allowed) throw new Error(decision.reason);

  const now = new Date().toISOString();
  await supabase
    .from("telesales_leads")
    .update({ status: "closed_lost", closed_at: now, closed_reason: input.reason })
    .eq("id", input.leadId);
  await supabase
    .from("telesales_followups")
    .update({ status: "cancelled", completed_at: now, completed_by: input.actor.userId })
    .eq("lead_id", input.leadId)
    .eq("status", "scheduled");

  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: "closed",
    note: input.reason,
    fromStatus: lead.status,
    toStatus: "closed_lost",
  });
}

/**
 * Reopening is its own action, not a second outcome.
 *
 * `canRecordOutcome` refuses an outcome on a closed lead, so a lead closed in
 * error would otherwise be stuck. Making the reversal explicit means the
 * timeline says "this was closed and then reopened" rather than showing an
 * unexplained call after a terminal outcome.
 */
export async function reopenLead(
  supabase: any,
  input: { leadId: string; reason: string; actor: ActorIdentity },
): Promise<void> {
  if (!input.actor.canManage) {
    throw new Error("Only a team lead can reopen a closed lead.");
  }
  const lead = await loadLead(supabase, input.leadId);
  await supabase
    .from("telesales_leads")
    .update({
      status: lead.assigned_to ? "in_progress" : "new",
      closed_at: null,
      closed_reason: null,
    })
    .eq("id", input.leadId);

  await appendActivity(supabase, {
    leadId: input.leadId,
    actor: input.actor,
    activityType: "reopened",
    note: input.reason,
    fromStatus: lead.status,
    toStatus: lead.assigned_to ? "in_progress" : "new",
  });
}

/* ------------------------------------------------------------------------- */
/* Wasfaty phone numbers                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Record a phone number an agent found in the Wasfaty portal.
 *
 * There is no Wasfaty API here and none is assumed. This is the manual lookup
 * done once: the number belongs to the *patient*, so every other prescription
 * for that patient — now and next month — is answered from it rather than
 * sending another agent back to the portal.
 *
 * A correction supersedes rather than overwrites, so "the number we called last
 * month" stays answerable, and it back-fills every open lead for that patient so
 * the queue reflects it immediately.
 */
export async function setPatientPhone(
  supabase: any,
  input: {
    patientId: string;
    phone: string;
    leadId?: string | null;
    prescriptionNo?: string | null;
    notes?: string | null;
    actor: ActorIdentity;
  },
): Promise<{ phoneE164: string; leadsUpdated: number }> {
  if (!input.actor.canWork && !input.actor.canManage) {
    throw new Error("You do not have permission to record a phone number.");
  }
  const phoneE164 = toE164(input.phone);
  if (!phoneE164) {
    throw new Error("That is not a usable Saudi mobile number.");
  }

  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from("telesales_patient_contacts")
    .select("id,phone_e164")
    .eq("patient_id", input.patientId)
    .is("superseded_at", null)
    .maybeSingle();

  const previous = (existing as { id: string; phone_e164: string } | null) ?? null;
  if (previous?.phone_e164 === phoneE164) {
    // Nothing changed. Recording an identical number as a correction would put a
    // meaningless entry on every lead for that patient.
    return { phoneE164, leadsUpdated: 0 };
  }

  if (previous) {
    await supabase
      .from("telesales_patient_contacts")
      .update({ superseded_at: now, superseded_by: input.actor.userId })
      .eq("id", previous.id);
  }

  const { error } = await supabase.from("telesales_patient_contacts").insert({
    patient_id: input.patientId,
    phone_e164: phoneE164,
    phone_raw: input.phone,
    source: "agent",
    prescription_no: input.prescriptionNo ?? null,
    added_by: input.actor.userId,
    notes: input.notes ?? null,
  });
  if (error) throw new Error(error.message);

  // Back-fill the open leads for this patient.
  const { data: touched } = await supabase
    .from("telesales_leads")
    .update({ phone_e164: phoneE164 })
    .eq("patient_id", input.patientId)
    .in("status", ["new", "assigned", "in_progress", "follow_up"])
    .select("id");

  const leadIds = ((touched as { id: string }[]) ?? []).map((r) => r.id);
  if (leadIds.length > 0) {
    await supabase.from("telesales_lead_activities").insert(
      leadIds.map((id) => ({
        lead_id: id,
        activity_type: previous ? "phone_updated" : "phone_added",
        note: previous ? "Phone number corrected" : "Phone number found in the Wasfaty portal",
        actor_id: input.actor.userId,
        actor_name: input.actor.name,
        actor_role: input.actor.role,
        // The number itself is not written into the activity metadata. It is on
        // the lead where the agent can see it; repeating it across every history
        // row would spread a patient's contact details through an append-only
        // table that can never be corrected.
        metadata: { patient_id: input.patientId, superseded: Boolean(previous) },
      })),
    );
  }

  return { phoneE164, leadsUpdated: leadIds.length };
}

/** Today, in the business timezone. Re-exported so callers do not each import
 *  the date module to stamp a follow-up. */
export { businessToday };
