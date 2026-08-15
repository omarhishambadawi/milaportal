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
 * ## Two tabs, not three
 *
 * The standalone Products tab was removed: Branch Stock already begins with the
 * same catalog search, and an agent looking a product up almost always wants to
 * know where it is. One flow instead of two that overlapped.
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
    tab: s.tab === "invoices" ? "invoices" : "stock",
    q: typeof s.q === "string" && s.q.trim() !== "" ? s.q.slice(0, 80) : undefined,
    item: typeof s.item === "string" && ITEM_CODE.test(s.item.trim()) ? s.item.trim() : undefined,
  }),
  component: ShamsPage,
});

type TabId = "stock" | "invoices";

/** What a URL may carry as an item code. Digits, and not unboundedly many. */
const ITEM_CODE = /^[0-9]{1,20}$/;

interface ShamsSearch {
  tab: TabId;
  /** The settled search term, not the keystroke. */
  q?: string;
  /** The open product's item code. */
  item?: string;
}

function ShamsPage() {
  const { role, profile, loading } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;

  const canShams = hasPerm(role, perms, "view_shams_mis");

  const { tab, q, item } = Route.useSearch();
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

  /** Write one part of the search, leaving the rest of the URL alone. */
  const put = (next: Partial<ShamsSearch>, replace: boolean) =>
    navigate({ search: (prev) => ({ ...prev, ...next }), replace });

  const selectProduct = (product: ShamsProduct | null) => {
    setStockProduct(product);
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
        </TabsList>

        <TabsContent value="stock" className="space-y-4">
          <StockTab
            selected={stockProduct}
            onSelect={selectProduct}
            query={q ?? ""}
            // `replace`, so a search does not bury the page in history: the
            // agent's Back should leave the page, not walk back through
            // everything they typed.
            onQueryChange={(next) => put({ q: next || undefined }, true)}
          />
        </TabsContent>

        <TabsContent value="invoices" className="space-y-4">
          <InvoicesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
