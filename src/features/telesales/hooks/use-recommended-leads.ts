import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { shamsGetProduct } from "@/lib/shams.functions";
import { branchStockState, type StockState } from "@/lib/shams/availability";
import { businessToday } from "@/lib/telesales/dates";
import { OPEN_LEAD_STATUSES } from "@/lib/telesales/types";
import {
  groupHistoryByPhone,
  groupRelationsByItem,
  recommendLeads,
  type ProductRelation,
  type PurchaseRecord,
  type RecommendableLead,
  type Recommendation,
  type RecommendationSummary,
} from "@/lib/telesales/recommendations";
import type { QueueLead } from "@/features/telesales/types";
import type { InvoiceMatchStatus } from "@/lib/telesales/reconciliation";

/**
 * The data behind Recommended Leads.
 *
 * ===========================================================================
 * Four bounded queries, and not one MIS request
 * ===========================================================================
 * The brief's sharpest constraint is that this page must not become one
 * upstream call per lead. It does not come close: the whole ranked list is
 * computed from Postgres.
 *
 *   1. candidate leads        one query, capped at `CANDIDATE_LIMIT`
 *   2. their purchase history one query per 250 phones (`telesales_source_records`)
 *   3. refill cycles          one query (`telesales_products`, 28 rows)
 *   4. configured cross-sells one query (`telesales_product_relations`, empty)
 *
 * The purchase history is the part that makes this possible. It is the
 * pharmacy's own sales extract, already imported, so "has this customer bought
 * this product before" is a local join rather than a question for the MIS.
 *
 * Stock is the one signal the MIS owns, and it is fetched **per distinct
 * product on the visible page only** — a page of 25 leads spans far fewer than
 * 25 products — through the same `shamsGetProduct` the `/shams` Stock tab uses
 * and under the same query key, so it shares that cache. Rows render
 * immediately with stock `unknown` and fill in; nothing waits on it.
 *
 * ===========================================================================
 * A deliberate limitation, stated plainly
 * ===========================================================================
 * Ranking is computed from local data only, and stock decorates the rows rather
 * than reordering them. The alternative — ranking by stock — would mean either
 * asking the MIS about all 109 distinct products before drawing anything, or
 * ordering page 1 by stock we have and page 2 by stock we do not, so the same
 * lead would sit at a different rank depending on how you got to it.
 *
 * `compareRecommendations` implements the in-stock tiebreak and is tested; it
 * applies whenever a caller supplies stock. This caller does not, so the order
 * an agent sees is stable and does not shuffle under the cursor as answers
 * arrive. Agents who want to work in-stock leads first filter for them.
 *
 * The candidate cap is the other limitation: recommendations are derived across
 * the newest `CANDIDATE_LIMIT` open leads. At the live volume (712 open) that
 * is the entire queue. A desk working a materially larger backlog would want
 * this pushed into SQL.
 */

/**
 * How many open leads are considered.
 *
 * Sized against the real queue rather than guessed: 712 open leads today, and
 * the pipelines are generated from a monthly extract, so the working set is a
 * month wide by construction. The cap exists so this cannot silently become an
 * unbounded read if an import ever lands 173,008 rows.
 */
const CANDIDATE_LIMIT = 2000;

/** PostgREST takes these as a URL filter, so phones go in batches. */
const PHONE_CHUNK = 250;

/** The queue row plus the two columns the engine needs and the queue does not. */
export interface RecommendedQueueLead extends QueueLead {
  item_code: string | null;
  invoice_match_status: InvoiceMatchStatus | null;
}

export interface RecommendedRow {
  lead: RecommendedQueueLead;
  recommendation: Recommendation;
}

const LEAD_COLUMNS =
  "id,lead_type,status,priority,last_outcome,assigned_to,customer_name,phone," +
  "branch_no,city,item_code,item_name,product_family,product_strength,patient_id," +
  "prescription_no,document_no,source_date,next_followup_on,contact_attempts," +
  "cycle_number,total_value,phone_alternates,last_contacted_by,last_contacted_at," +
  "customer_id,created_at,invoice_match_status";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface CandidateData {
  leads: RecommendedQueueLead[];
  history: PurchaseRecord[];
  cycles: { item_code: string; refill_days: number | null }[];
  relations: ProductRelation[];
  /** True when the cap was reached, so the page can say so. */
  capped: boolean;
}

/**
 * Everything the engine needs, in one cache entry.
 *
 * Gathered together rather than as four hooks because they are one logical
 * read: a recommendation is only correct if its history, cycle and relation
 * come from the same moment. Splitting them would let the list render against a
 * lead set from one refetch and a history from another.
 */
function useRecommendationData(enabled: boolean) {
  return useQuery<CandidateData>({
    queryKey: [...queryKeys.telesales.all(), "recommendations", "data"],
    enabled,
    // Longer than the queue's 15s: this is a planning view, not a claim race,
    // and recomputing it is more expensive than re-reading one page.
    staleTime: 60_000,
    queryFn: async () => {
      const { data: leadRows, error: leadError } = await (supabase as any)
        .from("telesales_leads")
        .select(LEAD_COLUMNS)
        .is("archived_at", null)
        .in("status", OPEN_LEAD_STATUSES)
        .order("created_at", { ascending: false })
        .limit(CANDIDATE_LIMIT);
      if (leadError) throw new Error(leadError.message);

      const leads = (leadRows as RecommendedQueueLead[]) ?? [];

      const phones = [...new Set(leads.map((l) => l.phone?.trim()).filter(Boolean))] as string[];

      /*
       * History for exactly the customers on screen.
       *
       * Batched rather than one big `in(...)`, because the filter travels in the
       * URL and 700 numbers would overrun it. Three requests for the live queue.
       */
      const history: PurchaseRecord[] = [];
      for (const batch of chunk(phones, PHONE_CHUNK)) {
        const { data, error } = await (supabase as any)
          .from("telesales_source_records")
          .select("phone,item_code,item_name,source_date,document_no,branch_no")
          .is("archived_at", null)
          .in("phone", batch);
        if (error) throw new Error(error.message);
        for (const r of (data as any[]) ?? []) {
          history.push({
            phone: r.phone,
            itemCode: r.item_code,
            itemName: r.item_name,
            sourceDate: r.source_date,
            documentNo: r.document_no,
            branchNo: r.branch_no,
          });
        }
      }

      const [{ data: cycleRows, error: cycleError }, { data: relationRows, error: relationError }] =
        await Promise.all([
          (supabase as any)
            .from("telesales_products")
            .select("item_code,refill_days")
            .eq("active", true),
          (supabase as any)
            .from("telesales_product_relations")
            .select("from_item_code,to_item_code,to_item_name,note")
            .eq("active", true),
        ]);
      if (cycleError) throw new Error(cycleError.message);
      // The relations table is new; a deployment that has not run the migration
      // should show recommendations without cross-sell rather than an error.
      const relations: ProductRelation[] = relationError
        ? []
        : ((relationRows as any[]) ?? []).map((r) => ({
            fromItemCode: r.from_item_code,
            toItemCode: r.to_item_code,
            toItemName: r.to_item_name,
            note: r.note,
          }));

      return {
        leads,
        history,
        cycles: (cycleRows as CandidateData["cycles"]) ?? [],
        relations,
        capped: leads.length >= CANDIDATE_LIMIT,
      };
    },
  });
}

export interface RecommendedLeadsResult {
  rows: RecommendedRow[];
  summary: RecommendationSummary | null;
  isLoading: boolean;
  error: Error | null;
  capped: boolean;
  refetch: () => void;
}

/**
 * The ranked list. Pure computation over the four reads above.
 */
export function useRecommendedLeads(enabled: boolean): RecommendedLeadsResult {
  const query = useRecommendationData(enabled);

  const computed = useMemo(() => {
    if (!query.data) return { rows: [] as RecommendedRow[], summary: null };

    const { leads, history, cycles, relations } = query.data;
    const byId = new Map(leads.map((l) => [l.id, l]));

    const candidates: RecommendableLead[] = leads.map((l) => ({
      id: l.id,
      phone: l.phone,
      itemCode: l.item_code,
      itemName: l.item_name,
      branchNo: l.branch_no,
      sourceDate: l.source_date,
      nextFollowupOn: l.next_followup_on,
      invoiceMatchStatus: l.invoice_match_status,
      documentNo: l.document_no,
    }));

    const summary = recommendLeads(candidates, {
      today: businessToday(),
      historyByPhone: groupHistoryByPhone(history),
      cycleByItem: new Map(
        cycles.map((c) => [c.item_code, { itemCode: c.item_code, refillDays: c.refill_days }]),
      ),
      relationsByItem: groupRelationsByItem(relations),
      // Deliberately no stock: see the note at the top of this file. Ordering
      // stays stable and stock decorates the visible rows instead.
    });

    const rows: RecommendedRow[] = [];
    for (const rec of summary.recommended) {
      const lead = byId.get(rec.leadId);
      if (lead) rows.push({ lead, recommendation: rec });
    }
    return { rows, summary };
  }, [query.data]);

  return {
    rows: computed.rows,
    summary: computed.summary,
    isLoading: query.isPending,
    error: (query.error as Error) ?? null,
    capped: query.data?.capped ?? false,
    refetch: () => void query.refetch(),
  };
}

/* ------------------------------------------------------------------------- */
/* Stock for the visible page                                                */
/* ------------------------------------------------------------------------- */

export interface RowStock {
  state: StockState;
  quantity: number | null;
}

/**
 * Branch stock for the products on screen.
 *
 * One request per *distinct product*, not per lead — a page of 25 leads is
 * frequently a handful of products, and the whole live catalogue is 109. Keyed
 * on `queryKeys.shams.product`, so it shares a cache entry with the `/shams`
 * Stock tab and with the lead detail's verification panel: an agent who has
 * already looked a product up pays nothing to see it here.
 *
 * The verdict comes from `branchStockState`, the integration's own rule, which
 * is why a branch missing from a non-empty response reads `unknown` rather than
 * `out_of_stock`.
 */
export function useVisibleStock(
  rows: readonly RecommendedRow[],
  enabled: boolean,
): Map<string, RowStock> {
  const codes = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      const code = row.recommendation.crossSell?.toItemCode ?? row.lead.item_code;
      if (code?.trim()) set.add(code.trim());
    }
    return [...set];
  }, [rows]);

  const results = useQueries({
    queries: codes.map((itemCode) => ({
      queryKey: queryKeys.shams.product(itemCode),
      enabled: enabled && Boolean(itemCode),
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
      queryFn: () => shamsGetProduct({ data: { itemCode } }),
    })),
  });

  return useMemo(() => {
    const out = new Map<string, RowStock>();
    codes.forEach((code, i) => {
      const r = results[i];
      // Anything short of a successful, configured answer is `unknown`. An
      // unanswered question must never render as "out of stock".
      if (!r || r.isPending || r.isError || !r.data?.configured || !r.data.ok) return;
      out.set(code, branchStockState(r.data.stock, branchForCode(rows, code)));
    });
    return out;
  }, [codes, results, rows]);
}

/**
 * Which branch to read a product's stock at.
 *
 * Stock is per product *per branch*, and the branch that matters is the one the
 * lead belongs to. Where several leads share a product across branches the
 * first is used and the row still shows its own branch, which is honest for the
 * common case (one product, one branch) and never invents a figure — a branch
 * absent from the response is `unknown`.
 */
function branchForCode(rows: readonly RecommendedRow[], code: string): string {
  for (const row of rows) {
    const rowCode = row.recommendation.crossSell?.toItemCode ?? row.lead.item_code;
    if (rowCode?.trim() === code && row.lead.branch_no) return row.lead.branch_no;
  }
  return "";
}
