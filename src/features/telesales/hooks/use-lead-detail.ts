import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import {
  telesalesAddNote,
  telesalesAssignLead,
  telesalesCloseLead,
  telesalesDeleteLead,
  telesalesRecordOutcome,
  telesalesReopenLead,
  telesalesScheduleFollowup,
  telesalesSetPatientPhone,
} from "@/lib/telesales.functions";
import type {
  Followup,
  LeadActivity,
  LeadDetail,
  PatientContact,
} from "@/features/telesales/types";

/**
 * One lead: its row, its timeline, its follow-ups — and every way to change it.
 *
 * Three separate queries rather than one joined read. They age differently and
 * they are invalidated differently: adding a note rewrites the timeline and
 * touches neither of the others, while recording an outcome rewrites all three.
 * A single blob would refetch the lot every time an agent typed a note.
 */

export function useLeadDetail(leadId: string | undefined) {
  return useQuery<LeadDetail | null>({
    queryKey: queryKeys.telesales.detail(leadId),
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_leads")
        .select("*")
        .eq("id", leadId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as LeadDetail) ?? null;
    },
  });
}

export function useLeadActivity(leadId: string | undefined) {
  return useQuery<LeadActivity[]>({
    queryKey: queryKeys.telesales.activity(leadId),
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_lead_activities")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        // A lead with more than 200 entries is a lead somebody needs to look at
        // for a different reason; the cap keeps one pathological row from
        // dominating the page.
        .limit(200);
      if (error) throw new Error(error.message);
      return (data as LeadActivity[]) ?? [];
    },
  });
}

export function useLeadFollowups(leadId: string | undefined) {
  return useQuery<Followup[]>({
    queryKey: queryKeys.telesales.followups(leadId),
    enabled: Boolean(leadId),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_followups")
        .select("*")
        .eq("lead_id", leadId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data as Followup[]) ?? [];
    },
  });
}

/**
 * A Wasfaty patient's phone history.
 *
 * Keyed by patient, not by lead. The number belongs to the patient and every
 * prescription for them shares it — which is the entire point of the table, and
 * why an agent working their third prescription this month is not sent back to
 * the portal a third time.
 */
export function usePatientContacts(patientId: string | null | undefined) {
  return useQuery<PatientContact[]>({
    queryKey: queryKeys.telesales.patientContacts(patientId ?? undefined),
    enabled: Boolean(patientId),
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_patient_contacts")
        .select("*")
        .eq("patient_id", patientId)
        .order("added_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return (data as PatientContact[]) ?? [];
    },
  });
}

/* ------------------------------------------------------------------------- */
/* Writes                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Every mutation invalidates `telesales.all()`.
 *
 * Coarse, and deliberately so. These writes are cross-cutting by nature — one
 * recorded outcome changes the lead, its timeline, its follow-up, the queue's
 * ordering and the management board's counts — so a targeted invalidation would
 * be five calls that each have to remember the other four, and the first one
 * anybody forgot would show an agent a stale queue with a lead they had just
 * closed still in it.
 *
 * The cost is a refetch of at most a page of 50 rows and one lead's history.
 */
export function useLeadMutations(leadId?: string) {
  const qc = useQueryClient();
  const sweep = () => qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });

  const fail = (err: unknown) => {
    toast.error(err instanceof Error ? err.message : "Something went wrong.");
  };

  const assign = useMutation({
    mutationFn: (input: { leadId: string; assigneeId: string | null; note?: string }) =>
      telesalesAssignLead({ data: input }),
    onSuccess: (result) => {
      sweep();
      toast.success(result.assignedTo ? "Lead assigned." : "Lead unassigned.");
    },
    onError: fail,
  });

  const recordOutcome = useMutation({
    mutationFn: (input: {
      leadId: string;
      outcomeKey: string;
      note?: string;
      followupDueOn?: string | null;
      followupTime?: string | null;
      followupReason?: string | null;
      orderId?: string | null;
      orderValue?: number | null;
    }) => telesalesRecordOutcome({ data: input }),
    onSuccess: () => {
      sweep();
      toast.success("Outcome recorded.");
    },
    onError: fail,
  });

  const addNote = useMutation({
    mutationFn: (input: { leadId: string; note: string }) => telesalesAddNote({ data: input }),
    onSuccess: () => {
      // A note changes only the timeline, so this is the one write that does not
      // need the full sweep.
      qc.invalidateQueries({ queryKey: queryKeys.telesales.activity(leadId) });
      toast.success("Note added.");
    },
    onError: fail,
  });

  const scheduleFollowup = useMutation({
    mutationFn: (input: {
      leadId: string;
      dueOn: string;
      dueTime?: string | null;
      reason?: string | null;
    }) => telesalesScheduleFollowup({ data: input }),
    onSuccess: () => {
      sweep();
      toast.success("Follow-up scheduled.");
    },
    onError: fail,
  });

  const close = useMutation({
    mutationFn: (input: { leadId: string; reason: string }) => telesalesCloseLead({ data: input }),
    onSuccess: () => {
      sweep();
      toast.success("Lead closed.");
    },
    onError: fail,
  });

  const reopen = useMutation({
    mutationFn: (input: { leadId: string; reason: string }) => telesalesReopenLead({ data: input }),
    onSuccess: () => {
      sweep();
      toast.success("Lead reopened.");
    },
    onError: fail,
  });

  const setPhone = useMutation({
    mutationFn: (input: {
      patientId: string;
      phone: string;
      leadId?: string | null;
      prescriptionNo?: string | null;
    }) => telesalesSetPatientPhone({ data: input }),
    onSuccess: (result) => {
      sweep();
      toast.success(
        result.leadsUpdated > 1
          ? `Number saved — applied to ${result.leadsUpdated} open leads for this patient.`
          : "Number saved.",
      );
    },
    onError: fail,
  });

  return { assign, recordOutcome, addNote, scheduleFollowup, close, reopen, setPhone };
}

/**
 * Delete one lead. Administrators only, and the server enforces that.
 *
 * Separate from `useLeadMutations` because it is not one of the desk's daily
 * writes: it is offered on the row only to an administrator, and bundling it
 * into the hook every queue row already calls would put an irreversible
 * mutation one typo away from every one of them.
 *
 * The toast reports which of the two outcomes occurred, because they are
 * genuinely different: a lead nobody worked is gone, and a lead with call
 * history has been archived with its log intact.
 */
export function useDeleteLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { leadId: string }) => telesalesDeleteLead({ data: input }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: queryKeys.telesales.all() });
      toast.success(
        result.mode === "archived"
          ? "Lead removed from the queue. Its call history was kept."
          : "Lead deleted.",
      );
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "That lead could not be deleted."),
  });
}
