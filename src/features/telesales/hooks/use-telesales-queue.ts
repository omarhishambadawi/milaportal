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
  "phone_alternates,last_contacted_by,last_contacted_at,customer_id,created_at,import_id," +
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

      /*
       * The domain scope, applied before anything the user can change.
       *
       * Cash and Wasfaty are separate desks now, and this is the clause that
       * makes that true in the database rather than only in the navigation: a
       * hand-edited `?type=wasfaty` on the Cash queue narrows within
       * `cash,retention` and returns nothing, instead of quietly serving the
       * other domain's leads.
       */
      const domain = filters.domain.split(",").filter(Boolean);
      if (domain.length === 1) q = q.eq("lead_type", domain[0]);
      else if (domain.length > 1) q = q.in("lead_type", domain);

      if (filters.leadType !== "all" && domain.includes(filters.leadType)) {
        q = q.eq("lead_type", filters.leadType);
      }

      if (filters.status === "open") q = q.in("status", OPEN_LEAD_STATUSES);
      else if (filters.status !== "all") q = q.eq("status", filters.status);

      /*
       * The recorded action, which is what the Wasfaty desk means by "status".
       *
       * Its own clause rather than a widening of the one above, because the two
       * are different questions: `status` is the workflow state the action
       * produced, `last_outcome` is the action itself. Three of the eight
       * Wasfaty actions land on `follow_up` and two on `closed_lost`, so a
       * status filter cannot tell "Out of Stock" from "Refill Too Soon".
       */
      if (filters.outcome !== "all") q = q.eq("last_outcome", filters.outcome);

      /*
       * The import cycle.
       *
       * September's file is one cycle, October's is the next, and the desk works
       * one at a time — so All Leads means "this cycle", not "every prescription
       * this system has ever seen". `import_id` is carried on the lead itself
       * (see `20260913120000`), so this is one indexed `IN` rather than a join
       * through a table an agent may not read.
       */
      const importIds = filters.importIds.split(",").filter(Boolean);
      if (importIds.length === 1) q = q.eq("import_id", importIds[0]);
      else if (importIds.length > 1) q = q.in("import_id", importIds);

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

      /*
       * The date range, on the lead's own business date.
       *
       * `source_date` is the invoice date for Cash and the next-dispense date
       * for Wasfaty — the date the desk means when it says "last week" — and it
       * is a real column on the table rather than something the view derives,
       * so this is an index-usable range scan and not a filter the browser
       * finishes. Both ends inclusive, and either may stand alone.
       */
      if (filters.dateFrom) q = q.gte("source_date", filters.dateFrom);
      if (filters.dateTo) q = q.lte("source_date", filters.dateTo);

      /*
       * Worked, which is not a status.
       *
       * `last_outcome` is written the moment an agent records anything, and
       * three of the eight Wasfaty actions leave the lead open afterwards — so
       * a Worked Leads view built on `status` would miss every lead that was
       * called, actioned and correctly left in the queue.
       */
      if (filters.worked === "worked") q = q.not("last_outcome", "is", null);
      else if (filters.worked === "unworked") q = q.is("last_outcome", null);

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
export function useTelesalesBranches(enabled: boolean, domain: string) {
  return useQuery<string[]>({
    queryKey: [...queryKeys.telesales.all(), "branch-options", domain],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // Scoped to the domain for the same reason the queue is: the Cash desk's
      // branch list should not offer the Wasfaty pharmacy numbers, which are a
      // different identifier space entirely (see `branchCode` in `parse.ts`).
      const { data, error } = await (supabase as any)
        .from("telesales_leads")
        .select("branch_no")
        .in("lead_type", domain.split(",").filter(Boolean))
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

export function useStaleLeadCount(enabled: boolean, domain: string, leadType: string) {
  return useQuery<StaleBacklog>({
    queryKey: [...queryKeys.telesales.all(), "stale-backlog", domain, leadType],
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
      const types = domain.split(",").filter(Boolean);
      const scope = (q: any) =>
        leadType !== "all" && types.includes(leadType)
          ? q.eq("lead_type", leadType)
          : q.in("lead_type", types);
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

/* ------------------------------------------------------------------------- */
/* Cycles                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * One Wasfaty import cycle: a business month, and the batches uploaded in it.
 *
 * `importIds` rather than the month itself is what the queue filters on, because
 * two uploads of a corrected October file are one cycle to the desk and two rows
 * in `telesales_imports`.
 */
export interface WasfatyCycle {
  /** `2026-10`. The value that travels in the URL. */
  period: string;
  /** `October 2026`. What the selector shows. */
  label: string;
  importIds: string[];
  /** Live leads the batches in this cycle raised. */
  leads: number;
}

/**
 * The cycles an agent may choose between, newest first.
 *
 * Through an RPC rather than a read of `telesales_imports`, which is
 * `manage_telesales` only: the period selector is on a page every agent uses,
 * and which *batch* raised a lead is not the raw extract. The function returns
 * the month, its label, the batch ids and a count — no file names, no uploader.
 *
 * The first entry is the current cycle. That is what "All Leads" means when the
 * URL says nothing, so this query is what decides the default view; it is
 * cached for five minutes because a new cycle arrives once a month.
 */
export function useWasfatyCycles(enabled: boolean) {
  return useQuery<WasfatyCycle[]>({
    queryKey: [...queryKeys.telesales.all(), "wasfaty-cycles"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("telesales_wasfaty_cycles");
      if (error) throw new Error(error.message);
      return ((data as any[]) ?? []).map((r) => ({
        period: String(r.period),
        label: String(r.label),
        importIds: (r.import_ids as string[] | null) ?? [],
        leads: Number(r.leads ?? 0),
      }));
    },
  });
}

/**
 * Which cycle the page is actually showing, and the batches to ask for.
 *
 * `""` from the URL means "the current cycle", which is a datum and not a
 * constant — it is whichever month was imported last. Resolving it here rather
 * than in `queue-search.ts` keeps the URL honest: staying on the current cycle
 * writes nothing, so a link shared in October still means "the current cycle"
 * when it is opened in November.
 */
export function resolveCycle(
  cycles: WasfatyCycle[] | undefined,
  chosen: string,
): { period: string; importIds: string } {
  if (chosen === "all" || !cycles || cycles.length === 0) return { period: chosen, importIds: "" };
  const found = chosen === "" ? cycles[0] : cycles.find((c) => c.period === chosen);
  // A period that no longer exists — a deleted import, or a hand-edited URL —
  // widens to every cycle rather than showing an empty page with a month on it.
  if (!found) return { period: "all", importIds: "" };
  return { period: found.period, importIds: found.importIds.join(",") };
}
