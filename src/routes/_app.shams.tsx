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

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import type { ShamsProduct } from "@/lib/shams/types";
import { StockTab } from "@/features/shams/components/stock-tab";
import { InvoicesTab } from "@/features/shams/components/invoices-tab";

export const Route = createFileRoute("/_app/shams")({
  head: () => ({ meta: [{ title: "Shams MIS — MilaServ Portal" }] }),
  component: ShamsPage,
});

type TabId = "stock" | "invoices";

function ShamsPage() {
  const { role, profile, loading } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;

  const canShams = hasPerm(role, perms, "view_shams_mis");

  const [tab, setTab] = useState<TabId>("stock");
  /** The product Branch Stock is about, held across tab switches. */
  const [stockProduct, setStockProduct] = useState<ShamsProduct | null>(null);

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

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="space-y-4">
        <TabsList>
          <TabsTrigger value="stock">Branch Stock</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
        </TabsList>

        <TabsContent value="stock" className="space-y-4">
          <StockTab selected={stockProduct} onSelect={setStockProduct} />
        </TabsContent>

        <TabsContent value="invoices" className="space-y-4">
          <InvoicesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
