/**
 * Data access for the Shams MIS page.
 *
 * Every read here goes through an existing server function in
 * `@/lib/shams.functions` — the transport, normalization, caching and RBAC all
 * live server-side and none of it is reimplemented on the client. These hooks
 * only decide *when* to ask.
 *
 * Which matters, because the MIS is a third-party system and the page is
 * search-driven. Three rules keep the request count honest:
 *
 *   1. Search is debounced and floored at `MIN_QUERY_LENGTH`, so a burst of
 *      typing issues one request, not one per keystroke.
 *   2. Stock is never fetched for a result set — only for the single product a
 *      user has actually selected.
 *   3. An invoice lookup runs only once submitted, never while typing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { mergeInvoiceBranchMatches } from "@/lib/shams/search";
import { stripLeadingZeros } from "@/lib/shams/normalize";
import { cityEnglish } from "@/features/branches/normalize";
import {
  shamsFindInvoiceBranches,
  shamsGetCustomerHistory,
  shamsGetInvoices,
  shamsGetInvoiceStock,
  shamsGetProduct,
  shamsGetProductOffers,
  shamsSearchProducts,
} from "@/lib/shams.functions";

/** Matches `MIN_SEARCH_LENGTH` server-side — below it the server returns []. */
export const MIN_QUERY_LENGTH = 2;
/** Long enough not to search mid-word, short enough to feel responsive. */
const DEBOUNCE_MS = 350;

/**
 * Catalog data is stable over a working session; a product's price does not
 * move while someone reads it. Stock does, which is why it is not cached here
 * beyond the server's own 60 s window.
 */
const SEARCH_STALE_MS = 5 * 60_000;
const PRODUCT_STALE_MS = 60_000;
/** Matches the server's stock cache — the half of an invoice+stock read that moves. */
const STOCK_STALE_MS = 60_000;
/** Matches the server's offer cache. A promotional price is not reference data. */
const OFFERS_STALE_MS = 60_000;
/**
 * Branch discovery is the most expensive call on the page — one sweep of every
 * branch — and its answer (which branches ever held document N) does not move
 * within a shift. Held long enough that going back to a number is free.
 */
const DISCOVERY_STALE_MS = 10 * 60_000;

/** Trailing-edge debounce over a text input. */
export function useDebounced(value: string, delayMs = DEBOUNCE_MS): string {
  const [settled, setSettled] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === settled) return;
    timer.current = setTimeout(() => setSettled(value), delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, settled, delayMs]);

  return settled;
}

/* -------------------------------------------------------------------------- */
/* Branch directory                                                            */
/* -------------------------------------------------------------------------- */

export interface BranchLabel {
  branchNo: string;
  city: string;
  cityEnglish: string | null;
}

/**
 * MilaServ's own branch names, keyed by `branch_no`.
 *
 * The MIS returns `branchName` identical to `branchCode` on every row, so it
 * carries no display value. The portal already knows these branches — discovery
 * confirmed `branchCode` and `branches.branch_no` are the same identifier space
 * — so the stock table resolves its labels here rather than showing a code
 * twice.
 *
 * Read straight from Supabase under RLS like every other lookup on the site,
 * and parked under `lookups` so a Shams read never invalidates it.
 */
export function useBranchLabels() {
  return useQuery({
    queryKey: [...queryKeys.lookups.all(), "shams-branches"] as const,
    queryFn: async (): Promise<Map<string, BranchLabel>> => {
      const { data } = await supabase.from("branches").select("branch_no,city");
      const rows = (data ?? []) as { branch_no: string; city: string }[];
      return new Map(
        rows.map((b) => [
          b.branch_no,
          { branchNo: b.branch_no, city: b.city, cityEnglish: cityEnglish(b.city) },
        ]),
      );
    },
    // Reference data. It changes when someone imports the branch sheet, which
    // is not something this page needs to notice mid-session.
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Catalog search over a debounced term.
 *
 * `enabled` is the whole performance story: nothing is requested until the
 * debounce settles on a term long enough to mean something.
 */
export function useProductSearch(term: string, enabled = true) {
  const searchFn = useServerFn(shamsSearchProducts);
  const searchable = term.trim().length >= MIN_QUERY_LENGTH;

  return useQuery({
    queryKey: queryKeys.shams.productSearch(term.trim().toLowerCase()),
    queryFn: ({ signal }) => searchFn({ data: { q: term.trim() }, signal }),
    enabled: enabled && searchable,
    staleTime: SEARCH_STALE_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * One product's detail **and** its branch stock.
 *
 * Deliberately a single query: the server function fetches both in parallel, so
 * splitting them here would add a round trip and a second loading state for no
 * gain. Disabled until a product is actually selected — this is the hook that
 * would otherwise turn a twelve-row search into twelve stock requests.
 */
export function useProductDetail(itemCode: string | null, enabled = true) {
  const productFn = useServerFn(shamsGetProduct);

  return useQuery({
    queryKey: queryKeys.shams.product(itemCode ?? ""),
    queryFn: ({ signal }) => productFn({ data: { itemCode: itemCode as string }, signal }),
    enabled: enabled && Boolean(itemCode),
    staleTime: PRODUCT_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * CRM offer pricing for one opened product.
 *
 * Separate from `useProductDetail` on purpose. Offers are an enhancement: this
 * query failing, or the CRM not being configured at all, must leave the stock
 * table exactly as it is — so it loads alongside rather than in front, and its
 * error state is simply "no offers".
 *
 * Held for the server's own 60 s offer TTL rather than the catalog's hours: an
 * offer is a live price.
 */
export function useProductOffers(itemCode: string | null, enabled = true) {
  const offersFn = useServerFn(shamsGetProductOffers);

  return useQuery({
    queryKey: queryKeys.shams.productOffers(itemCode ?? ""),
    queryFn: () => offersFn({ data: { itemCode: itemCode as string } }),
    enabled: enabled && Boolean(itemCode),
    staleTime: OFFERS_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Invoices                                                                    */
/* -------------------------------------------------------------------------- */

export interface InvoiceLookup {
  branchCode: string;
  docNo: string;
}

/**
 * How many parts a branch sweep is split into.
 *
 * The MIS has no cross-branch lookup, so finding a document means asking every
 * branch. Splitting that into four requests that run at once does two things a
 * single request cannot: the sweep finishes in roughly a quarter of the waves,
 * and each part **resolves on its own**, so matches can be shown as they are
 * found instead of after the last branch replies.
 *
 * Four rather than more: each part carries its own upstream concurrency, and the
 * product of the two is what the MIS actually sees.
 */
export const DISCOVERY_PARTS = 4;

/**
 * Which branches hold a document number, discovered progressively.
 *
 * One query per part, all in flight together. `matches` is the merged, sorted
 * union of whatever has arrived — Call Centre first — and `done` says whether
 * every part has finished, so the UI can show real results while still telling
 * the agent the search is running. Nothing is auto-selected on the strength of a
 * partial answer.
 *
 * Deliberately keyed on a **submitted** number: this never runs while typing.
 * Parts are cached independently, so re-checking the same number inside the
 * window costs nothing.
 */
export function useInvoiceBranches(docNo: string | null, enabled = true) {
  const findFn = useServerFn(shamsFindInvoiceBranches);
  const active = enabled && Boolean(docNo);

  const parts = useQueries({
    queries: Array.from({ length: DISCOVERY_PARTS }, (_, part) => ({
      queryKey: queryKeys.shams.invoiceBranches(docNo ?? "", part, DISCOVERY_PARTS),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        findFn({
          data: { docNo: docNo as string, part, parts: DISCOVERY_PARTS },
          signal,
        }),
      enabled: active,
      staleTime: DISCOVERY_STALE_MS,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  });

  return useMemo(() => {
    const settled = parts.filter((p) => !p.isPending);
    const answered = parts.filter((p) => p.data?.ok);
    const configured = parts.every((p) => p.data?.configured !== false);

    return {
      /** Everything found so far, merged and Call-Centre-first. */
      matches: mergeInvoiceBranchMatches(parts.map((p) => p.data?.matches)),
      /** Branches asked so far, across the parts that have answered. */
      probed: answered.reduce((sum, p) => sum + (p.data?.probed ?? 0), 0),
      /** True only once every part has finished. */
      done: active && settled.length === parts.length,
      searching: active && parts.some((p) => p.isPending || p.isFetching),
      /** A sweep is a failure only when no part produced an answer. */
      failed: active && settled.length === parts.length && answered.length === 0,
      configured,
      error: parts.find((p) => p.data?.error)?.data?.error ?? null,
      started: active,
      refetch: () => {
        for (const p of parts) void p.refetch();
      },
    };
  }, [parts, active]);
}

/**
 * One document at one branch, with what that branch still holds of each line.
 *
 * The Orders panel's read, and the whole Order → Invoice → Branch → Stock chain
 * in a single round trip: the server resolves the document, pulls the item codes
 * off it and asks stock for them under bounded concurrency, all against caches
 * that live server-side. Splitting it would put a second round trip between the
 * agent and an answer the server already had.
 *
 * `staleTime` is the stock cache's 60 s rather than the document's, because
 * stock is the half that moves — a quantity is what goes out of date here, not
 * a document that has already been issued. Keyed on the zero-stripped number so
 * an order writing `022138` and a document numbered `22138` share one entry.
 */
export function useInvoiceStock(lookup: InvoiceLookup | null, enabled = true) {
  const invoiceStockFn = useServerFn(shamsGetInvoiceStock);
  const branchCode = lookup?.branchCode ?? "";
  const docNo = lookup ? stripLeadingZeros(lookup.docNo) : "";

  return useQuery({
    queryKey: queryKeys.shams.invoiceStock(branchCode, docNo),
    queryFn: ({ signal }) => invoiceStockFn({ data: { branchCode, docNo }, signal }),
    enabled: enabled && Boolean(branchCode && docNo),
    staleTime: STOCK_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * Several documents at one branch, each with its lines' availability.
 *
 * An order can carry more than one invoice number, so this is the shape the
 * Orders panel actually needs. One query per number rather than one request per
 * number: the keys are the same ones `useInvoiceStock` uses, so a number
 * already resolved anywhere in the session is served from cache, and the server
 * reads the same document and stock caches underneath.
 *
 * `useQueries` rather than a loop of `useInvoiceStock`, because the count is
 * data — an order may have one invoice or four — and hooks cannot be called in
 * a loop.
 */
export function useInvoiceStockMany(lookups: readonly InvoiceLookup[], enabled = true) {
  const invoiceStockFn = useServerFn(shamsGetInvoiceStock);

  return useQueries({
    queries: lookups.map((lookup) => {
      const branchCode = lookup.branchCode;
      const docNo = stripLeadingZeros(lookup.docNo);
      return {
        queryKey: queryKeys.shams.invoiceStock(branchCode, docNo),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          invoiceStockFn({ data: { branchCode, docNo }, signal }),
        enabled: enabled && Boolean(branchCode && docNo),
        staleTime: STOCK_STALE_MS,
        refetchOnWindowFocus: false,
        retry: false,
      };
    }),
  });
}

/**
 * Invoice lookup, only ever for a submitted pair.
 *
 * No date filter is offered: discovery marked the API's date parameters
 * NOT VERIFIED (the MIS frontend only ever sends them empty), so exposing one
 * would promise filtering nobody has seen work.
 *
 * Not cached beyond the session — an invoice is transactional and a stale total
 * is worse than a slow one.
 */
export function useInvoiceLookup(lookup: InvoiceLookup | null, enabled = true) {
  const invoicesFn = useServerFn(shamsGetInvoices);

  return useQuery({
    queryKey: queryKeys.shams.invoices(lookup?.branchCode ?? "", lookup?.docNo ?? ""),
    queryFn: ({ signal }) =>
      invoicesFn({
        data: {
          branchCode: lookup?.branchCode as string,
          docNoStart: lookup?.docNo as string,
        },
        signal,
      }),
    enabled: enabled && Boolean(lookup?.branchCode && lookup?.docNo),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/* CRM — customer sales history                                                */
/* -------------------------------------------------------------------------- */

export interface CustomerHistoryQuery {
  /** As typed. The server canonicalizes it; the browser does not guess. */
  mobile: string;
  /** `YYYYMMDD`. */
  fromDate: string;
  toDate: string;
  page: number;
  perPage: number;
}

/**
 * One page of a customer's purchase history.
 *
 * `enabled` on a **submitted** query, never on the form state: this is a
 * customer lookup, so a per-keystroke version would ask the MIS about a
 * different person on every digit — and about a series of real customers on the
 * way to the intended one. It runs when the agent submits, and again when they
 * page.
 *
 * `placeholderData` keeps the previous page on screen while the next one loads,
 * so paging does not blank the table and jump the scroll position back to the
 * top. The table dims instead — see `isFetching` in the tab.
 *
 * Cached for the session but never considered fresh: `staleTime: 0` means
 * returning to a page the agent has already seen shows it instantly and then
 * re-checks it, which is right for transactional data that someone may be
 * reading precisely because it just changed.
 */
export function useCustomerHistory(query: CustomerHistoryQuery | null) {
  const historyFn = useServerFn(shamsGetCustomerHistory);

  return useQuery({
    queryKey: queryKeys.shams.crmHistory(
      query?.mobile ?? "",
      query?.fromDate ?? "",
      query?.toDate ?? "",
      query?.page ?? 1,
      query?.perPage ?? 0,
    ),
    queryFn: ({ signal }) =>
      historyFn({
        data: {
          mobile: query?.mobile as string,
          fromDate: query?.fromDate as string,
          toDate: query?.toDate as string,
          page: query?.page as number,
          perPage: query?.perPage as number,
        },
        signal,
      }),
    enabled: Boolean(query),
    staleTime: 0,
    /**
     * Keep the previous page on screen while the next one loads — but **only**
     * when it is the same search.
     *
     * A bare `(previous) => previous` is the obvious version and it is wrong
     * here. It carries data across *any* key change, so searching a second
     * customer would render the first one's name, mobile number and purchases
     * until the new response landed: someone else's identity shown under the
     * number the agent just typed. Paging is the one transition where the rows
     * on screen still belong to the query being made, so it is the only one
     * allowed to keep them.
     *
     * The key is `[..., mobile, fromDate, toDate, page, perPage]`; everything
     * but `page` has to match.
     */
    placeholderData: (previous, previousQuery) => {
      if (!previous || !previousQuery) return undefined;
      const before = previousQuery.queryKey as readonly unknown[];
      const now = queryKeys.shams.crmHistory(
        query?.mobile ?? "",
        query?.fromDate ?? "",
        query?.toDate ?? "",
        query?.page ?? 1,
        query?.perPage ?? 0,
      );
      const sameSearch =
        before[2] === now[2] &&
        before[3] === now[3] &&
        before[4] === now[4] &&
        before[6] === now[6];
      return sameSearch ? previous : undefined;
    },
    refetchOnWindowFocus: false,
    retry: false,
  });
}
