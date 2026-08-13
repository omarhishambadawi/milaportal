/**
 * An order's invoices: resolved against Shams, then recorded once.
 *
 * The whole asynchronous half of the order lifecycle lives here. An order can be
 * taken at 09:00 and its document appear in the MIS at 11:00, so this hook is
 * built around the idea that *not found yet* is a normal, non-terminal state:
 *
 *   09:00  order saved, numbers typed        → every invoice `pending`
 *   11:00  the panel is opened again         → Shams answers, invoice `verified`
 *          → `record_invoice_verification`   → timeline event, order value,
 *                                              Call Center flag
 *
 * Nothing about that path requires the order to be recreated, and nothing polls.
 * The lookup runs when the panel mounts and when the agent asks again; React
 * Query's 60 s window and the server's own document and stock caches absorb the
 * rest. A full 137-branch sweep is *never* run from here — the order names a
 * branch, and one request asks it.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { useInvoiceStockMany, type InvoiceLookup } from "@/features/shams/hooks/use-shams-data";
import {
  invoiceKey,
  invoicesToRecord,
  summarizeInvoices,
  type InvoiceSummary,
  type OrderInvoice,
} from "../invoice-verification";
import { parseInvoiceNumbers } from "../utils";
import { recordedInvoiceKeys, useOrderActivity } from "./use-order-activity";

interface UseOrderInvoicesArgs {
  orderId: string | undefined;
  /** The order's stored `invoice_no` — one or many numbers. */
  invoiceNo: string | null | undefined;
  /** The order's `branch_no`: where to look first, never an answer in itself. */
  branchNo: string | null | undefined;
  /** False for agents without `view_shams_mis`; nothing is requested then. */
  enabled: boolean;
}

export interface OrderInvoicesResult extends InvoiceSummary {
  /** True while any number is still being resolved for the first time. */
  isLoading: boolean;
  isFetching: boolean;
  /** Ask Shams again — the agent's way to pick up a document that has landed. */
  refresh: () => void;
  /** True while the verification is being written. */
  isRecording: boolean;
  /** Invoice keys the order's timeline already records as verified. */
  recordedKeys: ReadonlySet<string>;
}

export function useOrderInvoices({
  orderId,
  invoiceNo,
  branchNo,
  enabled,
}: UseOrderInvoicesArgs): OrderInvoicesResult {
  const qc = useQueryClient();

  const numbers = useMemo(() => parseInvoiceNumbers(invoiceNo), [invoiceNo]);
  const branchCode = branchNo?.trim() || "";

  /**
   * One lookup per number, against the branch the order names.
   *
   * With no branch there is nowhere cheap to look, so nothing is requested and
   * every number stays `pending`. Discovering the branch would mean a sweep of
   * the whole chain, which is not something a page should do on open.
   */
  const lookups: InvoiceLookup[] = useMemo(
    () => (branchCode ? numbers.map((docNo) => ({ branchCode, docNo })) : []),
    [branchCode, numbers],
  );

  const results = useInvoiceStockMany(lookups, enabled);
  const activity = useOrderActivity(orderId, enabled);

  const recordedKeys = useMemo(() => recordedInvoiceKeys(activity.data), [activity.data]);

  /**
   * Every number on the order, in the state the lookup left it.
   *
   * A number is `verified` only when Shams returned a document for it. An empty
   * answer is `pending` — the document may simply not have been written yet —
   * and a transport failure is `unavailable`, which is deliberately a different
   * word: one is the MIS saying "no", the other is the MIS not saying anything.
   */
  const invoices: OrderInvoice[] = useMemo(() => {
    return numbers.map((invoiceNo, index) => {
      const key = invoiceKey(invoiceNo);
      const query = branchCode ? results[index] : undefined;
      const result = query?.data;

      const base: OrderInvoice = {
        invoiceNo,
        key,
        state: "pending",
        branchCode: null,
        customer: null,
        isCallCentre: false,
        total: null,
        docDate: null,
        cancelled: false,
        items: [],
      };

      // No branch to ask, or the answer has not arrived: pending, which is a
      // legitimate resting state and not a failure.
      if (!query || (!result && query.isFetching)) return base;
      if (query.isError) return { ...base, state: "unavailable" };
      if (!result) return base;
      if (result.configured === false) return { ...base, state: "unavailable" };
      if (!result.ok) return { ...base, state: "unavailable" };
      if (!result.invoice) return base;

      const doc = result.invoice;
      return {
        ...base,
        state: "verified",
        // Where Shams holds it, which is not necessarily the order's branch.
        branchCode: doc.branchCode ?? branchCode,
        customer: doc.customer,
        isCallCentre: doc.isCallCentre,
        total: doc.grandTotal,
        docDate: doc.docDate,
        cancelled: doc.cancelled,
        items: result.items,
      };
    });
  }, [numbers, results, branchCode]);

  const summary = useMemo(() => summarizeInvoices(invoices), [invoices]);

  /**
   * Write the verification: timeline event, order value, Call Center flag.
   *
   * One RPC, because the three have to agree, and idempotent in the database as
   * well as here — see the migration. The `edited` and `verification_changed`
   * events the orders trigger raises on the back of it are left to it: they are
   * a true record of what changed and the timeline should show them.
   */
  const record = useMutation({
    mutationFn: async (entries: OrderInvoice[]) => {
      const { data, error } = await supabase.rpc("record_invoice_verification" as any, {
        _order_id: orderId as string,
        _entries: entries.map((i) => ({
          invoice_no: i.invoiceNo,
          branch_code: i.branchCode,
          total: i.total,
          customer: i.customer,
          is_call_centre: i.isCallCentre,
          doc_date: i.docDate,
        })),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // The order itself changed (value, flag) and so did its history.
      qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
      qc.invalidateQueries({ queryKey: queryKeys.orders.activity(orderId ?? "") });
    },
  });

  /**
   * Guard against re-entry within a render cycle.
   *
   * The database is the real defence against double-recording; this only stops
   * the same request being sent twice while the first is in flight and before
   * the activity query has refetched.
   */
  const attempted = useRef<string>("");

  const pendingWrite = useMemo(
    () => (activity.isSuccess ? invoicesToRecord(summary, recordedKeys) : []),
    [activity.isSuccess, summary, recordedKeys],
  );

  useEffect(() => {
    if (!orderId || !enabled || pendingWrite.length === 0) return;
    const signature = pendingWrite
      .map((i) => i.key)
      .sort()
      .join(",");
    // Never cleared, including on failure. `useQueries` hands back a new array
    // every render, so `pendingWrite` is a new array every render too; a guard
    // that reset itself would turn one rejected call — an unapplied migration,
    // a revoked permission — into a request per render. A genuinely new invoice
    // changes the signature and gets its own attempt; a success makes
    // `pendingWrite` empty when the activity query refetches.
    if (attempted.current === signature) return;
    attempted.current = signature;
    record.mutate(pendingWrite);
    // `record` is recreated each render by `useMutation`; the signature above is
    // what actually decides whether this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, enabled, pendingWrite]);

  const refresh = useCallback(() => {
    for (const query of results) void query.refetch();
    void activity.refetch();
  }, [results, activity]);

  return {
    ...summary,
    isLoading: results.some((r) => r.isPending && r.fetchStatus !== "idle"),
    isFetching: results.some((r) => r.isFetching),
    refresh,
    isRecording: record.isPending,
    recordedKeys,
  };
}
