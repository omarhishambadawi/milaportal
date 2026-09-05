import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Link2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { ProductCatalogPanel } from "@/features/telesales/components/product-catalog-panel";
import { RelationManager } from "@/features/telesales/components/relation-manager";

export const Route = createFileRoute("/_app/telesales/catalog")({
  head: () => ({ meta: [{ title: "Cross & Up-sell — MilaServ Portal" }] }),
  component: CatalogPage,
});

/**
 * Cross &amp; Up-sell: the products, and what to say alongside them.
 *
 * ===========================================================================
 * One page, because they were never three questions
 * ===========================================================================
 * This replaces two screens and removes a third that no longer needs to exist.
 *
 *   - **Product identity** mapped one source item code onto another. It had a
 *     screen because the retention workbook arrived under two numbering
 *     systems. The historical mappings are still load-bearing — without them a
 *     customer who bought under the older code stops reading as a repeat
 *     buyer — so they are kept and shown against the product they mean, on the
 *     Products tab. What is gone is the idea that a supervisor has to sit down
 *     and map imported codes: an item code on a Cash or Retention row is the
 *     pharmacy's own, and it matches the catalogue's own, deterministically.
 *
 *   - **Cross-sell configuration** was a separate screen from the catalogue,
 *     which meant a supervisor could not configure a companion for a product
 *     until they had gone somewhere else to add it — and nothing said so. The
 *     catalogue is now the first tab, which is the order the work happens in.
 *
 *   - **Up-sell** is new, and it is the same table with a `kind`. Two tables
 *     would have duplicated the pair key, the activation flag, the audit
 *     columns and the RLS policy, and then had to answer what a pair existing
 *     in both would mean.
 *
 * The Phase 8 rule survives all of it: nothing here infers a relationship or a
 * shared identity. Every row on all three tabs exists because a person with
 * `manage_telesales` entered it.
 */
function CatalogPage() {
  const { profile, role } = useAuth();
  const perms = profile?.permissions as string[] | null | undefined;
  const canView = hasPerm(role, perms, "view_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">The CRM is restricted</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Cross &amp; Up-sell</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            The products this desk sells, and what an agent may offer alongside them.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/crm/cash">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to the Cash CRM
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="cross">Cross-sell</TabsTrigger>
          <TabsTrigger value="up">Up-sell</TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="mt-4">
          <ProductCatalogPanel canManage={canManage} />
        </TabsContent>

        <TabsContent value="cross" className="mt-4">
          <RelationManager kind="cross_sell" canManage={canManage} />
        </TabsContent>

        <TabsContent value="up" className="mt-4">
          <RelationManager kind="up_sell" canManage={canManage} />
        </TabsContent>
      </Tabs>

      <p className="px-1 text-xs text-muted-foreground">
        A cross-sell or up-sell is business configuration, not a clinical suggestion. It never
        outranks a refill, and it only reaches an agent when the customer has actually bought the
        first product and has not already bought the second.
      </p>
    </div>
  );
}
