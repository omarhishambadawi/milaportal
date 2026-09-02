import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { businessToday } from "@/lib/telesales/dates";
import { OPEN_LEAD_STATUSES } from "@/lib/telesales/types";
import type { QueueFilters, QueueLead } from "@/features/telesales/types";

/**
 * The agent queue's read.
 *
 * Server-side filtering and paging, always. The brief is explicit about it and
 * the numbers make the case on their own: the July extract is 173,008 source
 * rows, and pulling even the 670 eligible ones into the browser to reproduce an
 * Excel filter would be the old workflow with a nicer font.
 *
 * Every filter below becomes a `WHERE` clause and every page is a `range()`.
 * The count comes back with the page (`count: "exact"`) rather than from a
 * second query, so the pager and the rows can never disagree.
 */

const QUEUE_COLUMNS =
  "id,lead_type,status,priority,last_outcome,assigned_to,customer_name,phone," +
  "branch_no,city,item_name,product_family,product_strength,patient_id,prescription_no," +
  "document_no,source_date,next_followup_on,contact_attempts,cycle_number,total_value," +
  "phone_alternates,last_contacted_by,last_contacted_at,customer_id,created_at," +
  // Derived by the view, stored nowhere. See `20260906120000`.
  "lifecycle,refill_due_on,stale_after,refill_cycle_days,last_purchased_on," +
  "archived_at,archived_by,archive_reason";

/**
 * The queue reads the lifecycle view rather than the table.
 *
 * A view with `security_invoker = true`, so the RLS policies on
 * `telesales_leads` still decide what comes back -- the lens does not widen
 * anything. What it adds is the derived refill lifecycle as ordinary columns,
 * which is what lets "show me only the leads that are still current" stay a
 * `WHERE` clause and a `range()` instead of becoming a filter in the browser.
 */
const QUEUE_SOURCE = "telesales_lead_lifecycle";

export interface QueuePage {
  rows: QueueLead[];
  total: number;
}

/**
 * Escape a term for PostgREST's `or=(...)` grammar.
 *
 * A comma splits conditions and a parenthesis closes the list, so a customer
 * searching for `SMITH, J (VIP)` would otherwise produce a malformed filter and
 * a 400. Quoting the value and stripping the quote character is the smallest
 * thing that makes arbitrary user text safe here.
 */
function ilikeTerm(term: string): string {
  return `*${term.replace(/[,()"\\]/g, " ").trim()}*`;
}

export function useTelesalesQueue(
  filters: QueueFilters,
  page: number,
  pageSize: number,
  enabled: boolean,
) {
  return useQuery<QueuePage>({
    queryKey: queryKeys.telesales.queue(filters, page, pageSize),
    enabled,
    // The queue is a shared work list: another agent claiming a lead changes
    // what this one should see. Short, not real-time — a claim races anyway and
    // the write path is what actually refuses it.
    staleTime: 15_000,
    queryFn: async () => {
      const today = businessToday();
      let q = (supabase as any).from(QUEUE_SOURCE).select(QUEUE_COLUMNS, { count: "exact" });

      /*
       * Archived leads are excluded from every view except the one that asks
       * for them.
       *
       * The queue is the list of work and an archived lead is precisely what a
       * supervisor decided is not work, so this is applied before every other
       * filter. "Archived" is an explicit choice from the operational filter,
       * never a default and never mixed into a working view -- an agent cannot
       * arrive at archived rows by accident.
       *
       * RLS is unchanged either way: `view_telesales` already permits reading
       * an archived lead, which is how the lead detail and the customer profile
       * have always shown one. This exposes no row a caller could not already
       * read; restoring still requires `manage_telesales` at the server
       * function.
       */
      if (filters.lifecycle === "archived") q = q.not("archived_at", "is", null);
      else q = q.is("archived_at", null);

      if (filters.leadType !== "all") q = q.eq("lead_type", filters.leadType);

      if (filters.status === "open") q = q.in("status", OPEN_LEAD_STATUSES);
      else if (filters.status !== "all") q = q.eq("status", filters.status);

      /*
       * Lifecycle. Orthogonal to status, so it is its own clause.
       *
       * `active` deliberately keeps `none` -- a lead with no refill date has no
       * opportunity to have expired, and dropping it would quietly hide the
       * Wasfaty and Cash leads that never had one. Only leads that genuinely
       * went past their cycle are set aside.
       */
      if (filters.lifecycle === "active") q = q.in("lifecycle", ["active", "none"]);
      else if (filters.lifecycle === "stale") q = q.eq("lifecycle", "stale");

      if (filters.branch !== "all") q = q.eq("branch_no", filters.branch);
      if (filters.family !== "all") q = q.eq("product_family", filters.family);

      // Ownership. `unassignedOnly` wins over the agent picker when both are
      // set, because "show me what nobody owns" and "show me Ahmed's" cannot
      // both be true and the former is the claim-work gesture.
      if (filters.unassignedOnly) q = q.is("assigned_to", null);
      else if (filters.mineOnly && filters.userId) q = q.eq("assigned_to", filters.userId);
      else if (filters.agent === "unassigned") q = q.is("assigned_to", null);
      else if (filters.agent !== "all") q = q.eq("assigned_to", filters.agent);

      switch (filters.followup) {
        case "today":
          q = q.eq("next_followup_on", today);
          break;
        case "overdue":
          q = q.lt("next_followup_on", today);
          break;
        case "upcoming":
          q = q.gt("next_followup_on", today);
          break;
        case "none":
          q = q.is("next_followup_on", null);
          break;
        default:
          break;
      }

      if (filters.term.trim()) {
        const t = ilikeTerm(filters.term);
        /*
         * One search box over the five identifiers the desk actually uses.
         *
         * A Cash agent has an invoice number or a name, a Wasfaty agent has a
         * Patient ID or a Prescription No, and anybody with the customer on the
         * line has a phone number. Making them pick which field they are
         * searching would be a dropdown nobody wants to touch mid-call.
         */
        q = q.or(
          [
            `customer_name.ilike.${t}`,
            `phone.ilike.${t}`,
            `patient_id.ilike.${t}`,
            `prescription_no.ilike.${t}`,
            `document_no.ilike.${t}`,
          ].join(","),
        );
      }

      const { data, error, count } = await q
        // Priority first, then age. An overdue promise outranks everything, and
        // among equals the oldest lead is the one closest to expiring.
        .order("priority", { ascending: false })
        .order("created_at", { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1);

      if (error) throw new Error(error.message);
      return { rows: (data as QueueLead[]) ?? [], total: count ?? 0 };
    },
  });
}

/**
 * The branch codes that currently have leads, for the filter dropdown.
 *
 * Archived leads are excluded, matching every working view of the queue.
 * Without that, a branch whose only leads had been archived stayed in the
 * dropdown and selecting it returned an empty queue -- a filter that looks
 * broken rather than one that is simply empty.
 */
export function useTelesalesBranches(enabled: boolean) {
  return useQuery<string[]>({
    queryKey: [...queryKeys.telesales.all(), "branch-options"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_leads")
        .select("branch_no")
        .not("branch_no", "is", null)
        .is("archived_at", null)
        .in("status", OPEN_LEAD_STATUSES)
        .limit(5000);
      if (error) throw new Error(error.message);
      const set = new Set<string>();
      for (const r of (data as { branch_no: string }[]) ?? []) set.add(r.branch_no);
      return [...set].sort();
    },
  });
}

/** The product families in the catalogue, for the filter dropdown. */
export function useTelesalesFamilies(enabled: boolean) {
  return useQuery<string[]>({
    queryKey: [...queryKeys.telesales.products(), "families"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("telesales_products")
        .select("family")
        .eq("active", true);
      if (error) throw new Error(error.message);
      const set = new Set<string>();
      for (const r of (data as { family: string }[]) ?? []) set.add(r.family);
      return [...set].sort();
    },
  });
}

/**
 * The size of the backlog: stale, how much of it nobody owns, and how much has
 * already been archived.
 *
 * Head-only counts, so the whole summary costs four numbers rather than four
 * pages of rows. Deliberately independent of the queue's own filters except
 * lead type: the question is "how much old opportunity is sitting in the
 * system", which should not change because a supervisor happens to be looking
 * at one branch.
 *
 * Same lifecycle definition as everything else -- it comes from the view, so it
 * cannot drift from what the rows say.
 */
export interface StaleBacklog {
  /** Open, unarchived, past one full refill cycle. */
  stale: number;
  staleUnassigned: number;
  staleAssigned: number;
  /** Leads a supervisor has already taken out of the queue. */
  archived: number;
}

export function useStaleLeadCount(enabled: boolean, leadType: string) {
  return useQuery<StaleBacklog>({
    queryKey: [...queryKeys.telesales.all(), "stale-backlog", leadType],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      /*
       * Four head-only counts, run together.
       *
       * `head: true` means PostgREST returns the count and no rows, so the
       * whole summary costs four numbers rather than four pages of leads. They
       * are issued in parallel because they are independent, and none of them
       * touches the MIS.
       *
       * Deliberately independent of the queue's own filters except lead type:
       * the question a supervisor is asking is "how much backlog is in the
       * system", which should not change because they happened to be looking
       * at one branch.
       */
      const scope = (q: any) => (leadType === "all" ? q : q.eq("lead_type", leadType));
      const base = () =>
        scope(
          (supabase as any)
            .from(QUEUE_SOURCE)
            .select("id", { count: "exact", head: true })
            .in("status", OPEN_LEAD_STATUSES),
        );

      const [stale, unassigned, archived] = await Promise.all([
        base().is("archived_at", null).eq("lifecycle", "stale"),
        base().is("archived_at", null).eq("lifecycle", "stale").is("assigned_to", null),
        scope(
          (supabase as any)
            .from(QUEUE_SOURCE)
            .select("id", { count: "exact", head: true })
            .not("archived_at", "is", null),
        ),
      ]);

      for (const r of [stale, unassigned, archived]) {
        if (r.error) throw new Error(r.error.message);
      }

      const total = stale.count ?? 0;
      const un = unassigned.count ?? 0;
      return {
        stale: total,
        staleUnassigned: un,
        // Derived rather than counted: assigned is whatever is left, so the
        // three figures cannot disagree with one another.
        staleAssigned: Math.max(0, total - un),
        archived: archived.count ?? 0,
      };
    },
  });
}
