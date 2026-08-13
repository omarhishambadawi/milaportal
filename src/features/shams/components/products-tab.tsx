/**
 * Products — search the Shams catalog.
 *
 * The catalog exposes exactly three fields (item code, name, retail price), so
 * this table has three columns. No generic name, strength, dosage form, pack
 * size or barcode is shown, because the API returns none of them and a blank
 * column would imply the data merely happens to be missing.
 *
 * Layout follows the portal's existing two-rendering approach rather than a new
 * responsive system: a real table from `md` up, and the same rows as cards below
 * it, so a phone never scrolls sideways to read a price.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import type { ShamsProduct } from "@/lib/shams/types";
import {
  MIN_QUERY_LENGTH,
  useDebounced,
  useProductSearch,
} from "@/features/shams/hooks/use-shams-data";
import { ProductDetailDialog } from "./product-detail-dialog";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

/**
 * The search field, shared by this tab and the Branch Stock picker.
 *
 * Controlled by the caller so each tab owns its own term — typing in one is not
 * meant to move the other.
 */
export function ProductSearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search Shams products"
        autoComplete="off"
        autoFocus={autoFocus}
        className="h-11 pl-9 pr-9"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ProductsTab({ onViewStock }: { onViewStock: (product: ShamsProduct) => void }) {
  const [draft, setDraft] = useState("");
  const [openItem, setOpenItem] = useState<ShamsProduct | null>(null);
  const term = useDebounced(draft);

  const query = useProductSearch(term);
  const result = query.data;
  const products = useMemo(() => result?.products ?? [], [result]);

  const typedEnough = term.trim().length >= MIN_QUERY_LENGTH;
  // `isFetching` rather than `isLoading` so re-searching an already-cached term
  // still shows progress instead of appearing frozen.
  const busy = query.isFetching;

  const handleViewStock = useCallback(
    (product: ShamsProduct) => {
      setOpenItem(null);
      onViewStock(product);
    },
    [onViewStock],
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <ProductSearchField
            value={draft}
            onChange={setDraft}
            placeholder="Search product by name or item code…"
            autoFocus
          />
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Searches the live Shams catalog. Enter at least {MIN_QUERY_LENGTH} characters.
          </p>
        </CardContent>
      </Card>

      {query.isError && <ErrorState onRetry={() => query.refetch()} />}

      {result && !result.configured && <NotConfiguredState />}

      {result && result.configured && !result.ok && (
        <ErrorState kind={result.error?.kind} onRetry={() => query.refetch()} />
      )}

      {busy && !result && <TableSkeleton />}

      {result?.ok && products.length === 0 && !busy && (
        <EmptyState>No products found for “{term.trim()}”.</EmptyState>
      )}

      {result?.ok && products.length > 0 && (
        <ProductResults products={products} onOpen={setOpenItem} />
      )}

      {!typedEnough && !busy && (
        <EmptyState>Search Shams Pharmacy products to get started.</EmptyState>
      )}

      <ProductDetailDialog
        product={openItem}
        onOpenChange={(open) => !open && setOpenItem(null)}
        onViewStock={handleViewStock}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

const ProductResults = memo(function ProductResults({
  products,
  onOpen,
}: {
  products: ShamsProduct[];
  onOpen: (product: ShamsProduct) => void;
}) {
  return (
    <>
      {/* Desktop: a real table. */}
      <Card className="hidden overflow-hidden md:block">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Product</th>
                <th className={TH}>Item Code</th>
                <th className={cn(TH, "text-right")}>Retail Price</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr
                  key={p.itemCode}
                  onClick={() => onOpen(p)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(p);
                    }
                  }}
                  className="cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                >
                  <td className={cn(TD, "font-medium")}>{p.itemName}</td>
                  <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>
                    {p.itemCode}
                  </td>
                  <td className={cn(TD, "text-right tabular-nums")}>{fmtSAR(p.retailPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Mobile: the same rows as cards, so nothing scrolls sideways. */}
      <div className="space-y-2 md:hidden">
        {products.map((p) => (
          <Card key={p.itemCode}>
            <CardContent className="p-0">
              <button
                type="button"
                onClick={() => onOpen(p)}
                className="w-full rounded-lg p-4 text-left transition-colors hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
              >
                <p className="text-sm font-medium leading-snug">{p.itemName}</p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{p.itemCode}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {fmtSAR(p.retailPrice)}
                  </span>
                </div>
              </button>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
});
