/**
 * Shams MIS — product, stock and invoice lookup.
 *
 * A read-only window onto the pharmacy chain's own MIS, served entirely by the
 * server functions in `@/lib/shams.functions`. No Shams request is made from the
 * browser and no MIS detail — base URL, credentials, upstream errors — reaches
 * it; the page only ever sees normalized models and a `{kind}` failure code.
 *
 * ## Access
 *
 * One page-level permission, `view_shams_mis`, checked here and again in every
 * server function. This page is a single read-only window onto the pharmacy's
 * system, so gating its tabs against each other said nothing useful — and
 * borrowing `view_orders`/`view_invoice_analytics`, as it did before, meant
 * Shams access could not be granted or withdrawn on its own. The check here
 * decides which doors are visible; the server decides which are locked.
 *
 * ## The tabs
 *
 * Branch Stock, Invoices, Customers — three questions an agent actually
 * arrives with. There is no standalone Products tab: Branch Stock already
 * begins with the same catalog search, and an agent looking a product up almost
 * always wants to know where it is.
 *
 * Customers and Invoices are joined in one direction only. A customer's history
 * names the documents they bought on, so a row there opens the document; the
 * reverse is not offered, because `sales/details` returns no way to identify
 * the person behind a document. See `features/shams/invoice-customer-link.ts`.
 */

import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import type { ShamsProduct } from "@/lib/shams/types";
import { useProductDetail } from "@/features/shams/hooks/use-shams-data";
import { StockTab } from "@/features/shams/components/stock-tab";
import { InvoicesTab } from "@/features/shams/components/invoices-tab";
import { CustomersTab } from "@/features/shams/components/customers-tab";

export const Route = createFileRoute("/_app/shams")({
  head: () => ({ meta: [{ title: "Shams MIS — MilaServ Portal" }] }),
  /**
   * The page's state lives in the URL: which tab, what was searched, and which
   * product is open.
   *
   * It was all local `useState`, so opening a product and pressing Back
   * returned the agent to an empty search box — they had to type `nan` again to
   * get back to the list they had just been looking at. In the address bar it
   * survives Back, a refresh, and a pasted link.
   *
   * Validated rather than trusted: anything unexpected collapses to the
   * default, so a hand-edited URL cannot put the page into a state it has no
   * rendering for.
   */
  validateSearch: (s: Record<string, unknown>): ShamsSearch => ({
    tab: TAB_IDS.includes(s.tab as TabId) ? (s.tab as TabId) : "stock",
    q: typeof s.q === "string" && s.q.trim() !== "" ? s.q.slice(0, 80) : undefined,
    item: typeof s.item === "string" && ITEM_CODE.test(s.item.trim()) ? s.item.trim() : undefined,
    doc: typeof s.doc === "string" && DOC_NO.test(s.doc.trim()) ? s.doc.trim() : undefined,
    branch:
      typeof s.branch === "string" && BRANCH_CODE.test(s.branch.trim())
        ? s.branch.trim().toUpperCase()
        : undefined,
  }),
  component: ShamsPage,
});

type TabId = "stock" | "invoices" | "customers";
const TAB_IDS: readonly TabId[] = ["stock", "invoices", "customers"];

/** What a URL may carry as an item code. Digits, and not unboundedly many. */
const ITEM_CODE = /^[0-9]{1,20}$/;
/** Same shapes the server validates, so a hand-edited URL cannot reach it. */
const DOC_NO = /^[0-9]{1,12}$/;
const BRANCH_CODE = /^[A-Za-z][0-9]{4}$/;

interface ShamsSearch {
  tab: TabId;
  /** The settled search term, not the keystroke. */
  q?: string;
  /** The open product's item code. */
  item?: string;
  /**
   * A document handed to the Invoices tab, with the branch that holds it.
   *
   * Written when an agent opens an invoice from a customer's history. Both are
   * business identifiers — a document number and a warehouse code — and neither
   * identifies a person, which is why they are allowed in the address bar when
   * the mobile number that found them is not.
   */
  doc?: string;
  branch?: string;
}

function ShamsPage() {
  const { role, profile, loading } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;

  const canShams = hasPerm(role, perms, "view_shams_mis");

  const { tab, q, item, doc, branch } = Route.useSearch();
  const navigate = Route.useNavigate();

  /**
   * The product Branch Stock is about.
   *
   * The URL carries its *code*; this carries the row, so the header can name it
   * the instant it is picked rather than after a round trip. Restored below
   * when the page is entered with `?item=` and nothing in hand — a Back, or a
   * pasted link.
   */
  const [stockProduct, setStockProduct] = useState<ShamsProduct | null>(null);

  const restoring = Boolean(item) && stockProduct?.itemCode !== item;
  const restored = useProductDetail(item ?? null, restoring);
  useEffect(() => {
    if (!restoring) return;
    const product = restored.data?.ok ? restored.data.product : null;
    if (product) setStockProduct(product);
  }, [restoring, restored.data]);

  /**
   * The product actually on screen.
   *
   * Gated on the URL agreeing, rather than being `stockProduct` directly. The
   * two update at different moments — one is React state, the other is a router
   * navigation — and this is what makes the difference invisible: while a
   * selection is being restored, or has just been cleared, the URL is the
   * authority and a stale row is never rendered against the wrong `?item=`.
   */
  const openProduct = item && stockProduct?.itemCode === item ? stockProduct : null;

  /** Write one part of the search, leaving the rest of the URL alone. */
  const put = (next: Partial<ShamsSearch>, replace: boolean) =>
    navigate({ search: (prev) => ({ ...prev, ...next }), replace });

  /**
   * Open a product, or go back to the results.
   *
   * ## Why deselecting does not clear `stockProduct`
   *
   * It used to, and that was the "Change product needs two clicks" bug. The
   * sequence: the click set `stockProduct` to `null` immediately, but the
   * router's `?item=` only cleared a tick later. In between, `restoring`
   * evaluated to `Boolean(item) && undefined !== item` — **true** — so the
   * restore effect above fetched the product from cache and put it straight
   * back. The first click appeared to do nothing; the second worked only
   * because by then the URL had caught up.
   *
   * So a deselect is now a URL change and nothing else. `stockProduct` is left
   * holding the last product it loaded, which costs nothing because
   * `openProduct` will not render it without a matching `?item=`, and the
   * restore effect stays quiet because state and URL never disagree.
   */
  const selectProduct = (product: ShamsProduct | null) => {
    if (product) setStockProduct(product);
    // A *push*, so Back returns to the results the agent came from. Typing is
    // the opposite — see below — or every keystroke would be a history entry.
    put({ item: product?.itemCode }, false);
  };

  if (!loading && !canShams) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Shams MIS.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Shams MIS</h1>
        <p className="text-xs text-muted-foreground sm:text-sm">
          Shams Pharmacy product, stock and invoice information
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => put({ tab: v as TabId }, true)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="stock">Branch Stock</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="customers">Customers</TabsTrigger>
        </TabsList>

        {/*
          `forceMount` on all three, which is the whole of "switching tabs does
          not throw away what you loaded".

          Radix unmounts an inactive tab's content by default, and unmounting is
          what actually cost the work: every `useState` in the tab was
          discarded — the typed search, the chosen branch, the page you were on
          — and every React Query observer went with it, so coming back
          remounted the component and refetched from zero. Held mounted, the
          queries keep their observers and their cached data, and returning to a
          tab renders instantly with no request at all.

          Nothing here disables refetching. `staleTime` still governs freshness
          exactly as before, an explicit search or Retry still goes to the
          network, and a genuinely stale query still updates — this only stops
          the *remount* that was making that machinery moot.

          The cost is that all three mount at once, so each tab is told whether
          it is `active`; see `autoFocus` inside them. Their queries are all
          `enabled`-gated on a search having been made, so mounting three tabs
          issues no requests.
        */}
        <TabsContent value="stock" forceMount className="space-y-4 data-[state=inactive]:hidden">
          <StockTab
            active={tab === "stock"}
            selected={openProduct}
            onSelect={selectProduct}
            query={q ?? ""}
            // `replace`, so a search does not bury the page in history: the
            // agent's Back should leave the page, not walk back through
            // everything they typed.
            onQueryChange={(next) => put({ q: next || undefined }, true)}
          />
        </TabsContent>

        <TabsContent value="invoices" forceMount className="space-y-4 data-[state=inactive]:hidden">
          <InvoicesTab
            active={tab === "invoices"}
            handoff={doc && branch ? { docNo: doc, branchCode: branch } : null}
            // A search the agent typed themselves replaces the handed-over
            // document, so the URL stops claiming one. Without this, leaving the
            // tab and coming back would re-open the document they had moved on
            // from.
            onManualSearch={() => put({ doc: undefined, branch: undefined }, true)}
          />
        </TabsContent>

        <TabsContent
          value="customers"
          forceMount
          className="space-y-4 data-[state=inactive]:hidden"
        >
          <CustomersTab
            active={tab === "customers"}
            // A *push*, so Back returns the agent to the history they came
            // from — the invoice is a detour from the customer, not a new
            // starting point.
            onOpenInvoice={(branchCode, docNo) =>
              put({ tab: "invoices", doc: docNo, branch: branchCode }, false)
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
