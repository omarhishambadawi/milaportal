/**
 * Shams MIS — product, stock and invoice lookup.
 *
 * A read-only window onto the pharmacy chain's own MIS, served entirely by the
 * server functions in `@/lib/shams.functions`. No Shams request is made from the
 * browser and no MIS detail — base URL, credentials, upstream errors — reaches
 * it; the page only ever sees normalized models and a `{kind}` failure code.
 *
 * ## Access mirrors the server, rather than restating it
 *
 * The two server-side gates are `view_orders` for the catalog and
 * `view_invoice_analytics` for invoices, so this page shows exactly the tabs a
 * user's permissions can actually fetch: someone with only invoice access never
 * sees a Products tab that would error, and someone with only catalog access
 * never sees Invoices. The server checks again regardless — this is which doors
 * are visible, not which are locked.
 */

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import type { ShamsProduct } from "@/lib/shams/types";
import { ProductsTab } from "@/features/shams/components/products-tab";
import { StockTab } from "@/features/shams/components/stock-tab";
import { InvoicesTab } from "@/features/shams/components/invoices-tab";

export const Route = createFileRoute("/_app/shams")({
  head: () => ({ meta: [{ title: "Shams MIS — MilaServ Portal" }] }),
  component: ShamsPage,
});

type TabId = "products" | "stock" | "invoices";

function ShamsPage() {
  const { role, profile, loading } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;

  const canCatalog = hasPerm(role, perms, "view_orders");
  const canInvoices = hasPerm(role, perms, "view_invoice_analytics");

  const [tab, setTab] = useState<TabId>(canCatalog ? "products" : "invoices");
  /**
   * The product the Stock tab is about.
   *
   * Held here rather than inside the tab so that opening a product in Products
   * and pressing "View branch stock" carries the selection across — and because
   * both tabs then read the same React Query entry, the stock is already loaded
   * when the user arrives.
   */
  const [stockProduct, setStockProduct] = useState<ShamsProduct | null>(null);

  const tabs = useMemo(
    () =>
      [
        ...(canCatalog
          ? ([
              { id: "products", label: "Products" },
              { id: "stock", label: "Branch Stock" },
            ] as const)
          : []),
        ...(canInvoices ? ([{ id: "invoices", label: "Invoices" }] as const) : []),
      ] as { id: TabId; label: string }[],
    [canCatalog, canInvoices],
  );

  if (!loading && !canCatalog && !canInvoices) {
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

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="space-y-4">
        <TabsList>
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {canCatalog && (
          <>
            <TabsContent value="products" className="space-y-4">
              <ProductsTab
                onViewStock={(product) => {
                  setStockProduct(product);
                  setTab("stock");
                }}
              />
            </TabsContent>

            <TabsContent value="stock" className="space-y-4">
              <StockTab selected={stockProduct} onSelect={setStockProduct} />
            </TabsContent>
          </>
        )}

        {canInvoices && (
          <TabsContent value="invoices" className="space-y-4">
            <InvoicesTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
