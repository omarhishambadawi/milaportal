/**
 * Product detail.
 *
 * Deliberately small: the catalog returns four fields for one item and this
 * shows those four. It is a modal rather than an inline expansion so that the
 * mobile rendering is a full-width sheet the thumb can reach, and the desktop
 * one does not push the results table around.
 *
 * The query behind it (`useProductDetail`) fetches detail and branch stock in a
 * single server call, because the server function already overlaps them. That
 * makes "View branch stock" instant — the Stock tab reads the same cache entry
 * — at the cost of loading stock for a product whose detail was merely glanced
 * at. That is the right trade here: it is one request for a product the user
 * explicitly opened, not the per-result fan-out the brief warns against.
 */

import { Boxes } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fmtSAR } from "@/lib/branches";
import type { ShamsProduct } from "@/lib/shams/types";
import { useProductDetail } from "@/features/shams/hooks/use-shams-data";
import { DetailSkeleton, ErrorState } from "./states";

export function ProductDetailDialog({
  product,
  onOpenChange,
  onViewStock,
}: {
  product: ShamsProduct | null;
  onOpenChange: (open: boolean) => void;
  onViewStock: (product: ShamsProduct) => void;
}) {
  const query = useProductDetail(product?.itemCode ?? null, Boolean(product));
  const result = query.data;
  // Fall back to the search row while the detail request is in flight, so the
  // dialog opens with the name and price already on screen.
  const detail = result?.product ?? null;

  return (
    <Dialog open={Boolean(product)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base leading-snug">
            {detail?.itemName ?? product?.itemName ?? "Product"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {detail?.itemCode ?? product?.itemCode}
          </DialogDescription>
        </DialogHeader>

        {query.isFetching && !result && <DetailSkeleton />}

        {query.isError && <ErrorState onRetry={() => query.refetch()} />}

        {result && result.configured && !result.ok && (
          <ErrorState kind={result.error?.kind} onRetry={() => query.refetch()} />
        )}

        {result?.ok && !detail && (
          <p className="text-sm text-muted-foreground">
            No further details are available for this item.
          </p>
        )}

        {detail && (
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Retail price" value={fmtSAR(detail.retailPrice)} />
            <Field label="Retail price incl. tax" value={fmtSAR(detail.retailPriceWithTax)} />
          </dl>
        )}

        <DialogFooter>
          {product && (
            <Button type="button" variant="outline" onClick={() => onViewStock(product)}>
              <Boxes className="mr-1.5 h-4 w-4" aria-hidden="true" />
              View branch stock
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
